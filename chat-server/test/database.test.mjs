import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ChatDatabase } from '../src/db/database.mjs';

const TEST_DB_PATH = join(process.cwd(), 'chat-server/test/test_chat.db');

describe('ChatDatabase SQLite 核心测试', () => {
  let db;

  before(() => {
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    db = new ChatDatabase(TEST_DB_PATH);
  });

  after(() => {
    db.close();
    if (existsSync(TEST_DB_PATH)) rmSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_PATH + '-wal')) rmSync(TEST_DB_PATH + '-wal');
    if (existsSync(TEST_DB_PATH + '-shm')) rmSync(TEST_DB_PATH + '-shm');
  });

  test('数据库成功初始化并开启 WAL 模式', () => {
    assert.ok(existsSync(TEST_DB_PATH));
  });

  test('点歌入库与去重统计（永久无上限）', () => {
    const track1 = {
      id: 'qq:test_song_1',
      title: '青花瓷',
      artist: '周杰伦',
      album: '我很忙',
      durationSec: 239,
      cover: 'https://example.com/cover1.jpg'
    };

    // 第一次点歌
    const uid1 = db.recordSongRequest({
      roomId: 'chat',
      track: track1,
      requesterKey: 'user:lengxi',
      requesterName: '冷汐',
      requesterAvatar: 'https://example.com/avatar.jpg',
      requestedAt: 1000
    });
    assert.ok(uid1);

    // 第二次点歌（同一首歌）
    const uid2 = db.recordSongRequest({
      roomId: 'chat',
      track: track1,
      requesterKey: 'user:guantou',
      requesterName: 'GuanT0u',
      requesterAvatar: 'https://example.com/avatar2.jpg',
      requestedAt: 2000
    });
    assert.ok(uid2);

    // 查全量历史
    const resAll = db.getMusicHistoryPage({ roomId: 'chat', type: 'request', sort: 'recent' });
    assert.equal(resAll.total, 1);
    assert.equal(resAll.items[0].requestCount, 2);
    assert.equal(resAll.items[0].lastRequesterName, 'GuanT0u');
    assert.equal(resAll.items[0].lastRequestedAt, 2000);

    // 按人筛选查历史
    const resUser = db.getMusicHistoryPage({ roomId: 'chat', type: 'request', requesterKey: 'user:lengxi' });
    assert.equal(resUser.total, 1);
    assert.equal(resUser.items[0].requestCount, 1);
    assert.equal(resUser.items[0].lastRequesterName, '冷汐');
  });

  test('歌单创建与单曲保存与查询', () => {
    const plId = 'pl_test_01';
    db.upsertPlaylist({
      id: plId,
      title: '冷汐的宝藏歌单',
      creatorKey: 'user:lengxi',
      creatorName: '冷汐',
      isPublic: 1
    });

    const tracks = [
      { id: 'qq:1', title: 'Song 1', artist: 'Artist 1' },
      { id: 'qq:2', title: 'Song 2', artist: 'Artist 2' }
    ];
    db.savePlaylistTracks(plId, tracks);

    const savedTracks = db.getPlaylistTracks(plId);
    assert.equal(savedTracks.length, 2);
    assert.equal(savedTracks[0].title, 'Song 1');
    assert.equal(savedTracks[1].title, 'Song 2');
  });

  test('聊天消息存取与分页', () => {
    for (let i = 1; i <= 10; i++) {
      db.insertMessage({
        roomId: 'interconnect',
        id: `msg_${i}`,
        userKey: 'user:1',
        name: 'Tester',
        content: `Hello ${i}`,
        createdAt: 1000 + i
      });
    }

    const msgs = db.getMessages({ roomId: 'interconnect', limit: 5 });
    assert.equal(msgs.length, 5);
    // getMessages 返回按时间升序（供前端从上到下展示）
    assert.equal(msgs[msgs.length - 1].content, 'Hello 10');
  });

  test('撤回存档保留原文与附件并按消息时间读取', () => {
    const original = {
      id: 42,
      msgUid: 'recall-archive-test',
      kind: 'user',
      userKey: 'user:test',
      name: 'Tester',
      content: '这段内容撤回后仍留在私有存档',
      attachments: [{ type: 'image', url: 'recall-media://fixture' }],
      createdAt: 1200
    };
    db.storeRecallCandidate({ roomId: 'interconnect', message: original });
    assert.equal(db.getRecalledMessages({ roomId: 'interconnect', msgUids: [original.msgUid] }).length, 0);
    assert.equal(db.archiveRecalledMessage({
      roomId: 'interconnect',
      message: original,
      recalledByKey: 'user:owner',
      recalledByName: 'Owner',
      recalledAt: 1500
    }), true);

    db.insertMessage({ ...original, roomId: 'interconnect', isRedacted: true });
    const publicMessage = db.getMessages({ roomId: 'interconnect', limit: 100 })
      .find((message) => message.msgUid === original.msgUid);
    assert.equal(publicMessage.content, '此消息已撤回');
    assert.equal(publicMessage.attachments, undefined);

    const [stored] = db.getRecalledMessages({ roomId: 'interconnect', msgUids: [original.msgUid] });
    assert.equal(stored.content, original.content);
    assert.deepEqual(stored.attachments, original.attachments);
    assert.equal(stored.isRedacted, true);
    assert.equal(stored.recalledByKey, 'user:owner');
    assert.equal(stored.recalledAt, 1500);
    assert.equal(db.getRecalledMessages({ roomId: 'chat', msgUids: [original.msgUid] }).length, 0);
  });

  test('撤回存档在关闭并重新打开数据库后仍存在', () => {
    const archivePath = join(process.cwd(), 'chat-server/test/test_recall_restart.db');
    for (const suffix of ['', '-wal', '-shm']) {
      const target = archivePath + suffix;
      if (existsSync(target)) rmSync(target);
    }
    let archiveDb = new ChatDatabase(archivePath);
    archiveDb.archiveRecalledMessage({
      roomId: 'chat',
      message: { msgUid: 'restart-recall', createdAt: 100, content: 'persisted', attachments: [] },
      recalledByKey: 'waline:1',
      recalledByName: 'Owner',
      recalledAt: 200
    });
    archiveDb.close();
    archiveDb = new ChatDatabase(archivePath);
    assert.equal(archiveDb.getRecalledMessages({ roomId: 'chat', msgUids: ['restart-recall'] })[0].content, 'persisted');
    archiveDb.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const target = archivePath + suffix;
      if (existsSync(target)) rmSync(target);
    }
  });

  test('系统 KV 存储', () => {
    db.setKv('room_topic:chat', { text: '欢迎来到聊天室！', updatedBy: 'admin' });
    const val = db.getKv('room_topic:chat');
    assert.equal(val.text, '欢迎来到聊天室！');
  });

  test('MusicManager 联动 ChatDatabase 分页查询', () => {
    // 验证 getMusicHistoryPage 正确返回数据库中的数据
    const resReq = db.getMusicHistoryPage({ roomId: 'chat', type: 'request', sort: 'recent' });
    assert.ok(resReq.ok);
    assert.equal(resReq.type, 'request');
    assert.ok(resReq.total >= 1);
    assert.ok(Array.isArray(resReq.items));

    // 验证 type: 'all' 查询
    const resAll = db.getMusicHistoryPage({ roomId: 'chat', type: 'all', sort: 'recent' });
    assert.ok(resAll.ok);
    assert.equal(resAll.type, 'all');
    assert.ok(resAll.total >= 1);
    assert.ok(Array.isArray(resAll.items));
  });

  test('全站音乐收藏与茶室星愿去重聚合', () => {
    const track = {
      id: 'qq:001favorite',
      sourcePlatform: 'qqmusic',
      sourceTrackId: '001favorite',
      title: '夜曲',
      artist: '周杰伦',
      album: '十一月的萧邦',
      cover: 'https://example.com/yequ.jpg',
      durationSec: 226,
      url: 'https://y.qq.com/n/ryqq/songDetail/001favorite'
    };

    // 1. 用户 A 收藏
    const res1 = db.toggleFavorite({
      track,
      userKey: 'user:lengxi',
      userName: '冷汐',
      userAvatar: 'https://example.com/lengxi.jpg'
    });
    assert.equal(res1.favorited, true);
    assert.equal(res1.favCount, 1);
    assert.equal(db.isFavorite('qq:001favorite', 'user:lengxi'), true);
    assert.equal(db.isFavorite('qq:001favorite', 'user:guantou'), false);

    // 2. 用户 B 收藏同一首歌
    const res2 = db.toggleFavorite({
      track,
      userKey: 'user:guantou',
      userName: 'GuanT0u',
      userAvatar: 'https://example.com/guantou.jpg'
    });
    assert.equal(res2.favorited, true);
    assert.equal(res2.favCount, 2);

    // 3. 用户 C 收藏另一首歌
    const track2 = {
      id: 'qq:002favorite',
      title: '七里香',
      artist: '周杰伦'
    };
    db.toggleFavorite({
      track: track2,
      userKey: 'user:lengxi',
      userName: '冷汐'
    });

    // 4. 查询茶室星愿全量聚合（去重，共 2 首不同曲目）
    const collective = db.getCollectiveFavorites({ sort: 'count' });
    assert.equal(collective.total, 2);
    // 夜曲有 2 人收藏，排在第一
    assert.equal(collective.items[0].id, 'qq:001favorite');
    assert.equal(collective.items[0].favCount, 2);
    assert.equal(collective.items[0].favoritedUsers.length, 2);
    assert.equal(collective.items[0].sourcePlatform, 'qqmusic');

    // 5. 按人筛选查询
    const guantouFavs = db.getCollectiveFavorites({ filterUserKey: 'user:guantou' });
    assert.equal(guantouFavs.total, 1);
    assert.equal(guantouFavs.items[0].id, 'qq:001favorite');
    // 依然保留所有人收藏的信息
    assert.equal(guantouFavs.items[0].favCount, 2);

    // 6. 查询客官筛选列表
    const favoriters = db.getCollectiveFavoriters();
    assert.ok(favoriters.length >= 2);
    assert.equal(favoriters[0].userKey, 'user:lengxi'); // 冷汐收藏了 2 首

    // 7. 查询冷汐个人收藏名片
    const userFavs = db.getUserFavorites({ userKey: 'user:lengxi' });
    assert.equal(userFavs.total, 2);

    // 8. 用户 A 再次 toggle 取消收藏
    const res3 = db.toggleFavorite({
      track,
      userKey: 'user:lengxi'
    });
    assert.equal(res3.favorited, false);
    assert.equal(res3.favCount, 1); // 还有 GuanT0u 收藏

    // 9. 管理员强制移出剩余收藏
    const adminRes = db.removeFavorite({ trackId: 'qq:001favorite', isAdmin: true });
    assert.equal(adminRes.ok, true);
    assert.equal(db.getFavoriteTrackStatus('qq:001favorite').favCount, 0);
  });

  test('不同来源的收藏汇入共享歌单，取消时保留其他成员的收藏', () => {
    const first = { id: 'qq:shared-test', title: '共享测试曲', artist: '测试歌手' };
    const alternate = { id: 'netease:shared-test', title: '共享测试曲', artist: '测试歌手' };
    db.toggleFavorite({ track: first, userKey: 'user:shared-a' });
    const added = db.toggleFavorite({ track: alternate, userKey: 'user:shared-b' });
    assert.equal(added.favCount, 2);
    let list = db.getCollectiveFavorites({ filterUserKey: 'user:shared-b' });
    assert.equal(list.total, 1);
    assert.equal(list.items[0].favCount, 2);
    const removed = db.toggleFavorite({ track: alternate, userKey: 'user:shared-a' });
    assert.equal(removed.favorited, false);
    assert.equal(removed.favCount, 1);
    list = db.getCollectiveFavorites({ filterUserKey: 'user:shared-b' });
    assert.equal(list.total, 1);
    assert.equal(list.items[0].favoritedUsers[0].userKey, 'user:shared-b');
    db.toggleFavorite({ track: first, userKey: 'user:shared-b' });
    assert.equal(db.getCollectiveFavorites({ filterUserKey: 'user:shared-b' }).total, 0);
  });

  test('历史跨来源重复收藏在共享歌单中聚合', () => {
    const first = { id: 'qq:legacy-test', title: '旧收藏测试曲', artist: '测试歌手' };
    const alternate = { id: 'netease:legacy-test', title: first.title, artist: first.artist };
    db.toggleFavorite({ track: first, userKey: 'user:legacy-a' });
    const stored = db.upsertTrackMeta(alternate);
    db.stmtInsertFavorite.run(stored.id, 'user:legacy-b', '', '', Date.now(), JSON.stringify(stored));
    const list = db.getCollectiveFavorites({ filterUserKey: 'user:legacy-a' });
    assert.equal(list.total, 1);
    assert.equal(list.items[0].favCount, 2);
    assert.equal(db.getFavoriteTrackStatus(first.id).favCount, 2);
    db.toggleFavorite({ track: alternate, userKey: 'user:legacy-a' });
    assert.equal(db.getCollectiveFavorites({ filterUserKey: 'user:legacy-b' }).items[0].favCount, 1);
    db.toggleFavorite({ track: first, userKey: 'user:legacy-b' });
  });
});
