import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export function normalizePlaylistOutTrack(rawTrack) {
  if (!rawTrack) return null;
  const provider = rawTrack.provider || rawTrack.sourcePlatform || 'qq';
  const sourcePlatform = rawTrack.sourcePlatform || (provider === 'qq' ? 'qqmusic' : provider);
  const sourceId = String(rawTrack.sourceId || rawTrack.sourceTrackId || rawTrack.id || '').replace(/^qq:/, '');
  const id = rawTrack.id || `${provider}:${sourceId}`;
  const title = String(rawTrack.title || '未知曲目').trim();
  const artist = String(rawTrack.artist || '群友精选').trim();
  const album = String(rawTrack.album || '').trim();
  const cover = String(rawTrack.cover || rawTrack.coverUrl || '').trim();
  const durationSec = Number(rawTrack.durationSec) || (Number(rawTrack.durationMs) ? Math.round(Number(rawTrack.durationMs) / 1000) : 0);
  const sourceUrl = String(rawTrack.sourceUrl || rawTrack.url || '').trim();
  const streamUrl = String(rawTrack.streamUrl || '').trim();
  const lrc = rawTrack.lrc || '';
  const lrcUrl = rawTrack.lrcUrl || '';

  return {
    id,
    provider,
    sourceId,
    sourcePlatform,
    sourceTrackId: sourceId,
    title,
    artist,
    album,
    cover,
    coverUrl: cover,
    durationSec,
    durationMs: durationSec * 1000,
    sourceUrl,
    url: sourceUrl || rawTrack.url || '',
    streamUrl,
    lrc,
    lrcUrl,
    quality: rawTrack.quality || '320k',
  };
}

export class ChatDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  init() {
    // 开启 WAL 模式以获得极高的并发读写性能并杜绝写放大
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');

    // 1. 聊天消息表与索引
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL,
        event_id TEXT UNIQUE NOT NULL,
        msg_uid TEXT,
        kind TEXT,
        sender_key TEXT NOT NULL,
        sender_name TEXT,
        sender_avatar TEXT,
        sender_url TEXT,
        badge TEXT,
        badge_type TEXT,
        is_admin INTEGER DEFAULT 0,
        content TEXT NOT NULL,
        msg_type TEXT DEFAULT 'm.text',
        thread_root_id TEXT,
        reply_to_json TEXT,
        attachments_json TEXT,
        mentions_json TEXT,
        mention_keys_json TEXT,
        custom_badges_json TEXT,
        is_redacted INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_room_created ON chat_messages (room_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (room_id, thread_root_id);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON chat_messages (sender_key);
    `);

    // 2. 表情回应表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_event_id TEXT NOT NULL,
        sender_key TEXT NOT NULL,
        sender_name TEXT,
        reaction_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (message_event_id, sender_key, reaction_key)
      );
      CREATE INDEX IF NOT EXISTS idx_reactions_msg ON chat_reactions (message_event_id);
    `);

    // 3. 歌曲元数据去重主表（永久保存、无上限）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS music_tracks (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT,
        album TEXT,
        cover_url TEXT,
        duration_sec REAL DEFAULT 0,
        track_json TEXT NOT NULL,
        total_requests INTEGER DEFAULT 0,
        first_requested_at INTEGER,
        last_requested_at INTEGER,
        total_rotations INTEGER DEFAULT 0,
        first_rotated_at INTEGER,
        last_rotated_at INTEGER,
        last_playlist_name TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_music_tracks_req ON music_tracks (last_requested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_music_tracks_req_count ON music_tracks (total_requests DESC);
      CREATE INDEX IF NOT EXISTS idx_music_tracks_rot ON music_tracks (last_rotated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_music_tracks_rot_count ON music_tracks (total_rotations DESC);
    `);

    // 4. 点歌流水日志表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS music_request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_uid TEXT UNIQUE,
        room_id TEXT NOT NULL,
        track_id TEXT NOT NULL REFERENCES music_tracks(id),
        requester_key TEXT NOT NULL,
        requester_name TEXT,
        requester_avatar TEXT,
        outcome TEXT DEFAULT 'queued',
        requested_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_music_req_logs_room_time ON music_request_logs (room_id, requested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_music_req_logs_user ON music_request_logs (requester_key, requested_at DESC);
    `);

    // 5. 歌单轮播流水日志表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS music_rotation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT UNIQUE,
        room_id TEXT NOT NULL,
        track_id TEXT NOT NULL REFERENCES music_tracks(id),
        playlist_id TEXT,
        playlist_name TEXT,
        rotated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_music_rot_logs_room_time ON music_rotation_logs (room_id, rotated_at DESC);
    `);

    // 6. 歌单元信息表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        creator_key TEXT NOT NULL,
        creator_name TEXT,
        cover_url TEXT,
        is_public INTEGER DEFAULT 1,
        track_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_playlists_creator ON playlists (creator_key);
      CREATE INDEX IF NOT EXISTS idx_playlists_public ON playlists (is_public, updated_at DESC);
    `);

