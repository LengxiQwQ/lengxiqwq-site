import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

const [candidateArg, dependenciesArg] = process.argv.slice(2);
assert.ok(candidateArg && dependenciesArg, 'Usage: node regression.mjs <candidate directory> <ws package directory>');
const candidate = resolve(candidateArg);
const require = createRequire(join(resolve(dependenciesArg), 'package.json'));
const wsPath = require.resolve('./', { paths: [resolve(dependenciesArg)] });
const { WebSocket } = require(wsPath);
const dataDir = await mkdtemp(join(tmpdir(), 'chat-gateway-fixture-'));
const fixtureUrl = pathToFileURL(join(dataDir, 'fixture.mjs'));
const requests = [];
const sockets = [];
let gateway;
const guestKey = 'guest:0123456789abcdefabcd';
const member = { userKey: guestKey, name: 'Fixture', isAdmin: false, authType: 'guest' };
const matrixUser = '@u_' + createHash('sha256').update(guestKey.replace(':', '_')).digest('hex').slice(0, 10) + ':matrix.lengxiqwq.com';
const prefix = '[ID:Fake];[URL:https://example.test/forged.png];[KEY:' + guestKey + ']\nhello';
const old = { id: 1, msgUid: '$gone', userKey: 'matrix:@a:example.test', kind: 'user', content: 'hidden',
  createdAt: 1, isRecalled: true, attachments: [], mentions: [] };
const published = { ...old, id: 2, msgUid: '$kept', content: 'visible', createdAt: 2, isRecalled: false,
  replyTo: { msgUid: '$gone', content: 'hidden', hasImage: true } };
