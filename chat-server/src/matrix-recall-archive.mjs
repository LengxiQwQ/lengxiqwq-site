import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseRange } from './music/stream-cache.mjs';

const MAX_ARCHIVE_MEDIA_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_CONCURRENT = 4;
const SIGNED_URL_TTL_SECONDS = 15 * 60;
const SAFE_INLINE = /^(?:image\/(?:png|jpe?g|gif|webp|avif|apng|bmp|x-icon|vnd\.microsoft\.icon)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+)$/i;

function mediaSource(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  let match = /^mxc:\/\/([^/?#]+)\/([^/?#]+)$/.exec(raw);
  if (match) return { server: match[1], media: match[2] };
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') ||
        !(url.hostname === 'lengxiqwq.com' || url.hostname.endsWith('.lengxiqwq.com'))) return null;
    match = /^\/api\/media\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!match) return { directUrl: url.toString() };
    return { server: decodeURIComponent(match[1]), media: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

function byteLimiter() {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      total += chunk.length;
      done(total > MAX_ARCHIVE_MEDIA_BYTES ? new Error('Recall attachment exceeds archive limit') : null, chunk);
    },
  });
}

function mimeFromName(name = '') {
  const ext = String(name).toLowerCase().split('.').pop();
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg',
    wav: 'audio/wav', pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip',
  })[ext] || 'application/octet-stream';
}

function archiveUrl(id, expires, secret) {
  const signature = createHmac('sha256', secret).update(`${id}.${expires}`).digest('hex');
  return `/api/chat/recall-media/${id}?expires=${expires}&signature=${signature}`;
}

export function createMatrixRecallArchive({ directory, baseUrl, publicUrl = 'https://chat-server.lengxiqwq.com', token, signingSecret }) {
  if (!directory || !baseUrl || !token || !signingSecret) throw new Error('Recall archive configuration is incomplete');
  const root = join(directory, 'recall-media');
  let activeArchives = 0;
  const archiveQueue = [];

  async function withArchiveSlot(work) {
    if (activeArchives >= MAX_ARCHIVE_CONCURRENT) await new Promise((resolve) => archiveQueue.push(resolve));
    activeArchives++;
    try {
      return await work();
    } finally {
      activeArchives--;
      archiveQueue.shift()?.();
    }
  }

  async function archiveUrlValue(value, stableKey) {
    if (typeof value === 'string' && /^recall-media:\/\/[a-f0-9]{64}$/.test(value)) return { value, archived: true };
    const source = mediaSource(value);
    if (!source || (!source.directUrl && (!/^[A-Za-z0-9.:[\]-]+$/.test(source.server) || !/^[A-Za-z0-9._~-]+$/.test(source.media)))) {
      return { value, archived: false };
    }
    const id = createHash('sha256').update(stableKey).digest('hex');
    const target = join(root, id);
    try {
      await Promise.all([stat(target), readFile(`${target}.json`)]);
      return { value: `recall-media://${id}`, archived: true };
    } catch {}

    return withArchiveSlot(async () => {
      const upstream = await fetch(source.directUrl || `${baseUrl}/_matrix/client/v1/media/download/${encodeURIComponent(source.server)}/${encodeURIComponent(source.media)}`, {
        ...(source.directUrl ? { redirect: 'error' } : {}),
        headers: { ...(source.directUrl ? {} : { Authorization: `Bearer ${token}` }), 'Accept-Encoding': 'identity' },
        signal: AbortSignal.timeout(120_000),
      });
      if (!upstream.ok || !upstream.body) throw new Error(`Matrix media archive returned ${upstream.status}`);
      const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(root, { recursive: true });
      try {
        await pipeline(Readable.fromWeb(upstream.body), byteLimiter(), createWriteStream(temp, { flags: 'wx' }));
        const info = {
          contentType: upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || mimeFromName(''),
          size: (await stat(temp)).size,
        };
        await rename(temp, target);
        await writeFile(`${target}.json`, JSON.stringify(info), { flag: 'wx' }).catch(async (error) => {
          if (error.code !== 'EEXIST') throw error;
        });
        return { value: `recall-media://${id}`, archived: true };
      } catch (error) {
        await Promise.all([rm(temp, { force: true }), rm(target, { force: true }), rm(`${target}.json`, { force: true })]).catch(() => {});
        throw error;
      }
    });
  }

  async function archiveMessage(message, stableKey) {
    const copy = structuredClone(message);
    const attachments = Array.isArray(copy.attachments) ? copy.attachments : [];
    let failed = false;
    for (let index = 0; index < attachments.length; index++) {
      const attachment = attachments[index];
      for (const field of ['url', 'thumbnailUrl']) {
        if (!attachment?.[field]) continue;
        try {
          const result = await archiveUrlValue(attachment[field], `${stableKey}:${index}:${field}:${attachment[field]}`);
          attachment[field] = result.value;
          if (!result.archived) {
            failed = true;
            attachment.archiveFailed = true;
          }
        } catch {
          failed = true;
          attachment.archiveFailed = true;
        }
      }
    }
    if (failed) copy.recallArchiveIncomplete = true;
    return copy;
  }

  function hydrateMessage(message) {
    const copy = structuredClone(message);
    const expires = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS;
    for (const attachment of copy.attachments || []) {
      for (const field of ['url', 'thumbnailUrl']) {
        const match = /^recall-media:\/\/([a-f0-9]{64})$/.exec(attachment?.[field] || '');
        if (match) attachment[field] = new URL(archiveUrl(match[1], expires, signingSecret), publicUrl).toString();
      }
    }
    return copy;
  }

  async function handleRequest(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' }).end();
      return;
    }
    const match = /^\/api\/chat\/recall-media\/([a-f0-9]{64})$/.exec(pathname);
    if (!match) return false;
    const id = match[1];
    const requestUrl = new URL(req.url, 'http://localhost');
    const expires = Number(requestUrl.searchParams.get('expires'));
    const signature = requestUrl.searchParams.get('signature') || '';
    const expected = createHmac('sha256', signingSecret).update(`${id}.${expires}`).digest('hex');
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000) || expires > Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS + 5 ||
        sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
      res.writeHead(403, { 'Cache-Control': 'no-store' }).end();
      return true;
    }
    try {
      const file = join(root, id);
      const [info, fileStat] = await Promise.all([
        readFile(`${file}.json`, 'utf8').then(JSON.parse),
        stat(file),
      ]);
      const rangeHeader = req.method === 'GET' ? req.headers.range : undefined;
      const range = rangeHeader ? parseRange(rangeHeader, fileStat.size) : null;
      if (rangeHeader && !range) {
        res.writeHead(416, { 'Content-Range': `bytes */${fileStat.size}`, 'Cache-Control': 'private, no-store' }).end();
        return true;
      }
      const inline = SAFE_INLINE.test(info.contentType || '');
      const headers = {
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        'Cache-Control': 'private, no-store',
        'Content-Type': inline ? info.contentType : 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Content-Length': range ? range.end - range.start + 1 : fileStat.size,
        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${fileStat.size}` } : {}),
      };
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD') res.end();
      else createReadStream(file, range ? { start: range.start, end: range.end } : undefined).pipe(res);
    } catch {
      res.writeHead(404, { 'Cache-Control': 'no-store' }).end();
    }
    return true;
  }

  return { archiveMessage, hydrateMessage, handleRequest };
}
