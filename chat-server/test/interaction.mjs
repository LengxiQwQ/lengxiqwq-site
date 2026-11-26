import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// Run against a fresh candidate inside the private network/mount namespace.
// Only the upstream suppliers are simulated. Each participant uses a separate socket.
const origin = 'http://127.0.0.1:3001';
assert.equal(process.env.CHAT_INTERACTION_FIXTURE, '1');
assert.equal(process.cwd(), '/opt/chat-server');
assert.ok((await stat('interaction-fixture.mjs')).isFile());
const server = fork('./server.mjs', [], {
  execArgv: ['--import', './interaction-fixture.mjs'],
  silent: true,
});
server.stderr.resume();
server.stdout.resume();
const sockets = [];
const deadline = AbortSignal.timeout(5000);
async function until(fn, label, ms = 8000) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const result = fn();
    if (result) return result;
    await sleep(8);
  }
  throw Error('Timeout: ' + label);
}
function guest(name) {
  const user = { userKey: 'guest:' + name, authType: 'guest', name };
  const body = Buffer.from(JSON.stringify({ user, exp: Math.floor(Date.now() / 1000) + 180 })).toString(
    'base64url',
  );
  return body + '.' + createHmac('sha256', 'fixture').update(body).digest('base64url');
}
async function connect(name, room = 'chat') {
  const token = guest(name);
  const ws = new WebSocket(
    origin.replace('http:', 'ws:') +
      '/ws?' +
      new URLSearchParams({ room, token, authKind: 'guest', visitorId: name }),
  );
  sockets.push(ws);
  const c = {
    ws,
    token,
    results: new Map(),
    cards: [],
    init: null,
    send(packet) {
      ws.send(JSON.stringify(packet));
    },
  };
  ws.addEventListener('message', (event) => {
    const p = JSON.parse(event.data);
    if (p.type === 'room:init') {
      c.init = p;
      c.state = p.music;
    }
    if (p.type === 'music:state') {
      c.state = p;
    }
    if (p.type === 'music:request_result') c.results.set(p.requestId, p);
    if (p.type === 'chat:message' && p.message.content?.startsWith('[LX:音乐分享]')) c.cards.push(p.message);
  });
  await until(() => c.init, 'join ' + name);
  assert.equal(c.init.self?.name, name);
  return c;
}
let sequence = 0;
const track = (id) => ({
  id: 'qq:' + id,
  provider: 'qq',
  sourceId: id,
  title: id,
  artist: 'Fixture Artist',
  durationSec: 180,
});
function enqueue(c, id) {
  const requestId = 'interaction-' + ++sequence;
  c.send({ type: 'music:enqueue', requestId, track: track(id), allowAlternatives: true });
  return until(() => c.results.get(requestId), 'request ' + id);
}
const current = (c) => c.state?.current?.track?.sourceId;
const queue = (c) => c.state.queue.map((row) => row.track.sourceId);
const stateIs = (c, id) => until(() => current(c) === id, 'play ' + id);
const skim = (c) => c.send({ type: 'music:skip', playUid: c.state.current.uid });
const p95 = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const metric = (scenario, data) => console.log(JSON.stringify({ scenario, ...data }));
function stats() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.off('message', receive);
      reject(Error('stats timeout'));
    }, 2000);
    const receive = (data) => {
      clearTimeout(timer);
      resolve(data);
    };
    server.once('message', receive);
    server.send('stats');
  });
}
let probe,
  healthRunning = false;
const healthTimes = [],
  healthErrors = [];
