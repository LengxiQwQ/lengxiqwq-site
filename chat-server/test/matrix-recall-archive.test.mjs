import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createMatrixRecallArchive } from '../src/matrix-recall-archive.mjs';

test('Matrix media is copied to the private archive and served only with a signed URL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chat-recall-archive-'));
  const originalFetch = globalThis.fetch;
  try {
    const bytes = Buffer.from('private image bytes');
    globalThis.fetch = async () => new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length) },
    });
    const archive = createMatrixRecallArchive({
      directory,
      baseUrl: 'http://127.0.0.1:6167',
      token: 'test-matrix-token',
      signingSecret: 'test-signing-secret',
    });
    const original = {
      msgUid: 'recalled-image',
      createdAt: 1000,
      content: '',
      attachments: [
        { type: 'image', url: 'mxc://matrix.lengxiqwq.com/media123' },
        { type: 'image', url: 'https://lengxiqwq.com/uploads/site-image.png' },
      ],
    };
    const archived = await archive.archiveMessage(original, 'interconnect:recalled-image');
    const mediaId = createHash('sha256')
      .update('interconnect:recalled-image:0:url:mxc://matrix.lengxiqwq.com/media123')
      .digest('hex');
    assert.equal(archived.attachments[0].url, `recall-media://${mediaId}`);
    assert.deepEqual(await readFile(join(directory, 'recall-media', mediaId)), bytes);
    const directMediaId = createHash('sha256')
      .update('interconnect:recalled-image:1:url:https://lengxiqwq.com/uploads/site-image.png')
      .digest('hex');
    assert.equal(archived.attachments[1].url, `recall-media://${directMediaId}`);
    assert.equal(archived.recallArchiveIncomplete, undefined);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'recall-media', `${mediaId}.json`), 'utf8')), {
      contentType: 'image/png',
      size: bytes.length,
    });

    const hydrated = archive.hydrateMessage(archived);
    const signedUrl = new URL(hydrated.attachments[0].url);
    assert.equal(signedUrl.hostname, 'chat-server.lengxiqwq.com');
    assert.equal(signedUrl.pathname, `/api/chat/recall-media/${mediaId}`);

    let deniedStatus = 0;
    await archive.handleRequest(
      { method: 'GET', url: `${signedUrl.pathname}?expires=${signedUrl.searchParams.get('expires')}&signature=bad` },
      { writeHead(status) { deniedStatus = status; return this; }, end() {} },
      signedUrl.pathname,
    );
    assert.equal(deniedStatus, 403);

    const chunks = [];
    let servedStatus = 0;
    const response = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    response.writeHead = (status) => { servedStatus = status; return response; };
    response.once('finish', () => {});
    await archive.handleRequest(
      { method: 'GET', url: signedUrl.pathname + signedUrl.search, headers: {} },
      response,
      signedUrl.pathname,
    );
    if (!response.writableFinished) await new Promise((resolve) => response.once('finish', resolve));
    assert.equal(servedStatus, 200);
    assert.deepEqual(Buffer.concat(chunks), bytes);

    const unarchived = await archive.archiveMessage({
      msgUid: 'external-image',
      content: '',
      attachments: [{ type: 'image', url: 'https://untrusted.example/image.png' }],
    }, 'interconnect:external-image');
    assert.equal(unarchived.recallArchiveIncomplete, true);
    assert.equal(unarchived.attachments[0].archiveFailed, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
