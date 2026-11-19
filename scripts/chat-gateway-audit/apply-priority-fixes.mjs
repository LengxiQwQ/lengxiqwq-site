import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const serverPath = resolve("/opt/chat-server/server.mjs");
const registryPath = resolve("/opt/chat-server/src/music/registry.mjs");

console.log("1. Patching server.mjs...");
let serverCode = await readFile(serverPath, "utf8");

// A. Insert publicRoomHistory before WebSocket Server
if (!serverCode.includes("function publicRoomHistory(roomId)")) {
	const targetWS =
		"// WebSocket Server\nconst wss = new WebSocketServer({ server, path: '/ws' });";
	const helperCode =
		`function publicRoomHistory(roomId) {
  const records = Object.hasOwn(messagesStore, roomId) ? messagesStore[roomId] : [];
  const hidden = new Set(records.filter((message) => message.isRecalled ||
    message.status === 'recalled' || message.status === 'deleted').map((message) => message.msgUid));
  return records.filter((message) => !hidden.has(message.msgUid)).map((message) => {
    if (!hidden.has(message.replyTo?.msgUid)) return message;
    return {
      ...message,
      replyTo: { ...message.replyTo, content: '', hasImage: false, isRecalled: true }
    };
  });
}

` + targetWS;
	if (!serverCode.includes(targetWS)) {
		throw new Error("Cannot find WebSocket Server anchor in server.mjs");
	}
	serverCode = serverCode.replace(targetWS, helperCode);
	console.log("  [+] publicRoomHistory inserted");
} else {
	console.log("  [=] publicRoomHistory already present");
}

// B. Replace roomMessages in handshake
const initMsgTarget =
	"  const roomMessages = messagesStore[roomId] || [];\n  const initialMessages = roomMessages.slice(-50);";
const initMsgReplace =
	"  const roomMessages = publicRoomHistory(roomId);\n  const initialMessages = roomMessages.slice(-50);";
if (serverCode.includes(initMsgTarget)) {
	serverCode = serverCode.replace(initMsgTarget, initMsgReplace);
	console.log("  [+] room:init messagesStore replaced with publicRoomHistory");
}

// C. Replace room:switch
const switchTarget =
	"        const currentRoomMsgs = messagesStore[ws.currentRoom] || [];\n        const initSlice = currentRoomMsgs.slice(-50);";
const switchReplace =
	"        const currentRoomMsgs = publicRoomHistory(ws.currentRoom);\n        const initSlice = currentRoomMsgs.slice(-50);";
if (serverCode.includes(switchTarget)) {
	serverCode = serverCode.replace(switchTarget, switchReplace);
	console.log(
		"  [+] room:switch messagesStore replaced with publicRoomHistory",
	);
}

// D. Replace chat:load_history
const loadHistTarget = `      if (packet.type === 'chat:load_history') {
        const beforeId = Number(packet.beforeId) || 0;
        const roomMsgs = messagesStore[ws.currentRoom] || [];`;
const loadHistReplace = `      if (packet.type === 'chat:load_history') {
        const beforeId = Number(packet.beforeId) || 0;
        const roomMsgs = publicRoomHistory(ws.currentRoom);`;
if (serverCode.includes(loadHistTarget)) {
	serverCode = serverCode.replace(loadHistTarget, loadHistReplace);
	console.log(
		"  [+] chat:load_history messagesStore replaced with publicRoomHistory",
	);
}

// E. prefixMatch sender restriction
const prefixTarget =
	"  const prefixMatch = /^\\[ID:(?<name>[^\\]\\r\\n]+)\\];\\[URL:(?<avatar>[^\\]\\r\\n]*?)\\](?:;\\[KEY:(?<userKey>[^\\]\\r\\n]+)\\])?(?:\\r?\\n)?(?<content>[\\s\\S]*)$/.exec(rawBody);";
const prefixReplace =
	"  const prefixMatch = ev.sender === MATRIX_ADMIN_USER_ID ? /^\\[ID:(?<name>[^\\]\\r\\n]+)\\];\\[URL:(?<avatar>[^\\]\\r\\n]*?)\\](?:;\\[KEY:(?<userKey>[^\\]\\r\\n]+)\\])?(?:\\r?\\n)?(?<content>[\\s\\S]*)$/.exec(rawBody) : null;";
if (serverCode.includes(prefixTarget)) {
	serverCode = serverCode.replace(prefixTarget, prefixReplace);
	console.log("  [+] prefixMatch sender restricted to MATRIX_ADMIN_USER_ID");
}

// F. hasLocalPrefix sender restriction
const hasPrefixTarget =
	"          const hasLocalPrefix = rawBody.startsWith('[ID:') && rawBody.includes(';[KEY:');";