try {
  while (!deadline.aborted) {
    try {
      if ((await fetch(origin + '/api/health')).ok) break;
    } catch {}
    await sleep(40);
  }
  assert.ok(!deadline.aborted, 'isolated gateway failed to become ready');
  assert.equal(server.exitCode, null);
  const [a, b] = await Promise.all([connect('Alice'), connect('Bob')]);

  const baseline = await stats();
  probe = setInterval(async () => {
    if (healthRunning) return;
    healthRunning = true;
    const t = performance.now();
    try {
      const r = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(2000) });
      await r.arrayBuffer();
      assert.equal(r.status, 200);
      healthTimes.push(Math.round(performance.now() - t));
    } catch (e) {
      healthErrors.push(e.message);
    } finally {
      healthRunning = false;
    }
  }, 60);

  // First click is slow; the rest of the list resolves quickly.
  const list = ['slowFirst', 'songB', 'songC', 'songD', 'songE', 'songF'];
  const t = performance.now(),
    promises = [];
  for (const id of list) {
    promises.push(enqueue(a, id));
    await sleep(24);
  }
  const replies = await Promise.all(promises);
  assert.ok(replies.every((r) => r.ok));
  await until(() => current(b) === list[0] && queue(b).length === 5, 'both see playlist');
  assert.deepEqual(queue(b), list.slice(1));
  assert.deepEqual(queue(a), queue(b));
  metric('six fast clicks', {
    current: current(b),
    queue: queue(b),
    elapsedMs: Math.round(performance.now() - t),
  });

  // Double/triple-tapping the same visible song must advance exactly once.
  const old = a.state.current.uid;
  const tCut = performance.now();
  for (let i = 0; i < 5; i++) a.send({ type: 'music:skip', playUid: old });
  await stateIs(b, 'songB');
  await stateIs(a, 'songB');
  const firstCutMs = Math.round(performance.now() - tCut);
  await sleep(90);
  assert.equal(current(b), 'songB');
  assert.deepEqual(queue(b), list.slice(2));
  // A second person can have a stale display; their delayed command must not skip B.
  b.send({ type: 'music:skip', playUid: old });
  await sleep(50);
  assert.equal(current(a), 'songB');
  metric('repeated skip on the old song', { current: current(b), elapsedMs: firstCutMs });
  const times = [];
  for (const id of ['songC', 'songD', 'songE']) {
    const start = performance.now();
    skim(a);
    await Promise.all([stateIs(a, id), stateIs(b, id)]);
    times.push(Math.round(performance.now() - start));
    assert.equal(a.state.current.uid, b.state.current.uid);
    assert.equal(a.state.current.startedAt, b.state.current.startedAt);
  }
  metric('three intentional skips', { order: ['songC', 'songD', 'songE'], ms: times });

  // A fast request from another user should not wait for Alice's upstream.
  const start = performance.now();
  const slow = enqueue(a, 'slowSecond');
  await sleep(35);
  const fast = await enqueue(b, 'bobFast');
  assert.ok(fast.ok);
  const fastMs = Math.round(performance.now() - start);
  assert.equal(queue(b).includes('slowSecond'), false);
  skim(a);
  await stateIs(b, 'songF');
  assert.ok((await slow).ok);
  metric('slow request and another person ordering and skipping', {
    fastMs,
    slowMs: Math.round(performance.now() - start),
    queue: queue(b),
  });

  const dup = await Promise.all(Array.from({ length: 5 }, (_, i) => enqueue(i % 2 ? a : b, 'sameSong')));
  assert.equal(dup.filter((r) => r.ok).length, 1);
  assert.equal(queue(b).filter((id) => id === 'sameSong').length, 1);
  metric('two users tap the same song', { accepted: 1, rejected: 4 });

  // Navigate away while the provider is still resolving.
  const switchedId = 'room-leave';
  a.send({
    type: 'music:enqueue',
    requestId: switchedId,
    allowAlternatives: true,
    track: track('slowLeave'),
  });
  await sleep(70);
  a.send({ type: 'room:switch', roomId: 'interconnect' });
  await until(() => a.init.roomId === 'interconnect', 'room switch');
  await sleep(1300);
  assert.equal(current(a), undefined);
  assert.deepEqual(queue(a), []);
  assert.ok(!queue(b).includes('slowLeave'));
  assert.ok(!a.results.has(switchedId));
  a.send({ type: 'room:switch', roomId: 'chat' });
  await until(() => a.init.roomId === 'chat', 'return to room');
  assert.deepEqual(queue(a), queue(b));
  metric('leave and reconnect', { current: current(a), queue: queue(a) });

  // Two dozen listeners start and seek. In parallel several share the same recording.
  const listeners = await Promise.all(Array.from({ length: 22 }, (_, i) => connect('listener' + i)));
  const clients = [a, b, ...listeners];
  const length = (await stat('fixture.mp3')).size;
  const bytes = await readFile('fixture.mp3');
  const digest = (data) => createHash('sha256').update(data).digest('hex');
  const stream =
    new URL(b.state.current.track.proxyUrl).pathname + new URL(b.state.current.track.proxyUrl).search;
  const before = await stats();
  const mediaTimes = [];
  const listen = clients.map(async (c, i) => {
    c.send({ type: 'music:ready', playUid: c.state.current.uid });
    const start = performance.now(),
      offset = i % 2 ? Math.floor(length / 2) : 0;
    const r = await fetch(origin + stream, {
      headers: { Range: 'bytes=' + offset + '-' + (offset + 65535) },
    });
    const body = Buffer.from(await r.arrayBuffer());
    assert.equal(r.status, 206);
    assert.equal(digest(body), digest(bytes.subarray(offset, offset + 65536)));
    mediaTimes.push(Math.round(performance.now() - start));
  });
  const shareId = 'shareSong';
  const shareTimes = [];
  const shares = clients.slice(0, 8).map(async (c) => {
    const start = performance.now();
    const r = await fetch(origin + '/api/music/share', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + c.token,
        'X-Auth-Kind': 'guest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ track: track(shareId) }),
    });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    shareTimes.push(Math.round(performance.now() - start));
    return j;
  });
  const [cards] = await Promise.all([Promise.all(shares), Promise.all(listen)]);
  assert.equal(new Set(cards.map((c) => c.sharedAudioUrl)).size, 1);
  const after = await stats();
  assert.equal(after.downloads[shareId], 1);
  const link = new URL(cards[0].sharedAudioUrl);
  const audio = await fetch(origin + link.pathname);
  assert.equal(digest(Buffer.from(await audio.arrayBuffer())), digest(bytes));
  const sharedText =
    '[LX:音乐分享]\n> 🎵 ' +
    shareId +
    '\n<!--lx-music:' +
    Buffer.from(JSON.stringify({ ...track(shareId), sharedAudioUrl: cards[0].sharedAudioUrl })).toString(
      'base64url',
    ) +
    '-->';
  b.send({ type: 'chat:send', content: sharedText, attachments: [], mentionEntities: [] });
  await Promise.all(clients.map((c) => until(() => c.cards.length === 1, 'receive playable card')));
  assert.equal(new Set(clients.map((c) => c.cards[0].msgUid)).size, 1);
  metric('crowded room', {
    listeners: clients.length,
    rangeP95Ms: p95(mediaTimes),
    shareP95Ms: p95(shareTimes),
    shareDownloads: after.downloads[shareId],
    audioBytes: length,
    rssBaseMiB: baseline.rss,
    rssBeforeBurstMiB: before.rss,
    rssAfterBurstMiB: after.rss,
    peakRssMiB: after.peak,
  });

  // First playback of a cold file with many listeners and half of them seeking later.
  const preview = await fetch(origin + '/api/music/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ track: track('coldStream') }),
  });
  const source = await preview.json();
  assert.equal(preview.status, 200);
  const coldUrl = origin + new URL(source.proxyUrl).pathname + new URL(source.proxyUrl).search;
  const coldTimes = [];
  await Promise.all(
    clients.map(async (_, i) => {
      const t = performance.now(),
        offset = i % 2 === 0 ? 0 : Math.floor(length / 2);
      const response = await fetch(coldUrl, {
        headers: { Range: 'bytes=' + offset + '-' + (offset + 65535) },
      });
      assert.equal(response.status, 206);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(offset, offset + 65536));
      coldTimes.push(Math.round(performance.now() - t));
    }),
  );
  const coldStats = await stats();
  assert.equal(coldStats.downloads.coldStream, 1);
  assert.ok(coldStats.ranges.coldStream <= 2, 'one source probe plus at most one far seek');
  metric('24 cold start and seek', {
    p95Ms: p95(coldTimes),
    fullDownloads: coldStats.downloads.coldStream,
    upstreamRangeRequests: coldStats.ranges.coldStream || 0,
  });

  // Mobile players often request from a byte offset to EOF, then cancel when the user scrubs again.
  async function previewProxy(id) {
    const r = await fetch(origin + '/api/music/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track: track(id) }),
    });
    assert.equal(r.status, 200);
    const { proxyUrl } = await r.json();
    return origin + new URL(proxyUrl).pathname + new URL(proxyUrl).search;
  }
  const mobileUrl = await previewProxy('mobileSeek');
  const from = Math.floor(length * 0.75),
    openRange = { Range: 'bytes=' + from + '-' };
  await Promise.all(
    Array.from({ length: 8 }, async (_, i) => {
      const ctl = new AbortController();
      const r = await fetch(mobileUrl, { headers: openRange, signal: ctl.signal });
      assert.equal(r.status, 206);
      assert.equal(r.headers.get('content-range'), 'bytes ' + from + '-' + (length - 1) + '/' + length);
      if (i < 3) {
        const reader = r.body.getReader();
        await reader.read();
        ctl.abort();
        return;
      }
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(from));
    }),
  );
  const mobileStats = await stats();
  assert.ok(mobileStats.ranges.mobileSeek <= 2);
  metric('three listeners scrub away', {
    canceled: 3,
    finished: 5,
    upstreamRanges: mobileStats.ranges.mobileSeek,
  });

  // Losing the mobile connection must not re-enqueue anything. New join should see the same song and queue.
  const disconnected = listeners.at(-1);
  disconnected.ws.close();
  await until(() => disconnected.ws.readyState === WebSocket.CLOSED, 'disconnect');
  const returned = await connect('listener21');
  assert.equal(returned.state.current.uid, b.state.current.uid);
  assert.deepEqual(queue(returned), queue(b));
  assert.equal(returned.state.current.startedAt, b.state.current.startedAt);
  metric('lost connection and rejoined', {
    current: current(returned),
    sameStart: true,
    queueLength: queue(returned).length,
  });

  // More than two listeners: a third-party tap registers a vote; the second vote changes exactly one song.
  const oldUid = b.state.current.uid;
  listeners[0].send({ type: 'music:vote_skip', playUid: oldUid });
  await until(() => b.state.current?.uid === oldUid && b.state.voteCount === 1, 'first vote');
  listeners[1].send({ type: 'music:vote_skip', playUid: oldUid });
  await Promise.all([stateIs(a, 'bobFast'), stateIs(b, 'bobFast'), stateIs(returned, 'bobFast')]);
  assert.equal(b.state.voteCount, 0);
  metric('crowded-room votes', { firstVoteKept: 'songF', secondVotePlayed: current(b) });

  // Twelve DIFFERENT simultaneous point requests, with a failure in the middle.
  // No fixed ordering is promised between different people; every accepted song must be present exactly once.
  const burst = clients.slice(0, 12).map((c, i) => enqueue(c, i === 4 ? 'offline' : 'burst' + i));
  const all = await Promise.all(burst);
  assert.equal(all.filter((x) => x.ok).length, 11);
  assert.equal(all[4].code, 'SOURCE_TEMPORARY');
  await until(() => queue(b).filter((x) => x.startsWith('burst')).length === 11, 'distinct song burst');
  assert.equal(new Set(queue(b).filter((x) => x.startsWith('burst'))).size, 11);
  assert.deepEqual(queue(b), queue(a));
  metric('12 people order different titles', {
    accepted: 11,
    failed: 1,
    queueConsistent: queue(b).join('|') === queue(a).join('|'),
  });

  // Several distinct uncached shares must progress without starving skip and room state broadcasts.
  const busyStart = performance.now();
  const heavy = clients.slice(0, 8).map(async (c, i) => {
    const r = await fetch(origin + '/api/music/share', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + c.token,
        'X-Auth-Kind': 'guest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ track: track('uniqueShare' + i) }),
    });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.equal(j.size, length);
    return j.sharedAudioUrl;
  });
  await sleep(75);
  const skipStart = performance.now();
  skim(b);
  await Promise.all([stateIs(a, 'slowSecond'), stateIs(b, 'slowSecond')]);
  const busySkipMs = Math.round(performance.now() - skipStart);
  const distinctShares = await Promise.all(heavy);
  assert.equal(new Set(distinctShares).size, 8);
  const busyStats = await stats();
  metric('skip during eight distinct downloads', {
    skipMs: busySkipMs,
    batchMs: Math.round(performance.now() - busyStart),
    peakRssMiB: busyStats.peak,
  });

  // Cold YouTube Music audio requires a server download. Verify coalescing and simultaneous listener access.
  const youtube = async (c, id) => {
    const r = await fetch(origin + '/api/music/share', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + c.token,
        'X-Auth-Kind': 'guest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ track: { ...track(id), id: 'youtube:' + id, provider: 'youtube' } }),
    });
    return { status: r.status, body: await r.json() };
  };
  const youtubeId = 'Abc_1234567';
  const youtubeStart = performance.now();
  const youtubeShares = await Promise.all(clients.slice(0, 8).map((c) => youtube(c, youtubeId)));
  assert.ok(youtubeShares.every((result) => result.status === 200));
  assert.equal(new Set(youtubeShares.map((result) => result.body.sharedAudioUrl)).size, 1);
  const runs = (await readFile('downloader.log', 'utf8')).trim().split('\n');
  assert.equal(runs.filter((id) => id === youtubeId).length, 1);
  metric('8 simultaneous cold YouTube shares', {
    downloaderRuns: 1,
    elapsedMs: Math.round(performance.now() - youtubeStart),
  });
  const ids = ['Abc_1234568', 'Abc_1234569', 'Abc_1234570', 'Abc_1234571'];
  const ytBurst = await Promise.all(ids.map((id, i) => youtube(clients[i], id)));
  metric('different cold YouTube tracks', { statuses: ytBurst.map((r) => r.status) });
  assert.ok(
    ytBurst.every((r) => r.status === 200),
    'all four independent downloads should progress during a short burst',
  );
  const downloaderEvents = (await readFile('downloader-times.log', 'utf8')).trim().split('\n');
  let concurrentDownloads = 0,
    peakDownloads = 0;
  for (const event of downloaderEvents) {
    concurrentDownloads += event.split(' ')[1] === 'start' ? 1 : -1;
    peakDownloads = Math.max(peakDownloads, concurrentDownloads);
  }
  assert.equal(peakDownloads, 3);
  assert.equal(concurrentDownloads, 0);
  metric('downloader concurrency', { peak: peakDownloads, activeAfter: concurrentDownloads });

  // Short outage followed by a fresh click. A temporary source error must not add a phantom song.
  const missed = await enqueue(b, 'offline');
  assert.ok(!missed.ok);
  assert.equal(missed.code, 'SOURCE_TEMPORARY');
  assert.ok(!queue(b).includes('offline'));
  const next = await enqueue(b, 'afterFailure');
  assert.ok(next.ok);
  await until(() => queue(a).includes('afterFailure'), 'recovery');
  assert.equal(healthErrors.length, 0);
  assert.ok(healthTimes.length > 4);
  assert.equal(queue(a).filter((x) => x === 'afterFailure').length, 1);
  const warmState = b.state;
  const lastCurrent = warmState.current.track.sourceId;
  const expected = queue(b);
  const observed = [];
  for (const target of expected) {
    const leader =
      b.state.current.requesterKey === a.init.self.userKey
        ? a
        : b.state.current.requesterKey === b.init.self.userKey
          ? b
          : clients.find((c) => c.init.self.userKey === b.state.current.requesterKey);
    // One of the requesters may already have disconnected. Two listeners can pass a vote.
    if (leader?.ws.readyState === WebSocket.OPEN) {
      await until(
        () => leader.state.current?.uid === b.state.current?.uid,
        'requester sees the new song before clicking',
      );
      skim(leader);
    } else for (const voter of [a, b]) voter.send({ type: 'music:vote_skip', playUid: b.state.current.uid });
    await Promise.all([stateIs(a, target), stateIs(b, target)]);
    observed.push(current(a));
  }
  assert.deepEqual(observed, expected);
  const lastUid = b.state.current.uid;
  b.send({ type: 'music:skip', playUid: lastUid });
  await until(() => !b.state.current, 'room idle after the last song');
  b.send({ type: 'music:skip', playUid: lastUid });
  await sleep(50);
  assert.ok((await enqueue(a, 'freshStart')).ok);
  await stateIs(b, 'freshStart');
  metric('skip to end then restart', {
    transitions: observed.length,
    startedFrom: lastCurrent,
    idleThenPlayed: current(b),
  });
  for (const c of [...clients, returned]) if (c !== a && c !== b) c.ws.close();
  await sleep(500);
  const cleaned = await stats();
  assert.equal(cleaned.activeAudio, 0);
  metric('after listeners leave', {
    activeAudio: cleaned.activeAudio,
    remainingConnections: [a, b].filter((c) => c.ws.readyState === WebSocket.OPEN).length,
    rssMiB: cleaned.rss,
    cpuMs: Math.round((cleaned.cpu - baseline.cpu) / 1000),
  });
  metric('recovery and HTTP responsiveness', {
    missed: missed.code,
    following: next.ok,
    healthSamples: healthTimes.length,
    p95Ms: p95(healthTimes),
    maxMs: Math.max(...healthTimes),
  });
} finally {
  clearInterval(probe);
  for (const socket of sockets) socket.close();
  server.kill('SIGTERM');
  if (server.exitCode === null && server.signalCode === null)
    await Promise.race([new Promise((r) => server.once('exit', r)), sleep(1500)]);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
}
