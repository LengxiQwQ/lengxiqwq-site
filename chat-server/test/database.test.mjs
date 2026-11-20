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

  test('系统 KV 存储', () => {
    db.setKv('room_topic:chat', { text: '欢迎来到聊天室！', updatedBy: 'admin' });
    const val = db.getKv('room_topic:chat');
    assert.equal(val.text, '欢迎来到聊天室！');
  });

  test('MusicManager 联动 ChatDatabase 分页查询', () => {
    // 验证 getMusicHistoryPage 正确返回数据库中的数据
    const res = db.getMusicHistoryPage({ roomId: 'chat', type: 'request', sort: 'recent' });
    assert.ok(res.ok);
    assert.equal(res.type, 'request');
    assert.ok(res.total >= 1);
    assert.ok(Array.isArray(res.items));
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
});