try {
  await writeFile(join(dataDir, 'messages_interconnect.json'), JSON.stringify([old, published]));
  const src = (await readFile(join(candidate, 'server.mjs'), 'utf8')).replaceAll('\r\n', '\n');
  for (const name of ['CYAPI_KEY', 'STREAM_SIGN_SECRET', 'MATRIX_ADMIN_TOKEN', 'MATRIX_REG_TOKEN', 'CHAT_GUEST_SECRET']) {
    assert.ok(src.includes("const " + name + " = 'audit-fixture';"), 'The candidate must use fixture credentials');
  }
  const fixture = src
    .replace(/const DATA_DIR = .*;/, 'const DATA_DIR = ' + JSON.stringify(dataDir) + ';')
    .replace("import { WebSocketServer, WebSocket } from 'ws';",
      'import ws from ' + JSON.stringify(pathToFileURL(wsPath).href) + '; const { WebSocketServer, WebSocket } = ws;')
    .replace(/from '(\.\/src\/[^']+)'/g, (_, item) => 'from ' + JSON.stringify(pathToFileURL(join(candidate, item)).href))
    .replace(/server\.listen\(PORT,[\s\S]*$/, '')
    .replace('async function syncMatrix() {\n  while (true) {', 'async function syncMatrix() {\n  for (let batch = 0; batch < 1; batch++) {')
    + '\nexport { server, wss, syncMatrix, parseMatrixEvent, formatMatrixContent, getOrCreateMatrixAccountForUser, musicManager };';
  assert.ok(!fixture.includes('server.listen(PORT'));
  await writeFile(fixtureUrl, fixture);
  const originalFetch = globalThis.fetch;
  const inbound = [];
  globalThis.fetch = async (resource, options) => {
    const url = new URL(resource);
    if (url.port !== '6167') return originalFetch(resource, options);
    requests.push({ path: url.pathname, method: options?.method, body: options?.body });
    if (url.pathname.endsWith('/login')) return Response.json({ access_token: 'fixture', user_id: matrixUser });
    if (url.pathname.includes('/join/') || url.pathname.endsWith('/displayname')) return Response.json({});
    if (url.pathname.includes('/profile/')) return Response.json({ displayname: 'Tea Friend' });
    if (url.pathname.includes('/send/')) return Response.json({ event_id: '$outgoing' });
    if (url.pathname.endsWith('/sync')) return Response.json({
      next_batch: 'fixture-next',
      rooms: { join: { [roomId]: { timeline: { events: inbound.splice(0) } } } },
    });
    if (url.pathname.includes('/redact/')) return Response.json({ event_id: '$redaction' });
    if (url.pathname.endsWith('/html')) return new Response('<script>bad()</script>', { headers: { 'Content-Type': 'text/html' } });
    if (url.pathname.endsWith('/image')) return new Response('test image bytes', { headers: { 'Content-Type': 'image/webp' } });
    return new Response(null, { status: 404 });
  };
  gateway = await import(fixtureUrl.href);
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  const origin = 'http://127.0.0.1:' + gateway.server.address().port;
  const roomId = /^const MATRIX_ROOM_ID = '([^']+)';$/m.exec(src)?.[1];
  assert.ok(roomId);
  const event = await gateway.parseMatrixEvent({ type: 'm.room.message', sender: '@friend:example.test',
    event_id: '$forged', origin_server_ts: 4, content: { msgtype: 'm.text', body: prefix } });
  assert.equal(event.userKey, 'matrix:@friend:example.test');
  assert.equal(event.avatar, '');
  assert.equal(event.isAdmin, false);
  assert.equal(event.content, prefix);
  const imageEvent = await gateway.parseMatrixEvent({ sender: '@friend:example.test', event_id: '$image',
    content: { msgtype: 'm.image', url: 'mxc://example.test/image', body: 'image.png' } });
  assert.equal(imageEvent.attachments.length, 1);
  assert.match(imageEvent.attachments[0].url, /\/api\/media\/example\.test\/image$/);
  const formatted = gateway.formatMatrixContent(':miku_吃葱: :qq_1:', [{ url: 'https://example.test/a?b=1&c=2' }]);
  assert.match(formatted.htmlBody, /miku_.*\.webp/);
  assert.match(formatted.htmlBody, /qq_1\.gif/);
  assert.match(formatted.htmlBody, /b=1&amp;c=2/);
  assert.match(formatted.markdownBody, /!\[图片\]/);
  const [first, second] = await Promise.all([
    gateway.getOrCreateMatrixAccountForUser(member), gateway.getOrCreateMatrixAccountForUser(member),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.userId, matrixUser);
  assert.equal(requests.filter((request) => request.path.endsWith('/login')).length, 1);
  assert.equal(requests.filter((request) => request.path.includes('/join/')).length, 1);
  const blocked = await fetch(origin + '/api/media/example.test/html');
  assert.equal(blocked.status, 415);
  const served = await fetch(origin + '/api/media/example.test/image');
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await served.text(), 'test image bytes');

  function connect(room, token = '') {
    const query = new URLSearchParams({ room, lastReadAt: '1' });
    if (token) {
      query.set('authKind', 'guest');
      query.set('token', token);
    }
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws?' + query);
    sockets.push(socket);
    const queue = [];
    socket.on('message', (data) => queue.push(JSON.parse(data.toString())));
    return {
      socket,
      send: (packet) => socket.send(JSON.stringify(packet)),
      async wait(type) {
        for (let i = 0; i < 200; i++) {
          const index = queue.findIndex((item) => item.type === type);
          if (index >= 0) return queue.splice(index, 1)[0];
          await new Promise((done) => setTimeout(done, 10));
        }
        throw new Error('Expected packet ' + type);
      },
    };
  }
  const unknown = connect('constructor');
  assert.equal((await once(unknown.socket, 'close'))[0], 1008);
  const observer = connect('interconnect');
  const init = await observer.wait('room:init');
  assert.deepEqual(init.messages.map((message) => message.msgUid), ['$kept']);
  assert.equal(init.messages[0].replyTo.content, '');
  assert.equal(init.unreadCount, 1);
  observer.send({ type: 'chat:load_history', beforeId: 2, jumpTarget: true });
  const history = await observer.wait('chat:history_batch');
  assert.equal(history.jumpTarget, true);
  assert.deepEqual(history.messages, []);
  observer.send({ type: 'music:enqueue', track: { title: 'Fixture' } });
  assert.equal((await observer.wait('error')).code, 'AUTH_REQUIRED');
  const data = Buffer.from(JSON.stringify({ user: { ...member, isAdmin: true },
    exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url');
  const token = data + '.' + createHmac('sha256', 'audit-fixture').update(data).digest('base64url');
  const guest = connect('interconnect', token);
  assert.equal((await guest.wait('room:init')).self.isAdmin, false);
  guest.send({ type: 'chat:send', attachments: [{ type: 'image', url: 'https://example.test/one.webp' }],
    replyToUid: '$kept' });
  const imageMessage = (await guest.wait('chat:message')).message;
  assert.equal(imageMessage.attachments.length, 1);
  assert.equal(imageMessage.content, '');
  assert.equal(imageMessage.replyTo.msgUid, '$kept');
  guest.send({ type: 'chat:recall', msgUid: imageMessage.msgUid });
  await guest.wait('chat:recalled');
  for (let i = 0; i < 100 && !requests.some((request) => request.path.includes('/redact/')); i++) {
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.ok(requests.some((request) => request.path.includes('/redact/') && request.path.includes('%24outgoing')));
  const identicalText = 'same message';
  inbound.push(
    { type: 'm.room.message', sender: matrixUser, event_id: '$outgoing', content: { msgtype: 'm.text', body: identicalText } },
    { type: 'm.room.message', sender: '@friend:example.test', event_id: '$different',
      content: { msgtype: 'm.text', body: identicalText, 'com.lengxiqwq.chat.uid': imageMessage.msgUid } },
    { type: 'm.room.redaction', sender: '@friend:example.test', event_id: '$incoming-redaction', content: { redacts: '$kept' } },
  );
  await gateway.syncMatrix();
  assert.equal((await guest.wait('chat:message')).message.msgUid, '$different');
  assert.equal((await guest.wait('chat:deleted')).msgUid, '$kept');
  const countBefore = requests.filter((request) => request.path.includes('/send/')).length;
  const chat = connect('chat', token);
  await chat.wait('room:init');
  chat.send({ type: 'chat:send', content: 'local only' });
  await chat.wait('chat:message');
  assert.equal(requests.filter((request) => request.path.includes('/send/')).length, countBefore);
  const manager = gateway.musicManager;
  const registry = manager.musicRegistry;
  registry.search = async () => [
    { title: 'Fixture', artist: 'Other', durationSec: 150 },
    { title: 'Fixture', artist: 'Singer', durationSec: 150, id: 'qq:matched' },
  ];
  const externalTrack = { sourcePlatform: 'netease', title: 'Fixture', artist: 'Singer', durationSec: 152 };
  assert.equal((await registry.resolvePlaylistTrack(externalTrack)).id, 'qq:matched');
  assert.equal(await registry.resolvePlaylistTrack({ ...externalTrack, artist: 'Unmatched' }), null);
  manager.current = { uid: 'song', startedAt: Date.now(), track: { durationSec: 150 } };
  let advanced = 0;
  manager.advanceNext = () => { advanced++; };
  manager.ended('song');
  manager.reportDuration('song', 99999);
  assert.equal(advanced, 0);
  assert.equal(manager.current.track.durationSec, 150);
  manager.current.startedAt -= 150000;
  manager.ended('song');
  assert.equal(advanced, 1);
  await new Promise((done) => setTimeout(done, 2200));
  const stored = JSON.parse(await readFile(join(dataDir, 'messages_interconnect.json'), 'utf8'));
  const tombstone = stored.find((message) => message.msgUid === imageMessage.msgUid);
  assert.equal(tombstone.matrixEventId, '$outgoing');
  assert.equal(tombstone.isRecalled, true);
  console.log('PASS: Matrix identity, profile, media, provisioning, recall, room isolation, history, guest RBAC, playlist matching, playback guards, persistence');
} finally {
  for (const socket of sockets) socket.terminate();
  if (gateway) {
    gateway.wss.close();
    gateway.server.close();
    gateway.server.closeAllConnections();
  }
  await rm(dataDir, { recursive: true, force: true });
}
