import { probeAudio } from './audio-source.mjs';

const QQ_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Referer: 'https://y.qq.com/'
};

function buildAlbumCoverUrl(albumMid) {
  if (!albumMid) return '';
  return `https://y.gtimg.cn/music/photo_new/T002R300x300M000${encodeURIComponent(albumMid)}.jpg`;
}

function decodeBase64Utf8(b64) {
  const clean = b64.replace(/\s+/g, '');
  return Buffer.from(clean, 'base64').toString('utf8');
}

function decodeHtmlEntities(input) {
  return input
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const SEARCH_CACHE_TTL_MS = 60_000;
const SEARCH_CACHE_MAX_SIZE = 200;

export class QQMusicProvider {
  constructor(cyapiKey) {
    this.id = 'qq';
    this.name = '在线曲库';
    this.cyapiKey = cyapiKey;
    this.searchCache = new Map();
    this.inFlightSearches = new Map();
  }

  async search(keyword, limit = 30, page = 1) {
    const trimmed = (keyword || '').trim();
    if (!trimmed) return { tracks: [], hasMore: false };
    const safeLimit = Math.min(30, Math.max(1, limit));
    const safePage = Math.max(1, Number.parseInt(String(page || 1), 10) || 1);
    const cacheKey = `${trimmed.toLowerCase()}:${safeLimit}:${safePage}`;

    const cached = this.searchCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < SEARCH_CACHE_TTL_MS) {
      return cached.result;
    }

    const existing = this.inFlightSearches.get(cacheKey);
    if (existing) {
      return existing;
    }

    if (this.inFlightSearches.size >= 24) throw new Error('在线曲库繁忙，请稍后重试');

    const promise = (async () => {
      const primary = await this.searchViaClientSearch(trimmed, safeLimit, safePage);
      if (primary.ok) {
        this.setSearchCache(cacheKey, primary);
        return primary;
      }

      if (safePage === 1) {
        const fallback = await this.searchViaSmartbox(trimmed, safeLimit);
        if (fallback.ok) {
          this.setSearchCache(cacheKey, fallback);
          return fallback;
        }
      }

      throw new Error('在线曲库搜索暂时不可用，请稍后重试');
    })();

    this.inFlightSearches.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      this.inFlightSearches.delete(cacheKey);
    }
  }

  setSearchCache(cacheKey, result) {
    if (this.searchCache.size >= SEARCH_CACHE_MAX_SIZE) {
      const oldestKey = this.searchCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.searchCache.delete(oldestKey);
      }
    }
    this.searchCache.set(cacheKey, { result, fetchedAt: Date.now() });
  }

  async searchViaClientSearch(keyword, limit, page = 1) {
    try {
      const url = `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?p=${page}&n=${limit}&w=${encodeURIComponent(keyword)}&format=json`;
      const resp = await fetch(url, {
        headers: QQ_HEADERS,
        signal: AbortSignal.timeout(3500)
      });
      if (!resp.ok) return { ok: false, tracks: [] };
      const data = await resp.json();
      if (typeof data?.code === 'number' && data.code !== 0) {
        return { ok: false, tracks: [] };
      }
      const song = data.data?.song;
      if (!Array.isArray(song?.list)) return { ok: false, tracks: [] };
      const list = song.list;
      const tracks = [];
      const seenIds = new Set();
      for (const item of list) {
        const mid = (item.songmid || '').trim();
        const title = (item.songname || '').trim();
        const trackId = `qq:${mid}`;
        if (!mid || !title || seenIds.has(trackId)) continue;
        seenIds.add(trackId);
        const singers = Array.isArray(item.singer)
          ? item.singer
              .map((s) => s.name?.trim())
              .filter(Boolean)
              .join(' / ')
          : '';
        const albumMid = (item.albummid || '').trim();
        const albumName = (item.albumname || '').trim();
        const durationSec =
          typeof item.interval === 'number' && Number.isFinite(item.interval) && item.interval > 0
            ? Math.round(item.interval)
            : 0;

        tracks.push({
          id: `qq:${mid}`,
          provider: this.id,
          sourceId: mid,
          title,
          artist: singers || '未知歌手',
          album: albumName || undefined,
          cover: buildAlbumCoverUrl(albumMid),
          durationSec
        });
      }
      const total = Number(song.totalnum);
      const hasMore = total > 0 ? page * limit < total : list.length >= limit;
      return { ok: true, tracks: tracks.slice(0, limit), hasMore };
    } catch {
      return { ok: false, tracks: [] };
    }
  }

  async searchViaSmartbox(keyword, limit) {
    try {
      const url = `https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=${encodeURIComponent(keyword)}&format=json&inCharset=utf8&outCharset=utf-8`;
      const resp = await fetch(url, {
        headers: QQ_HEADERS,
        signal: AbortSignal.timeout(3500)
      });
      if (!resp.ok) return { ok: false, tracks: [] };
      const data = await resp.json();
      if (typeof data?.code === 'number' && data.code !== 0) {
        return { ok: false, tracks: [] };
      }
      const items = data.data?.song?.itemlist;
      if (!data.data || (items != null && !Array.isArray(items))) return { ok: false, tracks: [] };
      const tracks = [];
      const seenIds = new Set();
      for (const item of (items || []).slice(0, limit)) {
        const mid = (item.mid || '').trim();
        const title = (item.name || '').trim();
        const trackId = `qq:${mid}`;
        if (!mid || !title || seenIds.has(trackId)) continue;
        seenIds.add(trackId);
        tracks.push({
          id: `qq:${mid}`,
          provider: this.id,
          sourceId: mid,
          title,
          artist: (item.singer || '').trim() || '未知歌手',
          cover: '',
          durationSec: 0
        });
      }
      return { ok: true, tracks, hasMore: false };
    } catch {
      return { ok: false, tracks: [] };
    }
  }

  async resolveStream(mid) {
    const id = encodeURIComponent(mid);
    const sources = [
      ...(this.cyapiKey ? [{
        name: 'cyapi',
        endpoint: 'https://cyapi.top/API/qq_music.php?type=json&quality=128&mid=' + id +
          '&apikey=' + encodeURIComponent(this.cyapiKey),
        read: data => data
      }] : []),
      {
        name: 'vkeys',
        endpoint: 'https://api.vkeys.cn/music/tencent/song/link?quality=1&mid=' + id,
        read: data => data.data
      }
    ];

    for (const source of sources) {
      try {
        const response = await fetch(source.endpoint, {
          headers: QQ_HEADERS,
          signal: AbortSignal.timeout(4500)
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('resolver HTTP ' + response.status);
        }
        const data = source.read(await response.json());
        if (typeof data?.url !== 'string') throw new Error('no audio URL');
        const mimeType = await probeAudio(data.url);
        return {
          url: data.url,
          mimeType,
          cover: data.cover || data.pic,
          durationSec: Number(data.interval) || undefined,
          providerChannel: source.name
        };
      } catch (error) {
        console.warn('[MusicSource]', source.name, mid, error.message);
      }
    }
    return null;
  }

  async getLyric(mid) {
    const cleanMid = (mid || '').trim();
    if (!cleanMid) return null;

    try {
      const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(cleanMid)}&format=json&nobase64=1`;
      const resp = await fetch(url, {
        headers: QQ_HEADERS,
        signal: AbortSignal.timeout(6000)
      });
      if (!resp.ok) return null;

      const rawText = await resp.text();
      const jsonText = rawText
        .trim()
        .replace(/^MusicJsonCallback\(/, '')
        .replace(/\);?$/, '');
      const data = JSON.parse(jsonText);
      if (typeof data.lyric !== 'string' || !data.lyric.trim()) {
        return null;
      }

      let lyricText = data.lyric.trim();
      if (!lyricText.includes('[') && /^[A-Za-z0-9+/=\r\n]+$/.test(lyricText)) {
        try {
          lyricText = decodeBase64Utf8(lyricText);
        } catch {}
      }

      return decodeHtmlEntities(lyricText);
    } catch {
      return null;
    }
  }
}
