import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicManager } from './candidate/src/music/music-manager.mjs';
import { parseRange } from './candidate/src/music/stream-cache.mjs';
import { idleWatchdog, waitBounded } from './candidate/src/music/stream-timeouts.mjs';
import { signStreamProxyUrl, verifyStreamProxyToken } from './candidate/src/music/stream-signer.mjs';
import { MusicClock } from '../../src/components/pages/chat/musicClock.ts';
import { correctionForDrift, RoomAudioPlayer } from '../../src/components/pages/chat/roomAudioPlayer.ts';

function manager({ healthy = false, resolved = null, listeners = [] } = {}) {
  const m = Object.create(MusicManager.prototype);
  Object.assign(m, {
    current: { uid: 'p1', track: { id: 'qq:1', streamUrl: 'https://example.invalid/song' }, sourceRevision: 0 },
    generation: 1, fallbackGeneration: 1, _actorLastErrorAt: new Map(),
    getListeners: () => listeners, events: { changed: 0, advance: 0, resolve: 0 },
    musicRegistry: { isHealthy: async () => healthy },
    resolve: async () => { m.events.resolve++; return resolved; },
    onStateChanged: () => m.events.changed++, advanceNext: () => m.events.advance++,
    savePlayback() {}, scheduleAdvance() {}, onPrefetchTrack() {}, prepareNext() {}
  });
  return m;
}

test('one weak device cannot replace a healthy source or skip the room', async () => {
  const m = manager({ healthy: true });
  await m.reportError('p1', 'a', 0);
  assert.deepEqual(m.events, { changed: 0, advance: 0, resolve: 0 });
});

test('resolver outage does not skip; same-URL recovery increments revision', async () => {
  const failed = manager();
  await failed.reportError('p1', 'a', 0);
  assert.equal(failed.events.advance, 0);
  const m = manager({ resolved: { streamUrl: 'https://example.invalid/song' } });
  await m.reportError('p1', 'a', 0);
  assert.equal(m.current.sourceRevision, 1);
  assert.equal(m.events.changed, 1);
  await m.reportError('p1', 'b', 0);
  assert.equal(m.events.resolve, 1, 'obsolete revision cannot initiate another recovery');
});

test('old recovery cannot overwrite a newer track', async () => {
  const m = manager();
  let complete;
  m.resolve = () => new Promise(resolve => { complete = resolve; });
  const pending = m.reportError('p1', 'a', 0);
  await new Promise(resolve => setImmediate(resolve));
  m.current = { uid: 'p2' }; m.generation++;
  complete({ streamUrl: 'https://example.invalid/new' });
  await pending;
  assert.equal(m.current.uid, 'p2'); assert.equal(m.events.changed, 0);
});

test('playTrack starts immediately with authoritative startedAt timestamp and increments fallbackGeneration to invalidate stale prepared tracks', () => {
  const m = manager();
  m.preparedFallback = { key: 1, playable: { id: 'qq:stale' }, checkedAt: Date.now() };
  const beforeGen = m.fallbackGeneration;
  const t0 = Date.now();
  m.playTrack({ id: 'qq:new', streamUrl: 'x' }, { userKey: 'a' });
  assert.equal(m.current.phase, 'playing');
  assert.ok(m.current.startedAt >= t0 && m.current.startedAt <= Date.now() + 50);
  assert.equal(m.fallbackGeneration, beforeGen + 1);
  assert.equal(m.preparedFallback, null, 'stale preparedFallback must be cleared on every track switch');
  clearTimeout(m._prepareFallbackTimer);
});

test('deterministic CDN-friendly stream signer includes static extension and preserves trackKey', () => {
  const urlA = signStreamProxyUrl('https://chat-server.lengxiqwq.com', 'https://ws.stream.qqmusic.qq.com/song.mp3', 'secret', 'https://y.qq.com/', 'audio/mpeg', 'qq:004IM0wx49gYJq');
  const urlB = signStreamProxyUrl('https://chat-server.lengxiqwq.com', 'https://ws.stream.qqmusic.qq.com/song.mp3', 'secret', 'https://y.qq.com/', 'audio/mpeg', 'qq:004IM0wx49gYJq');
  assert.equal(urlA, urlB);
  assert.match(new URL(urlA).pathname, /^\/api\/music\/stream\/qq_004IM0wx49gYJq\.mp3$/);
  const token = new URL(urlA).searchParams.get('token');
  const verified = verifyStreamProxyToken(token, 'secret');
  assert.equal(verified.trackKey, 'qq:004IM0wx49gYJq');
  assert.equal(verified.mimeType, 'audio/mpeg');
});

