import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseRange } from './music/stream-cache.mjs';

const MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const MAX_SVG_BYTES = 1024 * 1024;
const MAX_CONCURRENT = 16;
const MEDIA_TIMEOUT = 120_000;
const HEADER_TIMEOUT = 20_000;
const SAFE_INLINE = /^(?:image\/(?:png|jpe?g|gif|webp|avif|apng|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+)$/i;

const safeHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
};

function lengthHeader(value) {
  if (!/^\d+$/.test(value || '')) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

function fail(res, status, message, contentRange) {
  const headers = { ...safeHeaders, 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
  if (contentRange) headers['Content-Range'] = contentRange;
  res.writeHead(status, headers).end(JSON.stringify({ ok: false, error: message }));
}

function byteLimit(maximum) {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      done(bytes > maximum ? new Error('Matrix media exceeds size limit') : null, chunk);
    },
  });
}

async function* readSlice(body, range) {
  let offset = 0;
  for await (const chunk of Readable.fromWeb(body)) {
    const start = Math.max(0, range.start - offset);
    const end = Math.min(chunk.length, range.end + 1 - offset);
    offset += chunk.length;
    if (start < end) yield chunk.subarray(start, end);
    if (offset > range.end) return;
  }
  throw new Error('Matrix media ended before the requested range');
}

async function spoolMedia(body, signal, filename) {
  await pipeline(Readable.fromWeb(body), byteLimit(MAX_MEDIA_BYTES), createWriteStream(filename), { signal });
  return (await stat(filename)).size;
}

