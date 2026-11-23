import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MusicManager } from '../src/music/music-manager.mjs';
import { ChatDatabase } from '../src/db/database.mjs';
import { MusicRegistry } from '../src/music/registry.mjs';
import { findPlaylistRequestTrack } from '../src/music/music-input.mjs';
import { QQMusicProvider } from '../src/music/qq-music.mjs';
import { KugouMusicProvider, NeteaseMusicProvider } from '../src/music/catalog-providers.mjs';
import { lookupPreferredProviders } from '../src/music/provider-routing.mjs';
import { YoutubeCandidates } from '../src/music/youtube-candidates.mjs';

const origin = 'https://example.test';
const track = id => ({ id: 'qq:' + id, provider: 'qq', sourceId: id, title: id, durationSec: 180 });
const actor = { userKey: 'member', name: 'Member' };
const playable = item => ({ ...item, streamUrl: origin + '/audio/' + item.sourceId });

test('a missed primary starts both alternatives before either alternative returns', async () => {
  const starts = [];
  const pending = new Map();
  const lookup = lookupPreferredProviders(['qq', 'kugou', 'netease'], id => {
    starts.push(id);
    if (id === 'qq') return {};
    return new Promise(resolve => pending.set(id, resolve));
  }, 1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, ['qq', 'kugou', 'netease']);
  pending.get('netease')({ playable: track('lower') });
  pending.get('kugou')({ playable: track('higher') });
  assert.equal((await lookup).playable.sourceId, 'higher');
});

test('a slow primary allows the alternatives to run without holding the whole request open', async () => {
  let signal;
  const found = await lookupPreferredProviders(['qq', 'netease'], (id, lookupSignal) => {
    signal = lookupSignal;
    return id === 'qq' ? new Promise(() => {}) : { playable: track('ready') };
  }, 1600);
  assert.equal(found.playable.sourceId, 'ready');
  assert.equal(signal.aborted, true);
});

test('NetEase native tracks start with their own ID and a fast hit skips other catalogs', async () => {
  let searched = 0;
  const provider = id => ({ id, async search() { searched++; return { tracks: [] }; } });
  const registry = new MusicRegistry([provider('qq'), provider('netease')]);
  const source = { sourcePlatform: 'netease', sourceTrackId: '1234', title: 'Original', artist: 'Artist', durationSec: 180 };
  const found = await registry.resolveRotationTrack(source, async item => playable(item), { alternatives: true });
  assert.equal(found.playable.id, 'netease:1234');
  assert.deepEqual(found.playable.playbackSelection, {
    mode: 'original',
    original: { title: 'Original', artist: 'Artist', platform: 'netease' }
  });
  assert.equal(searched, 0);
});

test('only verified matches survive process restart and the background worker reuses them', async () => {
  const saved = new Map();
  const store = { getKv: key => saved.get(key), setKv: (key, value) => saved.set(key, value) };
  const candidate = { ...track('match'), title: 'Original', artist: 'Artist' };
  const source = { sourcePlatform: 'spotify', sourceTrackId: 'spotify-id', title: 'Original', artist: 'Artist', durationSec: 180 };
  let searches = 0;
  const provider = { id: 'qq', async search() { searches++; return { tracks: [candidate] }; } };
  const first = new MusicRegistry([provider], { matchStore: store });
  assert.equal(await first.preMatchPlaylists([{ tracks: [source, source] }], async item => playable(item)), 1);
  const next = new MusicRegistry([provider], { matchStore: store });
  assert.equal(await next.preMatchPlaylists([{ tracks: [source] }], async item => playable(item)), 0);
  assert.equal((await next.resolveRotationTrack(source, async item => playable(item))).playable.id, candidate.id);
  assert.equal(searches, 1);
  assert.ok([...saved.values()].every(record => !record.track?.streamUrl));
});

test('NetEase checks that the original CDN file supports seeking and rejects unavailable redirects', async t => {
  const provider = new NeteaseMusicProvider();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    calls.push(url.hostname);
    if (url.hostname === 'music.163.com') {
      return new Response(null, { status: 302, headers: { location: url.searchParams.get('id') === '123.mp3'
        ? 'http://m701.music.126.net/sound.mp3' : 'https://music.163.com/404' } });
    }
    assert.equal(url.protocol, 'https:');
    assert.equal(options.headers.Range, 'bytes=0-4095');
    return new Response('ID3fixture-audio', { status: 206, headers: { 'Content-Range': 'bytes 0-16/8000' } });
  });
  assert.equal((await provider.resolveStream('123')).mimeType, 'audio/mpeg');
  assert.equal(await provider.resolveStream('124'), null);
  assert.deepEqual(calls, ['music.163.com', 'm701.music.126.net', 'music.163.com']);
});

test('manual YouTube candidates share a bounded search and only return official video IDs', async t => {
  const service = new YoutubeCandidates('fixture');
  let calls = 0;
  const candidate = { id: 'AbCdEfGhI_1', title: 'Track', channel: 'Artist' };
  t.mock.method(globalThis, 'fetch', async input => {
    calls++;
    const url = new URL(input);
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(url.searchParams.get('type'), 'video');
    return Response.json({ items: [
      { id: { videoId: candidate.id }, snippet: { title: candidate.title, channelTitle: candidate.channel } },
      { id: { videoId: '?redirect' }, snippet: { title: 'Malformed ID' } }
    ] });
  });
  const results = await Promise.all([service.search('Song Artist', 'first'), service.search('song artist', 'second')]);
  assert.deepEqual(results, [[candidate], [candidate]]);
  assert.equal(calls, 1);
  await assert.rejects(service.search('Different query', 'first'), { statusCode: 429 });
});

