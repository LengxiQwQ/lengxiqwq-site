import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODES = new Set(['off', 'mention', 'all']);
const PUBLIC_CONFIG = '/api/chat/push/config';
const PUSH_ROOT = '/api/chat/push/';
const MAX_AGE = 5 * 60 * 1000;
const DEVICE_ID = /^[A-Za-z0-9_-]{16,100}$/;
const REVOCATION_KEY = /^[A-Za-z0-9_-]{43}$/;
const TEST_INTERVAL = 15_000;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) return null;
  }
  const data = JSON.parse(body);
  return data && typeof data === 'object' ? data : null;
}

function subscriptionFrom(value) {
  if (typeof value?.endpoint !== 'string' || value.endpoint.length > 4096) return null;
  const url = URL.parse(value.endpoint);
  if (url?.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return null;
  const host = url.hostname;
  const allowed = (host === 'fcm.googleapis.com' && /^\/(fcm\/send|wp)\//.test(url.pathname)) ||
    (host.endsWith('.push.services.mozilla.com') && /^\/(w?push)\//.test(url.pathname)) ||
    (host.endsWith('.push.apple.com') && url.pathname.length > 1) ||
    (host.endsWith('.notify.windows.com') && url.pathname.startsWith('/w/'));
  if (!allowed) return null;
  const { p256dh, auth } = value.keys || {};
  if (typeof p256dh !== 'string' || !/^[\w-]{87}$/.test(p256dh) ||
      typeof auth !== 'string' || !/^[\w-]{22}$/.test(auth)) return null;
  if (Buffer.from(p256dh, 'base64url')[0] !== 4) return null;
  return { endpoint: url.href, keys: { p256dh, auth } };
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function allowedOrigin(origin) {
  const url = typeof origin === 'string' ? URL.parse(origin) : null;
  return !origin || origin === 'https://lengxiqwq.com' ||
    (url?.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
}

export function matchesPushMode(record, message, roomMention) {
  if (message.kind !== 'user' || !message.userKey || record.userKey === message.userKey) return false;
  if (record.mode === 'all') return true;
  return record.mode === 'mention' && (
    message.mentionKeys?.includes(record.userKey) ||
    message.replyTo?.userKey === record.userKey ||
    roomMention
  );
}

export function createChatPush({ webPush, dataDir, resolveCaller, canReadRoom, isReading, logger = console }) {
  const keyFile = join(dataDir, 'web-push-vapid.json');
  const storeFile = join(dataDir, 'web-push-subscriptions.json');
  function readFile(file, fallback) {
    try { return JSON.parse(readFileSync(file, 'utf8')); }
    catch (err) {
      if (err.code === 'ENOENT') return fallback;
      throw err;
    }
  }
  function save(file, value) {
    const temp = file + '.tmp';
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, file);
  }

  let keys;
  let records = new Map();
  try {
    keys = readFile(keyFile, null);
    if (!keys) {
      keys = webPush.generateVAPIDKeys();
      save(keyFile, keys);
    }
    records = new Map(readFile(storeFile, []));
  } catch (err) {
    keys = null;
    logger.error('[chat push] initialization failed', err.code || err.name);
  }
  const queue = [];
  let active = 0;
  const recent = new Map();
  const lastTest = new Map();

  function update(next) {
    save(storeFile, [...next]);
    records = next;
  }

  async function deliver(record, payload, ttl) {
    try {
      await webPush.sendNotification(record.subscription, JSON.stringify(payload), {
        TTL: ttl,
        timeout: 8000,
        vapidDetails: { subject: 'https://lengxiqwq.com', ...keys },
      });
      return true;
    } catch (err) {
      if ([404, 410].includes(err.statusCode) && records.get(record.id) === record) {
        const next = new Map(records);
        next.delete(record.id);
        update(next);
      } else {
        logger.warn('[chat push] delivery failed', err.statusCode || err.code || err.name);
      }
      return false;
    }
  }

  function drain() {
    while (active < 8 && queue.length) {
      const job = queue.shift();
      if (!job.isCurrent()) continue;
      active++;
      void deliver(job.record, job.payload, job.ttl())
        .catch((err) => logger.warn('[chat push] update failed', err.code || err.name))
        .finally(() => {
          active--;
          drain();
        });
    }
  }

  function publish(roomId, message, isLive = true) {
    if (!keys || !isLive || !records.size || message.kind !== 'user' || !message.msgUid) return;
    const now = Date.now();
    const expires = Math.min(now, Number(message.createdAt) || now) + MAX_AGE;
    if (expires <= now) return;
    for (const [id, until] of recent) {
      if (until <= now) recent.delete(id);
      else break;
    }
    const id = roomId + ':' + message.msgUid;
    if (recent.has(id)) return;
    recent.set(id, now + MAX_AGE);
    if (recent.size > 10000) recent.delete(recent.keys().next().value);
    const roomMention = message.mentionKeys?.includes('room') === true;
    const payload = { roomId, msgUid: message.msgUid, roomMention };
    for (const record of records.values()) {
      if (queue.length >= 5000) break;
      if (!canReadRoom(record.userKey, roomId) || !matchesPushMode(record, message, roomMention)) continue;
      const isCurrent = () => records.get(record.id) === record && Date.now() < expires &&
        canReadRoom(record.userKey, roomId) && !isReading(record, roomId);
      queue.push({
        record,
        payload: {
          ...payload,
          body: message.mentionKeys?.includes(record.userKey) || roomMention ? '有人提及了你' :
            message.replyTo?.userKey === record.userKey ? '有人回复了你' : '聊天室有新消息',
        },
        isCurrent,
        ttl: () => Math.max(0, Math.floor((expires - Date.now()) / 1000)),
      });
    }
    drain();
  }

  async function handle(req, res, path) {
    if (!path.startsWith(PUSH_ROOT)) return false;
    if (!allowedOrigin(req.headers.origin)) {
      json(res, 403, { error: 'origin' });
      return true;
    }
    try {
      if (!keys) json(res, 503, { error: 'unavailable' });
      else if (path === PUBLIC_CONFIG && req.method === 'GET') json(res, 200, { publicKey: keys.publicKey });
      else if (req.method !== 'POST') json(res, 404, { error: 'route' });
      else {
        let data;
        try { data = await readBody(req); } catch {}
        if (!data || typeof data.revocationKey !== 'string' || !REVOCATION_KEY.test(data.revocationKey)) {
          json(res, 400, { error: 'invalid' });
          return true;
        }
        const id = hash(data.revocationKey);
        const record = records.get(id);
        if (path === PUSH_ROOT + 'disable') {
          if (record) {
            const next = new Map(records);
            next.delete(id);
            update(next);
          }
          json(res, 200, { mode: 'off' });
          return true;
        }
        const caller = await resolveCaller(req);
        const userKey = caller?.userKey;
        if (!/^(waline|guest):.+$/.test(userKey || '')) json(res, 401, { error: 'auth' });
        else if (path === PUSH_ROOT + 'status') {
          const current = records.get(id);
          json(res, 200, { mode: current?.userKey === userKey ? current.mode : 'off' });
        } else if (path === PUSH_ROOT + 'subscribe') {
          const sub = subscriptionFrom(data.subscription);
          if (!sub || !DEVICE_ID.test(data.deviceId || '') || !MODES.has(data.mode) || data.mode === 'off') {
            json(res, 400, { error: sub ? 'invalid' : 'endpoint' });
          } else {
            const next = new Map(records);
            for (const [otherId, other] of next) {
              if (other.subscription.endpoint === sub.endpoint) {
                if (other.userKey !== userKey && otherId !== id) {
                  json(res, 409, { error: 'ownership' });
                  return true;
                }
                next.delete(otherId);
              }
            }
            next.delete(id);
            if ([...next.values()].filter((item) => item.userKey === userKey).length >= 20) {
              json(res, 429, { error: 'limit' });
              return true;
            }
            next.set(id, { id, userKey, deviceId: data.deviceId, mode: data.mode, subscription: sub });
            update(next);
            json(res, 200, { mode: data.mode });
          }
        } else if (path === PUSH_ROOT + 'test') {
          const current = records.get(id);
          const now = Date.now();
          if (current?.userKey !== userKey) json(res, 404, { error: 'missing' });
          else if ((lastTest.get(userKey) || 0) > now) json(res, 429, { error: 'rate' });
          else {
            lastTest.set(userKey, now + TEST_INTERVAL);
            for (const [key, until] of lastTest) {
              if (until > now) break;
              lastTest.delete(key);
            }
            const sent = await deliver(current, { test: true, body: '浏览器推送已启用' }, 60);
            json(res, sent ? 200 : 502, { ok: sent });
          }
        } else json(res, 404, { error: 'route' });
      }
    } catch (err) {
      logger.warn('[chat push] request failed', err.code || err.name);
      if (!res.headersSent) json(res, 500, { error: 'unavailable' });
    }
    return true;
  }

  return { handle, publish };
}
