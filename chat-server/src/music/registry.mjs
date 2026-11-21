import { createHash } from 'node:crypto';
import { signStreamProxyUrl, verifyStreamProxyToken } from './stream-signer.mjs';
import { probeAudio } from './audio-source.mjs';
import { hasCachedAudio } from './stream-cache.mjs';
import { isMusicSourceId, normalizeIsrc, normalizeMusicTrack } from './music-input.mjs';
import { lookupPreferredProviders } from './provider-routing.mjs';

const RESOLVED_CACHE_TTL_MS = 30 * 60_000; // 30 minutes (QQ Music vkey TTL is 2+ hours)
const PARTNER_STREAM_TTL_MS = 10 * 60_000;
const FAILED_CACHE_TTL_MS = 15 * 60_000; // 15 minutes negative cache for unplayable tracks
const UNMATCHED_PLAYLIST_TTL_MS = 30 * 60_000;

const ROTATION_RELATIONS = ['same_artist_version', 'same_title', 'same_artist_other'];
const RECORDING_DURATION_TOLERANCE_SEC = 5;
const MAX_SOURCE_CHECKS = 6;
const TRACK_MATCH_TTL_MS = 24 * 60 * 60_000;
const TRACK_MATCH_LIMIT = 512;
const STORED_MATCH_TTL_MS = 30 * 24 * 60 * 60_000;
const PREMATCH_RETRY_MS = 3 * 24 * 60 * 60_000;
const LIVE_ALBUM = /(?:\blive\s+(?:at|in|from|on|version|recording)\b|\(live\)|现场实录|現場實錄|演唱会|演唱會|ライブ音源)/iu;
const TRAILING_NOTE = /\s*(?:\(([^()]*)\)|\[([^\[\]]*)\]|【([^【】]*)】|\s+[-‐‑‒–—]\s+((?:(?!\s+[-‐‑‒–—]\s).)+))$/u;
const VERSION_LABEL = /^(?:(?:19|20)\d{2}\s+)?(?:live\b|acoustic\b|cover\b|instrumental\b|karaoke\b|demo\b|rerecord(?:ed)?\b|re-record(?:ed)?\b|radio edit\b|studio\b|remix\b|alternate lyrics\b|alternative lyrics\b|all lyrics\b|original(?: version| lyrics)?$|ライブ|现场|現場|演唱会|演唱會|伴奏|翻唱|重录|重錄|录音室|錄音室|不插电|不插電|不同歌词|不同歌詞)/iu;
const MASTERING_LABEL = /^(?:(?:19|20)\d{2}\s*)?(?:remaster(?:ed)?(?:\s+(?:(?:19|20)\d{2}|edition|version))?|重[制製](?:版)?|リマスター(?:版)?)(?:\s+(?:19|20)\d{2})?$/iu;
const FEATURE_CREDIT = /\s*[(\[【]\s*(?:feat(?:uring)?|ft)(?:\.\s*|\s+)([^)\]】]+)[)\]】]|\s+(?:feat(?:uring)?|ft)(?:\.\s*|\s+)(.+)$/giu;
const ARTIST_SEPARATOR = /\s*[,、;/&]\s*/u;

function musicText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, '');
}

function splitArtists(value) {
  return String(value ?? '').normalize('NFKC').split(ARTIST_SEPARATOR).map(name => name.trim()).filter(Boolean);
}