async function manager(t, registry, roomId = 'chat', dataDir, chatDb) {
  if (!dataDir) {
    dataDir = await mkdtemp(join(tmpdir(), 'music-test-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
  }
  const mgr = new MusicManager({ roomId, dataDir, musicRegistry: registry, serverOrigin: origin, signSecret: 'fixture', chatDb });
  t.after(() => {
    for (const timer of [mgr._advanceTimer, mgr._prepareFallbackTimer, mgr._refreshPreparedTimer, mgr._saveTimer]) clearTimeout(timer);
  });
  return mgr;
}

test('late fallback cannot overwrite a user request', async t => {
  const mgr = await manager(t, { resolvePlayable: async item => playable(item) });
  let release;
  mgr.resolveFallbackTrackPlayable = () => new Promise(resolve => { release = resolve; });
  const transition = mgr.advanceNext();
  assert.equal((await mgr.enqueueTrack(track('request'), actor)).ok, true);
  release(playable(track('fallback')));
  await transition;
  assert.equal(mgr.current.track.sourceId, 'request');
});

test('restoring playback keeps the queue and failed source recovery stays in its room', async t => {
  let fail = false;
  let transient = false;
  const registry = { isHealthy: async () => false, resolvePlayable: async (item, _origin, _secret, options) => {
    if (transient) throw new Error('supplier timeout');
    return fail && (item.sourceId === 'first' || item.sourceId === 'second') ? null :
      { ...playable(item), streamUrl: origin + '/audio/' + item.sourceId + (options?.fresh ? '?renewed' : '') };
  } };
  const chat = await manager(t, registry);
  const tea = await manager(t, registry, 'interconnect', chat.dataDir);
  await chat.enqueueTrack(track('first'), actor);
  await chat.enqueueTrack(track('second'), actor);
  await chat.enqueueTrack(track('third'), actor);
  await tea.enqueueTrack(track('other'), actor);
  const stored = JSON.parse(await readFile(chat.statePath, 'utf8'));
  assert.deepEqual(stored.queue.map(item => item.track.sourceId), ['second', 'third']);
  assert.equal(stored.queue[0].track.streamUrl, undefined);
  const restored = await manager(t, registry, 'chat', chat.dataDir);
  await restored.restorePlayback();
  assert.deepEqual(restored.queue.map(item => item.track.sourceId), ['second', 'third']);
  assert.equal(restored.current.startedAt, chat.current.startedAt);

  const uid = chat.current.uid;
  await chat.reportError(uid, actor.userKey);
  assert.equal(chat.current.uid, uid);
  assert.equal(chat.current.sourceRevision, 1);
  assert.match(chat.current.track.streamUrl, /\?renewed$/);
  chat.current.lastRecoveryAt = 0;
  transient = true;
  await chat.reportError(uid, 'another-listener');
  assert.equal(chat.current.uid, uid);
  assert.equal(chat.current.sourceRevision, 1);
  transient = false;
  fail = true;
  chat.current.lastRecoveryAt = 0;
  await chat.reportError(uid, 'third-listener');
  assert.notEqual(chat.current.uid, uid);
  assert.equal(tea.current.track.sourceId, 'other');
});

test('duration changes reschedule and premature ended cannot advance', async t => {
  const mgr = await manager(t, { resolvePlayable: async item => playable(item) });
  await mgr.enqueueTrack(track('song'), actor);
  const oldTimer = mgr._advanceTimer;
  mgr.reportDuration(mgr.current.uid, 200);
  assert.equal(mgr.current.durationSec, 200);
  assert.notEqual(mgr._advanceTimer, oldTimer);
  mgr.current.startedAt = Date.now() - 21_000;
  mgr.ended(mgr.current.uid);
  assert.equal(mgr.advancing, undefined);
});

test('strict external match declines an unrelated search result', async () => {
  const provider = { id: 'qq', search: async () => ({ tracks: [{ ...track('x'), artist: 'Artist' }], hasMore: false }) };
  const registry = new MusicRegistry([provider]);
  assert.equal(await registry.resolvePlaylistTrack({ title: 'No match', artist: 'Artist' }), null);
  assert.equal((await registry.resolvePlaylistTrack({ title: 'x', artist: 'Artist' })).id, 'qq:x');
});

test('supplier fallback validates the actual media and search pagination uses the raw total', async t => {
  t.mock.method(globalThis, 'fetch', async value => {
    const url = new URL(value);
    switch (url.hostname) {
      case 'cyapi.top':
      case 'api.vkeys.cn': {
        const id = url.searchParams.get('mid');
        if (id === 'missing') return Response.json({}, { status: 404 });
        if (id === 'temporary') return Response.json({}, { status: 503 });
        return url.hostname === 'api.vkeys.cn'
          ? Response.json({ data: { url: 'https://isure6.stream.qqmusic.qq.com/bad' } })
          : Response.json({ url: 'https://ws.stream.qqmusic.qq.com/good' });
      }
      case 'isure6.stream.qqmusic.qq.com': return Response.json({}, { status: 404 });
      case 'ws.stream.qqmusic.qq.com': return new Response(Buffer.from('ID3abcdefghijk'), {
        status: 206, headers: { 'Content-Range': 'bytes 0-13/100', 'Content-Type': 'application/octet-stream' }
      });
      case 'c.y.qq.com': return Response.json({ code: 0, data: { song: {
        totalnum: 90,
        list: [{
          songmid: 'demo', songname: 'Demo',
          singer: [
            { name: 'Dazbee', mid: 'fixtureartist', transname: ' ダズビー ' },
            null,
            { name: 'Guest', id: 51, transname: 'Guest' },
            { name: 'No identity', transname: 'Unverified alias' }
          ]
        }, { songmid: 'demo', songname: 'Demo' }]
      } } });
      default: throw new Error('unexpected test host');
    }
  });
  const provider = new QQMusicProvider('fixture');
  const result = await provider.resolveStream('id');
  assert.equal(result.providerChannel, 'cyapi');
  assert.equal(await provider.resolveStream('missing'), null);
  await assert.rejects(provider.resolveStream('temporary'), /temporarily unavailable/);
  assert.equal(result.mimeType, 'audio/mpeg');
  const resolved = await new MusicRegistry([provider]).resolvePlayable(track('id'), origin, 'fixture');
  assert.equal(resolved.streamUrl, 'https://ws.stream.qqmusic.qq.com/good');
  assert.ok(resolved.proxyUrl.startsWith(origin + '/api/music/stream'));
  assert.deepEqual(resolved.audioSource, { checked: true, channel: 'cyapi', mimeType: 'audio/mpeg' });
  const page = await provider.search('Demo', 30, 2);
  assert.equal(page.tracks.length, 1);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.tracks[0].artistNames, ['Dazbee', 'Guest', 'No identity']);
  assert.deepEqual(page.tracks[0].artistCredits, [
    { id: 'mid:fixtureartist', name: 'Dazbee', alias: 'ダズビー' },
    { id: 'id:51', name: 'Guest' },
    { name: 'No identity' }
  ]);
});

test('cached proxy supports prefix, suffix, clamping, HEAD and invalid range', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cache-test-'));
  process.env.CHAT_MUSIC_CACHE_DIR = dir;
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { handleStreamProxyRequest } = await import('../src/music/stream-cache.mjs?range-fixture');
  const url = 'https://ws.stream.qqmusic.qq.com/example';
  const key = createHash('sha256').update(url).digest('hex').slice(0, 32);
  const bytes = Buffer.alloc(2048, 42);
  bytes.write('ID3');
  await writeFile(join(dir, key + '.audio'), bytes);
  await writeFile(join(dir, key + '.meta.json'), JSON.stringify({ complete: true, size: bytes.length }));
  const server = createServer((req, res) => { void handleStreamProxyRequest(req, res, url, '', 'audio/mp4'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = 'http://127.0.0.1:' + server.address().port;
  for (const [range, status, contentRange, length] of [
    ['bytes=0-1', 206, 'bytes 0-1/2048', 2],
    ['bytes=-2', 206, 'bytes 2046-2047/2048', 2],
    ['bytes=2040-2100', 206, 'bytes 2040-2047/2048', 8],
    ['bytes=4096-', 416, 'bytes */2048', 0]
  ]) {
    const response = await fetch(address, { headers: { Range: range }, signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, status);
    if (status >= 400) assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-range'), contentRange);
    assert.equal((await response.arrayBuffer()).byteLength, length);
  }
  const head = await fetch(address, { method: 'HEAD' });
  assert.equal(head.headers.get('content-type'), 'audio/mpeg');
  assert.equal(head.headers.get('content-length'), '2048');
});

test('warm queue head can switch after the resolver cache expires without another upstream call', async t => {
  const calls = [];
  const registry = {
    resolvePlayable: async item => { calls.push(item.sourceId); return playable(item); },
    isCached: async () => true
  };
  const mgr = await manager(t, registry);
  await mgr.enqueueTrack(track('first'), actor);
  await mgr.enqueueTrack(track('next'), actor);
  await mgr.enqueueTrack(track('third'), actor);
  const advertised = mgr.getSnapshot().next;
  assert.equal(advertised.track.sourceId, 'next');
  mgr.preparedQueue.checkedAt = Date.now() - 120_000;
  const before = Date.now();
  await mgr.advanceNext();
  assert.equal(mgr.current.track.sourceId, 'next');
  assert.equal(mgr.current.track, advertised.track);
  assert.equal(mgr.current.phase, 'scheduled');
  assert.ok(mgr.current.startedAt >= before + 500 && mgr.current.startedAt <= Date.now() + 500);
  assert.equal(calls.filter(id => id === 'next').length, 1);
});

test('concurrent skip and fallback warm-up share one resolver', async t => {
  const mgr = await manager(t, { resolvePlayable: async item => playable(item) });
  await mgr.enqueueTrack(track('first'), actor);
  mgr.fallbackTracks = [track('fallback')];
  let release;
  let resolves = 0;
  mgr.resolveFallbackTrackPlayable = () => {
    resolves++;
    return new Promise(resolve => { release = resolve; });
  };
  const preparing = mgr.prepareNext();
  const skipping = mgr.advanceNext();
  assert.equal(mgr.advanceNext(), skipping);
  release(playable(track('fallback')));
  await Promise.all([preparing, skipping]);
  assert.equal(resolves, 1);
  assert.equal(mgr.current.track.sourceId, 'fallback');
});

test('a historic implicit fallback does not resume, while an explicitly selected playlist does', async t => {
  const registry = {
    resolvePlaylistTrack: async item => item,
    resolvePlayable: async item => playable(item)
  };
  const before = await manager(t, registry, 'interconnect');
  before.playTrack(playable(track('radio')), { userKey: 'system:fallback', name: 'Radio' }, true);
  const restored = await manager(t, registry, 'interconnect', before.dataDir);
  restored.setFallbackPlaylist(null, [track('radio')], null, { start: false });
  await restored.resume();
  assert.equal(restored.current, null);
  restored.setFallbackPlaylist('selected', [track('radio')], 'Selected', { start: false });
  await restored.resume();
  assert.equal(restored.current.track.sourceId, 'radio');
  assert.equal(restored.current.requesterName, 'Selected（轮播）');
});

test('shuffle rotation plays sequentially without pure-random duplication, reshuffles on exhaust, and request takes priority', async t => {
  const registry = {
    resolvePlaylistTrack: async item => item,
    resolvePlayable: async item => playable(item)
  };
  const mgr = await manager(t, registry, 'chat');
  const tracks = [track('song-1'), track('song-2'), track('song-3')];
  mgr.setFallbackPlaylist('pl_test', tracks, 'TestPlaylist', { start: false });

  // 检查已生成洗牌牌堆，且包含了 3 首歌
  assert.equal(mgr.rotationDeck.length, 3);
  const queue1 = mgr.getRotationQueue(10);
  assert.equal(queue1.length, 3);
  const snapshot1 = mgr.getSnapshot();
  assert.equal(snapshot1.rotationQueue.length, 3);
  assert.equal(snapshot1.rotationDeckTotal, 3);
  assert.equal(snapshot1.rotationPoolTotal, 3);

  // 记录这三首歌被打乱后的顺序
  const expectedOrder = mgr.rotationDeck.map(x => x.sourceId);

  // 顺次播放第一首轮播曲
  await mgr.resume();
  assert.equal(mgr.current.track.sourceId, expectedOrder[0]);
  assert.equal(mgr.current.isFallback, true);
  assert.equal(mgr.rotationDeck.length, 2);

  // 此时用户点歌：当前为轮播且队列为空，立即切播用户点歌
  await mgr.enqueueTrack(track('user-req-1'), actor);
  assert.equal(mgr.current.track.sourceId, 'user-req-1');
  assert.equal(mgr.current.isFallback, false);
  // 轮播牌堆保持原进度，未被破坏
  assert.equal(mgr.rotationDeck.length, 2);

  // 用户再点第二首歌：当前正在播放点歌，加入排队队列
  await mgr.enqueueTrack(track('user-req-2'), actor);
  assert.equal(mgr.queue.length, 1);

  // 切歌或播完第一首点歌：播放排队的第二首点歌
  await mgr.advanceNext();
  assert.equal(mgr.current.track.sourceId, 'user-req-2');
  assert.equal(mgr.current.isFallback, false);
  assert.equal(mgr.queue.length, 0);
  assert.equal(mgr.rotationDeck.length, 2);

  // 点歌全部播完后，自然继续播放轮播的第二首
  await mgr.advanceNext();
  assert.equal(mgr.current.track.sourceId, expectedOrder[1]);
  assert.equal(mgr.current.isFallback, true);
  assert.equal(mgr.rotationDeck.length, 1);

  // 播放轮播的第三首
  await mgr.advanceNext();
  assert.equal(mgr.current.track.sourceId, expectedOrder[2]);
  assert.equal(mgr.current.isFallback, true);
  // 正在播本轮最后一首时，读取队列不会提前开始下一轮。
  assert.deepEqual(mgr.getSnapshot().rotationQueue, []);
  await mgr.advanceNext();
  assert.notEqual(mgr.current.track.sourceId, expectedOrder[2]);
  assert.equal(mgr.rotationDeck.length, 2);
});

test('removing rotation tracks preserves the playing track and remaining order through refresh and restart', async t => {
  const registry = { resolvePlaylistTrack: async item => item, resolvePlayable: async item => playable(item) };
  const mgr = await manager(t, registry);
  const tracks = ['a', 'b', 'c', 'd'].map((id, index) => ({
    ...track(id), sourcePlaylistId: index < 2 ? 'first' : 'second'
  }));
  mgr.setFallbackPlaylist('first,second', tracks, 'Both', { start: false });
  await mgr.resume();
  const playing = mgr.current;
  const timer = mgr._advanceTimer;
  const [head, middle, tail] = mgr.getRotationQueue();
  assert.equal(mgr.removeRotation({ entryId: middle.entryId }, actor).ok, true);
  assert.deepEqual(mgr.getRotationQueue(), [head, tail]);
  mgr.setFallbackPlaylist('first,second', tracks.map(item => ({ ...item })), 'Both', { start: false });
  assert.deepEqual(mgr.getRotationQueue(), [head, tail]);
  assert.equal(mgr.removeRotation({ entryId: head.entryId }, actor).ok, true);
  assert.equal(mgr.removeRotation({ entryId: tail.entryId }, actor).ok, true);
  assert.equal(mgr.current, playing);
  assert.equal(mgr._advanceTimer, timer);
  await mgr.prepareNext();
  assert.deepEqual(mgr.getSnapshot().rotationQueue, []);
  const restored = await manager(t, registry, 'chat', mgr.dataDir);
  restored.setFallbackPlaylist('first,second', tracks, 'Both', { start: false });
  await restored.restorePlayback();
  assert.deepEqual(restored.getSnapshot().rotationQueue, []);
  await restored.advanceNext();
  assert.equal(restored.fallbackTracks.length, 4);
  assert.equal(restored.rotationDeck.length, 3);
});

test('background preparation does not promote a later song after a temporary failure at the head', async t => {
  const mgr = await manager(t, rotationRegistry([]));
  const first = track('first');
  const second = track('second');
  const third = track('third');
  mgr.setFallbackPlaylist('selected', [first, second, third], 'Selected', { start: false });
  mgr.rotationDeck = [first, second, third];
  mgr.playTrack(playable(track('current')), actor, true);
  const calls = [];
  mgr.resolveRotationSource = async item => {
    calls.push(item.id);
    return calls.length === 1 ? { temporaryFailure: true } : { playable: playable(item) };
  };
  await mgr.prepareNext();
  assert.deepEqual(calls, [first.id]);
  assert.deepEqual(mgr.rotationDeck, [first, second, third]);
  assert.equal(mgr.getSnapshot().next, null);
  assert.equal(mgr.skip(actor, 1).skipped, true);
  await mgr.advancing.promise;
  assert.deepEqual(calls, [first.id, first.id]);
  assert.equal(mgr.current.track.id, first.id);
  assert.deepEqual(mgr.rotationDeck, [second, third]);
});

test('a confirmed missing track is passed over while a temporarily unavailable one stays in this round', async t => {
  const mgr = await manager(t, rotationRegistry([]));
  const unavailable = track('unavailable');
  const missing = track('missing');
  const ready = track('ready');
  const next = track('next');
  mgr.setFallbackPlaylist('selected', [unavailable, missing, ready, next], 'Selected', { start: false });
  mgr.rotationDeck = [unavailable, missing, ready, next];
  mgr.playTrack(playable(track('current')), actor, true);
  mgr.resolveRotationSource = async item => {
    if (item === unavailable) return { temporaryFailure: true };
    if (item === missing) return { temporaryFailure: false };
    return { playable: playable(item) };
  };
  await mgr.advanceNext();
  assert.equal(mgr.current.track.id, ready.id);
  assert.deepEqual(mgr.rotationDeck, [next, unavailable]);
});

test('deleting the head during a cut starts from the new head without consuming another entry', async t => {
  const mgr = await manager(t, rotationRegistry([]));
  mgr.setFallbackPlaylist('selected', [track('first'), track('second'), track('third')], 'Selected', { start: false });
  mgr.playTrack(playable(track('current')), actor, true);
  const [head, second, third] = mgr.getRotationQueue();
  let release;
  let started;
  const onHead = new Promise(resolve => { release = resolve; });
  const lookupStarted = new Promise(resolve => { started = resolve; });
  mgr.resolveRotationSource = async item => {
    if (item.id === head.id) {
      started();
      await onHead;
    }
    return { playable: playable(item) };
  };
  const switching = mgr.advanceNext();
  await lookupStarted;
  assert.equal(mgr.removeRotation({ entryId: head.entryId }, actor).ok, true);
  release();
  await switching;
  assert.equal(mgr.current.track.id, second.id);
  assert.deepEqual(mgr.getRotationQueue().map(item => item.entryId), [third.entryId]);
});

test('a request arriving during a rotation lookup takes priority without removing the rotation head', async t => {
  const mgr = await manager(t, rotationRegistry([]));
  mgr.musicRegistry.resolvePlayable = async item => playable(item);
  mgr.setFallbackPlaylist('selected', [track('rotation-next')], 'Selected', { start: false });
  await mgr.enqueueTrack(track('current-request'), actor);
  let release;
  let started;
  const lookupStarted = new Promise(resolve => { started = resolve; });
  mgr.resolveRotationSource = () => new Promise(resolve => { release = resolve; started(); });
  const switching = mgr.advanceNext();
  await lookupStarted;
  await mgr.enqueueTrack(track('next-request'), actor);
  release({ temporaryFailure: false });
  await switching;
  assert.equal(mgr.current.track.sourceId, 'next-request');
  assert.deepEqual(mgr.getRotationQueue().map(item => item.id), ['qq:rotation-next']);
});

test('unattended rotation plays the closest version before moving to the next song', async t => {
  const original = { ...recording('original'), sourcePlatform: 'applemusic', sourceTrackId: 'original' };
  const live = recording('live', { title: 'Morning (Live)' });
  const closest = recording('long-studio', { durationSec: 190 });
  const unrelated = recording('other', { title: 'Evening' });
  const differentArtist = recording('same-title', { artist: 'Another band' });
  const next = recording('following', { title: 'Next' });
  const mgr = await manager(t, rotationRegistry([live, closest, unrelated, differentArtist]));
  mgr.setFallbackPlaylist('selected', [original, next], 'Selected', { start: false });
  mgr.rotationDeck = [original, next];
  await mgr.advanceNext();
  assert.equal(mgr.current.track.id, closest.id);
  assert.deepEqual(mgr.current.track.rotationReplacement, { title: original.title, artist: original.artist });
  assert.equal(mgr.current.track.playbackSelection.mode, 'automatic-alternative');
  assert.equal(mgr.current.track.playbackSelection.original.platform, 'applemusic');
  assert.deepEqual(mgr.rotationDeck, [next]);
  const noEligible = await rotationRegistry([differentArtist, unrelated])
    .resolveRotationTrack(original, playable, { autoSelectAlternative: true });
  assert.equal(noEligible.playable, undefined);
});

test('unattended alternatives wait for a strict match and can rank results across providers', async () => {
  const original = { title: 'Morning', artist: 'Band', durationSec: 180, album: 'Debut' };
  const live = recording('live', { title: 'Morning (Live)' });
  const studio = { ...recording('studio', { durationSec: 191 }), id: 'netease:123', sourceId: '123', provider: 'netease' };
  const strict = { ...studio, durationSec: 180 };
  for (const item of [studio, strict]) {
    const registry = new MusicRegistry([
      { id: 'qq', async search() { return { tracks: [live] }; } },
      { id: 'netease', async search() { return { tracks: [item] }; } }
    ]);
    const found = await registry.resolveRotationTrack(original, playable, { autoSelectAlternative: true });
    assert.equal(found.playable.id, item.id);
    assert.equal(Boolean(found.playable.rotationReplacement), item === studio);
    assert.equal(found.playable.playbackSelection.mode, item === studio ? 'automatic-alternative' : 'same-version');
  }
});

test('removing a rotation entry invalidates its in-flight manual switch', async t => {
  const mgr = await manager(t, rotationRegistry([]));
  const planned = track('planned');
  mgr.setFallbackPlaylist('selected', [planned, track('following')], 'Selected', { start: false });
  mgr.playTrack(playable(track('current')), actor, true);
  let resolve;
  mgr.resolveRotationSource = () => new Promise(done => { resolve = done; });
  const target = mgr.getRotationQueue().find(item => item.id === planned.id);
  const pending = mgr.playRotationTrack(target.entryId, actor, 1);
  assert.equal(mgr.removeRotation({ entryId: target.entryId }, actor).ok, true);
  resolve({ playable: playable(planned) });
  assert.equal((await pending).code, 'PLAYBACK_CHANGED');
  assert.equal(mgr.current.track.sourceId, 'current');
});

test('playRotationTrack directly switches to chosen rotation track as fallback and removes it from deck', async t => {
  const registry = {
    resolvePlaylistTrack: async item => item,
    resolvePlayable: async item => playable(item)
  };
  const mgr = await manager(t, registry, 'chat');
  const tracks = [track('alpha'), track('beta'), track('gamma')];
  mgr.setFallbackPlaylist('pl_test', tracks, 'TestPlaylist', { start: false });

  // 初始启动轮播
  await mgr.resume();
  assert.equal(mgr.current.isFallback, true);
  const currentId = mgr.current.track.sourceId;

  // 挑一首不是当前正在播放的曲目进行直接播放
  const targetSourceId = tracks.map(x => x.sourceId).find(id => id !== currentId);
  const targetTrack = tracks.find(x => x.sourceId === targetSourceId);

  const res = await mgr.playRotationTrack(targetTrack, actor, 1);
  assert.equal(res.ok, true);
  // 直接替换当前这首歌，立即播放这首歌，且依然是轮播
  assert.equal(mgr.current.track.sourceId, targetSourceId);
  assert.equal(mgr.current.isFallback, true);
  assert.equal(mgr.current.requesterName, 'TestPlaylist（轮播）');
  // 该曲目已从牌堆中移除
  assert.ok(!mgr.rotationDeck.some(t => t.sourceId === targetSourceId));
});

test('normalizeMusicTrack robustly accepts QQ music tracks with missing provider or sourcePlatform alias', async () => {
  const { normalizeMusicTrack } = await import('../src/music/music-input.mjs');
  // 1. 没有 provider 但有 qq: id
  const t1 = normalizeMusicTrack({ id: 'qq:0039MnYb0qxYhV', title: '晴天', artist: '周杰伦' });
  assert.ok(t1);
  assert.equal(t1.id, 'qq:0039MnYb0qxYhV');
  assert.equal(t1.provider, 'qq');
  assert.equal(t1.sourceId, '0039MnYb0qxYhV');

  // 2. sourcePlatform 为 qqmusic，带 sourceTrackId
  const t2 = normalizeMusicTrack({ sourcePlatform: 'qqmusic', sourceTrackId: '0039MnYb0qxYhV', title: '晴天', artist: '周杰伦' });
  assert.ok(t2);
  assert.equal(t2.id, 'qq:0039MnYb0qxYhV');
  assert.equal(t2.provider, 'qq');

  assert.equal(normalizeMusicTrack({ id: 'netease:123456', title: 'Other' }).provider, 'netease');
  assert.equal(normalizeMusicTrack({ id: 'netease:invalid', title: 'Other' }), null);
  assert.equal(normalizeMusicTrack({ id: 'youtube:123456', title: 'Other' }), null);
});


function rotationRegistry(results, unavailable = new Set(), findSongs = async () => ({ tracks: results })) {
  const registry = new MusicRegistry([{ id: 'qq', search: findSongs }]);
  registry.resolvePlayable = async item => unavailable.has(item.sourceId) ? null : playable(item);
  return registry;
}

const recording = (id, attributes = {}) => ({
  ...track(id), title: 'Morning', artist: 'Band', album: 'Debut', ...attributes
});

test('rotation tries another matching recording after the original and first match lose their sources', async t => {
  const firstMatch = recording('match1');
  const secondMatch = recording('match2');
  const live = recording('live', { title: 'Morning (Live)' });
  const registry = rotationRegistry([live, firstMatch, secondMatch], new Set(['original', 'match1']));
  const mgr = await manager(t, registry);
  const original = recording('original');
  const unrelated = recording('unrelated', { title: 'Afternoon' });
  mgr.setFallbackPlaylist('test', [original, unrelated], 'Test', { start: false });
  const item = mgr.getRotationQueue().find(entry => entry.id === original.id);

  const result = await mgr.playRotationTrack(item.entryId, actor, 1, { allowAlternatives: true });
  assert.equal(result.ok, true);
  assert.equal(mgr.current.track.id, secondMatch.id);
  assert.equal(mgr.current.track.rotationReplacement, undefined);
  assert.deepEqual(mgr.rotationDeck, [unrelated]);
});

test('alternative offers are private, require explicit confirmation and consume the exact external playlist entry', async t => {
  const original = { ...recording('123'), provider: 'netease', sourcePlatform: 'netease', id: 'ext:123' };
  const other = recording('123', { title: 'Afternoon' });
  const live = recording('live', { title: 'Morning (Live)' });
  const cover = recording('cover', { artist: 'Another band' });
  const unrelated = recording('unrelated', { title: 'Evening', artist: 'Other band' });
  const noStream = recording('nostream', { title: 'Morning (Acoustic)' });
  const registry = rotationRegistry([noStream, live, cover, unrelated, other], new Set(['nostream']));
  const mgr = await manager(t, registry);
  mgr.setFallbackPlaylist('test', [original, other], 'Test', { start: false });
  mgr.playTrack(playable(track('current')), actor, true);
  const existingPlay = mgr.current;
  const existingTimer = mgr._advanceTimer;
  const [item, otherItem] = ['Morning', 'Afternoon'].map(title => mgr.getRotationQueue().find(row => row.title === title));
  assert.notEqual(item.entryId, otherItem.entryId);
  const connection = {};
  const context = { owner: connection, allowAlternatives: true, hasExpectedPlay: true, playUid: existingPlay.uid };

  const result = await mgr.playRotationTrack(item.entryId, actor, 1, context);
  assert.equal(result.code, 'ALTERNATIVES');
  assert.equal(mgr.current, existingPlay);
  assert.equal(mgr._advanceTimer, existingTimer);
  assert.equal(mgr.rotationDeck.length, 2);
  assert.deepEqual(result.offer.choices.map(option => [option.track.id, option.relation]), [
    [live.id, 'same_artist_version'], [cover.id, 'same_title'], [other.id, 'same_artist_other']
  ]);
  assert.ok(result.offer.choices.every(option => !option.track.streamUrl));
  const confirm = { ...context, offerId: result.offer.token, choiceId: live.id };
  assert.equal((await mgr.playRotationTrack(undefined, actor, 1, { ...confirm, owner: {} })).code, 'OFFER_EXPIRED');
  assert.equal((await mgr.playRotationTrack(undefined, actor, 1, { ...confirm, choiceId: 'qq:forged' })).code, 'OFFER_EXPIRED');
  assert.equal((await mgr.playRotationTrack(undefined, actor, 1, confirm)).ok, true);
  assert.equal(mgr.current.track.id, live.id);
  assert.deepEqual(mgr.current.track.rotationReplacement, { title: original.title, artist: original.artist });
  assert.equal(mgr.rotationLogs.at(-1).track.id, live.id);
  assert.deepEqual(mgr.rotationDeck, [other]);
  assert.equal((await mgr.playRotationTrack(undefined, actor, 1, confirm)).code, 'PLAYBACK_CHANGED');
});

test('an unavailable manual cut preserves playback and automatic rotation skips the missing original', async t => {
  const missing = recording('missing');
  const next = recording('next', { title: 'Next' });
  const mgr = await manager(t, rotationRegistry([], new Set(['missing'])));
  mgr.setFallbackPlaylist('test', [missing, next], 'Test', { start: false });
  mgr.rotationDeck = [missing, next];
  mgr.playTrack(playable(track('playing')), actor, true);
  const timer = mgr._advanceTimer;
  const result = await mgr.playRotationTrack(mgr.getRotationQueue()[0].entryId, actor, 1);
  assert.equal(result.code, 'NO_SOURCE');
  assert.equal(mgr._advanceTimer, timer);
  assert.equal(mgr.current.track.sourceId, 'playing');
  await mgr.advanceNext();
  assert.equal(mgr.current.track.sourceId, 'next');
});

test('a delayed rotation lookup cannot overwrite new playback or cross a room change', async t => {
  let release;
  let active = true;
  const initial = recording('target');
  const registry = rotationRegistry([]);
  registry.resolvePlayable = async item => item.id === initial.id
    ? new Promise(resolve => { release = () => resolve(playable(item)); })
    : playable(item);
  const mgr = await manager(t, registry);
  mgr.setFallbackPlaylist('test', [initial], 'Test', { start: false });
  const [item] = mgr.getRotationQueue();
  const pending = mgr.playRotationTrack(item.entryId, actor, 1, { active: () => active });
  assert.equal((await mgr.playRotationTrack(item.entryId, actor, 1)).code, 'BUSY');
  active = false;
  await mgr.enqueueTrack(track('pointed'), actor);
  release();
  registry.resolvePlayable = async item => playable(item);
  assert.equal((await pending).code, 'PLAYBACK_CHANGED');
  assert.equal(mgr.current.track.sourceId, 'pointed');
  mgr.setFallbackPlaylist('test', [{ ...initial }], 'Test', { start: false });
  assert.equal(mgr.getRotationQueue()[0].entryId, item.entryId);
  mgr.setFallbackPlaylist(null, [], '', { start: false });
  assert.equal((await mgr.playRotationTrack(item.entryId, actor, 1)).code, 'ROTATION_CHANGED');
});

test('temporary supplier failures are distinct from missing sources and can be retried', async t => {
  let broken = true;
  const original = recording('original');
  const registry = rotationRegistry([], new Set(), async () => { throw new Error('temporary search failure'); });
  registry.resolvePlayable = async item => {
    if (broken) throw new Error('temporary source failure');
    return playable(item);
  };
  const mgr = await manager(t, registry);
  mgr.setFallbackPlaylist('test', [original], 'Test', { start: false });
  const [item] = mgr.getRotationQueue();
  assert.equal((await mgr.playRotationTrack(item.entryId, actor, 1)).code, 'SOURCE_TEMPORARY');
  broken = false;
  assert.equal((await mgr.playRotationTrack(item.entryId, actor, 1)).ok, true);
});


test('all point requests share private alternatives and enqueue only the confirmed recording', async t => {
  const original = { title: 'Morning', artist: 'Band', sourcePlatform: 'netease', sourceTrackId: 'original' };
  const cover = recording('cover', { title: 'Morning (Live)' });
  const mgr = await manager(t, rotationRegistry([cover]));
  const listener = { ...actor, userKey: 'another' };
  const owner = {};
  const other = {};
  const active = () => true;
  await mgr.enqueueTrack(recording('current', { title: 'An earlier request' }), listener);
  const existing = mgr.current;
  const proposed = await mgr.enqueueWithAlternatives(original, actor, { owner, active });
  assert.equal(proposed.code, 'ALTERNATIVES');
  assert.deepEqual(proposed.offer.choices.map(option => option.track.id), [cover.id]);
  assert.equal(mgr.queue.length, 0);
  assert.equal(mgr.current, existing);
  const confirmation = { owner, active, offerId: proposed.offer.token, choiceId: cover.id };
  assert.equal((await mgr.enqueueWithAlternatives(null, actor, { ...confirmation, owner: other })).code, 'OFFER_EXPIRED');
  assert.equal((await mgr.enqueueWithAlternatives(null, actor, { ...confirmation, active: () => false })).code, 'ROOM_CHANGED');
  const accepted = await mgr.enqueueWithAlternatives(null, actor, confirmation);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.position, 1);
  assert.equal(mgr.queue[0].track.id, cover.id);
  assert.equal(mgr.queue[0].track.rotationReplacement.title, original.title);
  assert.equal((await mgr.enqueueWithAlternatives(null, actor, confirmation)).code, 'OFFER_EXPIRED');
  assert.equal(mgr.queue.length, 1);
});

test('pointing at a native catalog song with a broken source offers alternatives too', async t => {
  const original = recording('original');
  const alternate = recording('alternate', { title: 'Morning (Acoustic)' });
  const mgr = await manager(t, rotationRegistry([alternate], new Set(['original'])));
  const owner = {};
  const active = () => true;
  const reply = await mgr.enqueueWithAlternatives(original, actor, { owner, active });
  assert.equal(reply.code, 'ALTERNATIVES');
  assert.equal(mgr.current, null);
  const accepted = await mgr.enqueueWithAlternatives(null, actor, {
    owner, active, offerId: reply.offer.token, choiceId: alternate.id
  });
  assert.equal(accepted.playImmediately, true);
  assert.equal(mgr.current.track.id, alternate.id);
});


test('cross-platform matching normalizes title punctuation and credits and tolerates different or missing albums', async () => {
  const original = { title: '“Ｍorning” （Ｆｅａｔ．Ｂ）', artist: 'A', album: 'Original', durationSec: 180 };
  const compilation = recording('collection', {
    title: 'Morning', artist: 'B / A', artistNames: ['B', 'A'], album: 'Collection', durationSec: 185
  });
  const noAlbum = { ...compilation, album: undefined, artistNames: undefined, artist: 'B，A' };
  for (const found of [compilation, noAlbum]) {
    const queries = [];
    const registry = rotationRegistry([found], new Set(), async query => {
      queries.push(query);
      return { tracks: [found] };
    });
    const result = await registry.resolveRotationTrack(original, playable, { alternatives: true });
    assert.equal(result.playable?.id, found.id);
    assert.deepEqual(queries, ['Morning A B']);
  }
});

test('equivalent version labels match regardless of punctuation and feature credit placement', async () => {
  const original = { title: 'Morning（Live） feat. B', artist: 'A', durationSec: 180 };
  const alternate = recording('live', { title: 'Morning – Live Version', artist: 'B、A' });
  const result = await rotationRegistry([alternate]).resolveRotationTrack(original, playable, { alternatives: true });
  assert.equal(result.playable?.id, alternate.id);
});

test('a missing remaster label does not block the clear original-lyrics recording', async () => {
  const artist = "Guns N' Roses";
  const original = { title: "Don't Cry (Original) [2022 Remaster]", artist, album: 'Use Your Illusion I', durationSec: 284 };
  const exact = recording('qq44', { title: "Don't Cry (Original)", artist, album: 'Use Your Illusion (Super Deluxe) [Explicit]', durationSec: 284 });
  const albumRelease = recording('qq45', { ...exact, id: 'qq:qq45', sourceId: 'qq45',
    title: "Don't Cry (Original Version)", album: 'Use Your Illusion I (Explicit)', durationSec: 283 });
  const candidates = [
    { ...exact, id: 'qq:long', durationSec: 292 },
    { ...exact, id: 'qq:otherlyrics', title: "Don't Cry (Alternate Lyrics|2022 Remaster)", durationSec: 284 },
    { ...exact, id: 'qq:live', album: 'Live at the Ritz' },
    exact, albumRelease
  ];
  for (const options of [{ alternatives: true }, { alternatives: true, random: true }, {}]) {
    const result = await rotationRegistry(candidates).resolveRotationTrack(original, playable, options);
    assert.equal(result.playable?.id, exact.id);
  }
  const wrongLyricsOnly = await rotationRegistry([candidates[1]]).resolveRotationTrack(original, playable, { alternatives: true });
  assert.equal(wrongLyricsOnly.playable, undefined);
  assert.equal(wrongLyricsOnly.alternatives[0].track.id, 'qq:otherlyrics');
});

test('same-album metadata tolerates a small duration difference for a studio recording', async () => {
  const original = { title: 'Morning', artist: 'Band', album: 'Debut', durationSec: 180 };
  const alternate = recording('alternate', { album: 'Debut (Deluxe Edition)', durationSec: 186 });
  assert.equal((await rotationRegistry([alternate]).resolveRotationTrack(original, playable)).playable?.id, alternate.id);
});

test('missing data, different recordings and versions still need confirmation', async t => {
  const original = { title: 'Morning', artist: 'Band', album: 'Debut', durationSec: 180 };
  const scenarios = [
    ['too far apart even on the same album', {}, { durationSec: 188 }],
    ['no album support for six seconds of difference', {}, { durationSec: 186, album: 'Collection' }],
    ['missing duration even with matched album', {}, { durationSec: 0 }],
    ['live recording', {}, { title: 'Morning — Live' }],
    ['re-recording', {}, { title: 'Morning (Re-recorded)' }],
    ['different ISRCs', { isrc: 'AAABC2300011' }, { isrc: 'AAABC2300022' }],
    ['same ISRC but conflicting versions', { isrc: 'AAABC2300011' }, { isrc: 'AAABC2300011', title: 'Morning (Live)' }],
    ['solo vs a duet', {}, { artist: 'Band / Partner' }]
  ];
  for (const [name, source, match] of scenarios) {
    await t.test(name, async () => {
      const alternate = recording('alternate', match);
      const registry = rotationRegistry([alternate]);
      const result = await registry.resolveRotationTrack({ ...original, ...source }, playable, { alternatives: true });
      assert.equal(result.playable, undefined);
      assert.equal(result.alternatives[0].track.id, alternate.id);
    });
  }
});

test('an unambiguous ISRC allows a missing duration while the search still checks available audio', async () => {
  const isrc = 'AAABC2300011';
  const original = { title: 'Morning', artist: 'Band', isrc };
  const alternate = recording('alt', { isrc: 'AA-ABC-23-00011', durationSec: 0, album: undefined });
  const result = await rotationRegistry([alternate]).resolveRotationTrack(original, playable, { alternatives: true });
  assert.equal(result.playable?.id, alternate.id);
});

test('ambiguous close recordings wait for confirmation and the original album ranks first', async () => {
  const original = { title: 'Morning', artist: 'Band', album: 'Debut', durationSec: 180 };
  const collection = recording('collection', { album: 'Collection' });
  const sameAlbum = recording('debut', { durationSec: 184 });
  const registry = rotationRegistry([], new Set(), async query => ({
    tracks: query.includes('Band') ? [collection, sameAlbum] : [sameAlbum]
  }));
  const result = await registry.resolveRotationTrack(original, playable, { alternatives: true });
  assert.equal(result.playable, undefined);
  assert.deepEqual(result.alternatives.map(option => option.track.id), [sameAlbum.id, collection.id]);
  const automatic = await rotationRegistry([collection, sameAlbum]).resolveRotationTrack(original, playable);
  assert.equal(automatic.playable, undefined);
  const random = await rotationRegistry([collection, sameAlbum]).resolveRotationTrack(original, playable, { alternatives: true, random: true });
  assert.equal(random.playable, undefined);
});


test('random requests use the best available recording of the same version and skip Live', async t => {
  const original = { title: 'Morning', artist: 'Band', durationSec: 180, album: 'Debut', sourcePlatform: 'netease', sourceTrackId: 'original' };
  const collection = recording('collection', { album: 'Collection' });
  const studio = recording('studio');
  const live = recording('live', { title: 'Morning (Live)' });
  const mgr = await manager(t, rotationRegistry([collection, live, studio]));
  const result = await mgr.enqueueRandom([original], actor, () => true);
  assert.equal(result.ok, true);
  assert.equal(result.track.id, studio.id);
  assert.equal(result.offer, undefined);
  assert.equal(mgr.historyLogs.length, 1);

  const noStudio = await manager(t, rotationRegistry([live]));
  assert.equal((await noStudio.enqueueRandom([original], actor, () => true)).code, 'NO_SOURCE');
  assert.equal(noStudio.current, null);
  const originalLive = { ...original, title: 'Morning (Live)' };
  assert.equal((await noStudio.enqueueRandom([originalLive], actor, () => true)).track.id, live.id);
});

test('random requests draw again within the playlist and ignore unrelated substitutes', async t => {
  t.mock.method(Math, 'random', () => 0);
  const original = { title: 'Missing', artist: 'Band', sourcePlatform: 'netease', sourceTrackId: 'original' };
  const unrelated = recording('other', { title: 'Night' });
  const next = recording('next', { title: 'Day' });
  const mgr = await manager(t, rotationRegistry([unrelated]));
  const result = await mgr.enqueueRandom([original, next], actor, () => true);
  assert.equal(result.track.id, next.id);
  assert.equal(mgr.historyLogs.length, 1);
  assert.equal((await mgr.enqueueRandom([next, original], actor, () => true)).code, 'NO_SOURCE');
  assert.equal((await mgr.enqueueRandom([unrelated], actor, () => false)).code, 'ROOM_CHANGED');
});


const dazbeeCredit = { id: 'mid:dazbee', name: 'Dazbee', alias: 'ダズビー' };
const heroine = (id, attributes = {}) => recording(id, {
  title: 'ヒロイン', artist: 'Dazbee', artistNames: ['Dazbee'], durationSec: 297,
  artistCredits: [dazbeeCredit], ...attributes
});
const importedHeroine = { title: 'ヒロイン', artist: 'ダズビー', durationSec: 297 };

test('verified QQ artist aliases match across languages in requests and unattended rotation', async () => {
  const correct = heroine('dazbeetrack');
  const differentSinger = heroine('anothertrack', {
    artist: 'back number', artistNames: ['back number'], artistCredits: [{ id: 'mid:backnumber', name: 'back number' }]
  });
  const registry = rotationRegistry([differentSinger, correct]);
  assert.equal((await registry.resolveRotationTrack(importedHeroine, playable, { alternatives: true })).playable?.id, correct.id);
  assert.equal((await registry.resolveRotationTrack(importedHeroine, playable)).playable?.id, correct.id);
});

test('an alias on another QQ recording may identify the same credited artist ID', async () => {
  const other = heroine('knowncredit', { title: 'Other song' });
  const matching = heroine('target', { artistCredits: [{ id: dazbeeCredit.id, name: dazbeeCredit.name }] });
  assert.equal((await rotationRegistry([other, matching]).resolveRotationTrack(importedHeroine, playable)).playable?.id, matching.id);
});

test('aliases preserve complete collaboration rosters and version distinctions', async () => {
  const guest = { id: 'mid:guest', name: 'Guest', alias: '客演' };
  const duet = heroine('duet', { artist: 'Dazbee / Guest', artistNames: ['Dazbee', 'Guest'], artistCredits: [dazbeeCredit, guest] });
  const registry = rotationRegistry([duet]);
  assert.equal((await registry.resolveRotationTrack({ ...importedHeroine, artist: '客演 / ダズビー' }, playable)).playable?.id, duet.id);
  assert.equal((await registry.resolveRotationTrack(importedHeroine, playable, { alternatives: true })).playable, undefined);
  const live = heroine('livealias', { title: 'ヒロイン (Live)' });
  const offered = await rotationRegistry([live]).resolveRotationTrack(importedHeroine, playable, { alternatives: true });
  assert.equal(offered.playable, undefined);
  assert.equal(offered.alternatives[0].relation, 'same_artist_version');
});

test('ambiguous and unverified QQ names stay in the manual choice flow', async () => {
  const verified = heroine('known');
  const conflicting = heroine('conflict', {
    title: 'Another song', artist: 'Someone else', artistNames: ['Someone else'],
    artistCredits: [{ id: 'mid:someoneelse', name: 'Someone else', alias: 'ダズビー' }]
  });
  const disputed = await rotationRegistry([verified, conflicting]).resolveRotationTrack(importedHeroine, playable, { alternatives: true });
  assert.equal(disputed.playable, undefined);
  assert.equal(disputed.alternatives[0].relation, 'same_title');
  const unchecked = heroine('unverified', { artistCredits: [{ name: 'Dazbee', alias: 'ダズビー' }] });
  const lookup = await rotationRegistry([unchecked]).resolveRotationTrack(importedHeroine, playable, { alternatives: true });
  assert.equal(lookup.playable, undefined);
  assert.equal(lookup.alternatives[0].relation, 'same_title');
  const stored = await rotationRegistry([]).resolveRotationTrack({ ...importedHeroine, matchedTrack: verified }, playable, { alternatives: true });
  assert.equal(stored.playable, undefined);
});


test('a verified match avoids further searches and an unavailable cached source is replaced', async () => {
  const original = { title: 'Morning', artist: 'Band', album: 'Debut', durationSec: 180, sourcePlatform: 'applemusic', sourceTrackId: 'stable1' };
  const first = recording('first');
  const second = recording('second');
  const searches = [];
  let current = first;
  const registry = rotationRegistry([], new Set(), async query => {
    searches.push(query);
    return { tracks: [current] };
  });
  const resolve = async candidate => candidate.id === current.id ? playable(candidate) : null;
  assert.equal((await registry.resolveRotationTrack(original, resolve, { alternatives: true })).playable?.id, first.id);
  assert.equal((await registry.resolveRotationTrack({ ...original }, resolve, { alternatives: true })).playable?.id, first.id);
  assert.deepEqual(searches, ['Morning Band']);
  current = second;
  assert.equal((await registry.resolveRotationTrack(original, resolve, { alternatives: true })).playable?.id, second.id);
  assert.deepEqual(searches, ['Morning Band', 'Morning Band']);
});

test('manual version choice survives a new manager and stays private to the chooser', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'music-preference-'));
  const db = new ChatDatabase(join(dir,'chat.sqlite'));
  const original = { title: 'Morning', artist: 'Band', durationSec: 180, sourcePlatform: 'applemusic', sourceTrackId: 'stable1' };
  const live = recording('live', { title: 'Morning (Live)' });
  let queries = 0;
  let sourceWorks = true;
  const registry = rotationRegistry([], new Set(), async () => { queries++; return { tracks: [live] }; });
  registry.resolvePlayable = async item => sourceWorks ? playable(item) : null;
  const first = await manager(t, registry, 'chat', dir, db);
  const owner = {};
  const active = () => true;
  const firstResult = await first.enqueueWithAlternatives(original, actor, { owner, active });
  assert.equal(firstResult.code, 'ALTERNATIVES');
  const manual = await first.enqueueWithAlternatives(null, actor, { owner, active, offerId: firstResult.offer.token, choiceId: live.id });
  assert.equal(manual.ok, true);
  assert.equal(manual.track.playbackSelection.mode, 'manual-choice');
  const key = first.preferredTrackKey(original, actor.userKey);
  const preference = db.getKv(key);
  assert.equal(preference.id, live.id);
  assert.equal(preference.streamUrl, undefined);

  const later = await manager(t, registry, 'interconnect', dir, db);
  const previousQueries = queries;
  const repeat = await later.enqueueWithAlternatives(original, actor, { owner: {}, active });
  assert.equal(repeat.track.id, live.id);
  assert.equal(repeat.track.rotationReplacement.title, original.title);
  assert.equal(repeat.track.playbackSelection.mode, 'saved-choice');
  assert.equal(queries, previousQueries);
  const other = await later.enqueueWithAlternatives(original, { ...actor, userKey:'another' }, { owner: {}, active });
  assert.equal(other.code, 'ALTERNATIVES');

  sourceWorks = false;
  const freshRequest = await later.enqueueWithAlternatives(original, actor, { owner: {}, active });
  assert.equal(freshRequest.code, 'NO_SOURCE');
  assert.ok(queries > previousQueries);
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
});

