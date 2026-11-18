// Entire filesystem and upstream are in memory; no test server or production request.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { Readable, Writable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as crypto from 'node:crypto';
import path from 'node:path';

async function fixture() {
  const files = new Map();
  let fetches = 0;
  const media = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4093, 7)]);
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
  const fs = {
    mkdir: async () => {}, readdir: async () => [], utimes: async () => {},
    readFile: async name => { if (!files.has(name)) throw missing(); return files.get(name).toString(); },
    writeFile: async (name, data) => { files.set(name, Buffer.from(data)); },
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    unlink: async name => { files.delete(name); },
    open: async name => {
      const data = files.get(name); if (!data) throw missing();
      return {
        stat: async () => ({ size: data.length }), close: async () => {},
        read: async (buffer, offset, length, position) => ({ bytesRead: data.copy(buffer, offset, position, position + length) }),
        createReadStream: ({ start = 0, end = data.length - 1 }) => Readable.from([data.subarray(start, end + 1)])
      };
    }
  };
  const context = vm.createContext({ Buffer, AbortController, AbortSignal, setTimeout, clearTimeout, console, process: { env: { CHAT_MUSIC_CACHE_DIR: '/memory' } } });
  const synthetic = values => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
  const deps = {
    'node:crypto': synthetic({ createHash: crypto.createHash }),
    'node:path': synthetic({ default: path }),
    'node:stream': synthetic({ Readable, Transform }),
    'node:stream/promises': synthetic({ pipeline }),
    'node:fs': synthetic({ promises: fs, createReadStream() {}, createWriteStream(name) {
      const chunks = [];
      return new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); }, final(done) { files.set(name, Buffer.concat(chunks)); done(); } });
    } }),
    './audio-source.mjs': synthetic({ identifyAudio: () => 'audio/mpeg', fetchAudio: async () => {
      fetches++;
      await new Promise(resolve => setTimeout(resolve, 30));
      return new Response(media, { status: 200, headers: { 'Content-Length': String(media.length), 'Content-Type': 'audio/mpeg' } });
    } })
  };
  deps['./stream-timeouts.mjs'] = new vm.SourceTextModule(await readFile(new URL('./candidate/src/music/stream-timeouts.mjs', import.meta.url), 'utf8'), { context });
  const module = new vm.SourceTextModule(await readFile(new URL('./candidate/src/music/stream-cache.mjs', import.meta.url), 'utf8'), { context });
  await module.link(name => deps[name]); await module.evaluate();
  const request = async (range, method = 'GET') => {
    const chunks = [];
    const res = new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); } });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; return res; };
    await module.namespace.handleStreamProxyRequest({ method, headers: range ? { range } : {} }, res, 'https://example.invalid/audio', '', 'audio/mpeg');
    return { status: res.status, headers: res.headers, body: Buffer.concat(chunks) };
  };
  return { request, media, fetches: () => fetches };
}

test('concurrent cold listeners share one upstream download, then receive exact 206 ranges', async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([f.request('bytes=0-99'), f.request('bytes=100-199')]);
  assert.equal(f.fetches(), 1);
  for (const response of [first, second]) {
    assert.equal(response.status, 206); assert.equal(response.headers['X-Audio-Cache'], 'HIT');
    assert.equal(response.body.length, 100);
  }
  assert.deepEqual(first.body, f.media.subarray(0, 100));
  assert.equal(second.headers['Content-Range'], 'bytes 100-199/4096');
  const head = await f.request(undefined, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body.length, 0);
  assert.equal(head.headers['Content-Length'], 4096); assert.equal(f.fetches(), 1);
  const invalid = await f.request('bytes=99999-');
  assert.equal(invalid.status, 416); assert.equal(invalid.headers['Content-Range'], 'bytes */4096');
});
