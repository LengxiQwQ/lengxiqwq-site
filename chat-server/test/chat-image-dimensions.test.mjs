import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatImageLayout, validateChatImageDimensions } from '../../src/components/pages/chat/chatImageLayout.ts';
import { imageDimensions, withHistoryImageDimensions } from '../src/chat-image-dimensions.mjs';
import { ChatDatabase } from '../src/db/database.mjs';

test('preview geometry preserves wide and tall aspect ratios under the size caps', () => {
  assert.deepEqual(chatImageLayout({ width: 3200, height: 800 }), {
    ratio: 4, maxWidthRem: 14, intrinsicWidth: 3200
  });
  assert.deepEqual(chatImageLayout({ width: 400, height: 3200 }), {
    ratio: 0.125, maxWidthRem: 1.375, intrinsicWidth: 400
  });
  assert.deepEqual(chatImageLayout({ width: 32, height: 32 }), {
    ratio: 1, maxWidthRem: 11, intrinsicWidth: 32
  });
  assert.equal(chatImageLayout().maxWidthRem, 10);
});

test('untrusted or incomplete dimension pairs are ignored', () => {
  for (const pair of [[0, 40], [10, undefined], [NaN, 12], [10.5, 80], ['40', 80], [100_001, 1]]) {
    assert.deepEqual(imageDimensions(...pair), {});
    assert.equal(validateChatImageDimensions(...pair), undefined);
  }
});

test('new attachment sizes survive SQLite persistence and history reads', () => {
  const db = new ChatDatabase(':memory:');
  try {
    const attachments = [{ type: 'image', url: 'https://example.com/new.jpg', width: 1200, height: 960 }];
    db.insertMessage({ roomId: 'chat', msgUid: 'image-message', content: '', attachments, createdAt: 1000 });
    assert.deepEqual(db.getMessages({ roomId: 'chat', limit: 1 })[0].attachments, attachments);
  } finally {
    db.close();
  }
});

test('historical attachment and inline sizes can be added without changing the message', () => {
  const known = 'https://example.com/known.jpg';
  const legacy = 'https://example.com/legacy.jpg';
  const inline = 'https://example.com/body.jpg';
  const sticker = 'https://example.com/sticker.gif';
  const message = {
    content: `![图片](<${inline}> "标题")`,
    attachments: [
      { type: 'image', url: legacy },
      { type: 'image', url: sticker, isSticker: true },
      { type: 'image', url: known, width: 40, height: 20 }
    ]
  };
  const sizes = {
    [legacy]: { width: 60, height: 50 },
    [inline]: { width: 40, height: 80 },
    [sticker]: { width: 20, height: 20 },
    [known]: { width: 10, height: 10 }
  };
  const result = withHistoryImageDimensions(message, sizes);
  assert.deepEqual(result.attachments[0], { ...message.attachments[0], ...sizes[legacy] });
  assert.equal(result.attachments[1], message.attachments[1]);
  assert.equal(result.attachments[2], message.attachments[2]);
  assert.deepEqual(result.inlineImageDimensions[inline], sizes[inline]);
  assert.equal(message.attachments[0].width, undefined);
  assert.equal(withHistoryImageDimensions(message, {}), message);
});
