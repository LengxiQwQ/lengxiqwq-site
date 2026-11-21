import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeMusicTrack } from './music-input.mjs';
import { musicTrackMatchKey } from './registry.mjs';

export function stableTrack(track) {
  const { streamUrl, proxyUrl, directUrl, lrcUrl, url, lrc, rotationEntryId, ...identity } = track;
  return identity;
}

function durationOf(value) {
  return Number.isFinite(value) && value > 0 && value <= 86400 ? value : 0;
}

export function computeVoteThreshold(onlineMemberCount, isFallback, requesterOnline) {
  if (isFallback) return 1;
  return 2;
}

function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`[Data] Failed atomic write for ${filePath}:`, err.message);
  }
}

// Older snapshots may contain a scheduled start.
const RESTORE_FUTURE_WINDOW_MS = 1400;
const START_LEAD_MS = 500;

function withTimeout(promise, ms, label = 'timeout') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const PREPARED_REUSE_TTL_MS = 25 * 60_000;

export class MusicManager {
  constructor({ roomId = 'chat', dataDir, musicRegistry, signSecret, serverOrigin, onStateChanged, onUnavailable, getListeners = () => [], chatDb = null }) {
    this.roomId = roomId;
    this.dataDir = dataDir;
    this.chatDb = chatDb;
    this.musicRegistry = musicRegistry;
    this.signSecret = signSecret;
    this.serverOrigin = serverOrigin;
    this.onStateChanged = onStateChanged || (() => {});
    this.onUnavailable = onUnavailable;
    this.getListeners = getListeners;
    this.stateVersion = 0;

    this.current = null;
    this.queue = [];
    this.queueVotes = new Map();
    this.queueVotePlayUid = null;
    this.historyMap = new Map(); // trackId -> MusicHistoryEntry
    this.historyLogs = []; // Array of MusicHistoryLogEntry
    this.rotationHistoryMap = new Map(); // trackId -> MusicRotationEntry
    this.rotationLogs = []; // Array of MusicRotationLogEntry
    this._nextRotationLogId = 1;
    this.fallbackTracks = [];
    this.rotationDeck = [];
    this.rotationEntryIds = new WeakMap();
    this.rotationEntries = new Map();
    this.rotationOffers = new WeakMap();
    this.requestOffers = new WeakMap();
    this.rotationRequests = new Set();
    this.lastPlayedFallbackId = null;
    this.fallbackPlaylistId = null;
    this.fallbackPlaylistName = '歌单轮播';
    this._nextLogId = 1;
    this._advanceTimer = null;
    this._refreshPreparedTimer = null;
    this.preparedFallback = null;
    this.preparedQueue = null;
    this._prepareFallbackTimer = null;
    this._actorLastErrorAt = new Map();

    this.generation = 0;
    this.fallbackGeneration = 0;
    this.statePath = join(this.dataDir, 'music_state_' + roomId + '.json');
    this.savedState = null;
    this.loadData();
    try {
      if (existsSync(this.statePath)) {
        const state = JSON.parse(readFileSync(this.statePath, 'utf8'));
        this.savedState = state;
        if (Array.isArray(state?.queue)) {
          this.queue = state.queue.filter(item => item && item.track && item.track.id);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[Music] restore queue', this.roomId, error.message);
    }
  }

  loadData() {
    const histFileName = this.roomId ? `music_history_${this.roomId}.json` : 'music_history.json';
    const logsFileName = this.roomId ? `music_request_logs_${this.roomId}.json` : 'music_request_logs.json';

    let histPath = join(this.dataDir, histFileName);
    if (this.roomId === "chat" && !existsSync(histPath)) {
      histPath = join(this.dataDir, 'music_history.json');
    }
    if (existsSync(histPath)) {
      try {
        const arr = JSON.parse(readFileSync(histPath, 'utf8'));
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (item && item.track && item.track.id) {
              this.historyMap.set(item.track.id, { ...item, track: stableTrack(item.track) });
            }
          }
        }
      } catch (e) {
        console.error(`[Music:${this.roomId}] Error loading ${histFileName}:`, e.message);
      }
    }

    let logsPath = join(this.dataDir, logsFileName);
    if (this.roomId === "chat" && !existsSync(logsPath)) {
      logsPath = join(this.dataDir, 'music_request_logs.json');
    }
    if (existsSync(logsPath)) {
      try {
        const arr = JSON.parse(readFileSync(logsPath, 'utf8'));
        if (Array.isArray(arr)) {
          this.historyLogs = arr.filter(item => item?.track).map(item => ({ ...item, track: stableTrack(item.track) }));
          for (const item of arr) {
            if (item.id && item.id >= this._nextLogId) {
              this._nextLogId = item.id + 1;
            }
          }
        }
      } catch (e) {
        console.error(`[Music:${this.roomId}] Error loading ${logsFileName}:`, e.message);
      }
    }

    const rotHistFileName = this.roomId ? `music_rotation_history_${this.roomId}.json` : 'music_rotation_history.json';
    const rotLogsFileName = this.roomId ? `music_rotation_logs_${this.roomId}.json` : 'music_rotation_logs.json';

    let rotHistPath = join(this.dataDir, rotHistFileName);
    if (this.roomId === 'chat' && !existsSync(rotHistPath)) {
      rotHistPath = join(this.dataDir, 'music_rotation_history.json');
    }
    if (existsSync(rotHistPath)) {
      try {
        const arr = JSON.parse(readFileSync(rotHistPath, 'utf8'));
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (item && item.track && item.track.id) {
              this.rotationHistoryMap.set(item.track.id, { ...item, track: stableTrack(item.track) });
            }
          }
        }
      } catch (e) {
        console.error(`[Music:${this.roomId}] Error loading ${rotHistFileName}:`, e.message);
      }
    }

    let rotLogsPath = join(this.dataDir, rotLogsFileName);
    if (this.roomId === 'chat' && !existsSync(rotLogsPath)) {
      rotLogsPath = join(this.dataDir, 'music_rotation_logs.json');
    }
    if (existsSync(rotLogsPath)) {
      try {
        const arr = JSON.parse(readFileSync(rotLogsPath, 'utf8'));
        if (Array.isArray(arr)) {
          this.rotationLogs = arr.filter(item => item?.track).map(item => ({ ...item, track: stableTrack(item.track) }));
          for (const item of arr) {
            if (item.id && item.id >= this._nextRotationLogId) {
              this._nextRotationLogId = item.id + 1;
            }
          }
        }
      } catch (e) {
        console.error(`[Music:${this.roomId}] Error loading ${rotLogsFileName}:`, e.message);
      }
    }
  }

  savePlayback() {
    writeJsonAtomic(this.statePath, {
      current: this.current && { ...this.current, track: stableTrack(this.current.track) },
      queue: this.queue.map(item => ({ ...item, track: stableTrack(item.track) }))
    });
  }

  async restorePlayback() {
    const saved = this.savedState;
    this.savedState = null;
    const current = saved?.current;

    if (current && current.track && current.track.id) {
      const now = Date.now();
      const startedAt = Number(current.startedAt) || now;
      const durationSec = durationOf(current.durationSec || current.track.durationSec) || 240;
      const elapsedMs = now - startedAt;

      // 如果尚未超时（剩余至少 2 秒），尝试断点续播！
      if (elapsedMs >= -RESTORE_FUTURE_WINDOW_MS && elapsedMs < (durationSec - 2) * 1000) {
        try {
          const playable = await this.resolve(current.track);
          if (playable) {
            this.current = {
              uid: current.uid || ('play_' + startedAt + '_' + Math.random().toString(36).slice(2, 9)),
              track: playable,
              requesterKey: current.requesterKey || 'system:fallback',
              requesterName: current.requesterName || '系统轮播',
              requesterAvatar: current.requesterAvatar || '',
              startedAt,
              phase: elapsedMs < 0 ? 'scheduled' : 'playing',
              durationSec,
              isFallback: Boolean(current.isFallback),
              requestUid: current.requestUid,
              sourceRevision: Number(current.sourceRevision) || 0,
              skipVotes: Array.isArray(current.skipVotes) ? current.skipVotes : [],
              skipVoteNames: Array.isArray(current.skipVoteNames) ? current.skipVoteNames : [],
              measuredDuration: Boolean(current.measuredDuration)
            };
            this.scheduleAdvance();
            clearTimeout(this._prepareFallbackTimer);
            this._prepareFallbackTimer = setTimeout(() => void this.prepareNext(), 50);
            this.savePlayback();
            this.onStateChanged();
            console.log(`[Music:${this.roomId}] Successfully restored playback: 《${playable.title} - ${playable.artist}》, elapsed ${Math.round(elapsedMs / 1000)}s / ${Math.round(durationSec)}s`);
            return;
          }
        } catch (err) {
          console.warn(`[Music:${this.roomId}] Failed to resolve restored track:`, err.message);
        }
      } else {
        console.log(`[Music:${this.roomId}] Saved track 《${current.track.title || current.track.id}》 elapsed ${Math.round(elapsedMs / 1000)}s (expired), advancing to next...`);
      }
    }

    // 若无进行中曲目或已播完，自动无缝起播下一首（优先排队，其次轮播）
    if (this.queue.length > 0 || this.fallbackTracks.length > 0) {
      await this.advanceNext();
    }
  }

  resume() {
    if (this.queue.length || this.fallbackTracks.length) return this.advanceNext();
  }

  setFallbackPlaylist(playlistId, tracks, playlistName, { start = true, all = false } = {}) {
    this.fallbackPlaylistId = playlistId;
    this.fallbackPlaylistName = playlistName;
    this.fallbackTracks = playlistId || all ? tracks : [];
    this.rotationEntryIds = new WeakMap();
    this.rotationEntries.clear();
    this.rotationOffers = new WeakMap();
    this.fallbackTracks.forEach((track, index) => {
      const platform = track.sourcePlatform || track.provider || '';
      const sourceId = track.sourceTrackId || track.sourceId || track.id;
      const identity = sourceId ? [platform, sourceId] : [platform, track.title, track.artist, track.album];
      const key = createHash('sha256')
        .update(JSON.stringify([track.sourcePlaylistId || playlistId, ...identity]))
        .digest('base64url');
      const baseId = 'rotation:' + key;
      const id = this.rotationEntries.has(baseId) ? baseId + ':' + index : baseId;
      this.rotationEntryIds.set(track, id);
      this.rotationEntries.set(id, track);
    });
    this.fallbackGeneration++;
    this.reshuffleRotationDeck(true);
    this.preparedFallback = null;
    if (start && (!this.current || this.current.isFallback)) {
      this.generation++;
      void this.advanceNext();
    } else if (this.current && !this.queue.length) {
      void this.prepareNext();
    }
  }

  reshuffleRotationDeck(isNewPool = false) {
    if (!this.fallbackTracks.length) {
      this.rotationDeck = [];
      return;
    }
    const deck = [...this.fallbackTracks];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const lastId = this.lastPlayedFallbackId || this.current?.track?.id;
    if (deck.length > 1 && lastId) {
      const getTid = (t) => t?.matchedTrack?.id || t?.id || t?.sourceTrackId || '';
      if (getTid(deck[0]) === lastId) {
        const swapIdx = 1 + Math.floor(Math.random() * (deck.length - 1));
        [deck[0], deck[swapIdx]] = [deck[swapIdx], deck[0]];
      }
    }
    this.rotationDeck = deck;
  }

  getRotationQueue(limit = 30) {
    if (!this.rotationDeck.length && this.fallbackTracks.length > 0) {
      this.reshuffleRotationDeck();
    }
    if (!this.rotationDeck.length) return [];
    return this.rotationDeck.slice(0, limit).map((track, index) => {
      const sourceId = track.sourceTrackId || track.sourceId || '';
      const platform = track.sourcePlatform || track.provider || 'qq';
      const provider = platform === 'qqmusic' ? 'qq' : platform;
      const id = track.id || (sourceId ? provider + ':' + sourceId : 'rotation:' + index);
      return {
        id,
        entryId: this.rotationEntryIds.get(track),
        sourcePlatform: platform,
        sourceTrackId: sourceId,
        title: track.title || '未知曲目',
        artist: track.artist || '未知歌手',
        album: track.album || '',
        durationSec: track.durationSec || track.duration || 0,
        pic: track.pic || track.cover || track.picUrl || '',
        sourcePlaylistTitle: track.sourcePlaylistTitle || '',
        sourcePlaylistId: track.sourcePlaylistId || '',
      };
    });
  }

  consumeRotationTrack(playable) {
    if (!this.rotationDeck.length && this.fallbackTracks.length > 0) {
      this.reshuffleRotationDeck();
    }
    if (!this.rotationDeck.length) return;
    const playId = playable?.id;
    const playSourceId = playable?.sourceId;
    const idx = this.rotationDeck.findIndex((t) => {
      if (playable.rotationEntryId) return this.rotationEntryIds.get(t) === playable.rotationEntryId;
      const tid = t?.matchedTrack?.id || t?.id;
      const tsid = t?.matchedTrack?.sourceId || t?.sourceTrackId || t?.sourceId;
      return (playId && tid === playId) || (playSourceId && tsid === playSourceId);
    });
    if (idx !== -1) {
      this.rotationDeck.splice(idx, 1);
    } else if (!playable.rotationEntryId) {
      this.rotationDeck.shift();
    }
    if (this.rotationDeck.length === 0 && this.fallbackTracks.length > 0) {
      this.reshuffleRotationDeck();
    }
  }

  saveDataDebounced() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const histFileName = this.roomId ? `music_history_${this.roomId}.json` : 'music_history.json';
      const logsFileName = this.roomId ? `music_request_logs_${this.roomId}.json` : 'music_request_logs.json';
      const rotHistFileName = this.roomId ? `music_rotation_history_${this.roomId}.json` : 'music_rotation_history.json';
      const rotLogsFileName = this.roomId ? `music_rotation_logs_${this.roomId}.json` : 'music_rotation_logs.json';

      const histPath = join(this.dataDir, histFileName);
      const logsPath = join(this.dataDir, logsFileName);
      const rotHistPath = join(this.dataDir, rotHistFileName);
      const rotLogsPath = join(this.dataDir, rotLogsFileName);

      const histArr = Array.from(this.historyMap.values()).sort(
        (a, b) => b.lastRequestedAt - a.lastRequestedAt || b.requestCount - a.requestCount
      ).slice(0, 3000);

      const logsArr = this.historyLogs.slice(-3000);

      const rotHistArr = Array.from(this.rotationHistoryMap.values()).sort(
        (a, b) => b.lastRotatedAt - a.lastRotatedAt || b.rotationCount - a.rotationCount
      ).slice(0, 3000);

      const rotLogsArr = this.rotationLogs.slice(-3000);

      writeJsonAtomic(histPath, histArr);
      writeJsonAtomic(logsPath, logsArr);
      writeJsonAtomic(rotHistPath, rotHistArr);
      writeJsonAtomic(rotLogsPath, rotLogsArr);
    }, 2000);
  }

  getSnapshot(onlineKeys = new Set()) {
    const requesterOnline = this.current ? onlineKeys.has(this.current.requesterKey) : false;
    const voteCount = this.current ? this.current.skipVotes.length : 0;
    const voteThreshold = this.current
      ? computeVoteThreshold(onlineKeys.size, this.current.isFallback, requesterOnline)
      : 1;

    const histList = Array.from(this.historyMap.values()).sort(
      (a, b) => b.lastRequestedAt - a.lastRequestedAt || b.requestCount - a.requestCount
    ).slice(0, 100);

    const prepared = this.queue.length ? this.preparedQueue : this.preparedFallback;
    const logsList = this.historyLogs.slice(-80).reverse();

    return {
      protocolVersion: 2,
      next: prepared?.playable && prepared.key === (this.queue[0]?.uid ?? this.fallbackGeneration) ? {
        uid: String(prepared.key), track: prepared.playable, startedAt: 0,
        durationSec: prepared.playable.durationSec || 0, requesterKey: '', requesterName: '',
        isFallback: !this.queue.length, skipVotes: []
      } : null,
      stateVersion: ++this.stateVersion,
      current: this.current && {
        ...this.current,
        phase: (this.current.phase === 'scheduled' || this.current.phase === 'preparing') &&
          Date.now() >= this.current.startedAt
          ? 'playing' : (this.current.phase || 'playing')
      },
      queue: this.queue.map(item => ({
        ...item,
        playVotes: this.queueVotePlayUid === this.current?.uid
          ? [...this.queueVotes.entries()].filter(([, target]) => target === item.uid).map(([key]) => key)
          : []
      })),
      history: histList,
      historyLogs: logsList,
      rotationTotal: this.fallbackTracks.length || this.rotationHistoryMap.size,
      rotationQueue: this.getRotationQueue(30),
      rotationDeckTotal: this.rotationDeck.length,
      rotationPoolTotal: this.fallbackTracks.length,
      fallbackPlaylistName: this.fallbackPlaylistName || '歌单轮播',
      fallbackPlaylistId: this.fallbackPlaylistId,
      requesterOnline,
      voteCount,
      voteThreshold,
      skipVoteNames: this.current ? this.current.skipVoteNames || [] : [],
      serverTime: Date.now()
    };
  }

  preferredTrackKey(original, userKey) {
    const sourceKey = userKey && musicTrackMatchKey(original);
    if (!sourceKey) return null;
    return 'music:preferred-track:' + createHash('sha256').update(JSON.stringify([userKey, sourceKey])).digest('hex');
  }

  getPreferredTrack(original, userKey) {
    const key = this.preferredTrackKey(original, userKey);
    if (!key) return null;
    try {
      return normalizeMusicTrack(this.chatDb?.getKv?.(key));
    } catch (error) {
      console.warn('[Music] preferred track read failed', error.message);
      return null;
    }
  }

  savePreferredTrack(original, userKey, track) {
    const key = this.preferredTrackKey(original, userKey);
    const identity = normalizeMusicTrack(track);
    if (!key || !identity) return;
    try {
      this.chatDb?.setKv?.(key, identity);
    } catch (error) {
      console.warn('[Music] preferred track write failed', error.message);
    }
  }

  async enqueueRandom(tracks, requester, active) {
    const exclude = track => Boolean(track.id &&
      (this.current?.track.id === track.id || this.queue.some(item => item.track.id === track.id)));
    const candidates = tracks.filter(track => !exclude(track) && (!track.matchedTrack || !exclude(track.matchedTrack)));
    const deadline = Date.now() + 12_000;
    let temporaryFailure = false;
    for (let attempt = 0; attempt < 3 && candidates.length; attempt++) {
      if (!active()) return { ok: false, code: 'ROOM_CHANGED', error: '聊天室已切换，请重新点歌' };
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const index = Math.floor(Math.random() * candidates.length);
      const [original] = candidates.splice(index, 1);
      let result;
      try {
        result = await withTimeout(
          this.resolveRotationSource(original, { alternatives: true, random: true, exclude, budgetMs: Math.min(remaining, 4800) }),
          Math.min(remaining, 5000)
        );
      } catch {
        temporaryFailure = true;
        continue;
      }
      if (!active()) return { ok: false, code: 'ROOM_CHANGED', error: '聊天室已切换，请重新点歌' };
      temporaryFailure ||= result.temporaryFailure === true;

      const track = result.playable;
      if (track && !exclude(track)) return this.enqueueTrack(track, requester, track);
    }
    return temporaryFailure
      ? { ok: false, code: 'SOURCE_TEMPORARY', error: '曲库暂时没有响应，可以再抽一次' }
      : { ok: false, code: 'NO_SOURCE', error: '这次没抽到可播曲目，可以再抽一次' };
  }

  async enqueueWithAlternatives(original, requester, { owner, active, offerId, choiceId }) {
    const confirming = offerId !== undefined;
    const offer = this.requestOffers.get(owner);
    const choice = confirming && offer?.choices.find(option => option.track.id === choiceId);
    if (confirming && (!offer || offer.token !== offerId || offer.expiresAt <= Date.now() || !choice)) {
      return { ok: false, code: 'OFFER_EXPIRED', error: '可播版本已过期，请重新查找' };
    }
    if (!confirming) this.requestOffers.delete(owner);
    const requested = confirming ? offer.original : original;
    if (!requested) return { ok: false, code: 'TRACK_CHANGED', error: '找不到这条歌单曲目，请刷新歌单后重试' };

    try {
      const result = await withTimeout(
        choice
          ? this.resolve(choice.track, { fresh: true, rejectTransient: true }).then(playable => ({ playable }))
          : this.resolveRotationSource(requested, {
              alternatives: true, preferredTrack: this.getPreferredTrack(requested, requester.userKey)
            }),
        11_000
      );
      if (!active()) return { ok: false, code: 'ROOM_CHANGED', error: '聊天室已切换，请重新点歌' };
      if (confirming && offer.expiresAt <= Date.now()) {
        return { ok: false, code: 'OFFER_EXPIRED', error: '可播版本已过期，请重新查找' };
      }
      if (result.playable) {
        this.requestOffers.delete(owner);
        const playable = choice || result.usedPreference
          ? { ...result.playable, rotationReplacement: { title: requested.title, artist: requested.artist } }
          : result.playable;
        const accepted = await this.enqueueTrack(playable, requester, playable);
        if (accepted.ok && choice) this.savePreferredTrack(requested, requester.userKey, playable);
        return accepted;
      }
      if (result.alternatives?.length) {
        const token = randomUUID();
        const expiresAt = Date.now() + 90_000;
        const choices = result.alternatives;
        this.requestOffers.set(owner, { token, expiresAt, original: requested, choices });
        return { ok: false, code: 'ALTERNATIVES', offer: {
          token, expiresAt,
          choices: choices.map(({ track, relation }) => ({ track: stableTrack(track), relation }))
        } };
      }
      if (!result.temporaryFailure) {
        return { ok: false, code: 'NO_SOURCE', error: choice
          ? '所选版本暂时无法播放，请重新查找'
          : '这首歌暂时没有可播音源，也没有找到可播的替代版本' };
      }
    } catch (error) {
      console.warn('[Music] request alternatives', this.roomId, error.message);
    }
    return { ok: false, code: 'SOURCE_TEMPORARY', error: '曲库暂时无法完成检查，请重试' };
  }

  async enqueueTrack(rawTrack, requester, verifiedSource) {
    const selectionStartedAt = Date.now();
    const requesterKey = requester.userKey;
    const requesterName = requester.name;
    const requesterAvatar = requester.avatar || '';
    const check = () => {
      if (this.current?.track.id === rawTrack.id || this.queue.some(item => item.track.id === rawTrack.id)) {
        return '歌曲已在播放或排队';
      }
      if (this.queue.length >= 100 || (!requester.isAdmin &&
          this.queue.filter(item => item.requesterKey === requesterKey).length >= 10)) {
        return '待播队列已满，请稍后再点歌';
      }
      return null;
    };
    const before = check();
    if (before) return { ok: false, error: before };
    const playable = verifiedSource || await this.resolve(rawTrack);
    const after = check();
    if (after) return { ok: false, error: after };
    if (!playable) return { ok: false, error: '歌曲暂时没有可用音源' };
    const track = stableTrack(playable);

    // Record into historyMap
    const now = Date.now();
    let histEntry = this.historyMap.get(playable.id);
    if (!histEntry) {
      histEntry = {
        track,
        requestCount: 1,
        lastRequesterName: requesterName,
        firstRequestedAt: now,
        lastRequestedAt: now
      };
      this.historyMap.set(playable.id, histEntry);
    } else {
      histEntry.requestCount += 1;
      histEntry.lastRequesterName = requesterName;
      histEntry.lastRequestedAt = now;
      histEntry.track = track;
    }

    // Record into historyLogs & database
    const uid = 'q_' + now + '_' + Math.random().toString(36).slice(2, 9);
    if (this.chatDb) {
      try {
        this.chatDb.recordSongRequest({
          roomId: this.roomId,
          track,
          requesterKey,
          requesterName,
          requesterAvatar,
          requestedAt: now,
          requestUid: uid
        });
      } catch (dbErr) {
        console.error(`[Music:${this.roomId}] 写入 SQLite 失败:`, dbErr.message);
      }
    }

    const logEntry = {
      requestUid: uid,
      outcome: 'queued',
      id: this._nextLogId++,
      track,
      requesterKey,
      requesterName,
      requesterAvatar,
      requestedAt: now,
      requestCount: histEntry.requestCount
    };
    this.historyLogs.push(logEntry);
    if (!this.chatDb) {
      if (this.historyLogs.length > 500) this.historyLogs.shift();
      if (this.historyMap.size > 300) {
        const oldest = [...this.historyMap.entries()].reduce((a, b) => a[1].lastRequestedAt <= b[1].lastRequestedAt ? a : b);
        this.historyMap.delete(oldest[0]);
      }
      this.saveDataDebounced();
    }

    // If nothing playing or currently playing fallback, play immediately!
    if ((!this.current || this.current.isFallback) && this.queue.length === 0) {
      clearTimeout(this._advanceTimer);
      this.playTrack(
        playable,
        { userKey: requesterKey, name: requesterName, avatar: requesterAvatar },
        false, undefined, uid, selectionStartedAt
      );
      this.markOutcome(uid, 'played');
      this.onStateChanged();
      return { ok: true, playImmediately: true, track: playable };
    }

    // Otherwise add to queue
    const queueItem = { uid, track, requesterKey, requesterName, requesterAvatar, enqueuedAt: now };
    this.queue.push(queueItem);
    if (this.queue[0] === queueItem) {
      void this.prepareNext(playable);
    }
    this.savePlayback();
    this.onStateChanged();

    return {
      ok: true,
      playImmediately: false,
      position: this.queue.length,
      track: playable
    };
  }

  markOutcome(uid, outcome) {
    if (this.chatDb) {
      try {
        this.chatDb.markOutcome(uid, outcome);
      } catch (e) {
        console.error(`[Music:${this.roomId}] 更新 SQLite 状态失败:`, e.message);
      }
    }
    const entry = this.historyLogs.findLast(log => log.requestUid === uid);
    if (entry) {
      entry.outcome = outcome;
      if (!this.chatDb) this.saveDataDebounced();
    }
  }

  scheduleAdvance() {
    clearTimeout(this._advanceTimer);
    clearTimeout(this._refreshPreparedTimer);
    const play = this.current;
    if (!play) return;
    const remaining = Math.max(0, play.startedAt + play.durationSec * 1000 - Date.now());
    this._advanceTimer = setTimeout(() => {
      if (this.current !== play) return;
      void this.advanceNext();
    }, remaining);
    if (remaining > 30_000) {
      this._refreshPreparedTimer = setTimeout(() => {
        if (this.current === play) void this.prepareNext(undefined, true);
      }, remaining - 25_000);
    }
  }

  playTrack(track, requester, isFallback = false, startedAt = Date.now() + START_LEAD_MS, requestUid, selectionStartedAt) {
    this.generation++;
    this.fallbackGeneration++;
    this.preparedFallback = null;
    this.current = {
      uid: 'play_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
      track,
      requesterKey: requester.userKey,
      requesterName: requester.name,
      requesterAvatar: requester.avatar || '',
      startedAt,
      selectionStartedAt,
      phase: startedAt > Date.now() ? 'scheduled' : 'playing',
      durationSec: durationOf(track.durationSec) || 240,
      isFallback,
      requestUid,
      sourceRevision: 0,
      skipVotes: [],
      skipVoteNames: []
    };
    this.savePlayback();
    this.scheduleAdvance();

    if (isFallback) {
      this.recordRotation(track);
    }

    // Resolve only the next address ahead of the switch.
    clearTimeout(this._prepareFallbackTimer);
    this._prepareFallbackTimer = setTimeout(() => void this.prepareNext(), 20);
  }

  recordRotation(rawTrack) {
    if (!rawTrack || !rawTrack.id) return;
    const track = stableTrack(rawTrack);
    const now = Date.now();
    const playlistName = this.fallbackPlaylistName || '歌单轮播';
    const playlistId = this.fallbackPlaylistId || '';

    let entry = this.rotationHistoryMap.get(track.id);
    if (!entry) {
      entry = {
        track,
        rotationCount: 1,
        lastPlaylistName: playlistName,
        lastPlaylistId: playlistId,
        firstRotatedAt: now,
        lastRotatedAt: now
      };
      this.rotationHistoryMap.set(track.id, entry);
    } else {
      entry.rotationCount += 1;
      entry.lastRotatedAt = now;
      entry.lastPlaylistName = playlistName;
      entry.lastPlaylistId = playlistId;
      entry.track = track;
    }

    const logEntry = {
      id: this._nextRotationLogId++,
      uid: 'rot_' + now + '_' + Math.random().toString(36).slice(2, 8),
      track,
      playlistName,
      playlistId,
      rotatedAt: now,
      rotationCount: entry.rotationCount
    };
    if (this.chatDb) {
      try {
        this.chatDb.recordSongRotation({
          roomId: this.roomId,
          track,
          playlistId,
          playlistName,
          rotatedAt: now,
          uid: logEntry.uid
        });
      } catch (e) {
        console.error(`[Music:${this.roomId}] 轮播写入 SQLite 失败:`, e.message);
      }
    }

    this.rotationLogs.push(logEntry);
    if (!this.chatDb) {
      if (this.rotationLogs.length > 3000) this.rotationLogs.shift();
      if (this.rotationHistoryMap.size > 3000) {
        const oldest = [...this.rotationHistoryMap.entries()].reduce(
          (a, b) => a[1].lastRotatedAt <= b[1].lastRotatedAt ? a : b
        );
        this.rotationHistoryMap.delete(oldest[0]);
      }
      this.saveDataDebounced();
    }
  }

  getHistoryPage({ type = 'request', sort = 'recent', requesterKey = '', offset = 0, limit = 100 } = {}) {
    if (this.chatDb) {
      return this.chatDb.getMusicHistoryPage({
        roomId: this.roomId,
        type,
        sort,
        requesterKey,
        offset,
        limit
      });
    }

    offset = Math.max(0, Number.parseInt(offset, 10) || 0);
    limit = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 100));

    if (type === 'rotation') {
      const list = Array.from(this.rotationHistoryMap.values());
      if (sort === 'count') {
        list.sort((a, b) => b.rotationCount - a.rotationCount || b.lastRotatedAt - a.lastRotatedAt);
      } else {
        list.sort((a, b) => b.lastRotatedAt - a.lastRotatedAt || b.rotationCount - a.rotationCount);
      }
      const total = list.length;
      const items = list.slice(offset, offset + limit).map((item) => ({
        track: item.track,
        requestCount: item.rotationCount,
        lastRequesterName: item.lastPlaylistName ? `${item.lastPlaylistName} (轮播)` : '歌单轮播',
        firstRequestedAt: item.firstRotatedAt,
        lastRequestedAt: item.lastRotatedAt,
        isRotation: true
      }));
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
      const mergedMap = new Map();
      for (const item of this.historyMap.values()) {
        mergedMap.set(item.track.id, {
          track: item.track,
          requestCount: item.requestCount,
          lastRequesterName: item.lastRequesterName || '',
          firstRequestedAt: item.firstRequestedAt,
          lastRequestedAt: item.lastRequestedAt,
          isRotation: false
        });
      }
      for (const item of this.rotationHistoryMap.values()) {
        const existing = mergedMap.get(item.track.id);
        const rotName = item.lastPlaylistName ? `${item.lastPlaylistName} (轮播)` : '歌单轮播';
        if (existing) {
          existing.requestCount += item.rotationCount;
          if (item.firstRotatedAt && item.firstRotatedAt < existing.firstRequestedAt) {
            existing.firstRequestedAt = item.firstRotatedAt;
          }
          if (item.lastRotatedAt && item.lastRotatedAt > existing.lastRequestedAt) {
            existing.lastRequestedAt = item.lastRotatedAt;
            existing.lastRequesterName = rotName;
            existing.isRotation = true;
          }
        } else {
          mergedMap.set(item.track.id, {
            track: item.track,
            requestCount: item.rotationCount,
            lastRequesterName: rotName,
            firstRequestedAt: item.firstRotatedAt,
            lastRequestedAt: item.lastRotatedAt,
            isRotation: true
          });
        }
      }
      const list = Array.from(mergedMap.values());
      if (sort === 'count') {
        list.sort((a, b) => b.requestCount - a.requestCount || b.lastRequestedAt - a.lastRequestedAt);
      } else {
        list.sort((a, b) => b.lastRequestedAt - a.lastRequestedAt || b.requestCount - a.requestCount);
      }
      const total = list.length;
      return {
        ok: true,
        type: 'all',
        total,
        offset,
        limit,
        hasMore: offset + limit < total,
        items: list.slice(offset, offset + limit)
      };
    }

    // type === 'request'
    if (requesterKey) {
      const targetMap = new Map();
      for (const log of this.historyLogs) {
        const logKey = log.requesterKey || (log.requesterName ? `name:${log.requesterName}` : '');
        if (logKey !== requesterKey) continue;
        const existing = targetMap.get(log.track.id);
        if (existing) {
          existing.requestCount += 1;
          if (log.requestedAt < existing.firstRequestedAt) existing.firstRequestedAt = log.requestedAt;
          if (log.requestedAt >= existing.lastRequestedAt) {
            existing.lastRequestedAt = log.requestedAt;
            existing.track = log.track;
            existing.lastRequesterName = log.requesterName;
          }
        } else {
          targetMap.set(log.track.id, {
            track: log.track,
            requestCount: 1,
            lastRequesterName: log.requesterName,
            firstRequestedAt: log.requestedAt,
            lastRequestedAt: log.requestedAt,
            isRotation: false
          });
        }
      }
      const list = Array.from(targetMap.values());
      if (sort === 'count') {
        list.sort((a, b) => b.requestCount - a.requestCount || b.lastRequestedAt - a.lastRequestedAt);
      } else {
        list.sort((a, b) => b.lastRequestedAt - a.lastRequestedAt || b.requestCount - a.requestCount);
      }
      const total = list.length;
      return {
        ok: true,
        type: 'request',
        total,
        offset,
        limit,
        hasMore: offset + limit < total,
        items: list.slice(offset, offset + limit)
      };
    }

    const list = Array.from(this.historyMap.values()).map((item) => ({
      ...item,
      isRotation: false
    }));
    if (sort === 'count') {
      list.sort((a, b) => b.requestCount - a.requestCount || a.firstRequestedAt - b.firstRequestedAt || a.lastRequestedAt - b.lastRequestedAt);
    } else {
      list.sort((a, b) => b.lastRequestedAt - a.lastRequestedAt || b.requestCount - a.requestCount);
    }
    const total = list.length;
    return {
      ok: true,
      type: 'request',
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
      items: list.slice(offset, offset + limit)
    };
  }

  async resolveRotationSource(candidate, { alternatives = false, exclude, budgetMs, preferredTrack, random } = {}) {
    if (this.musicRegistry.resolveRotationTrack) {
      return this.musicRegistry.resolveRotationTrack(candidate,
        track => this.resolve(track, { rejectTransient: true }), { alternatives, exclude, budgetMs, preferredTrack, random });
    }
    const matched = await this.musicRegistry.resolvePlaylistTrack(candidate);
    const track = matched || (candidate.id?.startsWith('qq:') ? candidate : null);
    return { playable: track && !exclude?.(track) ? await this.resolve(track) : null };
  }

  async resolveFallbackTrackPlayable(excludeIds = new Set()) {
    if (!this.fallbackTracks.length) return null;
    if (!this.rotationDeck.length) this.reshuffleRotationDeck();
    const deck = this.rotationDeck;
    const generation = this.fallbackGeneration;
    const exclude = track => deck.length > 1 &&
      (track.id === this.current?.track?.id || excludeIds.has(track.id));
    const deadline = Date.now() + 8000;
    for (const candidate of deck.slice(0, 12)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let playable;
      try {
        ({ playable } = await withTimeout(
          this.resolveRotationSource(candidate, { exclude }), Math.min(remaining, 3000)
        ));
      } catch (error) {
        console.warn('[Music] rotation source', this.roomId, error.message);
      }
      if (deck !== this.rotationDeck || generation !== this.fallbackGeneration) return null;
      const index = deck.indexOf(candidate);
      if (index < 0) continue;
      if (playable) return { ...playable, rotationEntryId: this.rotationEntryIds.get(candidate) };
      deck.splice(index, 1);
      // Keep the current song at the end so a one-song (or all-duplicate) pool can repeat.
      if (exclude(candidate)) deck.push(candidate);
    }
    return null;
  }

  async prepareNext(resolved, refresh = false) {
    if (!this.current) return;
    const queued = this.queue[0];
    const slot = queued ? 'preparedQueue' : 'preparedFallback';
    const key = queued?.uid ?? this.fallbackGeneration;
    const previous = this[slot]?.key === key ? this[slot] : null;
    if (previous) {
      if (!refresh || !previous.checkedAt) return;
      const usable = await this.usePrepared(previous);
      if (usable && this[slot] === previous) {
        return;
      }
    }
    if (queued ? this.queue[0] !== queued : (this.queue.length || this.fallbackGeneration !== key)) return;
    if (!queued && !this.fallbackTracks.length) return;

    const record = { key };
    this[slot] = record;
    record.pending = Promise.resolve(resolved || (queued
      ? this.resolve(queued.track)
      : previous?.playable ? this.resolve(previous.playable) : this.resolveFallbackTrackPlayable()));
    const playable = await record.pending;
    if (this[slot] !== record) return;
    if (!playable) {
      this[slot] = null;
      return;
    }
    record.playable = playable;
    record.checkedAt = Date.now();
    if (this.advancing?.generation !== this.generation) this.onStateChanged();
  }

  async usePrepared(record) {
    if (!record) return null;
    if (!record.checkedAt) {
      if (!record.pending) return null;
      // The providers already bound their requests. Join the same resolution on a skip.
      return record.pending;
    }
    if (Date.now() - record.checkedAt < PREPARED_REUSE_TTL_MS) return record.playable;
    const cached = await this.musicRegistry.isCached?.(record.playable, this.signSecret).catch(() => false);
    return cached ? record.playable : null;
  }

  async resolve(track, options) {
    this.pendingResolutions ??= new Map();
    const key = JSON.stringify([track.id, Boolean(options?.fresh), Boolean(options?.rejectTransient)]);
    const running = this.pendingResolutions.get(key);
    if (running) return running;
    const pending = Promise.resolve().then(() =>
      this.musicRegistry.resolvePlayable(track, this.serverOrigin, this.signSecret, options)
    ).catch(error => {
      console.warn('[Music] resolve', this.roomId, track.id, error.message);
      if (options?.rejectTransient) throw error;
      return null;
    }).finally(() => this.pendingResolutions.delete(key));
    this.pendingResolutions.set(key, pending);
    return pending;
  }

  advanceNext() {
    const generation = this.generation;
    if (this.advancing?.generation === generation) return this.advancing.promise;
    clearTimeout(this._advanceTimer);
    clearTimeout(this._refreshPreparedTimer);
    clearTimeout(this._prepareFallbackTimer);

    const promise = this.selectNext(generation).finally(() => {
      if (this.advancing?.promise === promise) this.advancing = null;
    });
    this.advancing = { generation, promise };
    return promise;
  }

  async selectNext(generation, selectionStartedAt = Date.now()) {
    while (this.queue.length) {
      const next = this.queue[0];
      const prepared = this.preparedQueue?.key === next.uid ? this.preparedQueue : null;
      const playable = await this.usePrepared(prepared) || await this.resolve(next.track);
      if (generation !== this.generation) return;
      if (this.queue[0] !== next) continue;
      if (playable) {
          this.queue.shift();
        this.preparedQueue = null;
        const duration = durationOf(playable.durationSec) || 240;
        const startedAt = next.startedAt && Date.now() - next.startedAt < (duration - 2) * 1000
          ? next.startedAt : undefined;
        this.playTrack(playable, {
          userKey: next.requesterKey, name: next.requesterName, avatar: next.requesterAvatar
        }, false, startedAt, next.uid, selectionStartedAt);
        this.markOutcome(next.uid, 'played');
        this.onStateChanged();
        return;
      }
      this.queue.shift();
      this.preparedQueue = null;
      this.markOutcome(next.uid, 'unavailable');
      this.onUnavailable?.(next);
      this.current = null;
      this.savePlayback();
      this.onStateChanged();
    }

    const fallbackGeneration = this.fallbackGeneration;
    const prepared = this.preparedFallback?.key === fallbackGeneration ? this.preparedFallback : null;
    this.preparedFallback = null;
    let known = await this.usePrepared(prepared);
    if (known && known.id === this.current?.track?.id) known = null;
    const playable = known || await this.resolveFallbackTrackPlayable();
    if (generation !== this.generation) return;
    if (this.queue.length || fallbackGeneration !== this.fallbackGeneration) return this.selectNext(generation, selectionStartedAt);
    if (playable) {
      this.consumeRotationTrack(playable);
      this.lastPlayedFallbackId = playable.id;
      this.playTrack(playable, {
        userKey: 'system:fallback',
        name: (this.fallbackPlaylistName || '歌单轮播') + ' (轮播)'
      }, true, undefined, undefined, selectionStartedAt);
    } else {
      this.current = null;
      this.savePlayback();
      if (this.fallbackTracks.length) {
        this._advanceTimer = setTimeout(() => void this.advanceNext(), 30_000);
      }
    }
    this.onStateChanged();
  }

  skip(actor, onlineCount, listeningCount = 0) {
    if (!this.current) return { ok: false, error: '当前没有正在播放的歌曲' };

    const isOwner = actor.userKey === this.current.requesterKey;
    const isAdmin = Boolean(actor.isAdmin);
    const isFallback = Boolean(this.current.isFallback);

    // 轮播歌单、自己点的歌、站长：随时直接切！
    // 有效听歌人数 <= 2：随时直接切！
    const canDirect = isFallback || isOwner || isAdmin || listeningCount <= 2;

    if (canDirect) {
      this.advanceNext();
      return { ok: true, skipped: true };
    }

    return this.voteSkip(actor, onlineCount, listeningCount);
  }

  voteSkip(actor, onlineCount, listeningCount = 0) {
    if (!this.current) return { ok: false, error: '当前没有正在播放的歌曲' };
    if (this.current.isFallback || actor.isAdmin || actor.userKey === this.current.requesterKey || listeningCount < 3) {
      this.advanceNext();
      return { ok: true, skipped: true };
    }

    // 取消投票 (Toggle)
    const idx = this.current.skipVotes.indexOf(actor.userKey);
    if (idx >= 0) {
      this.current.skipVotes.splice(idx, 1);
      if (Array.isArray(this.current.skipVoteNames)) {
        const nameIdx = this.current.skipVoteNames.indexOf(actor.name);
        if (nameIdx >= 0) this.current.skipVoteNames.splice(nameIdx, 1);
      }
      this.onStateChanged();
      return { ok: true, skipped: false, unvoted: true, votes: this.current.skipVotes.length };
    }

    // 首次投票
    this.current.skipVotes.push(actor.userKey);
    if (!this.current.skipVoteNames) this.current.skipVoteNames = [];
    this.current.skipVoteNames.push(actor.name);

    const threshold = computeVoteThreshold(onlineCount, this.current.isFallback, true);
    if (this.current.skipVotes.length >= threshold) {
      this.advanceNext();
      return { ok: true, skipped: true };
    }

    this.onStateChanged();
    return { ok: true, skipped: false, votes: this.current.skipVotes.length, threshold };
  }

  removeRotation(target, actor) {
    if (!actor?.userKey) return { ok: false, error: '请先登录' };
    if (!this.rotationDeck.length) return { ok: false, error: '轮播队列为空' };
    const entryId = typeof target === 'object' ? target?.entryId : target;
    const trackId = typeof target === 'object' ? target?.trackId || target?.id : target;
    const entry = this.rotationEntries.get(entryId) || this.findRotationEntry(trackId);
    const index = this.rotationDeck.indexOf(entry);
    if (index < 0) return { ok: false, error: '曲目不在当前轮播队列中' };
    const [removed] = this.rotationDeck.splice(index, 1);
    if (index === 0) {
      this.preparedFallback = null;
      clearTimeout(this._prepareFallbackTimer);
      this._prepareFallbackTimer = setTimeout(() => void this.prepareNext(), 300);
    }
    if (!this.rotationDeck.length && this.fallbackTracks.length) this.reshuffleRotationDeck();
    this.savePlayback();
    this.onStateChanged();
    return { ok: true, track: removed };
  }

  removeQueue(uid, actor) {
    const idx = this.queue.findIndex((q) => q.uid === uid);
    if (idx < 0) return { ok: false, error: '排队曲目不存在' };

    const item = this.queue[idx];
    if (item.requesterKey !== actor.userKey && !actor.isAdmin) {
      return { ok: false, error: '无权移除他人点歌' };
    }

    this.queue.splice(idx, 1);
    for (const [key, target] of this.queueVotes) if (target === uid) this.queueVotes.delete(key);
    this.markOutcome(uid, 'cancelled');
    if (idx === 0) {
      this.preparedQueue = null;
      void this.prepareNext();
    }
    this.savePlayback();
    this.onStateChanged();
    return { ok: true };
  }

  async playQueued(uid, actor, listeningCount = 0, playUid) {
    const selectionStartedAt = Date.now();
    if (playUid && playUid !== this.current?.uid) return { ok: false, error: '歌曲已切换，请重试' };
    const item = this.queue.find(entry => entry.uid === uid);
    if (!item) return { ok: false, error: '排队曲目不存在' };
    const currentUid = this.current?.uid ?? null;
    if (this.queueVotePlayUid !== currentUid) {
      this.queueVotes.clear();
      this.queueVotePlayUid = currentUid;
    }
    const canDirect = !this.current || this.current.isFallback || actor.isAdmin ||
      actor.userKey === this.current.requesterKey || listeningCount < 3;
    if (!canDirect) {
      if (this.queueVotes.get(actor.userKey) === uid) {
        this.queueVotes.delete(actor.userKey);
        this.onStateChanged();
        return { ok: true, unvoted: true };
      }
      this.queueVotes.set(actor.userKey, uid);
      const votes = [...this.queueVotes.values()].filter(target => target === uid).length;
      if (votes < 2) {
        this.onStateChanged();
        return { ok: true, votes, threshold: 2 };
      }
    }
    const generation = this.generation;
    const prepared = this.preparedQueue?.key === uid ? this.preparedQueue : null;
    const playable = await this.usePrepared(prepared) || await this.resolve(item.track);
    if (generation !== this.generation || this.current?.uid !== (currentUid ?? undefined)) {
      return { ok: false, error: '播放状态已更新，请重试' };
    }
    const index = this.queue.indexOf(item);
    if (index < 0) return { ok: false, error: '排队曲目已变更' };
    if (!playable) {
      this.queueVotes.clear();
      this.onStateChanged();
      return { ok: false, error: '歌曲暂时没有可用音源' };
    }
    this.queueVotes.clear();
    this.queue.splice(index, 1);
    if (index === 0) this.preparedQueue = null;
    this.playTrack(playable, {
      userKey: item.requesterKey, name: item.requesterName, avatar: item.requesterAvatar
    }, false, undefined, item.uid, selectionStartedAt);
    this.markOutcome(uid, 'played');
    this.onStateChanged();
    return { ok: true };
  }

  rotationPermission(actor, listeningCount) {
    const current = this.current;
    return !current || current.isFallback || actor?.userKey === current.requesterKey ||
      actor?.isAdmin || listeningCount <= 2;
  }

  findRotationEntry(target) {
    const id = typeof target === 'string' ? target : target?.entryId || target?.id;
    if (typeof id !== 'string' || !id) return null;
    if (id.startsWith('rotation:')) return this.rotationEntries.get(id);
    // Accept IDs from clients loaded before the deployment.
    const matches = this.fallbackTracks.filter(track =>
      track.id === id || track.matchedTrack?.id === id ||
      id === 'qq:' + (track.matchedTrack?.sourceId || track.sourceTrackId || track.sourceId || '')
    );
    return matches.length === 1 ? matches[0] : null;
  }

  rotationFailure(code, error) {
    return { ok: false, code, error };
  }

  async playRotationTrack(target, actor, listeningCount = 0, context = {}) {
    const owner = context.owner || actor;
    const getAudience = context.getAudience || (() => listeningCount);
    const active = context.active || (() => true);
    if (this.rotationRequests.has(actor.userKey) || this.rotationRequests.size >= 12) {
      return this.rotationFailure('BUSY', '上一项切播请求仍在处理，请稍后重试');
    }
    if (context.hasExpectedPlay && (context.playUid || '') !== (this.current?.uid || '')) {
      return this.rotationFailure('PLAYBACK_CHANGED', '房间播放已变化，请重新选择');
    }
    if (!this.rotationPermission(actor, getAudience())) {
      return this.rotationFailure('FORBIDDEN', '当前有其他成员点播的歌曲正在播放，暂不能直接切换轮播');
    }

    const selectionStartedAt = Date.now();
    const confirming = context.offerId !== undefined;
    let offer;
    let requested;
    let selected;
    if (confirming) {
      offer = this.rotationOffers.get(owner);
      selected = offer?.choices.find(option => option.track.id === context.choiceId);
      if (!offer || offer.token !== context.offerId || offer.expiresAt <= Date.now() || !selected) {
        return this.rotationFailure('OFFER_EXPIRED', '可播版本已过期，请重新查找');
      }
      requested = offer.requested;
    } else {
      this.rotationOffers.delete(owner);
      requested = this.findRotationEntry(target);
    }
    if (!requested) {
      return this.rotationFailure('ROTATION_CHANGED', '轮播列表已更新，请重新选择曲目');
    }
    const entryId = this.rotationEntryIds.get(requested);
    const snapshot = { current: this.current, queue: this.queue[0], pool: this.rotationEntryIds };
    const stillCurrent = () => active() && snapshot.current === this.current &&
      snapshot.queue === this.queue[0] && snapshot.pool === this.rotationEntryIds &&
      this.rotationPermission(actor, getAudience()) &&
      (!offer || (offer.snapshot.current === this.current && offer.snapshot.queue === this.queue[0] &&
        offer.snapshot.pool === this.rotationEntryIds && offer.expiresAt > Date.now()));
    const changed = () => this.rotationFailure('PLAYBACK_CHANGED', '房间播放或轮播列表已变化，请重新选择');
    if (!stillCurrent()) return changed();

    this.rotationRequests.add(actor.userKey);
    try {
      const result = await withTimeout(
        selected
          ? this.resolve(selected.track, { fresh: true, rejectTransient: true }).then(playable => ({ playable }))
          : this.resolveRotationSource(requested, {
              alternatives: Boolean(context.allowAlternatives),
              preferredTrack: this.getPreferredTrack(requested, actor.userKey)
            }),
        11_000
      );
      if (!stillCurrent()) return changed();
      if (result.playable) {
        this.rotationOffers.delete(owner);
        const track = selected || result.usedPreference
          ? { ...result.playable, rotationReplacement: { title: requested.title, artist: requested.artist } }
          : result.playable;
        this.consumeRotationTrack({ ...track, rotationEntryId: entryId });
        this.lastPlayedFallbackId = track.id;
        this.playTrack(track, {
          userKey: 'system:fallback',
          name: (this.fallbackPlaylistName || '歌单轮播') + ' (轮播)'
        }, true, undefined, undefined, selectionStartedAt);
        if (selected) this.savePreferredTrack(requested, actor.userKey, track);
        this.onStateChanged();
        return { ok: true, playUid: this.current.uid };
      }
      if (result.alternatives?.length) {
        const token = randomUUID();
        const expiresAt = Date.now() + 90_000;
        this.rotationOffers.set(owner, {
          token, expiresAt, choices: result.alternatives, requested, snapshot
        });
        return {
          ok: false,
          code: 'ALTERNATIVES',
          offer: {
            token, expiresAt,
            choices: result.alternatives.map(({ track, relation }) => ({ track: stableTrack(track), relation }))
          }
        };
      }
      if (result.temporaryFailure) {
        return this.rotationFailure('SOURCE_TEMPORARY', '曲库暂时无法完成检查，请重试');
      }
      return this.rotationFailure('NO_SOURCE', selected ? '这个版本的音源已不可用，请重新查找' : '这首歌暂无可用音源');
    } catch (error) {
      console.warn('[Music] manual rotation source', this.roomId, error.message);
      return this.rotationFailure('SOURCE_TEMPORARY', '曲库暂时无法完成检查，请重试');
    } finally {
      this.rotationRequests.delete(actor.userKey);
    }
  }

  reportDuration(playUid, value) {
    const play = this.current;
    const duration = durationOf(value);
    if (!play || play.uid !== playUid || !duration || play.measuredDuration) return;
    if (play.track.durationSec && Math.abs(duration - play.durationSec) > Math.max(15, play.durationSec * 0.25)) return;
    if (duration < (Date.now() - play.startedAt) / 1000 - 2) return;
    play.measuredDuration = true;
    play.durationSec = duration;
    play.track.durationSec = duration;
    const history = this.historyMap.get(play.track.id);
    if (history) history.track.durationSec = duration;
    if (this.advancing?.generation !== this.generation) {
      this.scheduleAdvance();
      this.onStateChanged();
    }
    this.savePlayback();
    this.saveDataDebounced();
  }

  async reportError(playUid, actorKey, revision) {
    const play = this.current;
    if (!play || play.uid !== playUid || (revision !== undefined && revision !== play.sourceRevision) || this.recovering === play) return;
    if (Date.now() - (play.lastRecoveryAt || 0) < 20_000 || (play.recoveryCount || 0) >= 2) return;
    const lastError = this._actorLastErrorAt.get(actorKey) || 0;
    if (Date.now() - lastError < 12_000) return;
    this._actorLastErrorAt.set(actorKey, Date.now());
    if (this._actorLastErrorAt.size > 256) this._actorLastErrorAt.delete(this._actorLastErrorAt.keys().next().value);
    this.recovering = play;
    const generation = this.generation;
    const stale = () => this.current !== play || generation !== this.generation || this.advancing?.generation === generation;
    try {
      play.lastRecoveryAt = Date.now();
      // A client timeout is not evidence that the shared source is broken.
      const healthy = await this.musicRegistry.isHealthy(play.track, this.signSecret).catch(() => false);
      if (stale() || healthy) return;
      const playable = await this.resolve(play.track, { fresh: true, rejectTransient: play.isFallback });
      if (stale()) return;
      play.recoveryCount = (play.recoveryCount || 0) + 1;
      if (playable) {
        // Notify even for the same address: clients must actually reload that resource.
        play.track = playable;
        play.sourceRevision++;
        this.onStateChanged();
      } else if (play.isFallback) {
        await this.advanceNext();
      }
    } catch (error) {
      console.warn('[Music] rotation recovery', this.roomId, error.message);
    } finally {
      if (this.recovering === play) this.recovering = null;
    }
  }

  ended(playUid) {
    const play = this.current;
    if (play?.uid === playUid && Date.now() - play.startedAt >= Math.max(0, play.durationSec - 3) * 1000) {
      void this.advanceNext();
    }
  }

  getMemberTracks(userKey, beforeId = 0, limit = 50) {
    let list = this.historyLogs.filter((l) => l.requesterKey === userKey);
    if (beforeId > 0) {
      list = list.filter((l) => l.id < beforeId);
    }
    const safeLimit = Math.min(100, Math.max(1, limit));
    const slice = list.slice(-safeLimit).reverse();
    const hasMore = list.length > slice.length;
    const nextBeforeId = slice.length > 0 ? slice[slice.length - 1].id : 0;

    return {
      ok: true,
      tracks: slice,
      hasMore,
      nextBeforeId
    };
  }
}