test('explicitly live album metadata keeps plain-title audio out of studio auto-match', async () => {
  const original = { title: 'Morning', artist: 'Band', durationSec: 180, album: 'Debut' };
  const mislabeledByTitle = recording('albumlive', { album: 'Live at the Arena' });
  const registry = rotationRegistry([mislabeledByTitle]);
  const result = await registry.resolveRotationTrack(original, playable, { alternatives: true });
  assert.equal(result.playable, undefined);
  assert.equal(result.alternatives[0].track.id, mislabeledByTitle.id);
});

test('dead rotation tail gives a playable song another turn', async t => {
  const mgr = await manager(t, rotationRegistry([]));
  const good = track('good'), bad = track('bad');
  mgr.setFallbackPlaylist('p', [good, bad], 'p', { start: false });
  mgr.rotationDeck = [good, bad];
  mgr.resolveRotationSource = async item => item === good ? { playable: playable(item) } : {};
  await mgr.advanceNext();
  const first = mgr.current.uid;
  await mgr.advanceNext();
  assert.equal(mgr.current.track.id, good.id);
  assert.notEqual(mgr.current.uid, first);
});

test('a supplier outage keeps accepted requests in order across restart', async t => {
  let available = true;
  const registry = { async resolvePlayable(item) {
    if (!available) throw new Error('temporary upstream failure');
    return playable(item);
  } };
  const mgr = await manager(t, registry);
  for (const id of ['current', 'first', 'second']) await mgr.enqueueTrack(track(id), actor);
  available = false;
  mgr.preparedQueue = null;
  await mgr.advanceNext();
  assert.equal(mgr.current.track.sourceId, 'current');
  mgr.current.startedAt = Date.now() - (mgr.current.durationSec + 1) * 1000;
  await mgr.advanceNext();
  assert.equal(mgr.current, null);
  assert.deepEqual(mgr.queue.map(item => item.track.sourceId), ['first', 'second']);
  assert.ok(mgr.queue.every(item => item.sourceRetryAt > Date.now()));
  assert.deepEqual(mgr.historyLogs.map(item => item.outcome), ['played', 'queued', 'queued']);
  const restored = await manager(t, registry, 'chat', mgr.dataDir);
  available = true;
  for (const item of restored.queue) item.sourceRetryAt = 0;
  await restored.restorePlayback();
  assert.equal(restored.current.track.sourceId, 'first');
  assert.deepEqual(restored.queue.map(item => item.track.sourceId), ['second']);
});

