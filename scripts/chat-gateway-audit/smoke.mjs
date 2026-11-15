import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
const base = process.argv[2] || 'https://chat-server.lengxiqwq.com';
const from = new URL(base);
const get = async (path) => {
  const response = await fetch(new URL(path, from), { signal: AbortSignal.timeout(12000) });
  assert.ok(response.ok, path + ': HTTP ' + response.status);
  return response.json();
};
const health = await get('/api/health');
const playlists = await get('/api/playlists');
const summaries = new Map(
  ['featured', 'members', 'mine'].flatMap((key) => playlists[key] ?? []).map((item) => [item.id, item]),
);
const details = await Promise.all([...summaries.keys()].map((id) =>
  get('/api/playlists/detail?id=' + encodeURIComponent(id))));
const presence = await get('/api/presence');
const memberDirectory = await get('/api/members');
const rooms = await get('/api/rooms/summary');
const observations = [];
for (const room of ['chat', 'interconnect']) {
  const socketUrl = new URL('/ws?room=' + room, from);
  socketUrl.protocol = from.protocol === 'https:' ? 'wss:' : 'ws:';
  observations.push(await new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('WS timeout: ' + room)); }, 10000);
    let initial;
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('message', (data) => {
      const packet = JSON.parse(data.toString());
      if (packet.type === 'room:init') {
        initial = packet;
        socket.send(JSON.stringify({ type: 'ping' }));
        socket.send(JSON.stringify({ type: 'chat:load_history', beforeId: packet.messages[0]?.id }));
      }
      if (packet.type === 'chat:history_batch') {
        clearTimeout(timer);
        socket.close();
        resolve({ room, actualRoom: initial.roomId, initial: initial.messages.length,
          older: packet.messages.length, recalled: [...initial.messages, ...packet.messages]
            .filter((message) => message.isRecalled).length, musicFields: Object.keys(initial.music) });
      }
    });
  }));
}
let musicRead;
try {
  const result = await get('/api/music/search?q=%E6%99%B4%E5%A4%A9&limit=3');
  const first = result.tracks?.[0];
  const lyric = first && await fetch(new URL('/api/music/lyric?provider=' + encodeURIComponent(first.provider) +
    '&id=' + encodeURIComponent(first.sourceId), from), { signal: AbortSignal.timeout(10000) });
  musicRead = { matched: result.tracks?.length, lyricStatus: lyric?.status };
  if (lyric) await lyric.body?.cancel();
} catch (error) {
  musicRead = { error: error.name };
}
const tracks = details.flatMap(({ playlist }) => playlist.tracks);
const external = tracks.filter((track) => !track.matchedTrack);
assert.ok(health.ok);
assert.ok(observations.every((room) => room.room === room.actualRoom));
console.log(JSON.stringify({
  service: health.service, stored: health.historyCount, members: memberDirectory.members.length,
  externalInMembers: memberDirectory.members.filter((member) => /^(matrix:|@)/.test(member.userKey) || member.authType === 'matrix').length,
  playlists: details.length, tracks: tracks.length, unmatchedTracks: external.length,
  presence: { global: presence.totalCount, observers: presence.observerCount, rooms: rooms.rooms.map((room) =>
    ({ id: room.id, count: room.totalCount, observers: room.observerCount })) },
  observations, musicRead,
}, null, 2));
