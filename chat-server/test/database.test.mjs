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
});
