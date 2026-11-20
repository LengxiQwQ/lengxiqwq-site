import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { ChatDatabase } from '../src/db/database.mjs';

export function runMigration(dataDir, dbPath) {
  console.log(`[Migration] 开始从 ${dataDir} 迁移数据到 SQLite (${dbPath})...`);

  // 1. 备份数据目录
  const backupDir = join(dataDir, '../backups');
  mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupTar = join(backupDir, `data_pre_sqlite_${timestamp}.tar.gz`);
  try {
    execSync(`tar -czf "${backupTar}" --exclude='./music_cache' --exclude='./lottie_cache' -C "${dataDir}" .`, { stdio: 'inherit' });
    console.log(`[Migration] ✅ 旧 JSON 数据已自动完整打包备份至: ${backupTar}`);
  } catch (err) {
    console.warn(`[Migration] 打包备份跳过或未完成 (若在 Windows 且无 tar 命令可忽略):`, err.message);
  }

  // 2. 初始化数据库
  const chatDb = new ChatDatabase(dbPath);
  const db = chatDb.db;

  const readJson = (file) => {
    const fullPath = join(dataDir, file);
    if (!existsSync(fullPath)) return null;
    try {
      return JSON.parse(readFileSync(fullPath, 'utf8'));
    } catch (e) {
      console.warn(`[Migration] 无法读取 ${file}:`, e.message);
      return null;
    }
  };

  db.exec('BEGIN TRANSACTION');
  try {
    // 3. 迁移点歌历史与去重曲库
    console.log('[Migration] 正在迁移点歌曲库与流水...');
    let tracksCount = 0;
    let reqLogsCount = 0;
    let rotLogsCount = 0;

    const upsertTrackRaw = db.prepare(`
      INSERT INTO music_tracks (
        id, provider, source_id, title, artist, album, cover_url, duration_sec, track_json,
        total_requests, first_requested_at, last_requested_at,
        total_rotations, first_rotated_at, last_rotated_at, last_playlist_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        total_requests = MAX(music_tracks.total_requests, excluded.total_requests),
        first_requested_at = MIN(COALESCE(music_tracks.first_requested_at, excluded.first_requested_at), excluded.first_requested_at),
        last_requested_at = MAX(COALESCE(music_tracks.last_requested_at, excluded.last_requested_at), excluded.last_requested_at),
        total_rotations = MAX(music_tracks.total_rotations, excluded.total_rotations),
        first_rotated_at = MIN(COALESCE(music_tracks.first_rotated_at, excluded.first_rotated_at), excluded.first_rotated_at),
        last_rotated_at = MAX(COALESCE(music_tracks.last_rotated_at, excluded.last_rotated_at), excluded.last_rotated_at),
        last_playlist_name = COALESCE(excluded.last_playlist_name, music_tracks.last_playlist_name)
    `);

    // 导入 music_history_*.json
    const historyFiles = ['music_history_chat.json', 'music_history_interconnect.json', 'music_history.json'];
    for (const hf of historyFiles) {
      const items = readJson(hf);
      if (Array.isArray(items)) {
        for (const item of items) {
          if (!item?.track?.id) continue;
          const t = item.track;
          upsertTrackRaw.run(
            t.id,
            t.provider || 'qq',
            t.sourceId || t.id.replace(/^qq:/, ''),
            t.title || '未知曲目',
            t.artist || '',
            t.album || '',
            t.cover || '',
            Number(t.durationSec) || 0,
            JSON.stringify(t),
            Number(item.requestCount) || 1,
            item.firstRequestedAt || Date.now(),
            item.lastRequestedAt || Date.now(),
            0, null, null, null
          );
          tracksCount++;
        }
      }
    }

    // 导入轮播历史 music_rotation_history_*.json
    const rotHistFiles = ['music_rotation_history_interconnect.json', 'music_rotation_history.json'];
    for (const rhf of rotHistFiles) {
      const items = readJson(rhf);
      if (Array.isArray(items)) {
        for (const item of items) {
          if (!item?.track?.id) continue;
          const t = item.track;
          upsertTrackRaw.run(
            t.id,
            t.provider || 'qq',
            t.sourceId || t.id.replace(/^qq:/, ''),
            t.title || '未知曲目',
            t.artist || '',
            t.album || '',
            t.cover || '',
            Number(t.durationSec) || 0,
            JSON.stringify(t),
            0, null, null,
            Number(item.rotationCount) || 1,
            item.firstRotatedAt || Date.now(),
            item.lastRotatedAt || Date.now(),
            item.lastPlaylistName || '歌单轮播'
          );
        }
      }
    }

    // 导入点歌流水日志 music_request_logs_*.json
    const insertLogStmt = db.prepare(`
      INSERT OR IGNORE INTO music_request_logs (
        request_uid, room_id, track_id, requester_key, requester_name, requester_avatar, outcome, requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const logRoomMap = [
      { file: 'music_request_logs_chat.json', roomId: 'chat' },
      { file: 'music_request_logs_interconnect.json', roomId: 'interconnect' },
      { file: 'music_request_logs.json', roomId: 'chat' }
    ];
    for (const { file, roomId } of logRoomMap) {
      const logs = readJson(file);
      if (Array.isArray(logs)) {
        for (const log of logs) {
          if (!log?.track?.id) continue;
          const uid = log.requestUid || log.uid || `log_${log.id || Math.random()}`;
          insertLogStmt.run(
            uid,
            roomId,
            log.track.id,
            log.requesterKey || '',
            log.requesterName || '',
            log.requesterAvatar || '',
            log.outcome || 'played',
            log.requestedAt || Date.now()
          );
          reqLogsCount++;
        }
      }
    }

    // 导入轮播流水日志 music_rotation_logs_*.json
    const insertRotLogStmt = db.prepare(`
      INSERT OR IGNORE INTO music_rotation_logs (
        uid, room_id, track_id, playlist_id, playlist_name, rotated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const rotLogs = readJson('music_rotation_logs_interconnect.json');
    if (Array.isArray(rotLogs)) {
      for (const log of rotLogs) {
        if (!log?.track?.id) continue;
        insertRotLogStmt.run(
          log.uid || `rot_${log.id || Math.random()}`,
          'interconnect',
          log.track.id,
          log.playlistId || '',
          log.playlistName || '歌单轮播',
          log.rotatedAt || Date.now()
        );
        rotLogsCount++;
      }
    }

    // 4. 迁移歌单元信息与歌单曲目
    console.log('[Migration] 正在迁移歌单与单曲...');
    const plMeta = readJson('playlists.json');
    const plDetails = readJson('playlist_details.json') || {};
    let plCount = 0;
    let plTracksCount = 0;

    const allPlaylists = [];
    if (plMeta?.all && typeof plMeta.all === 'object') {
      for (const [id, meta] of Object.entries(plMeta.all)) {
        allPlaylists.push({ id, ...meta });
      }
    }
    // 补充 details 里有但 meta 漏掉的
    for (const id of Object.keys(plDetails)) {
      if (!allPlaylists.some((p) => p.id === id)) {
        const detail = plDetails[id];
        allPlaylists.push({
          id,
          title: detail?.title || '未命名歌单',
          creatorKey: detail?.creatorKey || detail?.ownerKey || 'system',
          creatorName: detail?.creatorName || detail?.ownerName || '管理员',
          isPublic: 1
        });
      }
    }

    for (const pl of allPlaylists) {
      chatDb.upsertPlaylist({
        id: pl.id,
        title: pl.title || pl.name || '歌单',
        creatorKey: pl.creatorKey || pl.ownerKey || pl.userId || 'system',
        creatorName: pl.creatorName || pl.ownerName || pl.userName || '用户',
        coverUrl: pl.coverUrl || pl.cover || '',
        isPublic: pl.isPublic !== false && pl.isPublic !== 0 ? 1 : 0
      });
      plCount++;

      const detail = plDetails[pl.id];
      const tracks = Array.isArray(detail?.tracks) ? detail.tracks : Array.isArray(detail) ? detail : [];
      if (tracks.length > 0) {
        chatDb.savePlaylistTracks(pl.id, tracks, true);
        plTracksCount += tracks.length;
      }
    }

    // 5. 迁移聊天消息
    console.log('[Migration] 正在迁移聊天消息...');
    let msgCount = 0;
    const msgFiles = [
      { file: 'messages_chat.json', roomId: 'chat' },
      { file: 'messages_interconnect.json', roomId: 'interconnect' }
    ];

    for (const { file, roomId } of msgFiles) {
      const msgs = readJson(file);
      if (Array.isArray(msgs)) {
        for (const m of msgs) {
          if (!m?.id && !m?.msgUid) continue;
          chatDb.insertMessage({ ...m, roomId });
          msgCount++;
        }
      }
    }

    // 6. 迁移用户成员
    console.log('[Migration] 正在迁移用户名录...');
    const members = readJson('members.json');
    let memberCount = 0;
    if (Array.isArray(members)) {
      const insertMemberStmt = db.prepare(`
        INSERT OR REPLACE INTO chat_members (
          user_key, auth_type, name, avatar, url, badge, badge_type, is_admin,
          bio, status, location, matrix_user, matrix_id, custom_badges_json, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const mem of members) {
        if (!mem?.userKey) continue;
        insertMemberStmt.run(
          mem.userKey,
          mem.authType || 'guest',
          mem.name || '',
          mem.avatar || '',
          mem.url || '',
          mem.badge || '',
          mem.badgeType || '',
          mem.isAdmin ? 1 : 0,
          mem.bio || '',
          mem.status || '',
          mem.location || '',
          mem.matrixUser || '',
          mem.matrixId || '',
          mem.customBadges ? JSON.stringify(mem.customBadges) : '',
          mem.lastSeenAt || Date.now()
        );
        memberCount++;
      }
    }

    // 7. 迁移系统 KV 状态
    console.log('[Migration] 正在迁移房间与系统配置...');
    const kvFiles = [
      { file: 'room_settings.json', key: 'room_settings' },
      { file: 'room_topics.json', key: 'room_topics' },
      { file: 'pinned_chat.json', key: 'pinned:chat' },
      { file: 'pinned_interconnect.json', key: 'pinned:interconnect' },
      { file: 'matrix_sync_state.json', key: 'matrix_sync_state' },
      { file: 'member_notify_prefs.json', key: 'member_notify_prefs' }
    ];
    for (const { file, key } of kvFiles) {
      const data = readJson(file);
      if (data) {
        chatDb.setKv(key, data);
      }
    }

    db.exec('COMMIT');
    console.log('[Migration] 🎉 数据全部成功写入 SQLite 数据库！');
    console.log(`[Migration] 统计报告:
  - 聊天消息: ${msgCount} 条
  - 歌曲曲库 (去重后): ${tracksCount} 首
  - 点歌流水: ${reqLogsCount} 条
  - 轮播流水: ${rotLogsCount} 条
  - 歌单数量: ${plCount} 个 (曲目关联 ${plTracksCount} 首)
  - 注册/活跃成员: ${memberCount} 位`);

  } catch (err) {
    db.exec('ROLLBACK');
    console.error('[Migration] ❌ 迁移失败，已安全回滚事务:', err);
    throw err;
  } finally {
    chatDb.close();
  }
}

// 支持直接作为脚本执行
if (process.argv[1]?.endsWith('migrate-to-sqlite.mjs')) {
  const dataDir = process.argv[2] || join(process.cwd(), 'chat-server/data');
  const dbPath = process.argv[3] || join(dataDir, 'chat.db');
  runMigration(dataDir, dbPath);
}