test('sync snapshot preserves newly deployed queue votes', () => {
  const m = manager();
  Object.assign(m, { historyMap: new Map(), historyLogs: [], queue: [{uid:'q1',track:{id:'t1'}}],
    queueVotes: new Map([['listener','q1']]), queueVotePlayUid:'p1', stateVersion:0 });
  Object.assign(m.current, {skipVotes:[],startedAt:Date.now(),phase:'playing'});
  const snapshot = m.getSnapshot();
  assert.equal(snapshot.protocolVersion,2);
  assert.equal(snapshot.current.phase,'playing');
  assert.deepEqual(snapshot.queue[0].playVotes,['listener']);
});

test('slow but progressing transfer survives; truly idle transfer aborts', async () => {
  const controller = new AbortController();
  const watchdog = idleWatchdog(controller, 80);
  for (let i = 0; i < 6; i++) {
    await new Promise(resolve => setTimeout(resolve, 20)); watchdog.touch();
    assert.equal(controller.signal.aborted, false);
  }
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(controller.signal.aborted, true); watchdog.stop();
});

test('cache wait is bounded and cancellation releases the waiter', async () => {
  const controller = new AbortController();
  const wait = waitBounded(new Promise(() => {}), 60_000, controller.signal);
  controller.abort(); await wait;
  await waitBounded(new Promise(() => {}), 10);
});

test('Range handling preserves suffix, open ranges and unsatisfiable ranges', () => {
  assert.deepEqual(parseRange('bytes=-20', 100), { start: 80, end: 99 });
  assert.deepEqual(parseRange('bytes=20-', 100), { start: 20, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), false);
  assert.equal(parseRange('bytes=0-1,4-5', 100), false);
});

test('clock ignores wall-clock changes and filters high-latency outliers', () => {
  let now = 100; const c = new MusicClock(() => now);
  c.seed(10000); now = 200; assert.equal(c.now(), 10100);
  c.sample(10150, 100); // midpoint 150 => offset 10000
  now = 300; assert.equal(c.now(), 10300);
  now = 1600; c.sample(50000, 300);
  assert.equal(c.now(), 11600, 'lower RTT sample wins');
  now = 6000; assert.equal(c.sample(90000, 1600), false);
  c.resetSamples(); now = 6100; c.sample(100000, 6000);
  assert.equal(c.now(), 100050, 'resume discards pre-sleep samples');
});

test('drift control keeps rate locked at 1.0 (iPad safe) and only seeks when drift >= 2.2s', () => {
  assert.deepEqual(correctionForDrift(0.08), { seek: false, rate: 1 });
  assert.deepEqual(correctionForDrift(0.5), { seek: false, rate: 1 });
  assert.deepEqual(correctionForDrift(1.5), { seek: false, rate: 1 });
  assert.deepEqual(correctionForDrift(2.5), { seek: true, rate: 1 });
});

class FakeAudio extends EventTarget {
  src = ''; currentTime = 0; readyState = 4; duration = 180; paused = true;
  seeking = false; ended = false; muted = true; volume = 1; playbackRate = 1;
  buffered = { length: 1, start: () => 0, end: () => 20 };
  loads = 0; plays = 0; reject = false;
  getAttribute() { return this.src; }
  removeAttribute() { this.src = ''; }
  load() { this.loads++; this.currentTime = 0; }
  play() { this.plays++; if (this.reject) return Promise.reject(new DOMException('blocked', 'NotAllowedError')); this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}

test('multiple tabs on the same device get distinct _cid stream URLs and align directly to (serverNow - startedAt)/1000', async () => {
  const doc = new EventTarget(); doc.hidden = false;
  const win = new EventTarget();
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });

