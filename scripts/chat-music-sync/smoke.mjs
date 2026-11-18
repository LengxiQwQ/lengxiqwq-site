// Read-only spectator check: no song requests, skip commands or chat messages.
import assert from 'node:assert/strict';
const base = process.argv[2] || 'https://chat-server.lengxiqwq.com';
const health = await fetch(base + '/api/health').then(r => r.json());
assert.equal(health.ok, true);
for (const room of ['chat', 'interconnect']) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws?room=' + room + '&focused=0');
  const snapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket timeout')); }, 12_000);
    let music;
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket failed')); });
    ws.addEventListener('message', event => {
      const packet = JSON.parse(event.data);
      if (packet.music) {
        music = packet.music;
        ws.send(JSON.stringify({ type: 'ping', id: 991, musicSyncVersion: 2, musicListening: false }));
      }
      if (packet.type === 'pong' && packet.id === 991) { clearTimeout(timer); resolve(music); }
    });
  }).finally(() => ws.close());
  assert.equal(snapshot.protocolVersion, 2);
  console.log(room + ': protocol v2 snapshot and correlated clock pong OK');
  if (snapshot.current?.track.streamUrl) {
    const response = await fetch(snapshot.current.track.streamUrl, {
      headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(15_000)
    });
    assert.equal(response.status, 206);
    assert.match(response.headers.get('content-range'), /^bytes 0-1023\//);
    assert.equal((await response.arrayBuffer()).byteLength, 1024);
    console.log(room + ': signed media Range 206 / 1024 bytes OK; cache=' + response.headers.get('x-audio-cache'));
  }
}
