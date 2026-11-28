/**
 * 聊天室全景统计引擎（基于 SQLite + 自然日预聚合缓存）
 *
 * 覆盖：
 * - 单日 / 近3天 / 本周 / 本月 / 全部历史多维度聚合
 * - 5 种表情贴纸形态归一去重（附件 isSticker、:pack_name:、[lottie:name]、[sticker:id]、Markdown 贴纸）
 * - 纯图片附件与用户 Markdown 晒图统计（排除贴纸与 [LX:*] 分享卡片封面图）
 * - 有效自然语言字数统计（剥离分享注释、短码与 URL）
 * - 消息回应 Reactions 统计、点歌与轮播金曲榜、互联友站分布、24h 作息分布与日历热力图
 */

export const STATS_CACHE_VERSION = 5;
const DEFAULT_TZ_OFFSET_MIN = 480; // UTC+8 北京时间
const LIVE_DAY_TTL_MS = 15_000;
const DAY_MS = 86_400_000;

const LOTTIE_LABEL_MAP = {
  caigou: '菜狗',
  aini: '爱你',
  bianpao: '鞭炮',
  bixin: '比心',
  cool: '酷',
  daku: '大哭',
  exin: '恶心',
  fan: '烦',
  foxi: '佛系',
  gandong: '感动',
  gongzuo: '工作',
  huang: '慌',
  jingxia: '惊吓',
  jiong: '囧',
  kaixin: '开心',
  meiku: '美哭',
  meishi: '美食',
  re: '热',
  shengqi: '生气',
  shengri: '生日',
  shuijiao: '睡觉',
  tietie: '贴贴',
  wangpan: '网盘',
  wenhao: '问号',
  wuzui: '捂嘴',
  xiaoku: '笑哭',
  yanhua: '烟花',
};

