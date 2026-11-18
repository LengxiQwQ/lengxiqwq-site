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
    current: { uid: 'p1', track: { streamUrl: 'https://example.invalid/song' }, sourceRevision: 0 },
    generation: 1, _actorLastErrorAt: new Map(), readyClients: new Set(),
    getListeners: () => listeners, events: { changed: 0, advance: 0, resolve: 0 },
    musicRegistry: { isHealthy: async () => healthy },
    resolve: async () => { m.events.resolve++; return resolved; },
    onStateChanged: () => m.events.changed++, advanceNext: () => m.events.advance++,
    savePlayback() {}, scheduleAdvance() {}, onPrefetchTrack() {}, prepareNext() {},
    clearBarrierTimers() {
      clearTimeout(this._prepareBarrierTimer);
      clearTimeout(this._quorumBarrierTimer);
      this._prepareBarrierTimer = null;
      this._quorumBarrierTimer = null;
    }
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

test('two-phase adaptive ready barrier commits early when all active listeners report ready', () => {
  const listeners = [{ id: 'phone', modern: true }, { id: 'tablet', modern: true }];
  const m = manager({ listeners });
  try {
    m.playTrack({ streamUrl: 'x' }, { userKey: 'a' });
    const initialDeadline = m.current.startedAt;
    assert.equal(m.current.phase, 'preparing');
    assert.ok(initialDeadline >= Date.now() + 1900);

    // First listener ready -> still preparing until second listener is ready
    m.ready(m.current.uid, 'phone', 0);
    assert.equal(m.current.phase, 'preparing');

    // Second listener ready -> barrier immediately commits to scheduled with a tight lead window
    m.ready(m.current.uid, 'tablet', 0);
    assert.equal(m.current.phase, 'scheduled');
    assert.ok(m.current.startedAt < initialDeadline);
    assert.ok(m.current.startedAt <= Date.now() + 350);
  } finally {
    m.clearBarrierTimers();
    clearTimeout(m._prepareFallbackTimer);
  }
});

test('legacy listening clients keep compatible immediate playback', () => {
  const m = manager({ listeners: [{ id: 'legacy', modern: false }] });
  m.playTrack({ streamUrl: 'x' }, { userKey: 'a' });
  assert.equal(m.current.phase, 'playing');
  m.clearBarrierTimers();
  clearTimeout(m._prepareFallbackTimer);
});

test('deterministic stream signer produces identical URLs within the same bucket and preserves trackKey', () => {
  const urlA = signStreamProxyUrl('https://chat-server.lengxiqwq.com', 'https://ws.stream.qqmusic.qq.com/song.mp3', 'secret', 'https://y.qq.com/', 'audio/mpeg', 'qq:004IM0wx49gYJq');
  const urlB = signStreamProxyUrl('https://chat-server.lengxiqwq.com', 'https://ws.stream.qqmusic.qq.com/song.mp3', 'secret', 'https://y.qq.com/', 'audio/mpeg', 'qq:004IM0wx49gYJq');
  assert.equal(urlA, urlB);
  const token = new URL(urlA).searchParams.get('token');
  const verified = verifyStreamProxyToken(token, 'secret');
  assert.equal(verified.trackKey, 'qq:004IM0wx49gYJq');
  assert.equal(verified.mimeType, 'audio/mpeg');
});