function recordingMetadata(track) {
  let title = String(track.title ?? '').normalize('NFKC').trim();
  const versions = [];
  let mastering = '';
  const collectVersions = () => {
    let note;
    while ((note = title.match(TRAILING_NOTE))) {
      const label = (note[1] ?? note[2] ?? note[3] ?? note[4]).trim();
      const annotations = label.split(/\s*[|/]\s*/u);
      if (!annotations.every(part => VERSION_LABEL.test(part) || MASTERING_LABEL.test(part))) break;
      for (const part of annotations) {
        if (MASTERING_LABEL.test(part)) mastering ||= musicText(part);
        else versions.push(musicText(part.replace(/(?:\s+version|版)$/iu, '')));
      }
      title = title.slice(0, note.index).trimEnd();
    }
  };
  collectVersions();
  const artists = Array.isArray(track.artistNames) && track.artistNames.length
    ? [...track.artistNames]
    : splitArtists(track.artist);
  title = title.replace(FEATURE_CREDIT, (_match, bracketed, trailing) => {
    artists.push(...splitArtists(bracketed ?? trailing));
    return '';
  }).trim();
  collectVersions();
  const artistNames = [...new Set(artists.map(musicText).filter(Boolean))].sort();
  return {
    title,
    titleKey: musicText(title),
    artistNames: artistNames.includes('未知歌手') ? [] : artistNames,
    artistCredits: track.provider === 'qq' && Array.isArray(track.artistCredits) ? track.artistCredits : [],
    artists,
    versionKey: [...new Set([...versions,
      ...(LIVE_ALBUM.test(String(track.album || track.albumName || '').normalize('NFKC')) &&
        !versions.some(version => version.startsWith('live')) ? ['live'] : [])
    ])].sort().join('/'),
    mastering,
    albumKey: musicText(String(track.album || track.albumName || '').normalize('NFKC')
      .replace(/\s*(?:\(|\[)(?:deluxe(?: edition)?|expanded(?: edition)?|explicit|clean|(?:\d{4}\s+)?remaster(?:ed)?)(?:\)|\])/giu, '')),
    durationSec: Number(track.durationSec) || 0,
    isrc: normalizeIsrc(track.isrc)
  };
}

// Use only search-provider credits. A name shared by multiple artist IDs is ambiguous.
function indexArtistNames(tracks) {
  const idsByName = new Map();
  for (const track of tracks) {
    if (track.provider !== 'qq' || !Array.isArray(track.artistCredits)) continue;
    for (const { id, name, alias } of track.artistCredits) {
      if (!id) continue;
      for (const label of [name, alias]) {
        const key = musicText(label);
        if (!key) continue;
        if (!idsByName.has(key)) idsByName.set(key, id);
        else if (idsByName.get(key) !== id) idsByName.set(key, null);
      }
    }
  }
  return idsByName;
}

function sameArtistRoster(original, candidate, artistIds) {
  if (!original.artistNames.length || original.artistNames.length !== candidate.artistNames.length) return false;
  if (original.artistNames.every((name, index) => name === candidate.artistNames[index])) return true;

  const remaining = new Set(candidate.artistNames);
  const namesToResolve = original.artistNames.filter(name => !remaining.delete(name));
  for (const name of namesToResolve) {
    const id = artistIds.get(name);
    if (!id) return false;
    const credit = candidate.artistCredits.find(artist => artist.id === id);
    if (!credit || !remaining.delete(musicText(credit.name))) return false;
  }
  return remaining.size === 0;
}

function compareRecording(original, candidate, artistIds) {
  const titleMatches = Boolean(original.titleKey && original.titleKey === candidate.titleKey);
  const artistsMatch = sameArtistRoster(original, candidate, artistIds);
  const relation = titleMatches
    ? (artistsMatch ? 'same_artist_version' : 'same_title')
    : (artistsMatch ? 'same_artist_other' : null);
  const albumMatch = Boolean(original.albumKey && original.albumKey === candidate.albumKey);
  const durationDiff = original.durationSec > 0 && candidate.durationSec > 0
    ? Math.abs(original.durationSec - candidate.durationSec)
    : Infinity;
  let confidence = 0;
  const sameVersion = original.versionKey === candidate.versionKey;
  const masteringMatch = Boolean(original.mastering && original.mastering === candidate.mastering);
  const plainStudio = !original.versionKey || original.versionKey === 'original' || original.versionKey === 'originallyrics';
  if (titleMatches && artistsMatch && sameVersion) {
    if (original.isrc && candidate.isrc) {
      if (original.isrc === candidate.isrc) confidence = 3;
    } else if (durationDiff <= RECORDING_DURATION_TOLERANCE_SEC ||
        (plainStudio && albumMatch && durationDiff <= 7)) {
      confidence = 1;
      if (durationDiff <= 2 && (albumMatch || masteringMatch ||
          (plainStudio && original.versionKey && durationDiff <= 1))) confidence = 2;
    }
  }
  return { relation, confidence, masteringMatch, albumMatch, durationDiff,
    isrc: candidate.isrc, versionKey: candidate.versionKey, mastering: candidate.mastering,
    durationSec: candidate.durationSec };
}