    // 7. 歌单单曲关联表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        track_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        track_json TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        UNIQUE (playlist_id, track_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pl_tracks_order ON playlist_tracks (playlist_id, sort_order ASC);
    `);

    // 8. 成员名录与资料表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_members (
        user_key TEXT PRIMARY KEY,
        auth_type TEXT,
        name TEXT,
        avatar TEXT,
        url TEXT,
        badge TEXT,
        badge_type TEXT,
        is_admin INTEGER DEFAULT 0,
        bio TEXT,
        status TEXT,
        location TEXT,
        matrix_user TEXT,
        matrix_id TEXT,
        custom_badges_json TEXT,
        last_seen_at INTEGER,
        created_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_members_seen ON chat_members (last_seen_at DESC);
    `);

    // 9. 系统键值存储表（置顶消息、话题公告、通知偏好、同步游标）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // 10. 全站音乐收藏表（每个成员的收藏汇入茶室星愿）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS music_favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT NOT NULL REFERENCES music_tracks(id),
        user_key TEXT NOT NULL,
        user_name TEXT NOT NULL,
        user_avatar TEXT,
        created_at INTEGER NOT NULL,
        track_json TEXT NOT NULL,
        UNIQUE (track_id, user_key)
      );
      CREATE INDEX IF NOT EXISTS idx_fav_user ON music_favorites (user_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_fav_track ON music_favorites (track_id);
      CREATE INDEX IF NOT EXISTS idx_fav_time ON music_favorites (created_at DESC);
    `);

    this.prepareStatements();
  }

  prepareStatements() {
    // 预编译高频执行的 SQL 语句以获得最高性能
    this.stmtInsertMessage = this.db.prepare(`
      INSERT OR REPLACE INTO chat_messages (
        room_id, event_id, msg_uid, kind, sender_key, sender_name, sender_avatar, sender_url,
        badge, badge_type, is_admin, content, msg_type, thread_root_id, reply_to_json,
        attachments_json, mentions_json, mention_keys_json, custom_badges_json, is_redacted, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtRedactMessage = this.db.prepare(`
      UPDATE chat_messages SET is_redacted = 1, content = '此消息已撤回' WHERE event_id = ?
    `);

    this.stmtUpsertTrackRequest = this.db.prepare(`
      INSERT INTO music_tracks (
        id, provider, source_id, title, artist, album, cover_url, duration_sec, track_json,
        total_requests, first_requested_at, last_requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        cover_url = excluded.cover_url,
        duration_sec = excluded.duration_sec,
        track_json = excluded.track_json,
        total_requests = music_tracks.total_requests + 1,
        last_requested_at = excluded.last_requested_at
    `);

    this.stmtInsertRequestLog = this.db.prepare(`
      INSERT OR REPLACE INTO music_request_logs (
        request_uid, room_id, track_id, requester_key, requester_name, requester_avatar, outcome, requested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtUpsertTrackRotation = this.db.prepare(`
      INSERT INTO music_tracks (
        id, provider, source_id, title, artist, album, cover_url, duration_sec, track_json,
        total_rotations, first_rotated_at, last_rotated_at, last_playlist_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        cover_url = excluded.cover_url,
        duration_sec = excluded.duration_sec,
        track_json = excluded.track_json,
        total_rotations = music_tracks.total_rotations + 1,
        last_rotated_at = excluded.last_rotated_at,
        last_playlist_name = excluded.last_playlist_name
    `);

    this.stmtInsertRotationLog = this.db.prepare(`
      INSERT OR REPLACE INTO music_rotation_logs (
        uid, room_id, track_id, playlist_id, playlist_name, rotated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.stmtUpdateLogOutcome = this.db.prepare(`
      UPDATE music_request_logs SET outcome = ? WHERE request_uid = ?
    `);

    this.stmtSetKv = this.db.prepare(`
      INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);

    this.stmtGetKv = this.db.prepare(`
      SELECT value FROM system_kv WHERE key = ?
    `);

    // 音乐元数据更新（供收藏等无需累加点歌/轮播次数的场景）
    this.stmtUpsertTrackMeta = this.db.prepare(`
      INSERT INTO music_tracks (
        id, provider, source_id, title, artist, album, cover_url, duration_sec, track_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        cover_url = excluded.cover_url,
        duration_sec = CASE WHEN excluded.duration_sec > 0 THEN excluded.duration_sec ELSE music_tracks.duration_sec END,
        track_json = excluded.track_json
    `);

    // 收藏管理 SQL
    this.stmtCheckFavorite = this.db.prepare(`
      SELECT id FROM music_favorites WHERE track_id = ? AND user_key = ?
    `);

    this.stmtInsertFavorite = this.db.prepare(`
      INSERT INTO music_favorites (
        track_id, user_key, user_name, user_avatar, created_at, track_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.stmtDeleteFavorite = this.db.prepare(`
      DELETE FROM music_favorites WHERE track_id = ? AND user_key = ?
    `);

    this.stmtDeleteAllFavoritesForTrack = this.db.prepare(`
      DELETE FROM music_favorites WHERE track_id = ?
    `);

    this.stmtGetFavoriteUsersForTrack = this.db.prepare(`
      SELECT user_key, user_name, user_avatar, created_at
      FROM music_favorites
      WHERE track_id = ?
      ORDER BY created_at ASC
    `);
  }

  // --- 点歌历史 API ---

  recordSongRequest({ roomId = 'chat', track, requesterKey, requesterName, requesterAvatar, requestedAt = Date.now(), requestUid }) {
    if (!track?.id) return;
    const uid = requestUid || 'q_' + requestedAt + '_' + Math.random().toString(36).slice(2, 9);
    const trackJson = JSON.stringify(track);

    this.db.exec('BEGIN TRANSACTION');
    try {
      this.stmtUpsertTrackRequest.run(
        track.id,
        track.provider || 'qq',
        track.sourceId || track.id.replace(/^qq:/, ''),
        track.title || '未知曲目',
        track.artist || '',
        track.album || '',
        track.cover || '',
        Number(track.durationSec) || 0,
        trackJson,
        requestedAt,
        requestedAt
      );

      this.stmtInsertRequestLog.run(
        uid,
        roomId,
        track.id,
        requesterKey || '',
        requesterName || '',
        requesterAvatar || '',
        'queued',
        requestedAt
      );
      this.db.exec('COMMIT');
      return uid;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  recordSongRotation({ roomId = 'chat', track, playlistId = '', playlistName = '歌单轮播', rotatedAt = Date.now(), uid }) {
    if (!track?.id) return;
    const rotUid = uid || 'rot_' + rotatedAt + '_' + Math.random().toString(36).slice(2, 8);
    const trackJson = JSON.stringify(track);

    this.db.exec('BEGIN TRANSACTION');
    try {
      this.stmtUpsertTrackRotation.run(
        track.id,
        track.provider || 'qq',
        track.sourceId || track.id.replace(/^qq:/, ''),
        track.title || '未知曲目',
        track.artist || '',
        track.album || '',
        track.cover || '',
        Number(track.durationSec) || 0,
        trackJson,
        rotatedAt,
        rotatedAt,
        playlistName
      );

      this.stmtInsertRotationLog.run(
        rotUid,
        roomId,
        track.id,
        playlistId,
        playlistName,
        rotatedAt
      );
      this.db.exec('COMMIT');
      return rotUid;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  markOutcome(uid, outcome) {
    if (!uid) return;
    this.stmtUpdateLogOutcome.run(outcome, uid);
  }

  getMusicHistoryPage({ roomId = 'chat', type = 'request', sort = 'recent', requesterKey = '', offset = 0, limit = 100 } = {}) {
    offset = Math.max(0, Number.parseInt(offset, 10) || 0);
    limit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 100));

    if (type === 'rotation') {
      const countStmt = this.db.prepare('SELECT COUNT(*) AS total FROM music_tracks WHERE total_rotations > 0');
      const total = Number(countStmt.get().total) || 0;

      const orderClause = sort === 'count'
        ? 'ORDER BY total_rotations DESC, last_rotated_at DESC'
        : 'ORDER BY last_rotated_at DESC, total_rotations DESC';

      const queryStmt = this.db.prepare(`
        SELECT track_json, total_rotations, first_rotated_at, last_rotated_at, last_playlist_name
        FROM music_tracks
        WHERE total_rotations > 0
        ${orderClause}
        LIMIT ? OFFSET ?
      `);

      const rows = queryStmt.all(limit, offset);
      const items = rows.map((r) => {
        let track = {};
        try { track = JSON.parse(r.track_json); } catch {}
        return {
          track,
          requestCount: r.total_rotations,
          lastRequesterName: r.last_playlist_name ? `${r.last_playlist_name} (轮播)` : '歌单轮播',
          firstRequestedAt: r.first_rotated_at,
          lastRequestedAt: r.last_rotated_at,
          isRotation: true
        };
      });

      return {
        ok: true,
        type: 'rotation',
        total,
        offset,
        limit,
        hasMore: offset + limit < total,
        items
      };
    }

    if (type === 'all' && !requesterKey) {
      const countStmt = this.db.prepare('SELECT COUNT(*) AS total FROM music_tracks WHERE (total_requests > 0 OR total_rotations > 0)');
      const total = Number(countStmt.get().total) || 0;

      const orderClause = sort === 'count'
        ? 'ORDER BY (COALESCE(total_requests, 0) + COALESCE(total_rotations, 0)) DESC, MAX(COALESCE(last_requested_at, 0), COALESCE(last_rotated_at, 0)) DESC'
        : 'ORDER BY MAX(COALESCE(last_requested_at, 0), COALESCE(last_rotated_at, 0)) DESC, (COALESCE(total_requests, 0) + COALESCE(total_rotations, 0)) DESC';

      const queryStmt = this.db.prepare(`
        SELECT t.track_json,
               t.total_requests,
               t.first_requested_at,
               t.last_requested_at,
               t.total_rotations,
               t.first_rotated_at,
               t.last_rotated_at,
               t.last_playlist_name,
               (SELECT requester_name FROM music_request_logs WHERE track_id = t.id ORDER BY requested_at DESC LIMIT 1) AS last_requester_name
        FROM music_tracks t
        WHERE (t.total_requests > 0 OR t.total_rotations > 0)
        ${orderClause}
        LIMIT ? OFFSET ?
      `);

      const rows = queryStmt.all(limit, offset);
      const items = rows.map((r) => {
        let track = {};
        try { track = JSON.parse(r.track_json); } catch {}
        const totalReq = r.total_requests || 0;
        const totalRot = r.total_rotations || 0;
        const totalCount = totalReq + totalRot;
        const lastRot = r.last_rotated_at || 0;
        const lastReq = r.last_requested_at || 0;
        const isLastRotation = lastRot > lastReq;
        let lastRequesterName = '';
        if (isLastRotation) {
          lastRequesterName = r.last_playlist_name ? `${r.last_playlist_name} (轮播)` : '歌单轮播';
        } else {
          lastRequesterName = r.last_requester_name || (r.last_playlist_name ? `${r.last_playlist_name} (轮播)` : '');
        }
        const firstValidTimes = [r.first_requested_at, r.first_rotated_at].filter(Boolean);
        const firstAt = firstValidTimes.length > 0 ? Math.min(...firstValidTimes) : 0;
        const lastAt = Math.max(lastRot, lastReq);

        return {
          track,
          requestCount: totalCount,
          lastRequesterName,
          firstRequestedAt: firstAt || lastAt,
          lastRequestedAt: lastAt,
          isRotation: isLastRotation
        };
      });

      return {
        ok: true,
        type: 'all',
        total,
        offset,
        limit,
        hasMore: offset + limit < total,
        items
      };
    }

    // type === 'request'
    if (requesterKey) {
      // 查询特定点歌人点过的歌（去重并汇总点歌次数与最近时间）
      const countStmt = this.db.prepare(`
        SELECT COUNT(DISTINCT track_id) AS total
        FROM music_request_logs
        WHERE room_id = ? AND requester_key = ?
      `);
      const total = Number(countStmt.get(roomId, requesterKey).total) || 0;

      const orderClause = sort === 'count'
        ? 'ORDER BY req_count DESC, last_at DESC'
        : 'ORDER BY last_at DESC, req_count DESC';

      const queryStmt = this.db.prepare(`
        SELECT t.track_json,
               COUNT(l.id) AS req_count,
               MIN(l.requested_at) AS first_at,
               MAX(l.requested_at) AS last_at,
               (SELECT requester_name FROM music_request_logs WHERE room_id = ? AND requester_key = ? AND track_id = l.track_id ORDER BY requested_at DESC LIMIT 1) AS last_name
        FROM music_request_logs l
        JOIN music_tracks t ON l.track_id = t.id
        WHERE l.room_id = ? AND l.requester_key = ?
        GROUP BY l.track_id
        ${orderClause}
        LIMIT ? OFFSET ?
      `);

      const rows = queryStmt.all(roomId, requesterKey, roomId, requesterKey, limit, offset);
      const items = rows.map((r) => {
        let track = {};
        try { track = JSON.parse(r.track_json); } catch {}
        return {
          track,
          requestCount: r.req_count,
          lastRequesterName: r.last_name || '',
          firstRequestedAt: r.first_at,
          lastRequestedAt: r.last_at,
          isRotation: false
        };
      });

      return {
        ok: true,
        type: 'request',
        total,
        offset,
        limit,
        hasMore: offset + limit < total,
        items
      };
    }

    // 默认全房间点歌历史
    const countStmt = this.db.prepare('SELECT COUNT(*) AS total FROM music_tracks WHERE total_requests > 0');
    const total = Number(countStmt.get().total) || 0;

    const orderClause = sort === 'count'
      ? 'ORDER BY total_requests DESC, last_requested_at DESC'
      : 'ORDER BY last_requested_at DESC, total_requests DESC';

    const queryStmt = this.db.prepare(`
      SELECT t.track_json, t.total_requests, t.first_requested_at, t.last_requested_at,
             (SELECT requester_name FROM music_request_logs WHERE track_id = t.id ORDER BY requested_at DESC LIMIT 1) AS last_requester_name
      FROM music_tracks t
      WHERE t.total_requests > 0
      ${orderClause}
      LIMIT ? OFFSET ?
    `);

    const rows = queryStmt.all(limit, offset);
    const items = rows.map((r) => {
      let track = {};
      try { track = JSON.parse(r.track_json); } catch {}
      return {
        track,
        requestCount: r.total_requests,
        lastRequesterName: r.last_requester_name || '',
        firstRequestedAt: r.first_requested_at,
        lastRequestedAt: r.last_requested_at,
        isRotation: false
      };
    });

    return {
      ok: true,
      type: 'request',
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
      items
    };
  }

  // --- 歌单 API ---

  upsertPlaylist({ id, title, creatorKey, creatorName, coverUrl = '', isPublic = 1, trackCount = 0, createdAt = Date.now(), updatedAt = Date.now() }) {
    const stmt = this.db.prepare(`
      INSERT INTO playlists (id, title, creator_key, creator_name, cover_url, is_public, track_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        creator_name = excluded.creator_name,
        cover_url = excluded.cover_url,
        is_public = excluded.is_public,
        track_count = excluded.track_count,
        updated_at = excluded.updated_at
    `);
    stmt.run(id, title, creatorKey, creatorName, coverUrl, isPublic ? 1 : 0, trackCount, createdAt, updatedAt);
  }

  savePlaylistTracks(playlistId, tracks, inTransaction = false) {
    if (!playlistId || !Array.isArray(tracks)) return;
    if (!inTransaction) this.db.exec('BEGIN TRANSACTION');
    try {
      this.db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId);
      const insertStmt = this.db.prepare(`
        INSERT OR REPLACE INTO playlist_tracks (playlist_id, track_id, sort_order, track_json, added_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const now = Date.now();
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (!t?.id) continue;
        insertStmt.run(playlistId, t.id, i, JSON.stringify(t), now);
      }
      this.db.prepare('UPDATE playlists SET track_count = ?, updated_at = ? WHERE id = ?').run(tracks.length, now, playlistId);
      if (!inTransaction) this.db.exec('COMMIT');
    } catch (err) {
      if (!inTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getPlaylistTracks(playlistId) {
    const stmt = this.db.prepare(`
      SELECT track_json FROM playlist_tracks WHERE playlist_id = ? ORDER BY sort_order ASC
    `);
    const rows = stmt.all(playlistId);
    return rows.map((r) => {
      try { return JSON.parse(r.track_json); } catch { return null; }
    }).filter(Boolean);
  }

  // --- 聊天消息 API ---

  insertMessage(msg) {
    if (!msg?.id && !msg?.msgUid) return;
    const eventId = msg.id || msg.msgUid;
    this.stmtInsertMessage.run(
      msg.roomId || 'chat',
      eventId,
      msg.msgUid || '',
      msg.kind || 'chat',
      msg.userKey || '',
      msg.name || '',
      msg.avatar || '',
      msg.url || '',
      msg.badge || '',
      msg.badgeType || '',
      msg.isAdmin ? 1 : 0,
      msg.content || '',
      msg.msgType || 'm.text',
      msg.threadRootId || '',
      msg.replyTo ? JSON.stringify(msg.replyTo) : '',
      msg.attachments ? JSON.stringify(msg.attachments) : '',
      msg.mentions ? JSON.stringify(msg.mentions) : '',
      msg.mentionKeys ? JSON.stringify(msg.mentionKeys) : '',
      msg.customBadges ? JSON.stringify(msg.customBadges) : '',
      msg.isRedacted ? 1 : 0,
      msg.createdAt || Date.now()
    );
  }

  getMessages({ roomId = 'chat', limit = 50, beforeTime = null, threadRootId = null } = {}) {
    limit = Math.min(100, Math.max(1, limit));
    let sql = 'SELECT * FROM chat_messages WHERE room_id = ?';
    const params = [roomId];

    if (threadRootId) {
      sql += ' AND thread_root_id = ?';
      params.push(threadRootId);
    }
    if (beforeTime) {
      sql += ' AND created_at < ?';
      params.push(beforeTime);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params);
    return rows.reverse().map((r) => ({
      id: r.event_id,
      msgUid: r.msg_uid,
      kind: r.kind,
      userKey: r.sender_key,
      name: r.sender_name,
      avatar: r.sender_avatar,
      url: r.sender_url,
      badge: r.badge,
      badgeType: r.badge_type,
      isAdmin: Boolean(r.is_admin),
      content: r.content,
      msgType: r.msg_type,
      threadRootId: r.thread_root_id || undefined,
      replyTo: r.reply_to_json ? JSON.parse(r.reply_to_json) : undefined,
      attachments: r.attachments_json ? JSON.parse(r.attachments_json) : undefined,
      mentions: r.mentions_json ? JSON.parse(r.mentions_json) : undefined,
      mentionKeys: r.mention_keys_json ? JSON.parse(r.mention_keys_json) : undefined,
      customBadges: r.custom_badges_json ? JSON.parse(r.custom_badges_json) : undefined,
      isRedacted: Boolean(r.is_redacted),
      createdAt: r.created_at
    }));
  }

  // --- 音乐元数据与收藏 API ---

  upsertTrackMeta(rawTrack) {
    const track = normalizePlaylistOutTrack(rawTrack);
    if (!track?.id) return null;
    this.stmtUpsertTrackMeta.run(
      track.id,
      track.provider || 'qq',
      track.sourceId || track.id.replace(/^qq:/, ''),
      track.title || '未知曲目',
      track.artist || '',
      track.album || '',
      track.cover || '',
      Number(track.durationSec) || 0,
      JSON.stringify(track)
    );
    return track;
  }

  toggleFavorite({ track, userKey, userName = '', userAvatar = '' }) {
    if (!track || !userKey) {
      throw new Error('track and userKey are required');
    }
    const normalized = normalizePlaylistOutTrack(track);
    const trackId = normalized.id;
    const now = Date.now();
    const trackJson = JSON.stringify(normalized);

    this.upsertTrackMeta(normalized);

    // 优先复用共享收藏中已有的同曲 ID，让不同来源的收藏汇入同一首歌。
    const matches = normalized.title && normalized.artist ? this.db.prepare(`
      SELECT f.track_id, f.user_key FROM music_favorites f
      JOIN music_tracks t ON f.track_id = t.id
      WHERE LOWER(TRIM(t.title)) = LOWER(TRIM(?)) AND LOWER(TRIM(t.artist)) = LOWER(TRIM(?))
      ORDER BY f.created_at ASC, f.id ASC
    `).all(normalized.title, normalized.artist) : [];
    const ownIds = new Set(matches.filter((row) => row.user_key === userKey).map((row) => row.track_id));
    if (this.stmtCheckFavorite.get(trackId, userKey)) ownIds.add(trackId);
    const favorited = ownIds.size === 0;
    if (favorited) {
      const sharedId = matches[0]?.track_id || trackId;
      this.stmtInsertFavorite.run(sharedId, userKey, userName || '', userAvatar || '', now, trackJson);
    } else {
      for (const id of ownIds) this.stmtDeleteFavorite.run(id, userKey);
    }
    const status = this.getFavoriteTrackStatus(trackId, userKey);

    return {
      ok: true,
      favorited,
      favCount: status.favCount,
      favoritedUsers: status.favoritedUsers,
      track: normalized,
    };
  }

  isFavorite(trackId, userKey) {
    if (!trackId || !userKey) return false;
    const row = this.stmtCheckFavorite.get(trackId, userKey);
    return Boolean(row);
  }

  getFavoriteTrackStatus(trackId, userKey = '') {
    if (!trackId) return { isFavorited: false, favCount: 0, favoritedUsers: [] };
    const rows = this.db.prepare(`
      SELECT f.user_key, f.user_name, f.user_avatar, MAX(f.created_at) AS created_at
      FROM music_favorites f JOIN music_tracks t ON t.id = f.track_id
      WHERE f.track_id = ? OR EXISTS (
        SELECT 1 FROM music_tracks target WHERE target.id = ?
          AND LOWER(TRIM(target.title)) = LOWER(TRIM(t.title))
          AND LOWER(TRIM(target.artist)) = LOWER(TRIM(t.artist))
      )
      GROUP BY f.user_key
    `).all(trackId, trackId);
    const favoritedUsers = rows.map((r) => ({
      userKey: r.user_key,
      userName: r.user_name,
      userAvatar: r.user_avatar,
      createdAt: r.created_at,
    }));
    const isFavorited = userKey ? favoritedUsers.some((u) => u.userKey === userKey) : false;
    return {
      isFavorited,
      favCount: favoritedUsers.length,
      favoritedUsers,
    };
  }

  removeFavorite({ trackId, userKey = null, isAdmin = false }) {
    if (!trackId) return { ok: false, message: 'trackId is required' };
    if (isAdmin && !userKey) {
      this.stmtDeleteAllFavoritesForTrack.run(trackId);
      return { ok: true, removedCount: 'all', favCount: 0, favoritedUsers: [] };
    }
    if (!userKey) return { ok: false, message: 'userKey is required' };
    this.stmtDeleteFavorite.run(trackId, userKey);
    const status = this.getFavoriteTrackStatus(trackId, userKey);
    return { ok: true, favCount: status.favCount, favoritedUsers: status.favoritedUsers };
  }

  getCollectiveFavorites({ filterUserKey = null, sort = 'recent', offset = 0, limit = 100 } = {}) {
    offset = Math.max(0, Number.parseInt(offset, 10) || 0);
    limit = Math.min(1000, Math.max(1, Number.parseInt(limit, 10) || 100));

    // 同歌跨来源的历史记录也在查询时聚合，不改写已有收藏数据。
    const grouped = `
      WITH keyed AS (
        SELECT f.*, CASE WHEN TRIM(t.title) != '' AND TRIM(t.artist) != ''
          THEN LOWER(TRIM(t.title)) || char(31) || LOWER(TRIM(t.artist))
          ELSE f.track_id END AS song_key
        FROM music_favorites f JOIN music_tracks t ON t.id = f.track_id
      ), unique_users AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY song_key, user_key ORDER BY created_at DESC, id DESC) AS rn
        FROM keyed
      ), grouped AS (
        SELECT song_key, track_json, COUNT(*) AS fav_count,
          MAX(created_at) AS last_favorited_at,
          json_group_array(json_object('userKey', user_key, 'userName', user_name,
            'userAvatar', user_avatar, 'createdAt', created_at)) AS favorited_users_json,
          MAX(CASE WHEN user_key = ? THEN 1 ELSE 0 END) AS selected_user
        FROM unique_users WHERE rn = 1 GROUP BY song_key
      )
    `;
    const filter = filterUserKey ? ' WHERE selected_user = 1' : '';
    const totalRow = this.db.prepare(`${grouped} SELECT COUNT(*) AS total FROM grouped${filter}`).get(filterUserKey || '');
    const total = Number(totalRow?.total) || 0;
    const order = sort === 'count' || sort === 'hot'
      ? 'fav_count DESC, last_favorited_at DESC, song_key ASC'
      : 'last_favorited_at DESC, fav_count DESC, song_key ASC';
    const rows = this.db.prepare(`${grouped} SELECT * FROM grouped${filter} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(filterUserKey || '', limit, offset);

    const items = rows.map((r) => {
      let track = {};
      try {
        track = JSON.parse(r.track_json);
      } catch {
        track = {};
      }
      let favoritedUsers = [];
      try {
        favoritedUsers = JSON.parse(r.favorited_users_json) || [];
      } catch {
        favoritedUsers = [];
      }
      return {
        ...track,
        favCount: Number(r.fav_count) || favoritedUsers.length,
        lastFavoritedAt: r.last_favorited_at,
        favoritedUsers,
      };
    });

    return {
      ok: true,
      total,
      offset,
      limit,
      items,
    };
  }

  getCollectiveFavoriters() {
    const sql = `
      SELECT f.user_key as userKey, f.user_name as userName, f.user_avatar as userAvatar,
        COUNT(DISTINCT CASE WHEN TRIM(t.title) != '' AND TRIM(t.artist) != ''
          THEN LOWER(TRIM(t.title)) || char(31) || LOWER(TRIM(t.artist))
          ELSE f.track_id END) as trackCount, MAX(f.created_at) as lastFavTime
      FROM music_favorites f JOIN music_tracks t ON t.id = f.track_id
      GROUP BY f.user_key
      ORDER BY trackCount DESC, lastFavTime DESC
    `;
    const rows = this.db.prepare(sql).all();
    return rows.map((r) => ({
      userKey: r.userKey,
      userName: r.userName || '未知成员',
      userAvatar: r.userAvatar || '',
      trackCount: Number(r.trackCount) || 0,
      lastFavTime: r.lastFavTime,
    }));
  }

  getUserFavorites({ userKey, offset = 0, limit = 50 } = {}) {
    if (!userKey) return { ok: true, total: 0, items: [] };
    offset = Math.max(0, Number.parseInt(offset, 10) || 0);
    limit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));

    const countRow = this.db.prepare('SELECT COUNT(*) as total FROM music_favorites WHERE user_key = ?').get(userKey);
    const total = Number(countRow?.total) || 0;

    const rows = this.db.prepare(`
      SELECT f.track_id, f.created_at as favorited_at, f.track_json
      FROM music_favorites f
      WHERE f.user_key = ?
      ORDER BY f.created_at DESC
      LIMIT ? OFFSET ?
    `).all(userKey, limit, offset);

    const items = rows.map((r) => {
      let track = {};
      try {
        track = JSON.parse(r.track_json);
      } catch {
        track = { id: r.track_id };
      }
      return {
        ...track,
        favoritedAt: r.favorited_at,
      };
    });

    return {
      ok: true,
      total,
      offset,
      limit,
      items,
    };
  }

  getUserFavoriteKeys(userKey) {
    if (!userKey) return { ok: true, trackIds: [], titleArtists: [] };
    const rows = this.db.prepare('SELECT track_id, track_json FROM music_favorites WHERE user_key = ?').all(userKey);
    const trackIds = [];
    const titleArtists = [];
    for (const r of rows) {
      if (r.track_id) {
        trackIds.push(r.track_id);
        const bareId = r.track_id.replace(/^[a-z_]+:/i, '');
        if (bareId && bareId !== r.track_id) {
          trackIds.push(bareId);
        }
      }
      try {
        const t = JSON.parse(r.track_json);
        if (t?.title) {
          const cleanTitle = String(t.title).toLowerCase().replace(/\s+/g, ' ').trim();
          const cleanArtist = String(t.artist || '').toLowerCase().replace(/\s+/g, ' ').trim();
          titleArtists.push(`${cleanTitle}:::${cleanArtist}`);
        }
      } catch {}
    }
    return { ok: true, trackIds, titleArtists };
  }

  // --- 系统 KV 键值操作 ---

  setKv(key, value) {
    const valStr = typeof value === 'string' ? value : JSON.stringify(value);
    this.stmtSetKv.run(key, valStr, Date.now());
  }

  getKv(key, defaultValue = null) {
    const row = this.stmtGetKv.get(key);
    if (!row) return defaultValue;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  close() {
    this.db.close();
  }
}
