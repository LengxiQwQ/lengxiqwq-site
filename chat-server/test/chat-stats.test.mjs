import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ChatDatabase } from '../src/db/database.mjs';
import {
  analyzeMessageFeatures,
  backfillReactionsFromMessages,
  ChatStatsEngine,
  dayKeyToRangeMs,
  removeReactionRecord,
  toDayKey,
  upsertReactionRecord,
} from '../src/chat-stats.mjs';

test('toDayKey & dayKeyToRangeMs respect UTC+8 boundary', () => {
  const r = dayKeyToRangeMs('2026-11-26', 480);
  assert.ok(r);
  assert.equal(r.endMs - r.startMs, 86_400_000);
  assert.equal(toDayKey(r.startMs, 480), '2026-11-26');
  assert.equal(toDayKey(r.startMs - 1, 480), '2026-11-25');
  assert.equal(toDayKey(r.endMs - 1, 480), '2026-11-26');
  assert.equal(toDayKey(r.endMs, 480), '2026-11-27');
});

test('analyzeMessageFeatures normalizes 5 sticker forms and excludes share covers from images', () => {
  const f1 = analyzeMessageFeatures(':snow_snow-03: 哈哈', []);
  assert.equal(f1.stickerCount, 1);
  assert.equal(f1.stickers[0].key, 'sticker:snow:snow-03');
  assert.equal(f1.charCount, 2);

  const f2 = analyzeMessageFeatures('![mx-sticker:snow-03](https://chat-server.lengxiqwq.com/api/media/matrix.rainzt.cn/abc)', []);
  assert.equal(f2.stickerCount, 1);
  assert.equal(f2.stickers[0].key, 'sticker:snow:snow-03');
  assert.equal(f2.imageCount, 0);

  const f3 = analyzeMessageFeatures('', [{ type: 'image', name: 'snow-03', url: 'https://example.com/snow-03', isSticker: true }]);
  assert.equal(f3.stickerCount, 1);
  assert.equal(f3.stickers[0].key, 'sticker:snow:snow-03');
  assert.equal(f3.imageCount, 0);

  const f4 = analyzeMessageFeatures('[lottie:caigou] [lottie:caigou]', []);
  assert.equal(f4.stickerCount, 2);
  assert.equal(f4.stickers[0].key, 'lottie:caigou');
  assert.equal(f4.stickers[0].kind, 'lottie');

  const shareMsg = `[LX:音乐分享]\n> 🎵 Miku\n> ![封面](https://y.gtimg.cn/cover.jpg)\n<!--lx-music:eyJ0ZXN0IjoxfQ-->`;
  const f5 = analyzeMessageFeatures(shareMsg, []);
  assert.equal(f5.shareKind, '音乐分享');
  assert.equal(f5.imageCount, 0);
  assert.ok(f5.charCount < 20);

  const photoMsg = `看看新壁纸 ![壁纸](https://img.example.com/a.webp)`;
  const f6 = analyzeMessageFeatures(photoMsg, [{ type: 'image', url: 'https://img.example.com/b.webp' }]);
  assert.equal(f6.imageCount, 2);
  assert.equal(f6.stickerCount, 0);
});

test('ChatStatsEngine aggregates day, 3d, week, reactions, and music with daily cache', () => {
  const chatDb = new ChatDatabase(':memory:');
  const db = chatDb.db;

  const day1 = dayKeyToRangeMs('2026-11-25', 480).startMs + 10 * 3600_000;
  const day2 = dayKeyToRangeMs('2026-11-26', 480).startMs + 14 * 3600_000;

  chatDb.insertMessage({
    id: 'e1',
    msgUid: 'm1',
    roomId: 'interconnect',
    kind: 'user',
    userKey: 'waline:1',
    name: '冷汐',
    content: '早安 :miku_诶嘿嘿:',
    createdAt: day1,
  });

  chatDb.insertMessage({
    id: 'e2',
    msgUid: 'm2',
    roomId: 'interconnect',
    kind: 'user',
    userKey: 'matrix:@xue:matrix.rainzt.cn',
    name: '艾雪',
    content: '',
    attachments: [{ type: 'image', url: 'https://img.test/p1.png' }, { type: 'image', name: 'snow-03', url: 'https://img.test/s.webp', isSticker: true }],
    createdAt: day2,
  });

  chatDb.insertMessage({
    id: 'e3',
    msgUid: 'm3',
    roomId: 'interconnect',
    kind: 'user',
    userKey: 'matrix:@xue:matrix.rainzt.cn',
    name: '艾雪',
    content: ':snow_snow-03: 发第二张',
    createdAt: day2 + 60_000,
  });

  chatDb.recordSongRequest({
    roomId: 'interconnect',
    track: { id: 'qq:001', provider: 'qq', title: 'World is Mine', artist: 'supercell', cover: 'https://c.test/1.jpg' },
    requesterKey: 'waline:1',
    requesterName: '冷汐',
    requestedAt: day2 + 120_000,
    requestUid: 'req1',
  });

  backfillReactionsFromMessages(db, {
    interconnect: [
      { msgUid: 'm2', matrixEventId: 'e2', createdAt: day2 + 5000, reactions: { '👍': ['waline:1'] } },
    ],
  });
  upsertReactionRecord(db, { messageEventId: 'e3', senderKey: 'waline:1', reactionKey: '😂', createdAt: day2 + 70_000 });
  upsertReactionRecord(db, { messageEventId: 'e3', senderKey: 'waline:1', reactionKey: '👀', createdAt: day2 + 71_000 });
  removeReactionRecord(db, { messageEventId: 'e3', senderKey: 'waline:1', reactionKey: '👀' });

  const engine = new ChatStatsEngine({ db });

  const day2Stats = engine.getStats({ room: 'interconnect', range: 'day', date: '2026-11-26', tzOffset: 480 });
  assert.equal(day2Stats.summary.messages, 2);
  assert.equal(day2Stats.summary.images, 1);
  assert.equal(day2Stats.summary.stickers, 2);
  assert.equal(day2Stats.summary.reactions, 2);
  assert.equal(day2Stats.summary.musicRequests, 1);
  assert.equal(day2Stats.timeline.length, 24);
  assert.equal(day2Stats.highlights.talkKing.userKey, 'matrix:@xue:matrix.rainzt.cn');
  assert.equal(day2Stats.highlights.imageKing.userKey, 'matrix:@xue:matrix.rainzt.cn');
  assert.equal(day2Stats.highlights.musicKing.userKey, 'waline:1');
  assert.equal(day2Stats.topStickers[0].key, 'sticker:snow:snow-03');
  assert.equal(day2Stats.topStickers[0].count, 2);
  assert.equal(day2Stats.previousSummary.messages, 1);

  const range3d = engine.getStats({ room: 'interconnect', range: '3d', date: '2026-11-26', tzOffset: 480 });
  assert.equal(range3d.timeline.length, 36);
  assert.equal(range3d.summary.messages, 3);
  assert.equal(range3d.summary.stickers, 3);

  // Cache hit verification for completed day
  const cachedRow = db.prepare('SELECT version FROM chat_daily_stats_cache WHERE room_id = ? AND day_key = ?').get('interconnect', '2026-11-25');
  assert.ok(cachedRow);

  engine.invalidateDay('interconnect', '2026-11-26', 480);
  const afterInvalidate = db.prepare('SELECT version FROM chat_daily_stats_cache WHERE room_id = ? AND day_key = ?').get('interconnect', '2026-11-26');
  assert.equal(afterInvalidate, undefined);

  chatDb.close();
});
