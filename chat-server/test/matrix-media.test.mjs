import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createMatrixMediaHandler } from '../src/matrix-media.mjs';
import {
  historicalReplyAttachmentFields,
  matrixReplyAttachmentFields,
  replyAttachmentFields,
} from '../src/chat-attachment-kind.mjs';

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, baseUrl: 'http://127.0.0.1:' + server.address().port };
}

test('Matrix media proxy range responses, original images and failures', async (t) => {
  const video = Buffer.from('0123456789abcdef');
  const svg = '<svg width="10" height="20"></svg>';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=', 'base64');
  let finishStreaming;
  const upstream = await listen((req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-only') return res.writeHead(403).end();
    const id = req.url.split('/').pop();
    switch (id) {
      case 'range':
        if (req.headers.range !== 'bytes=2-4') return res.writeHead(400).end();
        return res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-4/16' })
          .end(video.subarray(2, 5));
      case 'bad-range':
        return res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 3-5/16' })
          .end(video.subarray(3, 6));
      case 'full':
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length });
        res.write(video.subarray(0, 4));
        return setImmediate(() => res.end(video.subarray(4)));
      case 'streaming':
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': video.length });
        res.write(video.subarray(0, 4));
        finishStreaming = () => res.end(video.subarray(4));
        return;
      case 'chunked':
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        res.write(video.subarray(0, 4));
        return setImmediate(() => res.end(video.subarray(4)));
      case 'png':
        return res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }).end(png);
      case 'svg':
        return res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': svg.length }).end(svg);
      case 'html':
        return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<script>throw new Error()</script>');
      default:
        return res.writeHead(404).end();
    }
  });
  const proxy = await listen((req, res) => handler(req, res, new URL(req.url, 'http://fixture').pathname));
  const handler = createMatrixMediaHandler({ baseUrl: upstream.baseUrl, token: 'fixture-only' });
  t.after(() => {
    proxy.server.closeAllConnections();
    proxy.server.close();
    upstream.server.closeAllConnections();
    upstream.server.close();
  });
  const url = (id) => proxy.baseUrl + '/api/media/example.org/' + id;
  const get = (id, range) => fetch(url(id), { headers: range ? { Range: range } : undefined });

  await t.test('passes through a valid upstream 206; rejects an unrelated partial response', async () => {
    const res = await get('range', 'bytes=2-4');
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 2-4/16');
    assert.equal(res.headers.get('content-length'), '3');
    assert.equal(await res.text(), '234');
    assert.equal((await get('bad-range', 'bytes=2-4')).status, 502);
  });

  await t.test('serves exact ranges when the homeserver returns a full file', async () => {
    for (const [id, range, expected, header] of [
      ['full', 'bytes=0-1', '01', 'bytes 0-1/16'],
      ['full', 'bytes=5-', '56789abcdef', 'bytes 5-15/16'],
      ['full', 'bytes=-3', 'def', 'bytes 13-15/16'],
      ['full', 'bytes=14-99', 'ef', 'bytes 14-15/16'],
      ['chunked', 'bytes=-3', 'def', 'bytes 13-15/16'],
    ]) {
      const res = await get(id, range);
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), header);
      assert.equal(await res.text(), expected);
    }
    const invalid = await get('full', 'bytes=16-');
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), 'bytes */16');
    assert.equal((await get('full', 'bytes=0-1,3-4')).status, 400);
  });

  await t.test('delivers the start of a response before the upstream finishes', async () => {
    try {
      const res = await fetch(url('streaming'), { signal: AbortSignal.timeout(2_000) });
      const reader = res.body.getReader();
      assert.equal(Buffer.from((await reader.read()).value).toString(), '0123');
      finishStreaming();
      assert.equal(Buffer.from((await reader.read()).value).toString(), '456789abcdef');
      assert.equal((await reader.read()).done, true);
    } finally {
      finishStreaming?.();
    }
  });

  await t.test('keeps full PNG bytes intact and supports HEAD and the existing SVG viewBox behavior', async () => {
    const res = await get('png');
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
    const head = await fetch(url('full'), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(video.length));
    assert.equal(await head.text(), '');
    const whole = await get('full');
    assert.equal(whole.status, 200);
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), video);
    assert.match(await (await get('svg')).text(), /viewBox="0 0 10 20"/);
  });

  await t.test('limits the public route to media reads and serves active files as attachments', async () => {
    const html = await get('html');
    assert.equal(html.headers.get('content-disposition'), 'attachment');
    assert.equal(html.headers.get('content-type'), 'application/octet-stream');
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
    const missing = await get('missing');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    assert.equal((await get('%2F')).status, 400);
    assert.equal((await fetch(url('png'), { method: 'POST' })).status, 405);
  });
});

test('reply metadata keeps video, audio, files, and mixed attachments distinct', () => {
  const legacy = { hasImage: true };
  for (const type of ['video', 'audio', 'file', 'image']) {
    const expected = { attachmentKind: type, hasImage: type === 'image' };
    assert.deepEqual(replyAttachmentFields([{ type }]), expected);
    assert.deepEqual(matrixReplyAttachmentFields({ content: { msgtype: 'm.' + type } }), expected);
    assert.deepEqual(historicalReplyAttachmentFields(legacy, { attachments: [{ type }] }), expected);
  }
  assert.deepEqual(replyAttachmentFields([{ type: 'image', isSticker: true }]), { attachmentKind: 'sticker', hasImage: true });
  assert.deepEqual(replyAttachmentFields([{ type: 'image' }, { type: 'video' }]), { attachmentKind: 'attachment', hasImage: false });
  assert.deepEqual(historicalReplyAttachmentFields(legacy), { attachmentKind: 'attachment', hasImage: false });
  assert.deepEqual(historicalReplyAttachmentFields(legacy, { attachments: [] }), { attachmentKind: null, hasImage: false });
});
