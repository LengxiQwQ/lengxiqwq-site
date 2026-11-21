import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MusicManager } from '../src/music/music-manager.mjs';
import { MusicRegistry } from '../src/music/registry.mjs';
import { QQMusicProvider } from '../src/music/qq-music.mjs';

const origin = 'https://example.test';
const track = id => ({ id: 'qq:' + id, provider: 'qq', sourceId: id, title: id, durationSec: 180 });
const actor = { userKey: 'member', name: 'Member' };
const playable = item => ({ ...item, streamUrl: origin + '/audio/' + item.sourceId });

async function manager(t, registry, roomId = 'chat', dataDir) {
  if (!dataDir) {
    dataDir = await mkdtemp(join(tmpdir(), 'music-test-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
  }
  const mgr = new MusicManager({ roomId, dataDir, musicRegistry: registry, serverOrigin: origin });
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
  const registry = { isHealthy: async () => false, resolvePlayable: async (item, _origin, _secret, options) =>
    fail && (item.sourceId === 'first' || item.sourceId === 'second') ? null :
      { ...playable(item), streamUrl: origin + '/audio/' + item.sourceId + (options?.fresh ? '?renewed' : '') }
  };
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
  fail = true;
  await chat.reportError(uid, 'another-listener');
  assert.equal(chat.current.uid, uid);
  assert.equal(chat.current.sourceRevision, 1);
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
      case 'cyapi.top': return Response.json({ url: 'https://isure6.stream.qqmusic.qq.com/bad' });
      case 'api.vkeys.cn': return Response.json({ data: { url: 'https://ws.stream.qqmusic.qq.com/good' } });
      case 'isure6.stream.qqmusic.qq.com': return Response.json({}, { status: 404 });
      case 'ws.stream.qqmusic.qq.com': return new Response(Buffer.from('ID3abcdefghijk'), {
        status: 206, headers: { 'Content-Range': 'bytes 0-13/100', 'Content-Type': 'application/octet-stream' }
      });
      case 'c.y.qq.com': return Response.json({ code: 0, data: { song: {
        totalnum: 90, list: [{ songmid: 'demo', songname: 'Demo' }, { songmid: 'demo', songname: 'Demo' }]
      } } });
      default: throw new Error('unexpected test host');
    }
  });
  const provider = new QQMusicProvider('fixture');
  const result = await provider.resolveStream('id');
  assert.equal(result.providerChannel, 'vkeys');
  assert.equal(result.mimeType, 'audio/mpeg');
  const resolved = await new MusicRegistry([provider]).resolvePlayable(track('id'), origin, 'fixture');
  assert.equal(resolved.streamUrl, 'https://ws.stream.qqmusic.qq.com/good');
  assert.ok(resolved.proxyUrl.startsWith(origin + '/api/music/stream'));
  const page = await provider.search('Demo', 30, 2);
  assert.equal(page.tracks.length, 1);
  assert.equal(page.hasMore, true);
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
  assert.equal(restored.current.requesterName, 'Selected (轮播)');
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
  // 牌堆播完后，自动触发重新洗牌，牌堆补满为 3 首歌
  assert.equal(mgr.rotationDeck.length, 3);
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
  assert.equal(mgr.current.requesterName, 'TestPlaylist (轮播)');
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

  // 3. 非法来源返回 null
  const t3 = normalizeMusicTrack({ id: 'netease:123456', provider: 'netease', title: 'Other' });
  assert.equal(t3, null);
});
