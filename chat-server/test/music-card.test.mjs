import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = await mkdtemp(join(tmpdir(), 'jukebox-share-'));
after(() => rm(dir, { recursive: true, force: true }));
process.env.CHAT_SHARED_MUSIC_DIR = join(dir, 'shared');
process.env.CHAT_MUSIC_CACHE_DIR = join(dir, 'cache');
await mkdir(process.env.CHAT_MUSIC_CACHE_DIR);

const { MusicRegistry } = await import('../src/music/registry.mjs');
const { createMusicCardResolver } = await import('../src/music/music-card.mjs');
const { isReadyShare } = await import('../src/music/shared-audio.mjs');
const { lookupPreferredProviders } = await import('../src/music/provider-routing.mjs');
const origin = 'https://example.test';
const track = (id, title = 'Song') => ({
  id, provider: id.split(':')[0], sourceId: id.split(':')[1], title, artist: 'Artist', durationSec: 180
});
const audio = Buffer.alloc(4096);
audio.write('ID3');
const provider = (id, tracks = []) => ({
  id, search: async () => ({ tracks }),
  resolveStream: async () => ({ url: 'https://a.music.126.net/' + id, mimeType: 'audio/mpeg', providerChannel: id })
});
const resolver = providers => createMusicCardResolver(new MusicRegistry(providers), origin, 'fixture');

test('catalog order and measured priority window retain a slower QQ recording', async () => {
  const ids = ['youtube', 'kugou', 'netease', 'qq'];
  const registry = new MusicRegistry(ids.map(id => provider(id)));
  for (const sourcePlatform of ['applemusic', 'spotify']) {
    assert.deepEqual(registry.providerOrder({ sourcePlatform }), ['qq', 'netease', 'youtube', 'kugou']);
  }
  const result = await lookupPreferredProviders(['qq', 'netease'], async id => {
    if (id === 'qq') await new Promise(resolve => setTimeout(resolve, 1400));
    return { playable: id };
  }, 3000);
  assert.equal(result.playable, 'qq');
});

test('legacy Apple card resolves the original recording and concurrent shares fetch one file', async t => {
  const netease = track('netease:2089023383');
  const qq = provider('qq');
  qq.resolveStream = () => assert.fail('Apple ID reached QQ');
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => { downloads++; return new Response(audio); });
  const prepare = resolver([qq, provider('netease', [netease])]);
  const old = { ...track('applemusic:1707998520'), provider: 'qq' };
  const cards = await Promise.all(Array.from({ length: 12 }, () => prepare(old, true)));
  assert.equal(downloads, 1);
  assert.equal(cards[0].track.id, netease.id);
  assert.equal(new Set(cards.map(card => card.sharedAudioUrl)).size, 1);
  assert.equal(await isReadyShare(cards[0].sharedAudioUrl, origin), true);
  assert.deepEqual(await readFile(join(process.env.CHAT_SHARED_MUSIC_DIR, cards[0].shareId + '.audio')), audio);
});

test('a complete VPS playback file is shareable without calling any upstream', async () => {
  const song = track('youtube:Abc_def1234');
  const key = createHash('sha256').update(song.id + ':128').digest('hex').slice(0, 32);
  const base = join(process.env.CHAT_MUSIC_CACHE_DIR, key);
  await writeFile(base + '.audio', audio);
  await writeFile(base + '.meta.json', JSON.stringify({ complete: true, size: audio.length }));
  const yt = provider('youtube');
  yt.resolveStream = yt.search = () => assert.fail('existing disk audio must be reused');
  const prepare = resolver([yt]);
  assert.equal((await prepare(song, true)).size, audio.length);
  const preview = await prepare(song, false);
  const { verifyStreamProxyToken } = await import('../src/music/stream-signer.mjs');
  const { handleStreamProxyRequest } = await import('../src/music/stream-cache.mjs');
  const token = new URL(preview.streamUrl).searchParams.get('token');
  const verified = verifyStreamProxyToken(token, 'fixture');
  assert.equal(verified.url, '');
  assert.equal(verified.trackKey, song.id + ':128');
  const server = createServer((req, res) => handleStreamProxyRequest(req, res, verified.url,
    verified.referer, verified.mimeType, verified.trackKey));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const local = 'http://127.0.0.1:' + server.address().port;
    const response = await fetch(local, { headers: { range: 'bytes=0-15' } });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio.subarray(0, 16));
    await rm(base + '.audio');
    assert.equal((await fetch(local)).status, 410);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a broken full download falls through to a different catalog; later requests recover', async t => {
  const song = track('qq:broken', 'Another Song');
  const backup = track('netease:1234567', song.title);
  let broken = true;
  t.mock.method(globalThis, 'fetch', async url => new Response(broken && url.endsWith('/qq')
    ? Buffer.alloc(4096, 60) : audio));
  const prepare = resolver([provider('qq', [song]), provider('netease', [backup])]);
  const result = await prepare(song, true);
  assert.equal(result.track.id, backup.id);
  const single = resolver([provider('qq', [song])]);
  await assert.rejects(single(song, true), { code: 'SOURCE_TEMPORARY' });
  broken = false;
  assert.equal((await single(song, true)).track.id, song.id);
});

test('search is offered only after every catalog answered and a timeout is temporary', async () => {
  const ids = ['qq','netease','youtube','kugou'];
  const tried = new Set();
  const providers = ids.map(id => ({ id, search: async () => { tried.add(id); return { tracks: [] }; } }));
  const song = track('spotify:abc123');
  await assert.rejects(resolver(providers)(song, false), { code: 'NO_SOURCE' });
  assert.deepEqual([...tried].sort(), ids.sort());
  providers[0].search = async () => { throw new Error('timeout'); };
  await assert.rejects(resolver(providers)(song, true), { code: 'SOURCE_TEMPORARY' });
});

test('a partial upstream response never becomes a share and the following full download succeeds', async t => {
  let partial = true;
  t.mock.method(globalThis, 'fetch', async () => partial
    ? new Response(audio, { status: 206, headers: { 'Content-Range': 'bytes 0-4095/16000' } })
    : new Response(audio));
  const song = track('qq:partial');
  const prepare = resolver([provider('qq', [song])]);
  await assert.rejects(prepare(song, true), { code: 'SOURCE_TEMPORARY' });
  partial = false;
  assert.equal((await prepare(song, true)).size, audio.length);
});

test('an unrelated stalled stream cannot occupy its resolution slot forever', async t => {
  const qq = provider('qq');
  let release;
  const started = Promise.withResolvers();
  qq.resolveStream = () => {
    started.resolve();
    return new Promise(resolve => { release = resolve; });
  };
  const registry = new MusicRegistry([qq]);
  const song = track('qq:stall');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = registry.resolvePlayable(song, origin, 'fixture');
  await started.promise;
  t.mock.timers.tick(14_001);
  await assert.rejects(first, /超时/);
  assert.equal(registry.resolving.size, 0);
  qq.resolveStream = async () => ({ url: 'https://a.music.126.net/good', mimeType: 'audio/mpeg', providerChannel: 'second' });
  const next = await registry.resolvePlayable(song, origin, 'fixture');
  release(null);
  assert.equal(next.audioSource.channel, 'second');
  assert.equal((await registry.resolvePlayable(song, origin, 'fixture')).audioSource.channel, 'second');
});
