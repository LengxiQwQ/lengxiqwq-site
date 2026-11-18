import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { idleWatchdog, waitBounded } from './stream-timeouts.mjs';
import { fetchAudio, identifyAudio } from './audio-source.mjs';

const directory = process.env.CHAT_MUSIC_CACHE_DIR || '/opt/chat-server/data/music_cache';
const MAX_BYTES = 500 * 1024 * 1024;
const MAX_FILE = 32 * 1024 * 1024;
const MAX_FILES = 150;
const FETCH_TIMEOUT = 90_000;
const queue = [];
let downloading = 0;
const pending = new Map();
const active = new Map();
let cleanup;

function paths(url) {
  const key = createHash('sha256').update(url).digest('hex').slice(0, 32);
  return { key, audio: path.join(directory, key + '.audio'), meta: path.join(directory, key + '.meta.json') };
}

export function parseRange(header, size) {
  if (header === undefined) return null;
  const range = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!range || !(range[1] || range[2])) return false;
  const first = range[1] ? Number(range[1]) : null;
  const last = range[2] ? Number(range[2]) : null;
  if ([first, last].some(value => value !== null && !Number.isSafeInteger(value))) return false;
  if (first === null) return last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : false;
  const end = Math.min(last ?? size - 1, size - 1);
  return first <= end ? { start: first, end } : false;
}

async function openCached(files) {
  let file;
  try {
    const meta = JSON.parse(await fs.readFile(files.meta, 'utf8'));
    if (!meta.complete) return null;
    file = await fs.open(files.audio, 'r');
    const { size } = await file.stat();
    const prefix = Buffer.alloc(12);
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    const type = identifyAudio(prefix.subarray(0, bytesRead));
    if (size <= 0 || size !== meta.size || !type) throw new Error('invalid cached audio');
    return { file, size, type };
  } catch {
    await file?.close().catch(() => {});
    return null;
  }
}

export async function hasCachedAudio(url) {
  const cached = await openCached(paths(url));
  if (!cached) return false;
  await cached.file.close();
  return true;
}

async function trimCache() {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = (await Promise.all(entries
    .filter(item => item.isFile() && /^[a-f0-9]{32}\.audio$/.test(item.name))
    .map(async item => {
      const audio = path.join(directory, item.name);
      const stat = await fs.stat(audio).catch(() => null);
      return stat && { audio, stat, key: item.name.slice(0, 32) };
    }))).filter(Boolean).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  let size = files.reduce((sum, item) => sum + item.stat.size, 0);
  let count = files.length;
  for (const item of files) {
    if (size <= MAX_BYTES && count <= MAX_FILES) break;
    if (pending.has(item.key) || active.has(item.key)) continue;
    if (await fs.unlink(item.audio).then(() => true, () => false)) {
      await fs.unlink(path.join(directory, item.key + '.meta.json')).catch(() => {});
      size -= item.stat.size;
      count--;
    }
  }
}

export function maintainAudioCache() {
  cleanup ??= fs.mkdir(directory, { recursive: true }).then(trimCache)
    .catch(error => console.warn('[StreamCache] cleanup:', error.message))
    .finally(() => { cleanup = undefined; });
  return cleanup;
}

function drainPrefetch() {
  while (downloading < 2 && queue.length) {
    const job = queue.shift();
    downloading++;
    job.run().finally(() => { downloading--; job.done(); drainPrefetch(); });
  }
}

export function prefetchAudio(url, priority = false) {
  const files = paths(url);
  if (pending.has(files.key)) {
    if (priority) {
      const index = queue.findIndex(job => job.key === files.key);
      if (index > 0) queue.unshift(queue.splice(index, 1)[0]);
    }
    return pending.get(files.key);
  }
  if (pending.size >= 12) return Promise.resolve();
  let done;
  const task = new Promise(resolve => { done = resolve; });
  pending.set(files.key, task);
  const run = async () => {
    const cached = await openCached(files);
    if (cached) {
      await cached.file.close();
      return;
    }
    const part = files.audio + '.part';
    const metaPart = files.meta + '.part';
    try {
      await fs.mkdir(directory, { recursive: true });
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(FETCH_TIMEOUT)]);
      const headerTimer = setTimeout(() => controller.abort(new Error('prefetch first-byte timeout')), 10_000);
      let upstream;
      try { upstream = await fetchAudio(url, { signal }); }
      finally { clearTimeout(headerTimer); }
      const length = Number(upstream.headers.get('content-length'));
      if (upstream.status !== 200 || !upstream.body || length > MAX_FILE) {
        await upstream.body?.cancel();
        throw new Error('invalid prefetch response HTTP ' + upstream.status);
      }
      let size = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length;
          done(size > MAX_FILE ? new Error('audio file too large') : null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(upstream.body), limiter, createWriteStream(part), { signal });
      const file = await fs.open(part, 'r');
      const prefix = Buffer.alloc(12);
      let type;
      try {
        await file.read(prefix, 0, prefix.length, 0);
        type = identifyAudio(prefix);
      } finally {
        await file.close();
      }
      if (!type || size < 12 || (length && size !== length)) throw new Error('invalid audio cache entry');
      await fs.rename(part, files.audio);
      await fs.writeFile(metaPart, JSON.stringify({ complete: true, size }));
      await fs.rename(metaPart, files.meta);
      void maintainAudioCache();
    } catch (error) {
      console.warn('[StreamCache] prefetch:', files.key, error.message);
    } finally {
      await Promise.all([part, metaPart].map(file => fs.unlink(file).catch(() => {})));
    }
  };
  const job = {
    key: files.key,
    run: () => run().catch(error => console.warn('[StreamCache] prefetch:', files.key, error.message))
      .finally(() => pending.delete(files.key)),
    done
  };
  if (priority) queue.unshift(job);
  else queue.push(job);
  drainPrefetch();
  return task;
}

