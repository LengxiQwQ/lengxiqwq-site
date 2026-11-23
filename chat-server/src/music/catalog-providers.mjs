import { isAllowedStreamTarget, probeAudio } from './audio-source.mjs';
import { isMusicSourceId, normalizeMusicTrack } from './music-input.mjs';

async function getJson(base, params, referer) {
  const url = new URL(base);
  url.search = new URLSearchParams(params);
  const response = await fetch(url, {
    headers: { Referer: referer, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(2500)
  });
  if (!response.ok) throw new Error('catalog HTTP ' + response.status);
  return response.json();
}

function catalogTrack(input, extra = {}) {
  const track = normalizeMusicTrack(input);
  return track && input.title ? { ...track, ...extra } : null;
}

async function checkStream(rawUrl, channel) {
  if (!isAllowedStreamTarget(rawUrl)) return null;
  const url = new URL(rawUrl);
  url.protocol = 'https:';
  const mimeType = await probeAudio(url.href, { requireRange: true });
  return { url: url.href, mimeType, providerChannel: channel };
}

export class NeteaseMusicProvider {
  id = 'netease';
  name = '网易云音乐';

  async search(keyword, limit = 15, page = 1) {
    const data = await getJson('https://music.163.com/api/search/get', {
      s: keyword, type: '1', limit, offset: (page - 1) * limit
    }, 'https://music.163.com/');
    if (data.code !== 200) throw new Error('netease search returned an error');
    const songs = Array.isArray(data.result?.songs) ? data.result.songs : [];
    const tracks = songs.map(song => {
      const artistNames = (song.artists || []).map(artist => artist.name).filter(Boolean);
      return catalogTrack({
        provider: this.id, sourceId: String(song.id), title: song.name,
        artist: artistNames.join(', '), album: song.album?.name, cover: song.album?.picUrl,
        durationSec: Number(song.duration) / 1000
      }, { artistNames });
    }).filter(Boolean);
    return { tracks, hasMore: Boolean(data.result?.hasMore) };
  }

  async resolveStream(sourceId) {
    if (!isMusicSourceId(this.id, sourceId)) return null;
    const endpoint = 'https://music.163.com/song/media/outer/url?id=' + sourceId + '.mp3';
    const response = await fetch(endpoint, {
      redirect: 'manual',
      headers: { Referer: 'https://music.163.com/' },
      signal: AbortSignal.timeout(2200)
    });
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (response.status === 404 || response.status === 403 || response.status === 451) return null;
    if (response.status !== 302 || !location) throw new Error('netease source HTTP ' + response.status);
    const url = new URL(location, endpoint);
    if (!url.hostname.endsWith('.music.126.net')) return null;
    return checkStream(url.href, this.id);
  }

  async getLyric(sourceId) {
    const data = await getJson('https://music.163.com/api/song/lyric',
      { id: sourceId, lv: '-1', kv: '-1', tv: '-1' }, 'https://music.163.com/');
    return typeof data.lrc?.lyric === 'string' ? data.lrc.lyric : '';
  }
}

function kugouCover(song) {
  for (const raw of [song.Image, song.AlbumImage]) {
    if (typeof raw !== 'string' || !raw) continue;
    try {
      const url = new URL(raw.replace('{size}', '400'), 'https://www.kugou.com');
      if (!/^https?:$/u.test(url.protocol) || !url.hostname.endsWith('.kugou.com') || !raw.includes('//')) continue;
      url.protocol = 'https:';
      return url.href;
    } catch { continue; }
  }
  return '';
}

export class KugouMusicProvider {
  id = 'kugou';
  name = '酷狗音乐';

  async search(keyword, limit = 15, page = 1) {
    const data = await getJson('https://songsearch.kugou.com/song_search_v2', {
      keyword, page, pagesize: limit, platform: 'WebFilter'
    }, 'https://www.kugou.com/');
    if (data.status !== 1) throw new Error('kugou search returned an error');
    const songs = Array.isArray(data.data?.lists) ? data.data.lists : [];
    const tracks = songs.map(song => catalogTrack({
      provider: this.id, sourceId: song.FileHash, title: song.SongName?.replace(/<[^>]+>/g, ''),
      artist: song.SingerName?.replace(/<[^>]+>/g, ''), album: song.AlbumName, durationSec: song.Duration,
      cover: kugouCover(song)
    })).filter(Boolean);
    return { tracks, hasMore: Number(data.data?.total) > page * limit };
  }

  async resolveStream(sourceId) {
    if (!isMusicSourceId(this.id, sourceId)) return null;
    if (Date.now() < this.retryAfter) throw new Error('曲库暂时繁忙');
    const data = await getJson('https://m.kugou.com/app/i/getSongInfo.php',
      { cmd: 'playInfo', hash: sourceId }, 'https://www.kugou.com/');
    if (Number(data.status) !== 1 && /频繁|稍后再试|too many requests/i.test(data.error || '')) {
      this.retryAfter = Date.now() + 15_000;
      throw new Error('曲库暂时繁忙');
    }
    if (Number(data.status) !== 1 || !data.url || data.hash?.toUpperCase() !== sourceId.toUpperCase()) return null;
    const source = await checkStream(data.url, this.id);
    return source && { ...source, durationSec: Number(data.timeLength) || 0 };
  }

  async getLyric() {
    return '';
  }
}
