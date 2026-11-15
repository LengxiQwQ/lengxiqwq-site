import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stableTrack } from './src/music/music-manager.mjs';

const dataDir = process.argv[2];
const rooms = ['chat', 'interconnect'];

function snapshot(roomId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:3001/ws?room=' + roomId + '&visitorId=music-deploy-health');
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('missing room snapshot: ' + roomId));
    }, 5000);
    socket.addEventListener('message', event => {
      const packet = JSON.parse(event.data);
      if (packet.type !== 'room:init' || packet.roomId !== roomId) return;
      clearTimeout(timer);
      socket.close();
      resolve(packet.music);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('cannot capture room: ' + roomId));
    }, { once: true });
  });
}

const snapshots = await Promise.all(rooms.map(snapshot));
for (const [index, roomId] of rooms.entries()) {
  const music = snapshots[index];
  const file = join(dataDir, 'music_state_' + roomId + '.json');
  const existing = await readFile(file, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) continue;
  const isSupported = item => item?.track?.provider === 'qq';
  const scrub = item => ({ ...item, track: stableTrack(item.track) });
  const current = isSupported(music.current) && !music.current.isFallback ? scrub(music.current) : null;
  const queue = music.queue.filter(isSupported).map(scrub);
  await writeFile(file + '.deploy.tmp', JSON.stringify({ current, queue }), { mode: 0o600 });
  await rename(file + '.deploy.tmp', file);
  console.log(roomId + ': saved current=' + Boolean(current) + ', queued=' + queue.length);
}
