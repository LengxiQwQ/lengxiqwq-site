/** Pure transformation. Does not read credentials, write files, deploy or restart anything. */
export function integrateMusicSync(source) {
  const replace = (from, to) => {
    if (source.includes(to)) return;
    if (source.split(from).length !== 2) throw new Error('Gateway integration context changed; re-review required: ' + from.slice(0, 40));
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
  replace(
    `    onPrefetchTrack: (streamUrl) => {\n      prefetchTrackStream(streamUrl);\n    }\n  }),\n  interconnect:`,
    `    onPrefetchTrack: (streamUrl, priority = false) => {\n      prefetchTrackStream(streamUrl, priority);\n    }\n  }),\n  interconnect:`
  );
  replace(
    `    onUnavailable: (entry) => notifyUnavailable('interconnect', entry),\n    onPrefetchTrack: (streamUrl) => {\n      prefetchTrackStream(streamUrl);\n    }`,
    `    onUnavailable: (entry) => notifyUnavailable('interconnect', entry),\n    onPrefetchTrack: (streamUrl, priority = false) => {\n      prefetchTrackStream(streamUrl, priority);\n    }`
  );
  replace(
    `function prefetchTrackStream(streamUrl) {\n  if (!streamUrl || typeof streamUrl !== 'string') return;\n  if (!streamUrl.includes('/api/music/stream?token=')) return;`,
    `function prefetchTrackStream(streamUrl, priority = false) {\n  if (!streamUrl || typeof streamUrl !== 'string') return;\n  if (!streamUrl.includes('/api/music/stream')) return;`
  );
  replace(
    `void prefetchAudio(verified.url, verified.referer, verified.mimeType);`,
    `void prefetchAudio(verified.url, priority, verified.mimeType, verified.trackKey);`
  );
  replace(
    `if (url.pathname === '/api/music/stream' && ['GET', 'HEAD'].includes(req.method)) {`,
    `if ((url.pathname === '/api/music/stream' || url.pathname.startsWith('/api/music/stream/')) && ['GET', 'HEAD'].includes(req.method)) {`
  );
  replace(
    `await handleStreamProxyRequest(req, res, verified.url, verified.referer, verified.mimeType);`,
    `await handleStreamProxyRequest(req, res, verified.url, verified.referer, verified.mimeType, verified.trackKey);`
  );
  replace(`ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now() }));`, `ws.musicSyncVersion = packet.musicSyncVersion === 2 ? 2 : ws.musicSyncVersion;
        if (ws.musicSyncVersion === 2 && typeof packet.musicListening === 'boolean') ws.musicListening = packet.musicListening;
        ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now(),
          ...(Number.isSafeInteger(packet.id) && { id: packet.id }) }));`);
  replace(`        if (packet.type === 'music:report_duration') {`, `        if (packet.type === 'music:listen') {
          if (ws.musicSyncVersion === 2 && typeof packet.listening === 'boolean') {
            ws.musicListening = packet.listening;
            if (!packet.listening) targetMgr.recheckReady?.();
          }
          return;
        }
        if (packet.type === 'music:ready') {
          ws.musicSyncVersion = 2;
          ws.musicListening = true;
          targetMgr.ready?.(packet.playUid, ws, packet.sourceRevision);
          return;
        }
        if (packet.type === 'music:report_duration') {`);
  replace(`await targetMgr.reportError(packet.playUid, actor?.userKey || 'anonymous');`,
    `await targetMgr.reportError(packet.playUid, actor?.userKey || 'anonymous', packet.sourceRevision);`);
  replace(
    `if (packet.playUid && packet.playUid !== targetMgr.current?.uid) return;`,
    `if (packet.playUid && packet.playUid !== targetMgr.current?.uid) {\n            if (ws.readyState === 1) {\n              ws.send(JSON.stringify({ type: 'music:state', roomId: ws.currentRoom, ...targetMgr.getSnapshot(getOnlineUserKeys(ws.currentRoom)) }));\n            }\n            return;\n          }`
  );
  replace(
    `  ws.on('close', () => {\n    clients.delete(ws);`,
    `  ws.on('close', () => {\n    clients.delete(ws);\n    getMusicManager(ws.currentRoom)?.recheckReady?.();`
  );
  // Do not touch routing, credentials, Matrix, messages, playlists or member data.
  return source;
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('server-integration.mjs') && process.argv[2] && process.argv[3]) {
  import('node:fs').then(fs => {
    const input = fs.readFileSync(process.argv[2], 'utf8');
    const output = integrateMusicSync(input);
    fs.writeFileSync(process.argv[3], output, 'utf8');
    console.log('[OK] Integrated server.mjs written to', process.argv[3], 'bytes:', output.length);
  });
}