test('late startup restoration cannot replace an accepted request', async t => {
  const mgr = await manager(t, {});
  let release;
  mgr.savedState = { current: { uid: 'old', track: track('old'), startedAt: Date.now(), durationSec: 180 } };
  mgr.resolve = () => new Promise(resolve => { release = resolve; });
  const pending = mgr.restorePlayback();
  await mgr.enqueueTrack(track('new'), actor, playable(track('new')));
  release(playable(track('old')));
  await pending;
  assert.equal(mgr.current.track.sourceId, 'new');
});

test('queued cut rechecks room and permissions after slow resolution', async t => {
  const mgr = await manager(t, { resolvePlayable: async item => playable(item) });
  await mgr.enqueueTrack(track('first'), actor);
  await mgr.enqueueTrack(track('second'), actor);
  const guest = { userKey: 'guest:listener', name: 'other' };
  for (const active of [true, false]) {
    mgr.preparedQueue = null;
    let release;
    mgr.resolve = () => new Promise(resolve => { release = resolve; });
    const pending = mgr.playQueued(mgr.queue[0].uid, guest, 2, mgr.current.uid, {
      active: () => active, getAudience: () => active ? 3 : 2
    });
    await new Promise(resolve => setImmediate(resolve));
    release(playable(track('second')));
    assert.equal((await pending).ok, false);
    assert.equal(mgr.current.track.sourceId, 'first');
    assert.equal(mgr.queue.length, 1);
  }
});

