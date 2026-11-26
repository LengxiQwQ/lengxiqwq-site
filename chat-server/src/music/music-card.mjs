import { normalizeIsrc, normalizeMusicTrack } from './music-input.mjs';
import { cacheSharedAudio } from './shared-audio.mjs';
import { verifyStreamProxyToken } from './stream-signer.mjs';

function cardError(code, status, message) {
  return Object.assign(new Error(message), { code, status });
}

// Some old rotation cards put an Apple catalog ID in the QQ provider field.
// Use the catalog prefix when present, and never accept a client-supplied media URL.
function cardTrack(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = (value, max = 240) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const title = text(raw.title);
  if (!title) return null;
  const id = text(raw.id).match(/^([a-z_]+):([^:]+)$/i);
  const catalog = raw.sourceTrackId && raw.sourcePlatform;
  const platform = text(catalog || (id && id[1] !== 'ext' ? id[1] : raw.sourcePlatform || raw.provider), 32);
  const sourceId = text(catalog ? raw.sourceTrackId : id && id[1] !== 'ext' ? id[2] : raw.sourceId, 80);
  return { title, artist: text(raw.artist), album: text(raw.album), sourcePlatform: platform,
    sourceTrackId: sourceId, durationSec: Math.max(0, Number(raw.durationSec) || 0), isrc: normalizeIsrc(raw.isrc),
    cover: text(raw.cover, 1024) };
}

export function createMusicCardResolver(registry, origin, secret) {
  const pending = new Map();

  async function prepare(original, share) {
    const signal = AbortSignal.timeout(share ? 42_000 : 38_000);
    const deadline = Date.now() + (share ? 42_000 : 38_000);
    const tried = new Set();
    let cacheFailed = false;
    const cache = (track, options) => cacheSharedAudio({ origin, trackKey: track.id,
      artist: track.artist, title: track.title, signal, ...options });

    if (share) {
      const known = [normalizeMusicTrack(original)];
      for (const provider of registry.providerOrder(original)) {
        const match = registry.readMatch(registry.matchStorageKey(original, provider));
        if (match?.track && match.expiresAt > Date.now()) known.push(match.track);
      }
      for (const track of new Map(known.filter(Boolean).map(item => [item.id, item])).values()) {
        try {
          const shared = await cache(track, { cacheOnly: true });
          if (shared) return { ...shared, track };
        } catch {
          cacheFailed = true;
        }
      }
    }

    while (!signal.aborted && Date.now() < deadline) {
      const result = await registry.resolveRotationTrack(original, track => registry.resolvePlayable(track, origin, secret),
        { exactOnly: true, alternatives: true, exclude: track => tried.has(track.id),
          budgetMs: Math.min(38_000, deadline - Date.now()) });
      const track = result.playable;
      if (!track) {
        if (result.limited) throw cardError('SOURCE_LIMITED', 503, '音源服务暂时受限，请稍后重试');
        if (cacheFailed || result.temporaryFailure) break;
        throw cardError('NO_SOURCE', 404, '各平台都没找到这版歌曲的可播音源');
      }
      if (!share) return { streamUrl: track.streamUrl, proxyUrl: track.proxyUrl,
        directUrl: track.directUrl, durationSec: track.durationSec };
      tried.add(track.id);
      try {
        const token = new URL(track.proxyUrl).searchParams.get('token');
        const verified = verifyStreamProxyToken(token, secret);
        if (!verified || verified.trackKey !== track.id + ':128') throw new Error('音频身份已变化');
        const shared = await cache(track, { sourceUrl: verified.url });
        return { ...shared, track: normalizeMusicTrack(track) };
      } catch {
        cacheFailed = true;
      }
    }
    throw cardError('SOURCE_TEMPORARY', 503, '暂时没能准备好音频，请稍后重试');
  }

  return (raw, share) => {
    const track = cardTrack(raw);
    if (!track) throw cardError('INVALID_TRACK', 400, '缺少歌曲信息');
    const key = JSON.stringify([share, track]);
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 20) throw cardError('SOURCE_TEMPORARY', 503, '音源服务繁忙，请稍后重试');
    const task = prepare(track, share).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
}