const STICKER_URL_RE = /(?:\/(?:stickers|waline-emojis|owo)\/|qface)/i;
const COLON_STICKER_RE = /:([A-Za-z0-9_.-]+)_([^:\s<>"']+?):/g;
const LOTTIE_TOKEN_RE = /\[lottie:([a-zA-Z0-9-]+)\]/g;
const BRACKET_STICKER_RE = /\[sticker:([a-zA-Z0-9/_-]+)\]/g;
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const LX_SHARE_PREFIX_RE = /^\uFEFF?\s*\[LX:(文章分享|动态分享|友链分享|朋友圈分享|音乐分享)\]/;
const UNICODE_EMOJI_RE = /[\p{Extended_Pictographic}]/u;

const graphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('zh-Hans', { granularity: 'grapheme' })
  : null;

export function clampTzOffset(rawOffset) {
  const n = Number(rawOffset);
  if (!Number.isFinite(n)) return DEFAULT_TZ_OFFSET_MIN;
  return Math.max(-720, Math.min(840, Math.trunc(n)));
}

export function toDayKey(tsMs, tzOffsetMin = DEFAULT_TZ_OFFSET_MIN) {
  const shifted = new Date(Number(tsMs) + tzOffsetMin * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isValidDayKey(dayKey) {
  return typeof dayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dayKey);
}

export function dayKeyToRangeMs(dayKey, tzOffsetMin = DEFAULT_TZ_OFFSET_MIN) {
  if (!isValidDayKey(dayKey)) return null;
  const [y, m, d] = dayKey.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const testDate = new Date(utcMidnight);
  if (
    testDate.getUTCFullYear() !== y ||
    testDate.getUTCMonth() !== m - 1 ||
    testDate.getUTCDate() !== d
  ) {
    return null;
  }
  const startMs = utcMidnight - tzOffsetMin * 60_000;
  return { startMs, endMs: startMs + DAY_MS };
}

export function shiftDayKey(dayKey, deltaDays) {
  const range = dayKeyToRangeMs(dayKey, 0);
  if (!range) return dayKey;
  return toDayKey(range.startMs + deltaDays * DAY_MS, 0);
}

export function getHourOfDay(tsMs, tzOffsetMin = DEFAULT_TZ_OFFSET_MIN) {
  const shifted = new Date(Number(tsMs) + tzOffsetMin * 60_000);
  return shifted.getUTCHours();
}

export function listDayKeysBetween(startDay, endDay, maxDays = 400) {
  const start = dayKeyToRangeMs(startDay, 0);
  const end = dayKeyToRangeMs(endDay, 0);
  if (!start || !end || start.startMs > end.startMs) return [];
  const days = [];
  for (let t = start.startMs; t <= end.startMs && days.length < maxDays; t += DAY_MS) {
    days.push(toDayKey(t, 0));
  }
  return days;
}

function normalizeStickerTokenName(raw) {
  return String(raw || '')
    .trim()
    .replace(/^mx-sticker:/i, '')
    .trim();
}

function buildStickerUrlForPackItem(pack, item) {
  const p = pack.toLowerCase();
  const encoded = encodeURIComponent(item);
  if (p === 'miku') return `/assets/stickers/miku/${encodeURIComponent(`miku_${item}`)}.webp`;
  if (p === 'qq') return `/assets/stickers/qq/${encodeURIComponent(`qq_${item}`)}.gif`;
  if (p === 'bmoji') return `/assets/stickers/bmoji/${encodeURIComponent(`bmoji_${item}`)}.png`;
  if (p === 'anbao') return `https://rainzt.cn/assets/waline-emojis/anbao/anbao_${encoded}.webp`;
  if (p === 'younuo') return `https://rainzt.cn/assets/waline-emojis/younuo/younuo_${encoded}.webp`;
  if (p === 'bb') return `https://rainzt.cn/assets/waline-emojis/bilibili/bb_${encoded}.png`;
  if (p === 'snow') {
    const real = item.startsWith('snow-') ? item : `snow-${item}`;
    return `https://daily.yybb.us/owo/snow/${encodeURIComponent(real)}.webp`;
  }
  if (p === 'fav') {
    const real = item.startsWith('fav-') ? item : `fav-${item}`;
    return `https://daily.yybb.us/owo/favorites/${encodeURIComponent(real)}.jpg`;
  }
  return '';
}

function canonicalizeStickerFromNameOrUrl(rawName, rawUrl = '') {
  const cleanName = normalizeStickerTokenName(rawName);
  const url = String(rawUrl || '').trim();

  // 1. Lottie tokens inside name
  const lottieFromName = /^\[lottie:([a-z0-9-]+)\]$/i.exec(cleanName) || /^:lottie_([a-z0-9-]+):$/i.exec(cleanName);
  if (lottieFromName) {
    const key = lottieFromName[1].toLowerCase();
    return {
      key: `lottie:${key}`,
      label: LOTTIE_LABEL_MAP[key] || key,
      kind: 'lottie',
      lottieKey: key,
      previewUrl: `/assets/stickers/lottie/${encodeURIComponent(key)}.gif`,
    };
  }

  // 2. Colon shortcode inside name
  const colonFromName = /^:([A-Za-z0-9_.-]+)_([^:\s<>"']+?):$/.exec(cleanName);
  if (colonFromName) {
    return canonicalizeColonSticker(colonFromName[1], colonFromName[2], url);
  }

  // 3. Snow / Fav stickers (common across attachments, markdown, and colon shortcodes)
  if (/^snow-\d+$/i.test(cleanName) || /\/owo\/snow\/(snow-\d+)/i.test(url)) {
    const m = /^snow-\d+$/i.exec(cleanName) || /\/owo\/snow\/(snow-\d+)/i.exec(url);
    const id = m[1] ? m[1].toLowerCase() : m[0].toLowerCase();
    return {
      key: `sticker:snow:${id}`,
      label: id,
      kind: 'sticker',
      previewUrl: url || `https://daily.yybb.us/owo/snow/${encodeURIComponent(id)}.webp`,
    };
  }
  if (/^fav-\d+$/i.test(cleanName) || /\/owo\/favorites\/(fav-\d+)/i.test(url)) {
    const m = /^fav-\d+$/i.exec(cleanName) || /\/owo\/favorites\/(fav-\d+)/i.exec(url);
    const id = m[1] ? m[1].toLowerCase() : m[0].toLowerCase();
    return {
      key: `sticker:fav:${id}`,
      label: id,
      kind: 'sticker',
      previewUrl: url || `https://daily.yybb.us/owo/favorites/${encodeURIComponent(id)}.jpg`,
    };
  }

  // 4. Known path-based packs (anbao, younuo, miku, qq, bmoji)
  if (url) {
    const anbaoUrl = /\/anbao\/(?:anbao_)?([^/?#]+?)\.(?:webp|png|gif|jpg)/i.exec(url);
    if (anbaoUrl) {
      const item = decodeURIComponent(anbaoUrl[1]);
      return {
        key: `sticker:anbao:${item}`,
        label: `岸宝 · ${item}`,
        kind: 'sticker',
        previewUrl: url,
      };
    }
    const younuoUrl = /\/younuo\/(?:younuo_)?([^/?#]+?)\.(?:webp|png|gif|jpg)/i.exec(url);
    if (younuoUrl) {
      const item = decodeURIComponent(younuoUrl[1]);
      return {
        key: `sticker:younuo:${item}`,
        label: `尤诺 · ${item}`,
        kind: 'sticker',
        previewUrl: url,
      };
    }
    const localPackUrl = /\/assets\/stickers\/([a-z0-9_-]+)\/\1_([^/?#]+?)\.(?:png|webp|gif|jpg)/i.exec(url);
    if (localPackUrl) {
      const pack = localPackUrl[1].toLowerCase();
      const item = decodeURIComponent(localPackUrl[2]);
      return {
        key: `sticker:${pack}:${item}`,
        label: item,
        kind: 'sticker',
        previewUrl: url,
      };
    }
  }

  // 5. Generic Matrix / external sticker: avoid collapsing unrelated "image.png" / "sticker.webp" / UUIDs
  const isGenericFile =
    !cleanName ||
    /^(?:image|sticker|file|img|photo|贴纸|表情)(?:\.[a-z0-9]+)?$/i.test(cleanName) ||
    /^[0-9a-f]{8}-[0-9a-f-]{27}/i.test(cleanName);

  if (!isGenericFile) {
    const normLabel = cleanName.replace(/\.(?:png|webp|gif|jpe?g|avif)$/i, '');
    return {
      key: `ext:${normLabel.toLowerCase()}`,
      label: normLabel,
      kind: 'sticker',
      previewUrl: url,
    };
  }

  if (url) {
    const mediaPath = url.replace(/^https?:\/\/[^/]+/, '');
    return {
      key: `media:${mediaPath}`,
      label: cleanName && !/^[0-9a-f]{8}-/i.test(cleanName) ? cleanName.replace(/\.[a-z0-9]+$/i, '') : '自定义贴纸',
      kind: 'sticker',
      previewUrl: url,
    };
  }

  return {
    key: `ext:${(cleanName || 'sticker').toLowerCase()}`,
    label: cleanName || '贴纸',
    kind: 'sticker',
    previewUrl: '',
  };
}

function canonicalizeColonSticker(rawPack, rawItem, fallbackUrl = '') {
  const pack = String(rawPack || '').toLowerCase();
  const item = String(rawItem || '').trim();
  if (pack === 'lottie') {
    const key = item.toLowerCase();
    return {
      key: `lottie:${key}`,
      label: LOTTIE_LABEL_MAP[key] || key,
      kind: 'lottie',
      lottieKey: key,
      previewUrl: `/assets/stickers/lottie/${encodeURIComponent(key)}.gif`,
    };
  }
  if (pack === 'snow') {
    if (item.startsWith('fav-')) {
      return {
        key: `sticker:fav:${item.toLowerCase()}`,
        label: item.toLowerCase(),
        kind: 'sticker',
        previewUrl: fallbackUrl || buildStickerUrlForPackItem('fav', item),
      };
    }
    const real = item.startsWith('snow-') ? item.toLowerCase() : `snow-${item.toLowerCase()}`;
    return {
      key: `sticker:snow:${real}`,
      label: real,
      kind: 'sticker',
      previewUrl: fallbackUrl || buildStickerUrlForPackItem('snow', real),
    };
  }
  if (pack === 'fav' || pack === 'xue') {
    const lower = item.toLowerCase();
    if (pack === 'fav' || lower.startsWith('fav-')) {
      const real = lower.startsWith('fav-') ? lower : `fav-${lower}`;
      return {
        key: `sticker:fav:${real}`,
        label: real,
        kind: 'sticker',
        previewUrl: fallbackUrl || buildStickerUrlForPackItem('fav', real),
      };
    }
    const real = lower.startsWith('snow-') ? lower : `snow-${lower}`;
    return {
      key: `sticker:snow:${real}`,
      label: real,
      kind: 'sticker',
      previewUrl: fallbackUrl || buildStickerUrlForPackItem('snow', real),
    };
  }
  const label = pack === 'anbao' ? `岸宝 · ${item}` : pack === 'younuo' ? `尤诺 · ${item}` : item;
  return {
    key: `sticker:${pack}:${item}`,
    label,
    kind: 'sticker',
    previewUrl: fallbackUrl || buildStickerUrlForPackItem(pack, item),
  };
}

/**
 * 解析单条消息的贴纸、图片、多媒体、分享标记、有效字数与纯文本 Unicode Emoji
 */
export function analyzeMessageFeatures(contentRaw, attachmentsRaw) {
  const content = typeof contentRaw === 'string' ? contentRaw : '';
  let attachments = [];
  if (Array.isArray(attachmentsRaw)) {
    attachments = attachmentsRaw;
  } else if (typeof attachmentsRaw === 'string' && attachmentsRaw.trim() && attachmentsRaw.trim() !== '[]') {
    try {
      const parsed = JSON.parse(attachmentsRaw);
      if (Array.isArray(parsed)) attachments = parsed;
    } catch {}
  }

  const stickers = [];
  let imageCount = 0;
  let videoCount = 0;
  let audioCount = 0;
  let fileCount = 0;

  for (const att of attachments) {
    if (!att || typeof att !== 'object') continue;
    if (att.isSticker) {
      stickers.push(canonicalizeStickerFromNameOrUrl(att.name, att.url || att.thumbnailUrl || ''));
    } else if (att.type === 'image') {
      imageCount += 1;
    } else if (att.type === 'video') {
      videoCount += 1;
    } else if (att.type === 'audio') {
      audioCount += 1;
    } else if (att.type === 'file') {
      fileCount += 1;
    }
  }

  const shareMatch = LX_SHARE_PREFIX_RE.exec(content);
  const shareKind = shareMatch ? shareMatch[1] : null;

  // Strip HTML comments (e.g. <!--lx-music:...-->) before inline extraction
  let textForParsing = content.replace(/<!--[\s\S]*?-->/g, '');

  // Markdown images (skip share card embedded covers)
  textForParsing = textForParsing.replace(MD_IMAGE_RE, (_full, alt, url) => {
    const cleanAlt = String(alt || '').trim();
    const cleanUrl = String(url || '').trim();
    if (shareKind) return ' ';
    if (
      STICKER_URL_RE.test(cleanUrl) ||
      /^mx-sticker:/i.test(cleanAlt) ||
      /^表情[：:]/i.test(cleanAlt)
    ) {
      stickers.push(canonicalizeStickerFromNameOrUrl(cleanAlt, cleanUrl));
    } else if (cleanUrl) {
      imageCount += 1;
    }
    return ' ';
  });

  // Inline Lottie tokens
  textForParsing = textForParsing.replace(LOTTIE_TOKEN_RE, (_full, name) => {
    const key = String(name || '').toLowerCase();
    if (key) {
      stickers.push({
        key: `lottie:${key}`,
        label: LOTTIE_LABEL_MAP[key] || key,
        kind: 'lottie',
        lottieKey: key,
        previewUrl: `/assets/stickers/lottie/${encodeURIComponent(key)}.gif`,
      });
    }
    return ' ';
  });

  // Inline bracket stickers [sticker:...]
  textForParsing = textForParsing.replace(BRACKET_STICKER_RE, (_full, id) => {
    const label = String(id || '').split('/').pop() || '贴纸';
    stickers.push({
      key: `bracket:${id}`,
      label,
      kind: 'sticker',
      previewUrl: '',
    });
    return ' ';
  });

  // Inline colon stickers :pack_item:
  textForParsing = textForParsing.replace(COLON_STICKER_RE, (_full, pack, item) => {
    stickers.push(canonicalizeColonSticker(pack, item));
    return ' ';
  });

  // Effective natural language chars (remove share prefix, markdown link syntax/URLs, whitespace)
  let plain = textForParsing
    .replace(LX_SHARE_PREFIX_RE, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s<>()]+/g, '')
    .replace(/[`*_~>#\s]/g, '');

  const textEmojis = [];
  let charCount = 0;
  if (graphemeSegmenter) {
    for (const seg of graphemeSegmenter.segment(plain)) {
      const s = seg.segment;
      if (UNICODE_EMOJI_RE.test(s) && !/^[0-9#*]$/.test(s)) {
        textEmojis.push(s);
      } else {
        charCount += 1;
      }
    }
  } else {
    charCount = [...plain].length;
  }

  return {
    stickers,
    stickerCount: stickers.length,
    imageCount,
    videoCount,
    audioCount,
    fileCount,
    shareKind,
    textEmojis,
    charCount,
  };
}

export function ensureStatsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_daily_stats_cache (
      room_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, day_key)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_stats
      ON chat_messages (room_id, kind, is_redacted, created_at);
    CREATE INDEX IF NOT EXISTS idx_reactions_created
      ON chat_reactions (created_at DESC);
  `);
}

export function upsertReactionRecord(db, { messageEventId, senderKey, senderName = '', reactionKey, createdAt = Date.now() }) {
  if (!db || !messageEventId || !senderKey || !reactionKey) return;
  try {
    db.prepare(`
      INSERT INTO chat_reactions (message_event_id, sender_key, sender_name, reaction_key, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(message_event_id, sender_key, reaction_key) DO UPDATE SET
        sender_name = CASE WHEN excluded.sender_name != '' THEN excluded.sender_name ELSE chat_reactions.sender_name END
    `).run(String(messageEventId), String(senderKey), String(senderName || ''), String(reactionKey), Number(createdAt) || Date.now());
  } catch {}
}

export function removeReactionRecord(db, { messageEventId, senderKey, reactionKey }) {
  if (!db || !messageEventId || !senderKey || !reactionKey) return;
  try {
    db.prepare(`
      DELETE FROM chat_reactions
      WHERE message_event_id = ? AND sender_key = ? AND reaction_key = ?
    `).run(String(messageEventId), String(senderKey), String(reactionKey));
  } catch {}
}

/**
 * 将历史消息 JSON 中的 reactions 幂等回填到 chat_reactions 表
 */
export function backfillReactionsFromMessages(db, messagesByRoom = {}) {
  if (!db) return 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO chat_reactions (message_event_id, sender_key, sender_name, reaction_key, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const msgs of Object.values(messagesByRoom)) {
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        if (!m || !m.reactions || typeof m.reactions !== 'object') continue;
        const eventId = m.matrixEventId || m.msgUid;
        if (!eventId) continue;
        const ts = Number(m.createdAt) || Date.now();
        for (const [reactionKey, users] of Object.entries(m.reactions)) {
          if (!reactionKey || !Array.isArray(users)) continue;
          for (const uKey of users) {
            if (!uKey || typeof uKey !== 'string') continue;
            const res = stmt.run(String(eventId), uKey, '', String(reactionKey), ts);
            if (res?.changes > 0) inserted += Number(res.changes);
          }
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return inserted;
}

export class ChatStatsEngine {
  /**
   * @param {object} options
   * @param {import('node:sqlite').DatabaseSync} options.db
   * @param {(rawKey: string) => string} [options.normalizeUserKey]
   * @param {(userKey: string, fallback?: object) => object} [options.resolveUserMeta]
   * @param {(userKey: string, fallback?: object) => object} [options.resolveSiteMeta]
   */
  constructor({ db, normalizeUserKey, resolveUserMeta, resolveSiteMeta }) {
    this.db = db;
    this.normalizeUserKey = normalizeUserKey || ((k) => String(k || '').trim());
    this.resolveUserMeta = resolveUserMeta || defaultResolveUserMeta;
    this.resolveSiteMeta = resolveSiteMeta || defaultResolveSiteMeta;
    this.liveDayCache = new Map(); // `${roomId}:${dayKey}:${tz}` -> { ts, bucket }
    ensureStatsSchema(this.db);
  }

  invalidateDay(roomId, tsOrDayKey = Date.now(), tzOffsetMin = DEFAULT_TZ_OFFSET_MIN) {
    const dayKey = isValidDayKey(tsOrDayKey)
      ? tsOrDayKey
      : toDayKey(Number(tsOrDayKey) || Date.now(), tzOffsetMin);
    const rooms = roomId ? [roomId, 'all'] : ['interconnect', 'chat', 'all'];
    for (const r of rooms) {
      for (const cacheKey of this.liveDayCache.keys()) {
        if (cacheKey.startsWith(`${r}:${dayKey}:`)) {
          this.liveDayCache.delete(cacheKey);
        }
      }
      try {
        this.db.prepare('DELETE FROM chat_daily_stats_cache WHERE room_id = ? AND day_key = ?').run(r, dayKey);
      } catch {}
    }
  }

  getAvailableRange(roomId, tzOffsetMin = DEFAULT_TZ_OFFSET_MIN) {
    const todayKey = toDayKey(Date.now(), tzOffsetMin);
    const roomFilter = roomId && roomId !== 'all' ? 'AND room_id = ?' : '';
    const params = roomId && roomId !== 'all' ? [roomId] : [];
    const msgRow = this.db.prepare(`
      SELECT MIN(created_at) AS minTs, MAX(created_at) AS maxTs
      FROM chat_messages
      WHERE kind = 'user' AND is_redacted = 0 ${roomFilter}
    `).get(...params);
    const musicRow = this.db.prepare(`
      SELECT MIN(requested_at) AS minTs, MAX(requested_at) AS maxTs
      FROM music_request_logs
      WHERE 1=1 ${roomFilter}
    `).get(...params);

    const mins = [msgRow?.minTs, musicRow?.minTs].filter((v) => Number(v) > 0);
    const maxs = [msgRow?.maxTs, musicRow?.maxTs].filter((v) => Number(v) > 0);
    const minDay = mins.length > 0 ? toDayKey(Math.min(...mins), tzOffsetMin) : todayKey;
    const maxDay = maxs.length > 0 ? toDayKey(Math.max(...maxs), tzOffsetMin) : todayKey;
    return { minDay, maxDay: maxDay > todayKey ? maxDay : todayKey, todayKey };
  }

  getOrComputeDayBucket(roomId, dayKey, tzOffsetMin = DEFAULT_TZ_OFFSET_MIN) {
    const todayKey = toDayKey(Date.now(), tzOffsetMin);
    const isTodayOrFuture = dayKey >= todayKey;
    const cacheKey = `${roomId}:${dayKey}:${tzOffsetMin}`;

    if (isTodayOrFuture) {
      const cached = this.liveDayCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < LIVE_DAY_TTL_MS) {
        return cached.bucket;
      }
      const bucket = this.computeDayBucket(roomId, dayKey, tzOffsetMin);
      this.liveDayCache.set(cacheKey, { ts: Date.now(), bucket });
      return bucket;
    }

    if (tzOffsetMin === DEFAULT_TZ_OFFSET_MIN) {
      const row = this.db.prepare(`
        SELECT version, payload_json FROM chat_daily_stats_cache
        WHERE room_id = ? AND day_key = ?
      `).get(roomId, dayKey);
      if (row && Number(row.version) === STATS_CACHE_VERSION && row.payload_json) {
        try {
          return JSON.parse(row.payload_json);
        } catch {}
      }
    }

    const bucket = this.computeDayBucket(roomId, dayKey, tzOffsetMin);
    if (tzOffsetMin === DEFAULT_TZ_OFFSET_MIN) {
      try {
        this.db.prepare(`
          INSERT INTO chat_daily_stats_cache (room_id, day_key, version, payload_json, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(room_id, day_key) DO UPDATE SET
            version = excluded.version,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at
        `).run(roomId, dayKey, STATS_CACHE_VERSION, JSON.stringify(bucket), Date.now());
      } catch {}
    }
    return bucket;
  }

  computeDayBucket(roomId, dayKey, tzOffsetMin = DEFAULT_TZ_OFFSET_MIN) {
    const range = dayKeyToRangeMs(dayKey, tzOffsetMin);
    if (!range) return createEmptyDayBucket(dayKey);
    const { startMs, endMs } = range;

    const bucket = createEmptyDayBucket(dayKey);
    const activeUserSet = new Set();
    const siteActiveSets = new Map();
    const msgSenderById = new Map();

    const roomClause = roomId === 'all' ? '' : 'AND room_id = ?';
    const baseParams = roomId === 'all' ? [startMs, endMs] : [roomId, startMs, endMs];

    const messages = this.db.prepare(`
      SELECT room_id, event_id, msg_uid, sender_key, sender_name, sender_avatar,
             badge, badge_type, is_admin, content, reply_to_json,
             attachments_json, mention_keys_json, created_at
      FROM chat_messages
      WHERE kind = 'user' AND is_redacted = 0
        ${roomClause}
        AND created_at >= ? AND created_at < ?
      ORDER BY created_at ASC
    `).all(...baseParams);

    const morningCutoff = startMs + 5 * 3600_000;

    for (const row of messages) {
      const rawKey = String(row.sender_key || '').trim();
      if (!rawKey || rawKey === 'system:fallback') continue;
      const uKey = this.normalizeUserKey(rawKey) || rawKey;
      const createdAt = Number(row.created_at) || startMs;
      const hour = getHourOfDay(createdAt, tzOffsetMin);

      const userEntry = ensureBucketUser(bucket.users, uKey, () => {
        const meta = this.resolveUserMeta(uKey, {
          name: row.sender_name,
          avatar: row.sender_avatar,
          badge: row.badge,
          badgeType: row.badge_type,
          isAdmin: Boolean(row.is_admin),
        });
        const site = this.resolveSiteMeta(uKey, {
          roomId: row.room_id,
          badge: row.badge,
          senderName: row.sender_name,
        });
        return {
          userKey: uKey,
          name: meta.name || row.sender_name || uKey,
          avatar: meta.avatar || row.sender_avatar || '',
          badge: meta.badge || row.badge || '',
          badgeType: meta.badgeType || row.badge_type || 'tag',
          isAdmin: Boolean(meta.isAdmin ?? row.is_admin),
          customBadges: Array.isArray(meta.customBadges) ? meta.customBadges : [],
          siteKey: site.siteKey,
          siteName: site.siteName,
          siteColor: site.color,
          messages: 0,
          chars: 0,
          images: 0,
          stickers: 0,
          reactionsGiven: 0,
          reactionsReceived: 0,
          textEmojis: 0,
          musicRequests: 0,
          repliesSent: 0,
          repliesReceived: 0,
          mentionsReceived: 0,
          shares: 0,
          videos: 0,
          audios: 0,
          files: 0,
          firstMsgAt: createdAt,
          lastMsgAt: createdAt,
          nightOwlMessages: 0,
        };
      });

      // Keep freshest avatar/name if missing
      if (!userEntry.avatar && row.sender_avatar) userEntry.avatar = row.sender_avatar;
      if (createdAt < userEntry.firstMsgAt) userEntry.firstMsgAt = createdAt;
      if (createdAt > userEntry.lastMsgAt) userEntry.lastMsgAt = createdAt;

      if (row.event_id) msgSenderById.set(row.event_id, uKey);
      if (row.msg_uid) msgSenderById.set(row.msg_uid, uKey);

      const feat = analyzeMessageFeatures(row.content, row.attachments_json);
      activeUserSet.add(uKey);

      bucket.totals.messages += 1;
      bucket.totals.chars += feat.charCount;
      bucket.totals.images += feat.imageCount;
      bucket.totals.stickers += feat.stickerCount;
      bucket.totals.textEmojis += feat.textEmojis.length;
      bucket.totals.videos += feat.videoCount;
      bucket.totals.audios += feat.audioCount;
      bucket.totals.files += feat.fileCount;
      if (feat.shareKind) bucket.totals.shares += 1;

      userEntry.messages += 1;
      userEntry.chars += feat.charCount;
      userEntry.images += feat.imageCount;
      userEntry.stickers += feat.stickerCount;
      userEntry.textEmojis += feat.textEmojis.length;
      userEntry.videos += feat.videoCount;
      userEntry.audios += feat.audioCount;
      userEntry.files += feat.fileCount;
      if (feat.shareKind) userEntry.shares += 1;
      if (hour >= 0 && hour < 5) userEntry.nightOwlMessages += 1;

      if (!bucket.morningFirst && createdAt >= morningCutoff) {
        bucket.morningFirst = {
          userKey: uKey,
          name: userEntry.name,
          avatar: userEntry.avatar,
          createdAt,
        };
      }

      // Hourly slot
      const hSlot = bucket.hourly[hour];
      hSlot.messages += 1;
      hSlot.stickers += feat.stickerCount;
      hSlot.images += feat.imageCount;
      hSlot.users[uKey] = (hSlot.users[uKey] || 0) + 1;

      // Site distribution
      const sKey = userEntry.siteKey || 'local';
      if (!bucket.sites[sKey]) {
        bucket.sites[sKey] = {
          siteKey: sKey,
          siteName: userEntry.siteName || '本站',
          color: userEntry.siteColor || '',
          messages: 0,
        };
      }
      bucket.sites[sKey].messages += 1;
      if (!siteActiveSets.has(sKey)) siteActiveSets.set(sKey, new Set());
      siteActiveSets.get(sKey).add(uKey);

      // Stickers breakdown
      for (const st of feat.stickers) {
        if (!bucket.stickers[st.key]) {
          bucket.stickers[st.key] = {
            key: st.key,
            label: st.label,
            kind: st.kind,
            previewUrl: st.previewUrl || '',
            lottieKey: st.lottieKey || '',
            count: 0,
            userCounts: {},
          };
        } else if (!bucket.stickers[st.key].previewUrl && st.previewUrl) {
          bucket.stickers[st.key].previewUrl = st.previewUrl;
        }
        bucket.stickers[st.key].count += 1;
        bucket.stickers[st.key].userCounts[uKey] = (bucket.stickers[st.key].userCounts[uKey] || 0) + 1;
        hSlot.stickersMap[st.key] = (hSlot.stickersMap[st.key] || 0) + 1;
      }

      // Text Unicode emojis
      for (const em of feat.textEmojis) {
        if (!bucket.textEmojis[em]) {
          bucket.textEmojis[em] = { key: em, count: 0, userCounts: {} };
        }
        bucket.textEmojis[em].count += 1;
        bucket.textEmojis[em].userCounts[uKey] = (bucket.textEmojis[em].userCounts[uKey] || 0) + 1;
      }

      // Replies
      if (row.reply_to_json && row.reply_to_json !== 'null') {
        try {
          const rep = JSON.parse(row.reply_to_json);
          if (rep && rep.userKey) {
            bucket.totals.replies += 1;
            userEntry.repliesSent += 1;
            const targetKey = this.normalizeUserKey(rep.userKey) || rep.userKey;
            if (targetKey && targetKey !== uKey && bucket.users[targetKey]) {
              bucket.users[targetKey].repliesReceived += 1;
            }
          }
        } catch {}
      }

      // Mentions
      if (row.mention_keys_json && row.mention_keys_json !== '[]') {
        try {
          const mKeys = JSON.parse(row.mention_keys_json);
          if (Array.isArray(mKeys) && mKeys.length > 0) {
            bucket.totals.mentions += mKeys.length;
            for (const mk of mKeys) {
              if (!mk || mk === 'room') continue;
              const targetKey = this.normalizeUserKey(mk) || mk;
              if (targetKey !== uKey && bucket.users[targetKey]) {
                bucket.users[targetKey].mentionsReceived += 1;
              }
            }
          }
        } catch {}
      }
    }

    for (const [sKey, set] of siteActiveSets.entries()) {
      if (bucket.sites[sKey]) {
        bucket.sites[sKey].userKeys = [...set];
      }
    }

    // Reactions within this day
    const reactionRows = this.db.prepare(`
      SELECT r.message_event_id, r.sender_key, r.sender_name, r.reaction_key, r.created_at,
             m.room_id AS msg_room_id, m.sender_key AS msg_sender_key
      FROM chat_reactions r
      LEFT JOIN chat_messages m ON (m.event_id = r.message_event_id OR m.msg_uid = r.message_event_id)
      WHERE r.created_at >= ? AND r.created_at < ?
    `).all(startMs, endMs);

    for (const rr of reactionRows) {
      if (roomId !== 'all' && rr.msg_room_id && rr.msg_room_id !== roomId) continue;
      const rKey = String(rr.reaction_key || '').trim();
      if (!rKey) continue;
      const rawSender = String(rr.sender_key || '').trim();
      const uKey = rawSender ? (this.normalizeUserKey(rawSender) || rawSender) : '';
      bucket.totals.reactions += 1;
      if (!bucket.reactions[rKey]) {
        bucket.reactions[rKey] = { key: rKey, count: 0, userCounts: {} };
      }
      bucket.reactions[rKey].count += 1;
      if (uKey) {
        bucket.reactions[rKey].userCounts[uKey] = (bucket.reactions[rKey].userCounts[uKey] || 0) + 1;
        if (bucket.users[uKey]) bucket.users[uKey].reactionsGiven += 1;
      }
      const targetSenderRaw = rr.msg_sender_key || msgSenderById.get(rr.message_event_id);
      if (targetSenderRaw) {
        const targetKey = this.normalizeUserKey(targetSenderRaw) || targetSenderRaw;
        if (targetKey !== uKey && bucket.users[targetKey]) {
          bucket.users[targetKey].reactionsReceived += 1;
        }
      }
    }

    // Music requests within this day
    const reqClause = roomId === 'all' ? '' : 'AND r.room_id = ?';
    const reqParams = roomId === 'all' ? [startMs, endMs] : [roomId, startMs, endMs];
    const reqRows = this.db.prepare(`
      SELECT r.track_id, r.requester_key, r.requester_name, r.requester_avatar, r.outcome, r.requested_at,
             t.title, t.artist, t.cover_url
      FROM music_request_logs r
      LEFT JOIN music_tracks t ON t.id = r.track_id
      WHERE COALESCE(r.outcome, 'played') != 'cancelled'
        ${reqClause}
        AND r.requested_at >= ? AND r.requested_at < ?
    `).all(...reqParams);

    for (const req of reqRows) {
      const rawKey = String(req.requester_key || '').trim();
      const uKey = rawKey ? (this.normalizeUserKey(rawKey) || rawKey) : '';
      const ts = Number(req.requested_at) || startMs;
      const hour = getHourOfDay(ts, tzOffsetMin);
      bucket.totals.musicRequests += 1;
      bucket.hourly[hour].musicRequests += 1;

      if (uKey) {
        activeUserSet.add(uKey);
        const userEntry = ensureBucketUser(bucket.users, uKey, () => {
          const meta = this.resolveUserMeta(uKey, {
            name: req.requester_name,
            avatar: req.requester_avatar,
          });
          const site = this.resolveSiteMeta(uKey, { roomId });
          return {
            userKey: uKey,
            name: meta.name || req.requester_name || uKey,
            avatar: meta.avatar || req.requester_avatar || '',
            badge: meta.badge || '',
            badgeType: meta.badgeType || 'tag',
            isAdmin: Boolean(meta.isAdmin),
            customBadges: Array.isArray(meta.customBadges) ? meta.customBadges : [],
            siteKey: site.siteKey,
            siteName: site.siteName,
            siteColor: site.color,
            messages: 0,
            chars: 0,
            images: 0,
            stickers: 0,
            reactionsGiven: 0,
            reactionsReceived: 0,
            textEmojis: 0,
            musicRequests: 0,
            repliesSent: 0,
            repliesReceived: 0,
            mentionsReceived: 0,
            shares: 0,
            videos: 0,
            audios: 0,
            files: 0,
            firstMsgAt: ts,
            lastMsgAt: ts,
            nightOwlMessages: 0,
          };
        });
        userEntry.musicRequests += 1;
      }

      const songKey = buildTrackGroupKey(req.title, req.artist, req.track_id);
      if (!bucket.tracks[songKey]) {
        bucket.tracks[songKey] = {
          id: req.track_id,
          title: req.title || '未知曲目',
          artist: req.artist || '未知歌手',
          cover: req.cover_url || '',
          requestCount: 0,
          rotationCount: 0,
          lastRequesterName: req.requester_name || '',
        };
      }
      bucket.tracks[songKey].requestCount += 1;
      if (req.requester_name) bucket.tracks[songKey].lastRequesterName = req.requester_name;
    }

    // Music rotations within this day
    const rotClause = roomId === 'all' ? '' : 'AND r.room_id = ?';
    const rotRows = this.db.prepare(`
      SELECT r.track_id, r.playlist_name, r.rotated_at, t.title, t.artist, t.cover_url
      FROM music_rotation_logs r
      LEFT JOIN music_tracks t ON t.id = r.track_id
      WHERE 1=1
        ${rotClause}
        AND r.rotated_at >= ? AND r.rotated_at < ?
    `).all(...reqParams);

    for (const rot of rotRows) {
      bucket.totals.musicRotations += 1;
      const songKey = buildTrackGroupKey(rot.title, rot.artist, rot.track_id);
      if (!bucket.tracks[songKey]) {
        bucket.tracks[songKey] = {
          id: rot.track_id,
          title: rot.title || '未知曲目',
          artist: rot.artist || '未知歌手',
          cover: rot.cover_url || '',
          requestCount: 0,
          rotationCount: 0,
          lastRequesterName: rot.playlist_name ? `${rot.playlist_name} (轮播)` : '歌单轮播',
        };
      }
      bucket.tracks[songKey].rotationCount += 1;
    }

    bucket.totals.activeUsers = activeUserSet.size;
    bucket.activeUserKeys = [...activeUserSet];

    // Slim hourly slots (keep top userKey + top stickerKey per hour to shrink JSON cache)
    for (const h of bucket.hourly) {
      const topUserPair = pickTopPair(h.users);
      const topStickerPair = pickTopPair(h.stickersMap);
      h.topUserKey = topUserPair ? topUserPair[0] : '';
      h.topUserCount = topUserPair ? topUserPair[1] : 0;
      h.topStickerKey = topStickerPair ? topStickerPair[0] : '';
      h.topStickerCount = topStickerPair ? topStickerPair[1] : 0;
      delete h.users;
      delete h.stickersMap;
    }

    return bucket;
  }

  getStats({ room = 'interconnect', range = 'week', date = '', tzOffset = DEFAULT_TZ_OFFSET_MIN, site = 'all' } = {}) {
    const validRoom = room === 'chat' || room === 'interconnect' || room === 'all' ? room : 'interconnect';
    const validRange = ['day', '3d', 'week', 'month', 'all'].includes(range) ? range : 'week';
    const siteFilter = typeof site === 'string' && site.trim() && site.trim() !== 'all' ? site.trim() : 'all';
    const tz = clampTzOffset(tzOffset);
    const availableRange = this.getAvailableRange(validRoom, tz);
    const todayKey = availableRange.todayKey;

    const anchorDay = isValidDayKey(date) ? date : todayKey;
    let startDay = anchorDay;
    let endDay = anchorDay;
    let prevStartDay = '';
    let prevEndDay = '';

    if (validRange === 'day') {
      startDay = anchorDay;
      endDay = anchorDay;
      prevStartDay = shiftDayKey(anchorDay, -1);
      prevEndDay = prevStartDay;
    } else if (validRange === '3d') {
      startDay = shiftDayKey(anchorDay, -2);
      endDay = anchorDay;
      prevStartDay = shiftDayKey(anchorDay, -5);
      prevEndDay = shiftDayKey(anchorDay, -3);
    } else if (validRange === 'week') {
      startDay = shiftDayKey(anchorDay, -6);
      endDay = anchorDay;
      prevStartDay = shiftDayKey(anchorDay, -13);
      prevEndDay = shiftDayKey(anchorDay, -7);
    } else if (validRange === 'month') {
      startDay = shiftDayKey(anchorDay, -29);
      endDay = anchorDay;
      prevStartDay = shiftDayKey(anchorDay, -59);
      prevEndDay = shiftDayKey(anchorDay, -30);
    } else {
      startDay = availableRange.minDay;
      endDay = todayKey;
    }

    const dayKeys = listDayKeysBetween(startDay, endDay, 400);
    const buckets = dayKeys.map((dk) => this.getOrComputeDayBucket(validRoom, dk, tz));

    const prevDayKeys = prevStartDay && prevEndDay ? listDayKeysBetween(prevStartDay, prevEndDay, 60) : [];
    const prevBuckets = prevDayKeys.map((dk) => this.getOrComputeDayBucket(validRoom, dk, tz));

    const aggregated = mergeDayBuckets(buckets, validRange, tz, siteFilter);
    const previousSummary = prevBuckets.length > 0 ? summarizeDayBuckets(prevBuckets, siteFilter) : null;

    // Heatmap: always provide up to 90 days ending at max(todayKey, endDay)
    const heatEnd = endDay > todayKey ? endDay : todayKey;
    const heatStartCandidate = shiftDayKey(heatEnd, -89);
    const heatStart = heatStartCandidate < availableRange.minDay ? availableRange.minDay : heatStartCandidate;
    const heatDays = listDayKeysBetween(heatStart, heatEnd, 92);
    const heatmap = heatDays.map((dk) => {
      const b = this.getOrComputeDayBucket(validRoom, dk, tz);
      const topU = pickTopUserFromBucket(b, siteFilter);
      const siteMessages = siteFilter === 'all' ? b.totals.messages : (b.sites?.[siteFilter]?.messages || 0);
      const siteActiveUsers = siteFilter === 'all' ? b.totals.activeUsers : (b.sites?.[siteFilter]?.userKeys?.length || 0);
      return {
        dayKey: dk,
        messages: siteMessages,
        stickers: b.totals.stickers,
        images: b.totals.images,
        activeUsers: siteActiveUsers,
        topUserName: topU?.name || '',
        topUserAvatar: topU?.avatar || '',
      };
    });

    return {
      ok: true,
      room: validRoom,
      site: siteFilter,
      range: validRange,
      dateRange: {
        startDay,
        endDay,
        daysCount: dayKeys.length,
        isLive: endDay >= todayKey,
      },
      availableRange,
      summary: aggregated.summary,
      previousSummary,
      timeline: aggregated.timeline,
      highlights: aggregated.highlights,
      leaderboards: aggregated.leaderboards,
      topStickers: aggregated.topStickers,
      topReactions: aggregated.topReactions,
      topTextEmojis: aggregated.topTextEmojis,
      siteDistribution: aggregated.siteDistribution,
      topTracks: aggregated.topTracks,
      hourlyProfile: aggregated.hourlyProfile,
      heatmap,
    };
  }
}

function createEmptyDayBucket(dayKey) {
  return {
    dayKey,
    totals: {
      messages: 0,
      chars: 0,
      activeUsers: 0,
      images: 0,
      stickers: 0,
      reactions: 0,
      textEmojis: 0,
      musicRequests: 0,
      musicRotations: 0,
      shares: 0,
      replies: 0,
      mentions: 0,
      videos: 0,
      audios: 0,
      files: 0,
    },
    activeUserKeys: [],
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      messages: 0,
      stickers: 0,
      images: 0,
      musicRequests: 0,
      users: {},
      stickersMap: {},
    })),
    users: {},
    stickers: {},
    reactions: {},
    textEmojis: {},
    tracks: {},
    sites: {},
    morningFirst: null,
  };
}

function ensureBucketUser(usersMap, userKey, factory) {
  if (!usersMap[userKey]) usersMap[userKey] = factory();
  return usersMap[userKey];
}

function buildTrackGroupKey(title, artist, fallbackId) {
  const t = String(title || '').trim().toLowerCase();
  const a = String(artist || '').trim().toLowerCase();
  if (t && a) return `${t}:::${a}`;
  return String(fallbackId || t || 'unknown');
}

function pickTopPair(obj) {
  if (!obj) return null;
  let bestKey = '';
  let bestVal = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (v > bestVal) {
      bestVal = v;
      bestKey = k;
    }
  }
  return bestVal > 0 ? [bestKey, bestVal] : null;
}

function pickTopUserFromBucket(bucket, siteFilter = 'all') {
  let best = null;
  for (const u of Object.values(bucket.users || {})) {
    if (siteFilter !== 'all' && u.siteKey !== siteFilter) continue;
    if (!best || u.messages > best.messages) best = u;
  }
  return best;
}

function summarizeDayBuckets(buckets, siteFilter = 'all') {
  const activeSet = new Set();
  const sum = {
    messages: 0,
    chars: 0,
    activeUsers: 0,
    images: 0,
    stickers: 0,
    reactions: 0,
    textEmojis: 0,
    musicRequests: 0,
    musicRotations: 0,
    shares: 0,
    replies: 0,
    mentions: 0,
    videos: 0,
    audios: 0,
    files: 0,
  };
  for (const b of buckets) {
    if (siteFilter === 'all') {
      for (const k of Object.keys(sum)) {
        if (k !== 'activeUsers') sum[k] += Number(b.totals?.[k]) || 0;
      }
      for (const uk of b.activeUserKeys || []) activeSet.add(uk);
    } else {
      for (const u of Object.values(b.users || {})) {
        if (u.siteKey !== siteFilter) continue;
        sum.messages += u.messages || 0;
        sum.chars += u.chars || 0;
        sum.images += u.images || 0;
        sum.stickers += u.stickers || 0;
        sum.reactions += u.reactionsGiven || 0;
        sum.textEmojis += u.textEmojis || 0;
        sum.musicRequests += u.musicRequests || 0;
        sum.shares += u.shares || 0;
        sum.replies += u.repliesSent || 0;
        sum.videos += u.videos || 0;
        sum.audios += u.audios || 0;
        sum.files += u.files || 0;
        activeSet.add(u.userKey);
      }
    }
  }
  sum.activeUsers = activeSet.size;
  return sum;
}

function mergeDayBuckets(buckets, range, tzOffsetMin, siteFilter = 'all') {
  const activeSet = new Set();
  const filteredUserKeys = new Set();
  const usersMap = new Map();
  const stickersMap = new Map();
  const reactionsMap = new Map();
  const textEmojisMap = new Map();
  const tracksMap = new Map();
  const sitesMap = new Map();
  const siteUsersMap = new Map();
  const hourlyProfile = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    messages: 0,
    stickers: 0,
    images: 0,
    musicRequests: 0,
  }));

  const summary = {
    messages: 0,
    chars: 0,
    activeUsers: 0,
    images: 0,
    stickers: 0,
    reactions: 0,
    textEmojis: 0,
    musicRequests: 0,
    musicRotations: 0,
    shares: 0,
    replies: 0,
    mentions: 0,
    videos: 0,
    audios: 0,
    files: 0,
  };

  let morningFirst = null;

  for (const b of buckets) {
    if (siteFilter === 'all') {
      for (const k of Object.keys(summary)) {
        if (k !== 'activeUsers') summary[k] += Number(b.totals?.[k]) || 0;
      }
      for (const uk of b.activeUserKeys || []) activeSet.add(uk);
    }

    if (b.morningFirst && (siteFilter === 'all' || b.users?.[b.morningFirst.userKey]?.siteKey === siteFilter)) {
      if (!morningFirst || b.morningFirst.createdAt > morningFirst.createdAt) {
        morningFirst = b.morningFirst;
      }
    }

    for (let h = 0; h < 24; h++) {
      const hs = b.hourly?.[h];
      if (!hs) continue;
      hourlyProfile[h].messages += hs.messages || 0;
      hourlyProfile[h].stickers += hs.stickers || 0;
      hourlyProfile[h].images += hs.images || 0;
      hourlyProfile[h].musicRequests += hs.musicRequests || 0;
    }

    // Always collect unfiltered site distribution so the site selector shows all available sites
    for (const site of Object.values(b.sites || {})) {
      const prev = sitesMap.get(site.siteKey);
      if (!prev) {
        sitesMap.set(site.siteKey, {
          siteKey: site.siteKey,
          siteName: site.siteName,
          color: site.color,
          messages: site.messages,
        });
      } else {
        prev.messages += site.messages;
      }
      if (!siteUsersMap.has(site.siteKey)) siteUsersMap.set(site.siteKey, new Set());
      const su = siteUsersMap.get(site.siteKey);
      for (const uk of site.userKeys || []) su.add(uk);
    }

    for (const u of Object.values(b.users || {})) {
      if (siteFilter !== 'all' && u.siteKey !== siteFilter) continue;
      filteredUserKeys.add(u.userKey);
      if (siteFilter !== 'all') {
        activeSet.add(u.userKey);
        summary.messages += u.messages || 0;
        summary.chars += u.chars || 0;
        summary.images += u.images || 0;
        summary.stickers += u.stickers || 0;
        summary.reactions += u.reactionsGiven || 0;
        summary.textEmojis += u.textEmojis || 0;
        summary.musicRequests += u.musicRequests || 0;
        summary.shares += u.shares || 0;
        summary.replies += u.repliesSent || 0;
        summary.videos += u.videos || 0;
        summary.audios += u.audios || 0;
        summary.files += u.files || 0;
      }
      const prev = usersMap.get(u.userKey);
      if (!prev) {
        usersMap.set(u.userKey, { ...u, activeDays: (u.messages > 0 || u.musicRequests > 0) ? 1 : 0 });
      } else {
        prev.messages += u.messages;
        prev.chars += u.chars;
        prev.images += u.images;
        prev.stickers += u.stickers;
        prev.reactionsGiven += u.reactionsGiven;
        prev.reactionsReceived += u.reactionsReceived;
        prev.textEmojis += u.textEmojis;
        prev.musicRequests += u.musicRequests;
        prev.repliesSent += u.repliesSent;
        prev.repliesReceived += u.repliesReceived;
        prev.mentionsReceived += u.mentionsReceived;
        prev.shares += u.shares;
        prev.videos += u.videos;
        prev.audios += u.audios;
        prev.files += u.files;
        prev.nightOwlMessages += u.nightOwlMessages;
        if (u.messages > 0 || u.musicRequests > 0) prev.activeDays += 1;
        if (u.lastMsgAt >= prev.lastMsgAt) {
          prev.lastMsgAt = u.lastMsgAt;
          if (u.name) prev.name = u.name;
          if (u.avatar) prev.avatar = u.avatar;
          if (Array.isArray(u.customBadges) && u.customBadges.length > 0) prev.customBadges = u.customBadges;
        }
        if (u.firstMsgAt < prev.firstMsgAt) prev.firstMsgAt = u.firstMsgAt;
      }
    }

    for (const st of Object.values(b.stickers || {})) {
      let addCount = st.count;
      const filteredCounts = {};
      if (siteFilter !== 'all') {
        addCount = 0;
        for (const [uk, cnt] of Object.entries(st.userCounts || {})) {
          if (b.users?.[uk]?.siteKey === siteFilter) {
            filteredCounts[uk] = cnt;
            addCount += cnt;
          }
        }
        if (addCount === 0) continue;
      }
      const prev = stickersMap.get(st.key);
      if (!prev) {
        stickersMap.set(st.key, {
          ...st,
          count: addCount,
          userCounts: siteFilter === 'all' ? { ...(st.userCounts || {}) } : filteredCounts,
        });
      } else {
        prev.count += addCount;
        if (!prev.previewUrl && st.previewUrl) prev.previewUrl = st.previewUrl;
        const srcCounts = siteFilter === 'all' ? (st.userCounts || {}) : filteredCounts;
        for (const [uk, cnt] of Object.entries(srcCounts)) {
          prev.userCounts[uk] = (prev.userCounts[uk] || 0) + cnt;
        }
      }
    }

    for (const rc of Object.values(b.reactions || {})) {
      let addCount = rc.count;
      const filteredCounts = {};
      if (siteFilter !== 'all') {
        addCount = 0;
        for (const [uk, cnt] of Object.entries(rc.userCounts || {})) {
          if (b.users?.[uk]?.siteKey === siteFilter) {
            filteredCounts[uk] = cnt;
            addCount += cnt;
          }
        }
        if (addCount === 0) continue;
      }
      const prev = reactionsMap.get(rc.key);
      if (!prev) {
        reactionsMap.set(rc.key, {
          ...rc,
          count: addCount,
          userCounts: siteFilter === 'all' ? { ...(rc.userCounts || {}) } : filteredCounts,
        });
      } else {
        prev.count += addCount;
        const srcCounts = siteFilter === 'all' ? (rc.userCounts || {}) : filteredCounts;
        for (const [uk, cnt] of Object.entries(srcCounts)) {
          prev.userCounts[uk] = (prev.userCounts[uk] || 0) + cnt;
        }
      }
    }

    for (const em of Object.values(b.textEmojis || {})) {
      let addCount = em.count;
      const filteredCounts = {};
      if (siteFilter !== 'all') {
        addCount = 0;
        for (const [uk, cnt] of Object.entries(em.userCounts || {})) {
          if (b.users?.[uk]?.siteKey === siteFilter) {
            filteredCounts[uk] = cnt;
            addCount += cnt;
          }
        }
        if (addCount === 0) continue;
      }
      const prev = textEmojisMap.get(em.key);
      if (!prev) {
        textEmojisMap.set(em.key, {
          ...em,
          count: addCount,
          userCounts: siteFilter === 'all' ? { ...(em.userCounts || {}) } : filteredCounts,
        });
      } else {
        prev.count += addCount;
        const srcCounts = siteFilter === 'all' ? (em.userCounts || {}) : filteredCounts;
        for (const [uk, cnt] of Object.entries(srcCounts)) {
          prev.userCounts[uk] = (prev.userCounts[uk] || 0) + cnt;
        }
      }
    }

    for (const [songKey, tr] of Object.entries(b.tracks || {})) {
      const prev = tracksMap.get(songKey);
      if (!prev) {
        tracksMap.set(songKey, { ...tr });
      } else {
        prev.requestCount += tr.requestCount;
        prev.rotationCount += tr.rotationCount;
        if (!prev.cover && tr.cover) prev.cover = tr.cover;
        if (tr.lastRequesterName && !tr.lastRequesterName.includes('(轮播)')) {
          prev.lastRequesterName = tr.lastRequesterName;
        }
      }
    }
  }

  const totalAllSitesMessages = [...sitesMap.values()].reduce((acc, s) => acc + s.messages, 0);
  summary.activeUsers = activeSet.size;

  const leaderboards = [...usersMap.values()]
    .map((u) => ({
      ...u,
      avgChars: u.messages > 0 ? Math.round(u.chars / u.messages) : 0,
      interactionScore: u.repliesReceived + u.reactionsReceived + u.mentionsReceived,
    }))
    .sort((a, b) => b.messages - a.messages || b.chars - a.chars);

  const pickTopUserRef = (userCounts) => {
    const topPair = pickTopPair(userCounts);
    if (!topPair) return null;
    const u = usersMap.get(topPair[0]);
    return u ? { userKey: u.userKey, name: u.name, avatar: u.avatar, count: topPair[1] } : null;
  };

  const topStickers = [...stickersMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 30)
    .map((st) => ({
      key: st.key,
      label: st.label,
      kind: st.kind,
      previewUrl: st.previewUrl,
      lottieKey: st.lottieKey,
      count: st.count,
      sharePct: summary.stickers > 0 ? Math.round((st.count / summary.stickers) * 1000) / 10 : 0,
      topUser: pickTopUserRef(st.userCounts),
    }));

  const topReactions = [...reactionsMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 30)
    .map((rc) => ({
      key: rc.key,
      count: rc.count,
      sharePct: summary.reactions > 0 ? Math.round((rc.count / summary.reactions) * 1000) / 10 : 0,
      topUser: pickTopUserRef(rc.userCounts),
    }));

  const topTextEmojis = [...textEmojisMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 30)
    .map((em) => ({
      key: em.key,
      count: em.count,
      sharePct: summary.textEmojis > 0 ? Math.round((em.count / summary.textEmojis) * 1000) / 10 : 0,
      topUser: pickTopUserRef(em.userCounts),
    }));

  const siteDistribution = [...sitesMap.values()]
    .map((s) => ({
      ...s,
      activeUsers: siteUsersMap.get(s.siteKey)?.size || 0,
      sharePct: totalAllSitesMessages > 0 ? Math.round((s.messages / totalAllSitesMessages) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.messages - a.messages);

  const topTracks = [...tracksMap.values()]
    .map((t) => ({ ...t, totalCount: t.requestCount + t.rotationCount }))
    .sort((a, b) => b.requestCount - a.requestCount || b.totalCount - a.totalCount)
    .slice(0, 10);

  // Timeline construction according to range
  let timeline = [];
  if (range === 'day' && buckets[0]) {
    const b = buckets[0];
    const dayRange = dayKeyToRangeMs(b.dayKey, tzOffsetMin);
    const dayStart = dayRange ? dayRange.startMs : 0;
    timeline = b.hourly.map((h) => {
      const topU = h.topUserKey ? usersMap.get(h.topUserKey) : null;
      const topSt = h.topStickerKey ? stickersMap.get(h.topStickerKey) : null;
      return {
        key: `${b.dayKey}T${String(h.hour).padStart(2, '0')}`,
        label: `${String(h.hour).padStart(2, '0')}:00`,
        dayKey: b.dayKey,
        ts: dayStart + h.hour * 3600_000,
        messages: h.messages,
        stickers: h.stickers,
        images: h.images,
        musicRequests: h.musicRequests,
        activeUsers: 0,
        topUser: topU ? { userKey: topU.userKey, name: topU.name, avatar: topU.avatar, count: h.topUserCount } : null,
        topSticker: topSt ? { key: topSt.key, label: topSt.label, previewUrl: topSt.previewUrl, lottieKey: topSt.lottieKey, count: h.topStickerCount } : null,
      };
    });
  } else if (range === '3d') {
    // 2-hour buckets across 3 days = 36 smooth tidal points
    for (const b of buckets) {
      const dayRange = dayKeyToRangeMs(b.dayKey, tzOffsetMin);
      const dayStart = dayRange ? dayRange.startMs : 0;
      const shortDate = b.dayKey.slice(5);
      for (let h = 0; h < 24; h += 2) {
        const h1 = b.hourly[h];
        const h2 = b.hourly[h + 1];
        const messages = (h1?.messages || 0) + (h2?.messages || 0);
        const stickers = (h1?.stickers || 0) + (h2?.stickers || 0);
        const images = (h1?.images || 0) + (h2?.images || 0);
        const musicRequests = (h1?.musicRequests || 0) + (h2?.musicRequests || 0);
        const topUKey = (h1?.topUserCount || 0) >= (h2?.topUserCount || 0) ? h1?.topUserKey : h2?.topUserKey;
        const topU = topUKey ? usersMap.get(topUKey) : null;
        const topSKey = (h1?.topStickerCount || 0) >= (h2?.topStickerCount || 0) ? h1?.topStickerKey : h2?.topStickerKey;
        const topSt = topSKey ? stickersMap.get(topSKey) : null;
        timeline.push({
          key: `${b.dayKey}T${String(h).padStart(2, '0')}`,
          label: `${shortDate} ${String(h).padStart(2, '0')}:00`,
          dayKey: b.dayKey,
          ts: dayStart + h * 3600_000,
          messages,
          stickers,
          images,
          musicRequests,
          activeUsers: b.totals.activeUsers,
          topUser: topU ? { userKey: topU.userKey, name: topU.name, avatar: topU.avatar, count: Math.max(h1?.topUserCount || 0, h2?.topUserCount || 0) } : null,
          topSticker: topSt ? { key: topSt.key, label: topSt.label, previewUrl: topSt.previewUrl, lottieKey: topSt.lottieKey, count: Math.max(h1?.topStickerCount || 0, h2?.topStickerCount || 0) } : null,
        });
      }
    }
  } else {
    // Daily points for week / month / all
    timeline = buckets.map((b) => {
      const dayRange = dayKeyToRangeMs(b.dayKey, tzOffsetMin);
      const topU = pickTopUserFromBucket(b);
      let topSt = null;
      for (const st of Object.values(b.stickers || {})) {
        if (!topSt || st.count > topSt.count) topSt = st;
      }
      return {
        key: b.dayKey,
        label: b.dayKey.slice(5),
        dayKey: b.dayKey,
        ts: dayRange ? dayRange.startMs : 0,
        messages: b.totals.messages,
        stickers: b.totals.stickers,
        images: b.totals.images,
        musicRequests: b.totals.musicRequests,
        activeUsers: b.totals.activeUsers,
        topUser: topU ? { userKey: topU.userKey, name: topU.name, avatar: topU.avatar, count: topU.messages } : null,
        topSticker: topSt ? { key: topSt.key, label: topSt.label, previewUrl: topSt.previewUrl, lottieKey: topSt.lottieKey, count: topSt.count } : null,
      };
    });
  }

  // Highlights / MVPs
  const byMessages = [...leaderboards].filter((u) => u.messages > 0).sort((a, b) => b.messages - a.messages || b.chars - a.chars)[0] || null;
  const byImages = [...leaderboards].filter((u) => u.images > 0).sort((a, b) => b.images - a.images || b.messages - a.messages)[0] || null;
  const byStickers = [...leaderboards].filter((u) => u.stickers > 0).sort((a, b) => b.stickers - a.stickers || b.messages - a.messages)[0] || null;
  const byMusic = [...leaderboards].filter((u) => u.musicRequests > 0).sort((a, b) => b.musicRequests - a.musicRequests || b.messages - a.messages)[0] || null;
  const byNightOwl = [...leaderboards].filter((u) => u.nightOwlMessages > 0).sort((a, b) => b.nightOwlMessages - a.nightOwlMessages)[0] || null;

  let peakBucket = null;
  for (const pt of timeline) {
    if (pt.messages > 0 && (!peakBucket || pt.messages > peakBucket.messages)) {
      peakBucket = { label: pt.label, dayKey: pt.dayKey, messages: pt.messages };
    }
  }

  return {
    summary,
    timeline,
    highlights: {
      talkKing: byMessages ? toMvpSummary(byMessages, 'messages') : null,
      imageKing: byImages ? toMvpSummary(byImages, 'images') : null,
      stickerKing: byStickers ? toMvpSummary(byStickers, 'stickers') : null,
      musicKing: byMusic ? toMvpSummary(byMusic, 'musicRequests') : null,
      nightOwl: byNightOwl ? { userKey: byNightOwl.userKey, name: byNightOwl.name, avatar: byNightOwl.avatar, count: byNightOwl.nightOwlMessages } : null,
      morningFirst,
      peakBucket,
    },
    leaderboards: leaderboards.slice(0, 30),
    topStickers,
    topReactions,
    topTextEmojis,
    siteDistribution,
    topTracks,
    hourlyProfile,
  };
}

function toMvpSummary(u, metric) {
  return {
    userKey: u.userKey,
    name: u.name,
    avatar: u.avatar,
    badge: u.badge,
    badgeType: u.badgeType,
    isAdmin: Boolean(u.isAdmin),
    customBadges: Array.isArray(u.customBadges) ? u.customBadges : [],
    siteName: u.siteName,
    siteColor: u.siteColor,
    value: u[metric] || 0,
    messages: u.messages,
    chars: u.chars,
    images: u.images,
    stickers: u.stickers,
    musicRequests: u.musicRequests,
  };
}

function defaultResolveUserMeta(userKey, fallback = {}) {
  return {
    name: fallback.name || userKey,
    avatar: fallback.avatar || '',
    badge: fallback.badge || '',
    badgeType: fallback.badgeType || 'tag',
    isAdmin: Boolean(fallback.isAdmin),
  };
}

function defaultResolveSiteMeta(userKey) {
  if (userKey.startsWith('waline:') || userKey.startsWith('guest:') || userKey.includes('matrix.lengxiqwq.com')) {
    return { siteKey: 'local', siteName: '本站', color: '' };
  }
  const m = userKey.match(/@[^:]+:([^#]+)/);
  const host = m ? m[1] : 'external';
  return { siteKey: host, siteName: host, color: '' };
}