test('playlist requests use recording identity after filtering and reordering', () => {
  const first = track('first'), second = track('second');
  assert.equal(findPlaylistRequestTrack([first, second], { ...second, position: 1 }), second);
  const rows = [first, second].map((item, idx) => ({ ...item, position: idx + 1 }));
  assert.equal(findPlaylistRequestTrack(rows, { ...second, position: 1 }), rows[1]);
  assert.equal(findPlaylistRequestTrack(rows, { ...track('gone'), position: 1 }), null);
});

test('manual search keeps the fallback catalog for subsequent pages', async () => {
  const calls = [];
  const reg = new MusicRegistry([{ id: 'qq', async search() { calls.push('qq'); throw new Error('outage'); } },
    { id: 'netease', async search(_q, _limit, page) { calls.push(page); return { tracks: [track(String(page))], hasMore: true }; } }]);
  assert.equal((await reg.search('song', 10)).tracks[0].sourceId, '1');
  assert.equal((await reg.search('song', 10, undefined, 2)).tracks[0].sourceId, '2');
  assert.deepEqual(calls, ['qq', 1, 2]);
  assert.equal(await reg.isCached({ streamUrl: 'https://example.test/old' }, 'fixture'), false);
});

test('temporary request failures leave room rotation playable and resume at next cut', async t => {
  const mgr = await manager(t, { resolvePlayable: async item => playable(item) });
  await mgr.enqueueTrack(track('current'), actor);
  await mgr.enqueueTrack(track('queued'), actor);
  mgr.setFallbackPlaylist('p', [track('radio')], 'p', { start: false });
  mgr.preparedQueue = null;
  mgr.musicRegistry.resolvePlayable = async () => { throw new Error('temporary outage'); };
  mgr.resolveRotationSource = async item => ({ playable: playable(item) });
  await mgr.advanceNext();
  assert.equal(mgr.current.track.sourceId, 'radio');
  assert.equal(mgr.queue[0].track.sourceId, 'queued');
  mgr.queue[0].sourceRetryAt = 0;
  mgr.musicRegistry.resolvePlayable = async item => playable(item);
  await mgr.advanceNext();
  assert.equal(mgr.current.track.sourceId, 'queued');
  assert.equal(mgr.queue.length, 0);
});