function preferRecording(a, b) {
  return b.confidence - a.confidence || Number(b.masteringMatch) - Number(a.masteringMatch) ||
    Number(b.albumMatch) - Number(a.albumMatch) ||
    (a.durationDiff === b.durationDiff ? 0 : a.durationDiff - b.durationDiff);
}

function preferRotationAlternative(original, a, b) {
  const score = option => option.versionKey === original.versionKey ? 2 :
    (!option.versionKey && !original.versionKey.startsWith('live') ? 1 : 0);
  return score(b) - score(a) || Number(b.albumMatch) - Number(a.albumMatch) ||
    (a.durationDiff === b.durationDiff ? 0 : a.durationDiff - b.durationDiff);
}

function sameReleaseRecording(a, b) {
  if (a.versionKey !== b.versionKey) return false;
  if (a.isrc && b.isrc) return a.isrc === b.isrc;
  if (a.mastering && b.mastering && a.mastering !== b.mastering) return false;
  return a.durationSec > 0 && b.durationSec > 0 && Math.abs(a.durationSec - b.durationSec) <= 1;
}

function clearMatch(recordings, complete) {
  const [best, ...others] = recordings;
  if (!best) return null;
  if (best.confidence === 3) return best;
  if (!complete) return null;
  if (new Set(recordings.map(option => option.isrc).filter(Boolean)).size > 1) return null;
  const closest = [...recordings].sort((a, b) => b.confidence - a.confidence ||
    Number(b.masteringMatch) - Number(a.masteringMatch) || a.durationDiff - b.durationDiff ||
    Number(b.albumMatch) - Number(a.albumMatch))[0];
  if (new Set(recordings.map(option => option.mastering).filter(Boolean)).size <= 1 &&
      recordings.every(option => option === closest || sameReleaseRecording(closest, option))) return closest;
  if (best.confidence >= 2 && others.every(option =>
    sameReleaseRecording(best, option) ||
    (!(best.isrc && option.isrc && best.isrc !== option.isrc) &&
      (best.masteringMatch && !option.masteringMatch ||
        best.confidence > option.confidence && option.durationDiff - best.durationDiff >= 3)))) return best;
  return null;
}

export function musicTrackMatchKey(item) {
  const platform = item.sourcePlatform || item.provider;
  const sourceId = item.sourceTrackId || item.sourceId;
  if (!platform || !sourceId) return null;
  return JSON.stringify([platform === 'qqmusic' ? 'qq' : platform, sourceId, item.title, item.artist, item.album, item.durationSec, item.isrc]);
}

export function withPlaybackSelection(track, original, mode) {
  return {
    ...track,
    playbackSelection: {
      mode,
      original: {
        title: String(original.title || '').slice(0, 240),
        artist: String(original.artist || '').slice(0, 240),
        platform: String(original.sourcePlatform || original.provider || '').slice(0, 48)
      }
    }
  };
}

