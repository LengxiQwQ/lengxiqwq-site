import { signStreamProxyUrl, verifyStreamProxyToken } from './stream-signer.mjs';
import { probeAudio } from './audio-source.mjs';
import { hasCachedAudio } from './stream-cache.mjs';
import { normalizeMusicTrack } from './music-input.mjs';

const RESOLVED_CACHE_TTL_MS = 30 * 60_000; // 30 minutes (QQ Music vkey TTL is 2+ hours)
const FAILED_CACHE_TTL_MS = 15 * 60_000; // 15 minutes negative cache for unplayable tracks
const UNMATCHED_PLAYLIST_TTL_MS = 30 * 60_000;

export class MusicRegistry {
  constructor(providers = []) {
    this.providers = new Map();
    this.defaultOrder = [];
    this.resolved = new Map();
    this.resolving = new Map();
    for (const p of providers) {
      this.providers.set(p.id, p);
      this.defaultOrder.push(p.id);
    }
  }

  isKnownUnplayable(trackKey) {
    if (!trackKey) return false;
    const key = trackKey.includes(':') ? trackKey : 'qq:' + trackKey;
    const entry = this.resolved.get(key);
    return Boolean(entry && !entry.source && entry.expiresAt > Date.now());
  }

  listProviders() {
    return this.defaultOrder
      .map((id) => this.providers.get(id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, name: p.name }));
  }

  async search(keyword, limit = 30, providerId, page = 1) {
    const provider = this.providers.get(providerId || this.defaultOrder[0]);
    return provider ? provider.search(keyword, limit, page) : { tracks: [], hasMore: false };
  }

  async resolvePlaylistTrack(item) {
    if (!item || typeof item !== 'object') return null;
    const existing = normalizeMusicTrack(item.matchedTrack);
    if (existing) return existing;
    if (item._unmatchedAt && Date.now() - item._unmatchedAt < UNMATCHED_PLAYLIST_TTL_MS) {
      return null;
    }
    if (item.sourcePlatform === 'qqmusic' && item.sourceTrackId) {
      const direct = {
        id: 'qq:' + item.sourceTrackId,
        provider: 'qq',
        sourceId: item.sourceTrackId,
        title: item.title,
        artist: item.artist,
        album: item.album || item.albumName || undefined,
        cover: item.cover,
        durationSec: item.durationSec
      };
      item.matchedTrack = direct;
      return direct;
    }
    const cleanStr = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\-_·.,'"!?！？，。、()（）/&]+/g, '');
    const cleanTitle = cleanStr(item.title);
    const primaryArtist = cleanStr((item.artist || '').split(/[/,&、;；]+/)[0]);
    const { tracks: matches } = await this.search(item.title + ' ' + (item.artist || ''), 10, 'qq');
    if (!matches || matches.length === 0) {
      item._unmatchedAt = Date.now();
      return null;
    }

    const match = matches.find((candidate) => {
      const cTitle = cleanStr(candidate.title);
      const cArtist = cleanStr(candidate.artist);
      const titleMatch = Boolean(cleanTitle && cTitle === cleanTitle);
      const artistMatch = Boolean(primaryArtist && cArtist && (cArtist.includes(primaryArtist) || primaryArtist.includes(cArtist)));
      const durMatch = !(candidate.durationSec > 0 && item.durationSec > 0) || Math.abs(candidate.durationSec - item.durationSec) <= 10;
      return titleMatch && artistMatch && durMatch;
    });

    if (match) {
      item.matchedTrack = match;
      return match;
    }
    item._unmatchedAt = Date.now();
    return null;
  }

  async resolvePlayable(track, origin, signSecret, { fresh = false } = {}) {
    const provider = this.providers.get(track.provider);
    const id = track.sourceId;
    if (!provider || typeof id !== 'string' || !/^[a-zA-Z0-9]{1,32}$/.test(id)) return null;
    const key = provider.id + ':' + id;
    let resolved = fresh ? null : this.resolved.get(key);
    if (!resolved || resolved.expiresAt <= Date.now()) {
      let pending = this.resolving.get(key);
      if (!pending) {
        if (this.resolving.size >= 16) return null;
        pending = provider.resolveStream(id).then(source => {
          if (this.resolved.size >= 256) this.resolved.delete(this.resolved.keys().next().value);
          const result = {
            source,
            expiresAt: Date.now() + (source ? RESOLVED_CACHE_TTL_MS : FAILED_CACHE_TTL_MS)
          };
          this.resolved.set(key, result);
          return result;
        }).finally(() => this.resolving.delete(key));
        this.resolving.set(key, pending);
      }
      resolved = await pending;
    }
    const source = resolved.source;
    if (!source) return null;
    const base = origin.replace(/\/+$/, '');
    const proxyUrl = signStreamProxyUrl(base, source.url, signSecret, 'https://y.qq.com/', source.mimeType, key + ':128');
    const directUrl = typeof source.url === 'string' && source.url.startsWith('http')
      ? source.url.replace(/^http:\/\//i, 'https://')
      : '';
    const primaryStreamUrl = directUrl || proxyUrl;

    if (!resolved.streamUrl || resolved.streamOrigin !== base) {
      resolved.streamOrigin = base;
      resolved.streamUrl = primaryStreamUrl;
      resolved.proxyUrl = proxyUrl;
      resolved.directUrl = directUrl;
    }
    return {
      ...track,
      id: key,
      cover: track.cover || normalizeMusicTrack({ ...track, cover: source.cover })?.cover || '',
      durationSec: source.durationSec || track.durationSec || 0,
      streamUrl: primaryStreamUrl,
      proxyUrl,
      directUrl,
      lrcUrl: base + '/api/music/lyric?provider=' + provider.id + '&id=' + encodeURIComponent(id)
    };
  }

  async isCached(track, secret) {
    if (track.streamUrl && !track.streamUrl.includes('/api/music/stream')) return true;
    try {
      const urlToVerify = track.proxyUrl || track.streamUrl;
      const token = new URL(urlToVerify).searchParams.get('token');
      const verified = verifyStreamProxyToken(token, secret);
      return Boolean(verified && await hasCachedAudio(verified.url, verified.trackKey));
    } catch {
      return false;
    }
  }

  async isHealthy(track, secret) {
    if (track.streamUrl && !track.streamUrl.includes('/api/music/stream')) return true;
    try {
      const urlToVerify = track.proxyUrl || track.streamUrl;
      const token = new URL(urlToVerify).searchParams.get('token');
      const verified = verifyStreamProxyToken(token, secret);
      if (!verified) return false;
      if (await hasCachedAudio(verified.url, verified.trackKey)) return true;
      await probeAudio(verified.url);
      return true;
    } catch {
      return false;
    }
  }

  async getLyric(providerId, sourceId) {
    const provider = this.providers.get(providerId || 'qq');
    if (!provider) return null;
    return provider.getLyric(sourceId);
  }
}