test('optimistic enqueue accepts songs into queue during temporary upstream resolution failure while playing', async t => {
  const mgr = await manager(t, { resolvePlayable: async item => playable(item) });
  await mgr.enqueueTrack(track('current'), actor);
  assert.equal(mgr.current.track.sourceId, 'current');

  // Next point request encounters a temporary upstream outage
  mgr.resolveRotationSource = async () => ({ temporaryFailure: true, error: 'upstream timeout' });
  const requested = { id: 'qq:pending_song', title: 'Pending Song', artist: 'Artist' };
  const res = await mgr.enqueueWithAlternatives(requested, actor, { owner: {}, active: () => true });
  assert.equal(res.ok, true);
  assert.equal(res.position, 1);
  assert.equal(mgr.queue[0].track.title, 'Pending Song');
});

test('shuffleRotation succeeds gracefully without error when rotation deck has fewer than two tracks', async t => {
  const mgr = await manager(t, { resolvePlayable: async item => playable(item) });
  mgr.rotationDeck = [track('only_one')];
  const res = mgr.shuffleRotation(actor);
  assert.equal(res.ok, true);
});

test('admin can re-enqueue tracks and is not blocked by duplicate restrictions', async t => {
  const mgr = await manager(t, { resolvePlayable: async item => playable(item) });
  const adminActor = { ...actor, isAdmin: true };
  const song = track('repeat');
  await mgr.enqueueTrack(song, adminActor);
  assert.equal(mgr.current.track.sourceId, 'repeat');

  const second = await mgr.enqueueTrack(song, adminActor);
  assert.equal(second.ok, true);
  assert.equal(second.position, 1);
});