export class MusicRegistry {
  constructor(providers = [], { matchStore } = {}) {
    this.providers = new Map();
    this.defaultOrder = [];
    this.resolved = new Map();
    this.resolving = new Map();
    this.trackMatches = new Map();
    this.matchStore = matchStore;
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
    const native = normalizeMusicTrack({
      ...item, provider: item.sourcePlatform || item.provider, sourceId: item.sourceTrackId || item.sourceId
    });
    if (native && this.providers.has(native.provider)) return native;
    const existing = normalizeMusicTrack(item.matchedTrack);
    if (existing) return existing;
    const sourceId = item.sourceTrackId || item.sourceId || (typeof item.id === 'string' && item.id.startsWith('qq:') ? item.id.replace(/^qq:/, '') : '');
    const platform = item.sourcePlatform || item.provider;
    if ((platform === 'qqmusic' || platform === 'qq' || (!platform && typeof item.id === 'string' && item.id.startsWith('qq:'))) && sourceId) {
      const direct = {
        id: 'qq:' + sourceId,
        provider: 'qq',
        sourceId,
        title: item.title,
        artist: item.artist,
        album: item.album || item.albumName || undefined,
        cover: item.cover,
        durationSec: item.durationSec
      };
      item.matchedTrack = direct;
      return direct;
    }
    if (item._unmatchedAt && Date.now() - item._unmatchedAt < UNMATCHED_PLAYLIST_TTL_MS) {
      return null;
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

  matchStorageKey(item, providerId) {
    const sourceKey = musicTrackMatchKey(item);
    if (!sourceKey) return null;
    return 'music:verified-match:v2:' + createHash('sha256').update(JSON.stringify([sourceKey, providerId])).digest('hex');
  }

  readMatch(key) {
    if (!key) return null;
    const local = this.trackMatches.get(key);
    if (local?.expiresAt > Date.now()) return local;
    try {
      return this.matchStore?.getKv?.(key) ?? null;
    } catch {
      return null;
    }
  }

  saveMatch(key, track, ttlMs) {
    if (!key) return;
    const record = { track, expiresAt: Date.now() + ttlMs };
    if (this.trackMatches.size >= TRACK_MATCH_LIMIT) this.trackMatches.delete(this.trackMatches.keys().next().value);
    this.trackMatches.set(key, { ...record, expiresAt: Date.now() + Math.min(ttlMs, TRACK_MATCH_TTL_MS) });
    try {
      this.matchStore?.setKv?.(key, record);
    } catch {
      // An unavailable match store must not block playback.
    }
  }

  providerOrder(item, preferredTrack) {
    const original = normalizeMusicTrack({
      ...item, provider: item.sourcePlatform || item.provider, sourceId: item.sourceTrackId || item.sourceId
    });
    const possible = [...new Set([preferredTrack?.provider, original?.provider, 'qq', 'kugou', 'netease', ...this.defaultOrder])];
    const available = possible.filter(id => this.providers.has(id));
    if (original || preferredTrack) return available;
    // Reuse a previously verified cross-catalog match before repeating a search.
    const known = available.filter(id => this.readMatch(this.matchStorageKey(item, id))?.expiresAt > Date.now());
    return [...known, ...available.filter(id => !known.includes(id))];
  }

  async preMatchPlaylists(playlists, resolve, limit = 8) {
    const alreadyConsidered = new Set();
    let checked = 0;
    for (const playlist of playlists) {
      for (const track of playlist.tracks || []) {
        if (checked >= limit) return checked;
        if (this.resolving.size >= 4) return checked;
        const source = normalizeMusicTrack(track);
        if (source && this.providers.has(source.provider)) continue;
        const attemptKey = this.matchStorageKey(track, 'background');
        if (!attemptKey || alreadyConsidered.has(attemptKey)) continue;
        alreadyConsidered.add(attemptKey);
        if (this.readMatch(attemptKey)?.expiresAt > Date.now() ||
            this.defaultOrder.some(id => this.readMatch(this.matchStorageKey(track, id))?.expiresAt > Date.now())) continue;
        checked++;
        const result = await this.resolveRotationTrack(track, resolve, { alternatives: true, random: true, budgetMs: 4200 });
        this.saveMatch(attemptKey, null, result.temporaryFailure ? 60 * 60_000 : PREMATCH_RETRY_MS);
      }
    }
    return checked;
  }

  async resolveRotationTrack(item, resolve, options = {}) {
    const ordered = this.providerOrder(item, options.preferredTrack);
    const budgetMs = options.budgetMs ?? (options.alternatives ? (ordered.length > 1 ? 6500 : 10_500) : 2800);
    if (!ordered.length) return { temporaryFailure: false };
    const deadline = Date.now() + budgetMs;
    const lookup = (id, signal) => this.resolveProviderRecording(item, resolve, id, {
      ...options, alternatives: options.alternatives || options.autoSelectAlternative, deadline, signal
    });
    const result = ordered.length === 1
      ? await lookup(ordered[0])
      : await lookupPreferredProviders(ordered, lookup, budgetMs, options.autoSelectAlternative ? Infinity : 3);
    if (result.verifiedMatch) {
      const track = normalizeMusicTrack(result.playable);
      if (track) this.saveMatch(this.matchStorageKey(item, track.provider), track, STORED_MATCH_TTL_MS);
    }
    if (!result.playable && options.autoSelectAlternative) {
      const original = recordingMetadata(item);
      const noAliases = new Map();
      const alternatives = (result.alternatives || [])
        .filter(option => option.relation === 'same_artist_version')
        .map(({ track }) => ({ track, ...compareRecording(original, recordingMetadata(track), noAliases) }))
        .sort((a, b) => preferRotationAlternative(original, a, b));
      const best = alternatives[0]?.track;
      if (best) {
        const replacement = { ...best, rotationReplacement: { title: item.title, artist: item.artist } };
        return { playable: withPlaybackSelection(replacement, item, 'automatic-alternative') };
      }
    }
    if (result.playable) {
      const mode = result.usedPreference ? 'saved-choice'
        : result.nativeMatch ? 'original' : 'same-version';
      return { ...result, playable: withPlaybackSelection(result.playable, item, mode) };
    }
    return result;
  }

  async resolveProviderRecording(item, resolve, providerId, {
    alternatives = false, autoSelectAlternative = false, exclude = () => false, budgetMs, preferredTrack, random = false, deadline, signal
  }) {
    const platform = item.sourcePlatform || item.provider;
    const sourceId = item.sourceTrackId || item.sourceId ||
      (item.id?.startsWith('qq:') ? item.id.slice(3) : '');
    const provider = platform === 'qqmusic' ? 'qq' : platform || (item.id?.startsWith('qq:') ? 'qq' : '');
    const direct = provider === providerId && sourceId
      ? normalizeMusicTrack({ ...item, id: provider + ':' + sourceId, provider, sourceId })
      : null;
    const seen = new Set();
    let temporaryFailure = false;
    const uncertainSources = new Set();
    const bounded = async (operation, maxMs) => {
      const remaining = Math.min(maxMs, deadline - Date.now());
      if (remaining <= 0 || signal?.aborted) throw new Error('Music lookup budget exhausted');
      let timer;
      try {
        return await Promise.race([
          operation(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Rotation lookup timed out')), remaining);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const check = async (track, maxMs = 2000) => {
      if (!track || exclude(track) || seen.has(track.id)) return null;
      seen.add(track.id);
      try {
        return await bounded(() => resolve(track), maxMs);
      } catch {
        temporaryFailure = true;
        uncertainSources.add(track.id);
        return null;
      }
    };
    const search = async (keyword) => {
      if (!keyword.trim()) return [];
      try {
        const result = await bounded(() => this.search(keyword, 15, providerId), budgetMs ? 1800 : 4000);
        return result.tracks || [];
      } catch {
        temporaryFailure = true;
        return [];
      }
    };
    const preference = await check(preferredTrack?.provider === providerId ? preferredTrack : null, 1300);
    if (preference) return { playable: preference, usedPreference: true };
    const directPlayable = await check(direct, budgetMs ? 1900 : alternatives ? 5600 : 2300);
    if (directPlayable) return { playable: directPlayable, nativeMatch: true };

    const matchKey = this.matchStorageKey(item, providerId);
    const cached = this.readMatch(matchKey);
    if (cached?.track?.provider === providerId && cached.expiresAt > Date.now()) {
      const playable = await check(cached.track, 1300);
      if (playable) return { playable };
      if (!exclude(cached.track) && !uncertainSources.has(cached.track.id)) {
        this.saveMatch(matchKey, null, 0);
      }
    }
    const remember = playable => ({ playable, verifiedMatch: true });

    const original = recordingMetadata(item);
    const searchTitle = (original.title || item.title || '').replace(/["\p{Pi}\p{Pf}]/gu, '').trim();
    const titleAndArtists = [searchTitle, ...original.artists].filter(Boolean).join(' ');
    const stored = normalizeMusicTrack(item.matchedTrack);
    const matched = stored?.provider === providerId && {
      ...stored,
      artistNames: item.matchedTrack.artistNames,
      isrc: item.matchedTrack.isrc
    };
    const rank = (searchTracks) => {
      const artistIds = indexArtistNames(searchTracks);
      const tracks = new Map();
      for (const track of [...searchTracks, ...(matched ? [matched] : [])]) {
        if (!tracks.has(track.id) && !exclude(track)) tracks.set(track.id, track);
      }
      return [...tracks.values()].map(track => ({
        track, ...compareRecording(original, recordingMetadata(track), artistIds)
      }));
    };

    const primary = await search(titleAndArtists);
    const primaryRanked = rank(primary);
    const primaryMatches = primaryRanked.filter(option => option.confidence > 0).sort(preferRecording);
    const primaryChoice = clearMatch(primaryMatches, true);
    if (primaryChoice) {
      const playable = await check(primaryChoice.track);
      if (playable) return remember(playable);
    }

    const titleResults = alternatives && titleAndArtists !== searchTitle ? await search(searchTitle) : [];
    const ranked = titleResults.length ? rank([...primary, ...titleResults]) : primaryRanked;
    const recordings = ranked.filter(option => option.confidence > 0).sort(preferRecording);
    const checkedRecordings = (await Promise.all(recordings.slice(0, MAX_SOURCE_CHECKS).map(async option => {
      const track = await check(option.track);
      return track ? { ...option, track } : null;
    }))).filter(Boolean);
    // A shared recording code is sufficient even if the same recording has several releases.
    const completeCheck = recordings.length <= MAX_SOURCE_CHECKS &&
      !recordings.some(option => uncertainSources.has(option.track.id));
    const choice = clearMatch(checkedRecordings, completeCheck);
    if (choice) return remember(choice.track);
    if (!alternatives || random) return { temporaryFailure };

    const remaining = ranked
      .filter(option => option.relation && !seen.has(option.track.id) &&
        (!autoSelectAlternative || option.relation === 'same_artist_version'))
      .sort((a, b) => ROTATION_RELATIONS.indexOf(a.relation) - ROTATION_RELATIONS.indexOf(b.relation) ||
        (autoSelectAlternative ? preferRotationAlternative(original, a, b) : preferRecording(a, b)));
    const alternativeLimit = autoSelectAlternative ? 3 : Math.max(0, MAX_SOURCE_CHECKS - recordings.length);
    const checked = await Promise.all(remaining.slice(0, alternativeLimit).map(async option => {
      const track = await check(option.track);
      return track ? { track, relation: option.relation } : null;
    }));
    const distinctRecordings = checkedRecordings.filter((option, index) => !checkedRecordings.slice(0, index)
      .some(previous => sameReleaseRecording(previous, option)));
    return {
      alternatives: [...distinctRecordings.map(({ track, relation }) => ({ track, relation })), ...checked.filter(Boolean)]
        .slice(0, autoSelectAlternative ? Infinity : 3),
      temporaryFailure
    };
  }

  async resolvePlayable(track, origin, signSecret, { fresh = false } = {}) {
    const provider = this.providers.get(track.provider);
    const id = track.sourceId;
    if (!provider || !isMusicSourceId(track.provider, id)) return null;
    const key = provider.id + ':' + id;
    let resolved = fresh ? null : this.resolved.get(key);
    if (!resolved || resolved.expiresAt <= Date.now()) {
      let pending = this.resolving.get(key);
      if (!pending) {
        if (this.resolving.size >= 16) throw new Error('Music source resolution is busy');
        pending = provider.resolveStream(id).then(source => {
          if (this.resolved.size >= 256) this.resolved.delete(this.resolved.keys().next().value);
          const result = {
            source,
            expiresAt: Date.now() + (source
              ? (provider.id === 'qq' ? RESOLVED_CACHE_TTL_MS : PARTNER_STREAM_TTL_MS)
              : FAILED_CACHE_TTL_MS)
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
    const directUrl = provider.id === 'qq' && typeof source.url === 'string' && source.url.startsWith('http')
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
      audioSource: {
        checked: Boolean(source.providerChannel && source.mimeType),
        channel: source.providerChannel || '',
        mimeType: source.mimeType || ''
      },
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
