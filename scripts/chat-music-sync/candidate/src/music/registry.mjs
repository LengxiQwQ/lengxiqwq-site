import { signStreamProxyUrl, verifyStreamProxyToken } from './stream-signer.mjs';
import { probeAudio } from './audio-source.mjs';
import { hasCachedAudio } from './stream-cache.mjs';
import { normalizeMusicTrack } from './music-input.mjs';

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
    const existing = normalizeMusicTrack(item.matchedTrack);
    if (existing) return existing;
    if (item.sourcePlatform === 'qqmusic' && item.sourceTrackId) {
      return {
        id: 'qq:' + item.sourceTrackId,
        provider: 'qq',
        sourceId: item.sourceTrackId,
        title: item.title,
        artist: item.artist,
        album: item.album || item.albumName || undefined,
        cover: item.cover,
        durationSec: item.durationSec
      };
    }
    const cleanStr = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\-_·.,'"!?！？，。、()（）/&]+/g, '');
    const cleanTitle = cleanStr(item.title);
    const primaryArtist = cleanStr((item.artist || '').split(/[/,&、;；]+/)[0]);
    const { tracks: matches } = await this.search(item.title + ' ' + (item.artist || ''), 10, 'qq');
    if (!matches || matches.length === 0) return null;

    const match = matches.find((candidate) => {
      const cTitle = cleanStr(candidate.title);
      const cArtist = cleanStr(candidate.artist);
      const titleMatch = Boolean(cleanTitle && cTitle === cleanTitle);
      const artistMatch = Boolean(primaryArtist && cArtist && (cArtist.includes(primaryArtist) || primaryArtist.includes(cArtist)));
      const durMatch = !(candidate.durationSec > 0 && item.durationSec > 0) || Math.abs(candidate.durationSec - item.durationSec) <= 10;
      return titleMatch && artistMatch && durMatch;
    });

    return match ?? null;
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
        if (this.resolving.size >= 12) return null;
        pending = provider.resolveStream(id).then(source => {
          if (this.resolved.size >= 128) this.resolved.delete(this.resolved.keys().next().value);
          const result = { source, expiresAt: Date.now() + (source ? 60_000 : 10_000) };
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
    return {
      ...track,
      id: key,
      cover: track.cover || normalizeMusicTrack({ ...track, cover: source.cover })?.cover || '',
      durationSec: source.durationSec || track.durationSec || 0,
      streamUrl: signStreamProxyUrl(base, source.url, signSecret, 'https://y.qq.com/', source.mimeType),
      lrcUrl: base + '/api/music/lyric?provider=' + provider.id + '&id=' + encodeURIComponent(id)
    };
  }

  async isCached(track, secret) {
    const token = new URL(track.streamUrl).searchParams.get('token');
    const verified = verifyStreamProxyToken(token, secret);
    return Boolean(verified && await hasCachedAudio(verified.url));
  }

  async isHealthy(track, secret) {
    const token = new URL(track.streamUrl).searchParams.get('token');
    const verified = verifyStreamProxyToken(token, secret);
    if (!verified) return false;
    if (await hasCachedAudio(verified.url)) return true;
    await probeAudio(verified.url);
    return true;
  }

  async getLyric(providerId, sourceId) {
    const provider = this.providers.get(providerId || 'qq');
    if (!provider) return null;
    return provider.getLyric(sourceId);
  }
}