test('manual search fallback keeps a different recording out of the room', async t => {
  const original = recording('original');
  const other = recording('cover', { artist: 'Different artist' });
  const mgr = await manager(t, rotationRegistry([other], new Set(['original'])));
  const result = await mgr.enqueueWithAlternatives(original, actor, {
    owner: {}, active: () => true, searchFallback: true
  });
  assert.equal(result.code, 'NO_SOURCE');
  assert.equal(result.offer, undefined);
  assert.equal(mgr.current, null);
  assert.equal(mgr.queue.length, 0);
});

test('imported bilingual titles resolve using verified artist profiles, including a transient source retry', async () => {
  const id = 'mid:artist';
  const source = { title: '春の風 - Spring Wind', artist: 'Mira', durationSec: 212 };
  const correct = recording('studio', { title: '春の風', artist: '美良', durationSec: 212,
    artistCredits: [{ id, name: '美良' }] });
  const cover = { ...correct, id: 'qq:cover', sourceId: 'cover', artist: '別人',
    artistCredits: [{ id: 'mid:other', name: '別人' }] };
  const provider = { id: 'qq', search: async () => ({ tracks: [cover, correct] }),
    getArtistAliases: async key => key === id ? ['Mira'] : [] };
  const registry = new MusicRegistry([provider]);
  let calls = 0;
  const found = await registry.resolveRotationTrack(source, async track => {
    assert.equal(track.id, correct.id);
    if (++calls === 1) throw new Error('temporary supplier failure');
    return playable(track);
  }, { alternatives: true, exactOnly: true });
  assert.equal(found.playable.id, correct.id);
  assert.equal(calls, 2);
  provider.getArtistAliases = async () => ['Mira'];
  assert.equal((await registry.resolveRotationTrack(source, playable, { alternatives: true, exactOnly: true })).playable, undefined);
});