const responseHeaders = {
  'Cache-Control': 'private, max-age=3600, no-transform',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, X-Audio-Cache',
  'X-Content-Type-Options': 'nosniff'
};

export async function handleStreamProxyRequest(req, res, url, _referer, mimeType) {
  const files = paths(url);
  const range = req.headers.range;
  const abort = new AbortController();
  const disconnect = () => abort.abort();
  res.once('close', disconnect);
  const signal = abort.signal;
  const idle = idleWatchdog(abort);
  const progress = new Transform({ transform(chunk, _encoding, done) { idle.touch(); done(null, chunk); } });
  active.set(files.key, (active.get(files.key) || 0) + 1);
  let cached;
  try {
    cached = await openCached(files);
    if (!cached && req.method !== 'HEAD') {
      // All first listeners share one download. Bound the wait so a slow source cannot
      // indefinitely hold startup; the normal Range path remains a fallback.
      await waitBounded(prefetchAudio(url, true), 2500, signal);
      if (signal.aborted) return;
      cached = await openCached(files);
    }
    if (cached) {
      const { size, type, file } = cached;
      const slice = parseRange(range, size);
      if (slice === false) {
        res.writeHead(416, { ...responseHeaders, 'Content-Range': 'bytes */' + size });
        res.end();
        return;
      }
      const now = new Date();
      void fs.utimes(files.audio, now, now).catch(() => {});
      res.writeHead(slice ? 206 : 200, {
        ...responseHeaders,
        'X-Audio-Cache': 'HIT',
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Length': slice ? slice.end - slice.start + 1 : size,
        ...(slice && { 'Content-Range': 'bytes ' + slice.start + '-' + slice.end + '/' + size })
      });
      if (req.method === 'HEAD') res.end();
      else await pipeline(file.createReadStream({ ...slice, autoClose: false, start: slice?.start ?? 0 }), progress, res, { signal });
      return;
    }

    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/i.test(range)) {
      res.writeHead(400, responseHeaders).end();
      return;
    }
    const headerTimer = setTimeout(() => abort.abort(new Error('audio first-byte timeout')), 10_000);
    let upstream;
    try { upstream = await fetchAudio(url, { range, signal }); }
    finally { clearTimeout(headerTimer); }
    idle.touch();
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel();
      const contentRange = upstream.headers.get('content-range');
      res.writeHead(upstream.status, {
        ...responseHeaders,
        'Content-Type': 'application/json',
        ...(contentRange && { 'Content-Range': contentRange })
      });
      res.end(JSON.stringify({ ok: false, error: '上游音频服务返回 ' + upstream.status }));
      return;
    }

    const type = upstream.headers.get('content-type')?.split(';')[0]?.trim();
    if (type?.includes('json') || type?.includes('html') ||
        (upstream.status === 206 && !/^bytes \d+-\d+\/\d+$/.test(upstream.headers.get('content-range') || ''))) {
      await upstream.body.cancel();
      throw new Error('invalid audio response');
    }
    const headers = { ...responseHeaders, 'X-Audio-Cache': 'MISS', 'Content-Type': mimeType || 'audio/mpeg' };
    for (const key of ['content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(key);
      if (value) headers[key] = value;
    }
    res.writeHead(upstream.status, headers);
    if (req.method === 'HEAD') {
      await upstream.body.cancel();
      res.end();
    } else {
      await pipeline(Readable.fromWeb(upstream.body), progress, res, { signal });
    }
  } catch (error) {
    if (!abort.signal.aborted) console.warn('[StreamCache] response:', files.key, error.message);
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else res.writeHead(502, { ...responseHeaders, 'Content-Type': 'application/json' })
      .end(JSON.stringify({ ok: false, error: '音源暂时不可用' }));
  } finally {
    idle.stop();
    await cached?.file.close().catch(() => {});
    res.removeListener('close', disconnect);
    const count = active.get(files.key) - 1;
    if (count) active.set(files.key, count);
    else active.delete(files.key);
  }
}