  let now = 10800; // 0.8s after startedAt (10000)
  const audio1 = new FakeAudio();
  const audio2 = new FakeAudio();
  const p1 = new RoomAudioPlayer(audio1, { now: () => now, status() {}, ready() {}, error() {}, ended() {}, duration() {} });
  const p2 = new RoomAudioPlayer(audio2, { now: () => now, status() {}, ready() {}, error() {}, ended() {}, duration() {} });

  const play = {
    uid: 'p1',
    track: { streamUrl: 'https://chat-server.lengxiqwq.com/api/music/stream/qq_1.mp3?token=abc' },
    startedAt: 10000,
    phase: 'playing',
    sourceRevision: 0
  };

  try {
    p1.setTrack(play); p1.listen();
    p2.setTrack(play); p2.listen();
    await Promise.resolve();

    // Crucial: distinct URLs per tab prevent Chromium HttpCache exclusive media lock deadlocks!
    assert.notEqual(audio1.src, audio2.src);
    assert.ok(audio1.src.includes('_cid='));
    assert.ok(audio2.src.includes('_cid='));

    // Both tabs immediately align to (10800 - 10000) / 1000 = 0.8s and unmute
    assert.equal(audio1.currentTime, 0.8);
    assert.equal(audio2.currentTime, 0.8);
    assert.equal(audio1.muted, false);
    assert.equal(audio2.muted, false);
    assert.equal(audio1.playbackRate, 1);
    assert.equal(audio2.playbackRate, 1);
  } finally {
    p1.destroy();
    p2.destroy();
  }
});

test('slow buffering device does not prematurely lock initialAligned during early metadata/progress events before play() resolves', async () => {
  let now = 10000;
  const audio = new FakeAudio();
  let resolvePlay;
  audio.play = () => {
    audio.paused = false; // HTML5 spec: play() sets paused=false synchronously before resolving
    audio.readyState = 2; // HAVE_CURRENT_DATA at t=100ms
    return new Promise(resolve => { resolvePlay = resolve; });
  };
  const player = new RoomAudioPlayer(audio, {
    now: () => now, status() {}, ready() {}, error() {}, ended() {}, duration() {}
  });
  try {
    player.setTrack({
      uid: 'slow-ipad',
      track: { streamUrl: 'https://chat-server.lengxiqwq.com/api/music/stream/qq_2.mp3?token=xyz' },
      startedAt: 10000,
      phase: 'playing',
      sourceRevision: 0
    });
    player.listen();
    // At t=100ms (now=10100), early progress/loadedmetadata arrives while play() is still pending
    now = 10100;
    audio.dispatchEvent(new Event('loadedmetadata'));
    audio.dispatchEvent(new Event('progress'));
    assert.equal(audio.currentTime, 0);

    // At t=1200ms (now=11200), buffering finishes and play() finally resolves
    now = 11200;
    audio.readyState = 4;
    resolvePlay();
    await Promise.resolve();

    // Must align to 1.2s instead of being stuck at 0.0s!
    assert.equal(audio.currentTime, 1.2);
  } finally {
    player.destroy();
  }
});

test('superseded play rejection cannot put the latest track into a blocked state', async () => {
  const audio = new FakeAudio(); let rejectOld; const states = [];
  const player = new RoomAudioPlayer(audio, {
    now: () => 10000, status: s => states.push(s), ready() {}, error() {}, ended() {}, duration() {}
  });
  try {
    player.setTrack({ uid: 'old', track: { streamUrl: 'https://example.invalid/old' }, startedAt: 10000 });
    audio.play = () => new Promise((_, reject) => { rejectOld = reject; });
    player.listen();
    audio.play = () => { audio.paused = false; return Promise.resolve(); };
    player.setTrack({ uid: 'new', track: { streamUrl: 'https://example.invalid/new' }, startedAt: 10000 });
    await Promise.resolve();
    rejectOld(new DOMException('late rejection', 'NotAllowedError'));
    await Promise.resolve();
    assert.equal(states.at(-1), 'playing');
    assert.equal(audio.src, 'https://example.invalid/new');
  } finally { player.destroy(); }
});
