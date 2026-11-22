import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createChatPush } from '../src/web-push.mjs';

const root = '/api/chat/push/';
const alice = 'waline:1';
const bob = 'guest:bob';
const charlie = 'waline:3';
const keys = { p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'), auth: randomBytes(16).toString('base64url') };
const browser = (name, hostname = 'fcm.googleapis.com') => ({
  revocationKey: randomBytes(32).toString('base64url'),
  deviceId: randomBytes(16).toString('hex'),
  subscription: { endpoint: `https://${hostname}/fcm/send/${name}`, keys },
});

test('chat push routes and live delivery respect account, room, browser and mode', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'chat-web-push-'));
  const sent = [];
  const focused = new Map();
  const revoked = new Set();
  const webPush = {
    generateVAPIDKeys: () => ({ publicKey: 'test-public', privateKey: 'test-private' }),
    async sendNotification(subscription, payload, options) {
      assert.ok(options.TTL <= 300);
      sent.push({ endpoint: subscription.endpoint, ...JSON.parse(payload) });
      if (revoked.has(subscription.endpoint)) throw Object.assign(new Error('expired'), { statusCode: 410 });
    },
  };
  const options = {
    dataDir,
    webPush,
    resolveCaller: async (req) => req.headers.authorization && { userKey: req.headers.authorization },
    canReadRoom: (userKey, roomId) => roomId === 'chat' || userKey !== charlie,
    isReading: (record, roomId) => focused.get(record.deviceId) === roomId,
  };
  let push = createChatPush(options);
  const server = createServer((req, res) => { void push.handle(req, res, req.url); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = async (route, data, user, origin = 'https://lengxiqwq.com') => {
    const headers = { Origin: origin };
    if (user) headers.Authorization = user;
    const res = await fetch(`http://127.0.0.1:${server.address().port}${root}${route}`, {
      method: data ? 'POST' : 'GET',
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return [res.status, await res.json()];
  };
  const desktop = browser('desktop');
  const phone = browser('phone');
  const guest = browser('guest');
  const other = browser('other');
  const blocked = browser('blocked', '127.0.0.1');

  assert.deepEqual(await call('config'), [200, { publicKey: 'test-public' }]);
  assert.equal((await call('subscribe', { ...desktop, mode: 'all' }))[0], 401);
  assert.equal((await call('subscribe', { ...blocked, mode: 'all' }, alice))[0], 400);
  assert.equal((await call('subscribe', { ...desktop, mode: 'all' }, alice, 'https://example.com'))[0], 403);
  assert.equal((await call('subscribe', { ...desktop, mode: 'all' }, alice))[0], 200);
  assert.equal((await call('subscribe', { ...phone, mode: 'mention' }, alice))[0], 200);
  assert.equal((await call('subscribe', { ...guest, mode: 'all' }, bob))[0], 200);
  assert.equal((await call('subscribe', { ...other, mode: 'all' }, charlie))[0], 200);
  assert.equal((await call('subscribe', { ...browser('extra'), mode: 'all', subscription: desktop.subscription }, bob))[0], 409);
  assert.deepEqual(await call('status', desktop, bob), [200, { mode: 'off' }]);

  push = createChatPush(options);
  const message = { kind: 'user', msgUid: 'a1', userKey: bob, name: '小茶', content: '今晚一起听歌吗？', createdAt: Date.now() };
  push.publish('interconnect', message, false);
  push.publish('interconnect', { ...message, createdAt: Date.now() - 600_000 });
  push.publish('interconnect', { ...message, kind: 'system' });
  assert.equal(sent.length, 0);
  push.publish('interconnect', message);
  assert.deepEqual(sent.splice(0).map((row) => row.endpoint), [desktop.subscription.endpoint]);

  focused.set(desktop.deviceId, 'interconnect');
  const mention = { ...message, msgUid: 'a2', mentionKeys: [alice], replyTo: { userKey: alice } };
  push.publish('interconnect', mention);
  push.publish('interconnect', mention);
  assert.deepEqual(sent.splice(0), [{
    endpoint: phone.subscription.endpoint,
    roomId: 'interconnect',
    msgUid: 'a2',
    body: '小茶 提到了你\n今晚一起听歌吗？',
  }]);
  push.publish('interconnect', { ...message, msgUid: 'a3', mentionKeys: ['room'] });
  assert.equal(sent.splice(0).length, 1);
  push.publish('interconnect', { ...message, msgUid: 'a4', replyTo: { userKey: alice } });
  assert.equal(sent.splice(0)[0]?.body, '小茶 回复了你\n今晚一起听歌吗？');
  push.publish('interconnect', { ...message, msgUid: 'attachment', content: '', attachments: [{}], mentionKeys: [alice] });
  assert.equal(sent.splice(0)[0]?.body, '小茶 提到了你\n[附件]');
  push.publish('interconnect', { ...message, msgUid: 'long', content: '🎵'.repeat(300), mentionKeys: [alice] });
  assert.equal(sent.splice(0)[0]?.body, '小茶 提到了你\n' + '🎵'.repeat(240) + '…');

  assert.deepEqual(await call('mode', { revocationKey: phone.revocationKey, mode: 'off' }), [200, { mode: 'off' }]);
  push.publish('interconnect', { ...mention, msgUid: 'muted' });
  assert.equal(sent.length, 0);
  assert.equal((await call('test', phone, alice))[0], 404);

  push = createChatPush(options);
  assert.deepEqual(await call('status', phone, alice), [200, { mode: 'off' }]);
  assert.equal((await call('mode', { revocationKey: phone.revocationKey, mode: 'invalid' }))[0], 400);
  assert.deepEqual(await call('mode', { revocationKey: phone.revocationKey, mode: 'all' }), [200, { mode: 'all' }]);
  push.publish('interconnect', { ...message, msgUid: 'resumed' });
  assert.deepEqual(sent.splice(0).map(row => row.endpoint), [phone.subscription.endpoint]);
  assert.deepEqual(await call('mode', { revocationKey: phone.revocationKey, mode: 'mention' }), [200, { mode: 'mention' }]);
  push.publish('interconnect', { ...message, msgUid: 'ordinary-mention-mode' });
  assert.equal(sent.length, 0);

  const [testStatus, testBody] = await call('test', phone, alice);
  assert.equal(testStatus, 200);
  assert.ok(testBody.cooldownMs > 0 && testBody.cooldownMs <= 15_000);
  assert.equal(sent.splice(0)[0]?.test, true);
  const [limitedStatus, limited] = await call('test', phone, alice);
  assert.equal(limitedStatus, 429);
  assert.equal(limited.error, 'rate');
  assert.ok(limited.cooldownMs > 0 && limited.cooldownMs <= testBody.cooldownMs);
  assert.equal(sent.length, 0);
  revoked.add(phone.subscription.endpoint);
  push.publish('interconnect', { ...mention, msgUid: 'a5' });
  await setImmediate();
  assert.deepEqual(await call('status', phone, alice), [200, { mode: 'off' }]);
  assert.equal((await call('mode', { revocationKey: phone.revocationKey, mode: 'all' }))[0], 404);
  assert.equal((await call('disable', desktop))[0], 200);
  assert.deepEqual(await call('status', desktop, alice), [200, { mode: 'off' }]);
  if (process.platform !== 'win32') {
    const keyFile = await stat(join(dataDir, 'web-push-vapid.json'));
    assert.equal(keyFile.mode & 0o777, 0o600);
  }
});