async function normalizeSvg(body) {
  const chunks = [];
  let length = 0;
  for await (const chunk of Readable.fromWeb(body)) {
    length += chunk.length;
    if (length > MAX_SVG_BYTES) throw new Error('Matrix SVG exceeds size limit');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, length);
  const text = bytes.toString('utf8');
  const svg = /<svg\b([^>]*)>/i.exec(text);
  if (!svg || /\bviewBox\s*=/i.test(svg[1])) return bytes;
  const width = /\bwidth\s*=\s*["']?([0-9.]+)(?:px)?["']?/i.exec(svg[1]);
  const height = /\bheight\s*=\s*["']?([0-9.]+)(?:px)?["']?/i.exec(svg[1]);
  if (!(Number(width?.[1]) > 0 && Number(height?.[1]) > 0)) return bytes;
  return Buffer.from(text.replace(svg[0], '<svg' + svg[1] + ' viewBox="0 0 ' + width[1] + ' ' + height[1] + '">'));
}

function formatContentDisposition(filename) {
  if (!filename) return 'attachment';
  const cleanName = filename.replace(/[\r\n\0]/g, '').trim();
  if (!cleanName) return 'attachment';
  const asciiName = cleanName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const utf8Name = encodeURIComponent(cleanName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`;
}

export function createMatrixMediaHandler({ baseUrl, token }) {
  let active = 0;
  return async function handleMatrixMedia(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const parts = /^\/api\/media\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
    if (!parts) return fail(res, 400, 'Invalid Matrix media address');

    let encodedPath;
    try {
      const server = decodeURIComponent(parts[1]);
      const media = decodeURIComponent(parts[2]);
      if (!/^[A-Za-z0-9.:[\]-]+$/.test(server) || !/^[A-Za-z0-9._~-]+$/.test(media) ||
          media === '.' || media === '..' || server.includes('..') || server.startsWith('.')) throw new Error('invalid Matrix media address');
      encodedPath = encodeURIComponent(server) + '/' + encodeURIComponent(media);
    } catch {
      return fail(res, 400, 'Invalid Matrix media address');
    }

    let requestedFilename = '';
    try {
      const reqUrl = new URL(req.url, 'http://localhost');
      const queryName = reqUrl.searchParams.get('filename') || reqUrl.searchParams.get('name');
      const pathName = parts[3] ? decodeURIComponent(parts[3]) : '';
      requestedFilename = (queryName || pathName || '').trim().replace(/[/\\?%*:|"<>]/g, '_');
    } catch {}

    const range = req.method === 'GET' && !req.headers['if-range'] ? req.headers.range : undefined;
    if (range !== undefined && !/^bytes=(?:\d+-\d*|-\d+)$/i.test(range)) {
      return fail(res, 400, 'Only one byte range is supported');
    }
    if (active >= MAX_CONCURRENT) return fail(res, 503, 'Matrix media service busy');

    active += 1;
    const abort = new AbortController();
    const disconnect = () => abort.abort();
    const headerTimer = setTimeout(() => abort.abort(), HEADER_TIMEOUT);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(MEDIA_TIMEOUT)]);
    res.once('close', disconnect);
    let upstream;
    let directory;
    try {
      upstream = await fetch(baseUrl + '/_matrix/client/v1/media/download/' + encodedPath, {
        headers: { Authorization: 'Bearer ' + token, 'Accept-Encoding': 'identity', ...(range && { Range: range }) },
        signal,
      });
      clearTimeout(headerTimer);
      const upstreamRange = upstream.headers.get('content-range');
      if (!upstream.ok) {
        return fail(res, upstream.status, 'Matrix media unavailable', /^bytes \*\/\d+$/.test(upstreamRange || '') ? upstreamRange : null);
      }
      if (!upstream.body || ![200, 206].includes(upstream.status)) throw new Error('Unexpected Matrix media response');
      const encoding = upstream.headers.get('content-encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') throw new Error('Unexpected Matrix media encoding');

      const type = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
      const inline = SAFE_INLINE.test(type);
      const headers = {
        ...safeHeaders,
        'Content-Type': inline ? type : 'application/octet-stream',
        'Cache-Control': 'public, max-age=604800, immutable',
        ...(inline ? {} : { 'Content-Disposition': formatContentDisposition(requestedFilename) }),
      };
      let length = lengthHeader(upstream.headers.get('content-length'));
      if (length > MAX_MEDIA_BYTES) return fail(res, 413, 'Matrix media exceeds size limit');

      if (upstream.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(upstreamRange || '');
        if (!range || !match) throw new Error('Unexpected partial Matrix media response');
        const [, first, last, total] = match;
        const size = Number(total);
        const expected = parseRange(range, size);
        const span = Number(last) - Number(first) + 1;
        if (!Number.isSafeInteger(size) || size <= 0 || !expected ||
            Number(first) !== expected.start || Number(last) !== expected.end ||
            (length !== null && length !== span)) throw new Error('Invalid Matrix Content-Range');
        if (span > MAX_MEDIA_BYTES) return fail(res, 413, 'Matrix media exceeds size limit');
        res.writeHead(206, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': upstreamRange, 'Content-Length': span });
        await pipeline(Readable.fromWeb(upstream.body), byteLimit(span), res, { signal });
        return;
      }

      let svg;
      let file;
      if (type === 'image/svg+xml' && req.method === 'GET') {
        svg = await normalizeSvg(upstream.body);
        length = svg.length;
      } else if (range && length === null) {
        directory = await mkdtemp(join(tmpdir(), 'chat-matrix-media-'));
        file = join(directory, 'media');
        length = await spoolMedia(upstream.body, signal, file);
      }
      const slice = range ? (length > 0 && parseRange(range, length)) : null;
      if (slice === false) return fail(res, 416, 'Invalid media range', 'bytes */' + length);
      if (length !== null) {
        headers['Accept-Ranges'] = 'bytes';
        headers['Content-Length'] = slice ? slice.end - slice.start + 1 : length;
      }
      if (slice) headers['Content-Range'] = 'bytes ' + slice.start + '-' + slice.end + '/' + length;

      if (req.method === 'HEAD') {
        // SVG GET may add a viewBox, which changes its length.
        if (type === 'image/svg+xml') {
          delete headers['Content-Length'];
          delete headers['Accept-Ranges'];
        }
        res.writeHead(200, headers).end();
        return;
      }
      res.writeHead(slice ? 206 : 200, headers);
      if (svg) {
        res.end(slice ? svg.subarray(slice.start, slice.end + 1) : svg);
      } else if (file) {
        await pipeline(createReadStream(file, slice || undefined), res, { signal });
      } else if (slice) {
        await pipeline(Readable.from(readSlice(upstream.body, slice)), res, { signal });
      } else {
        await pipeline(Readable.fromWeb(upstream.body), byteLimit(MAX_MEDIA_BYTES), res, { signal });
      }
    } catch {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else fail(res, abort.signal.aborted || signal.aborted ? 504 : 502, 'Matrix media proxy failed');
    } finally {
      clearTimeout(headerTimer);
      res.removeListener('close', disconnect);
      if (upstream?.body && !upstream.body.locked) await upstream.body.cancel().catch(() => {});
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      active -= 1;
    }
  };
}