const hasPrefixReplace =
	"          const hasLocalPrefix = ev.sender === MATRIX_ADMIN_USER_ID && rawBody.startsWith('[ID:') && rawBody.includes(';[KEY:');";
if (serverCode.includes(hasPrefixTarget)) {
	serverCode = serverCode.replace(hasPrefixTarget, hasPrefixReplace);
	console.log("  [+] hasLocalPrefix sender restricted to MATRIX_ADMIN_USER_ID");
}

// G. music:enqueue external track resolution & auth check
const enqueueTarget = `      // Music WebSocket commands
      if (packet.type === 'music:enqueue') {
        const track = packet.track;
        const res = await musicManager.enqueueTrack(
          track,
          ws.user || { userKey: 'guest:anonymous', name: '房友' },
          getOnlineUserKeys()
        );
        if (!res.ok) {
          ws.send(JSON.stringify({ type: 'error', message: res.error }));
        }
        return;
      }`;

const enqueueReplace = `      // Music WebSocket commands
      if (packet.type === 'music:enqueue') {
        if (!ws.user) {
          ws.send(JSON.stringify({ type: 'error', code: 'AUTH_REQUIRED', message: '请先填写昵称或登录后再点歌' }));
          return;
        }
        let track = packet.track;
        if (track?.provider === 'external') {
          const playlist = typeof track.playlistId === 'string' && Object.hasOwn(playlistDetailsStore, track.playlistId)
            ? playlistDetailsStore[track.playlistId]
            : null;
          const item = playlist?.tracks?.find((song) => song.position === track.position);
          if (!item) {
            ws.send(JSON.stringify({ type: 'error', message: '歌单曲目不存在' }));
            return;
          }
          try {
            track = await musicRegistry.resolvePlaylistTrack(item);
          } catch {
            track = null;
          }
          if (!track) {
            ws.send(JSON.stringify({ type: 'error', message: '曲库中没有找到可信的可播版本' }));
            return;
          }
        }
        const res = await musicManager.enqueueTrack(
          track,
          ws.user,
          getOnlineUserKeys()
        );
        if (!res.ok) {
          ws.send(JSON.stringify({ type: 'error', message: res.error }));
        }
        return;
      }`;

if (serverCode.includes(enqueueTarget)) {
	serverCode = serverCode.replace(enqueueTarget, enqueueReplace);
	console.log("  [+] music:enqueue external track resolver & auth added");
}

await writeFile(serverPath, serverCode, "utf8");
console.log("server.mjs successfully updated.");

console.log("2. Patching src/music/registry.mjs...");
let registryCode = await readFile(registryPath, "utf8");

if (!registryCode.includes("resolvePlaylistTrack(item)")) {
	const searchEndTarget = `    for (const id of this.defaultOrder) {
      const provider = this.providers.get(id);
      if (!provider) continue;
      const results = await provider.search(keyword, limit);
      if (results.length > 0) {
        return results;
      }
    }
    return [];
  }`;

	const resolveMethodCode = `    for (const id of this.defaultOrder) {
      const provider = this.providers.get(id);
      if (!provider) continue;
      const results = await provider.search(keyword, limit);
      if (results.length > 0) {
        return results;
      }
    }
    return [];
  }

  async resolvePlaylistTrack(item) {
    if (item.matchedTrack) return item.matchedTrack;
    if (item.sourcePlatform === 'qqmusic' && item.sourceTrackId) {
      return {
        id: 'qq:' + item.sourceTrackId,
        provider: 'qq',
        sourceId: item.sourceTrackId,
        title: item.title,
        artist: item.artist,
        cover: item.cover,
        durationSec: item.durationSec
      };
    }
    const normalize = (value) => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\\s+/g, '');
    const matches = await this.search(item.title + ' ' + item.artist, 10, 'qq');
    const match = matches.find((candidate) => normalize(candidate.title) === normalize(item.title) &&
      normalize(candidate.artist) === normalize(item.artist) &&
      (!(candidate.durationSec > 0 && item.durationSec > 0) || Math.abs(candidate.durationSec - item.durationSec) <= 5));
    return match ?? null;
  }`;

	if (!registryCode.includes(searchEndTarget)) {
		throw new Error("Cannot find search method in registry.mjs");
	}
	registryCode = registryCode.replace(searchEndTarget, resolveMethodCode);
	await writeFile(registryPath, registryCode, "utf8");
	console.log("  [+] resolvePlaylistTrack added to registry.mjs");
} else {
	console.log("  [=] resolvePlaylistTrack already present in registry.mjs");
}

console.log("All files patched successfully.");
