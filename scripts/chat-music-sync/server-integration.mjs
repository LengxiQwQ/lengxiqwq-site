/** Pure transformation. Does not read credentials, write files, deploy or restart anything. */
export function integrateMusicSync(source) {
  const replace = (from, to) => {
    if (source.split(from).length !== 2) throw new Error('Gateway integration context changed; re-review required');
    source = source.replace(from, to);
  };
  for (const room of ['chat', 'interconnect']) {
    replace(`roomId: '${room}',\n    dataDir: DATA_DIR,`, `roomId: '${room}',
    getListeners: () => [...clients]
      .filter(client => client.readyState === 1 && client.currentRoom === '${room}' &&
        (client.musicSyncVersion === 2 ? client.musicListening === true : client.isMuted === false))
      .map(client => ({ id: client, modern: client.musicSyncVersion === 2 })),
    dataDir: DATA_DIR,`);
  }
  replace(`ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now() }));`, `ws.musicSyncVersion = packet.musicSyncVersion === 2 ? 2 : ws.musicSyncVersion;
        if (ws.musicSyncVersion === 2 && typeof packet.musicListening === 'boolean') ws.musicListening = packet.musicListening;
        ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now(),
          ...(Number.isSafeInteger(packet.id) && { id: packet.id }) }));`);
  replace(`        if (packet.type === 'music:report_duration') {`, `        if (packet.type === 'music:listen') {
          if (ws.musicSyncVersion === 2 && typeof packet.listening === 'boolean') ws.musicListening = packet.listening;
          return;
        }
        if (packet.type === 'music:report_duration') {`);
  replace(`await targetMgr.reportError(packet.playUid, actor?.userKey || 'anonymous');`,
    `await targetMgr.reportError(packet.playUid, actor?.userKey || 'anonymous', packet.sourceRevision);`);
  // Do not touch routing, credentials, Matrix, messages, playlists or member data.
  return source;
}