test('sync snapshot preserves newly deployed queue votes and schedules', () => {
  const m = manager();
  Object.assign(m, { historyMap: new Map(), historyLogs: [], queue: [{uid:'q1',track:{id:'t1'}}],
    queueVotes: new Map([['listener','q1']]), queueVotePlayUid:'p1', stateVersion:0 });
  Object.assign(m.current, {skipVotes:[],startedAt:Date.now()+2000,phase:'scheduled'});
  const snapshot = m.getSnapshot();
  assert.equal(snapshot.protocolVersion,2);
  assert.equal(snapshot.current.phase,'scheduled');
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

test('drift control has a deadband, quantized PLL rate, buffer-starvation protection, and 2.5s hard seek', () => {
  assert.deepEqual(correctionForDrift(0.08), { seek: false, rate: 1 });
  assert.equal(correctionForDrift(0.5).rate, 1.02);
  assert.equal(correctionForDrift(-0.5).rate, 0.98);
  assert.deepEqual(correctionForDrift(1.2), { seek: false, rate: 1.035 });
  assert.deepEqual(correctionForDrift(1.2, 0.5), { seek: false, rate: 1 });
  assert.equal(correctionForDrift(8).seek, true);
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

test('player holds future start, aligns late join, reloads same URL and supports explicit unblock', async () => {
  const doc = new EventTarget(); doc.hidden = false;
  const win = new EventTarget();
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  let now = 10000; const statuses = []; const ready = [];
  const audio = new FakeAudio();
  const player = new RoomAudioPlayer(audio, {
    now: () => now, status: (s) => statuses.push(s), ready: (uid) => ready.push(uid),
    error() {}, ended() {}, duration() {}
  });
  const play = { uid: 'p1', track: { streamUrl: 'https://example.invalid/a' }, startedAt: 12000, phase: 'scheduled', sourceRevision: 0 };
  try {
    player.setTrack(play); player.listen(); await Promise.resolve();
    assert.equal(audio.muted, true); assert.equal(statuses.at(-1), 'preparing');
    now = 12010; audio.currentTime = 2; audio.dispatchEvent(new Event('canplay'));
    assert.equal(audio.muted, false); assert.ok(audio.currentTime < 0.1);
    assert.equal(statuses.at(-1), 'playing'); assert.deepEqual(ready, ['p1']);
    now = 20000; audio.currentTime = 0; player.stop(); player.listen(); await Promise.resolve();
    assert.equal(audio.currentTime, 8, 'late join must catch up');
    const loads = audio.loads;
    player.setTrack({ ...play, sourceRevision: 1 }); await Promise.resolve();
    assert.equal(audio.loads, loads + 1);
    player.stop(); audio.reject = true; player.listen(); await Promise.resolve();
    assert.equal(statuses.at(-1), 'blocked');
    audio.reject = false; player.listen(); await Promise.resolve();
    assert.equal(statuses.at(-1), 'playing');
    player.stop(); audio.dispatchEvent(new Event('canplay')); assert.equal(audio.muted, true);
  } finally { player.destroy(); }
});

test('prime-and-park starts at 0.000s with ZERO seek when startedAt arrives, and tablet 1.2s lag uses PLL rate without 1.8s seek loop', async () => {
  let now = 10000, position = 0, seeks = 0;
  const audio = new FakeAudio();
  Object.defineProperty(audio, 'currentTime', { get: () => position, set(value) { position = value; seeks++; audio.seeking = false; } });
  audio.load = () => { audio.loads++; position = 0; audio.seeking = false; };
  const player = new RoomAudioPlayer(audio, {
    now: () => now, status() {}, ready() {}, error() {}, ended() {}, duration() {}
  });
  try {
    player.setTrack({ uid: 'tablet-sync', track: { streamUrl: 'https://example.invalid/audio' }, startedAt: 11000, phase: 'scheduled' });
    player.listen(); await Promise.resolve();
    // Playhead remains parked at 0 during preparing; at startedAt (11020), drift is 0.02s <= 0.15s deadband -> ZERO seeks!
    now = 11020;
    audio.dispatchEvent(new Event('canplay'));
    assert.equal(seeks, 0, 'zero seeks at start when parked at 0.000s');
    assert.equal(audio.muted, false);

    // Simulate tablet falling 1.2s behind (which used to trigger an infinite 1.8s hard-seek loop)
    now = 15200; position = 3.0; // expected = 4.2s, drift = +1.2s
    audio.dispatchEvent(new Event('progress'));
    assert.equal(seeks, 0, '1.2s drift on tablet must NOT trigger a hard seek');
    assert.equal(audio.playbackRate, 1.035, 'uses smooth 1.035x PLL rate to catch up');
  } finally { player.destroy(); }
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
