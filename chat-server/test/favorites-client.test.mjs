import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlaylistDetail } from '../../src/components/pages/chat/playlistClient.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('共享收藏超过单次返回上限时读取所有分页并保留成员筛选', async () => {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname === '/api/playlists/detail') {
      return Response.json({ ok: true, playlist: { id: 'pl_collective_favorites', tracks: [], trackCount: 205 } });
    }
    const offset = Number(url.searchParams.get('offset'));
    const items = Array.from({ length: Math.min(200, 205 - offset) }, (_, i) => ({
      id: `qq:${offset + i}`, title: `歌 ${offset + i}`, artist: '歌手', cover: '',
      favCount: 1, lastFavoritedAt: 1, favoritedUsers: [{ userKey: 'user:a' }],
    }));
    return Response.json({ ok: true, total: 205, offset, limit: 200, items });
  };
  const detail = await fetchPlaylistDetail('https://example.test', 'chat', 'pl_collective_favorites', undefined, 'user:a');
  assert.equal(detail.tracks.length, 205);
  assert.equal(detail.tracks[204].matchedTrack.id, 'qq:204');
  assert.deepEqual(calls.slice(1).map((url) => url.searchParams.get('offset')), ['0', '200']);
  assert.ok(calls.every((url) => url.searchParams.get('filterUser') === 'user:a'));
});

test('共享收藏分页失败时报告错误，而不是展示不完整列表', async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/playlists/detail') {
      return Response.json({ ok: true, playlist: { id: 'pl_collective_favorites', tracks: [], trackCount: 1 } });
    }
    return Response.json({ ok: false, error: '加载失败' }, { status: 500 });
  };
  await assert.rejects(fetchPlaylistDetail('https://example.test', 'chat', 'pl_collective_favorites'), /加载失败/);
});