test('a QQ artist profile only contributes explicitly labelled aliases and is shared between callers', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('<item><key><![CDATA[外文名]]></key><value><![CDATA[Mira、ミラ]]></value></item><item><key><![CDATA[简介]]></key><value><![CDATA[Other Singer]]></value></item>');
  });
  const provider = new QQMusicProvider();
  const [names] = await Promise.all([provider.getArtistAliases('mid:artist'), provider.getArtistAliases('mid:artist')]);
  assert.deepEqual(names, ['Mira', 'ミラ']);
  assert.deepEqual(await provider.getArtistAliases('mid:artist'), names);
  assert.equal(calls, 1);
});

test('manual playlist fallback selects the matching Kugou recording after QQ misses', async t => {
  const hash = 'F'.repeat(32);
  const original = recording('original');
  const candidate = { ...original, id: 'kugou:' + hash, provider: 'kugou', sourceId: hash };
  const registry = new MusicRegistry([
    { id: 'qq', search: async () => ({ tracks: [] }), resolveStream: async () => null },
    { id: 'kugou', search: async () => ({ tracks: [candidate] }), resolveStream: async () =>
      ({ url: 'https://sharefs.kugou.com/music.mp3', mimeType: 'audio/mpeg', providerChannel: 'kugou' }) }
  ]);
  const mgr = await manager(t, registry);
  const result = await mgr.enqueueWithAlternatives(original, actor, { owner: {}, active: () => true, searchFallback: true });
  assert.equal(result.ok, true);
  assert.equal(mgr.current.track.id, candidate.id);
});

test('Kugou returns playable audio only for the requested file hash', async t => {
  const hash = 'A'.repeat(32);
  let returnedHash = 'B'.repeat(32);
  let probes = 0;
  t.mock.method(globalThis, 'fetch', async (value, options) => {
    const url = new URL(value);
    if (url.hostname === 'm.kugou.com') {
      assert.equal(url.searchParams.get('hash'), hash);
      return Response.json({ status: 1, hash: returnedHash, timeLength: 202, url: 'https://sharefs.kugou.com/file.mp3' });
    }
    assert.equal(url.hostname, 'sharefs.kugou.com');
    assert.equal(options.headers.Range, 'bytes=0-4095');
    probes++;
    return new Response(Buffer.from('ID3abcdefghijk'), { status: 206, headers: { 'Content-Range': 'bytes 0-13/100' } });
  });
  const provider = new KugouMusicProvider();
  assert.equal(await provider.resolveStream(hash), null);
  returnedHash = hash;
  assert.equal((await provider.resolveStream(hash)).durationSec, 202);
  assert.equal(probes, 1);
});
