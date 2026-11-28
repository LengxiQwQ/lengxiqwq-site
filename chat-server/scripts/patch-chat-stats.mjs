import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function replaceOnce(source, marker, replacement, label) {
  const first = source.indexOf(marker);
  if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
    throw new Error(`Gateway marker is missing or ambiguous: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + marker.length);
}

export function patchGateway(source) {
  let output = source;

  // 1. Import chat-stats module
  output = replaceOnce(
    output,
    "import { ChatDatabase } from './src/db/database.mjs';",
    "import { ChatDatabase } from './src/db/database.mjs';\nimport { ChatStatsEngine, backfillReactionsFromMessages, upsertReactionRecord, removeReactionRecord } from './src/chat-stats.mjs';",
    'chat-stats import',
  );

  // 2. Startup backfill + initialize chatStats engine
  output = replaceOnce(
    output,
    `console.log(\`[Data] Loaded members: \${membersStore.length}, total playlists: \${getAllPlaylistSummaries().length}\`);`,
    `console.log(\`[Data] Loaded members: \${membersStore.length}, total playlists: \${getAllPlaylistSummaries().length}\`);
let chatStats = null;
if (chatDb?.db) {
  try {
    const backfilledReactions = backfillReactionsFromMessages(chatDb.db, messagesStore);
    if (backfilledReactions > 0) {
      console.log(\`[SQLite] Backfilled \${backfilledReactions} historical reactions into chat_reactions.\`);
    }
    chatStats = new ChatStatsEngine({
      db: chatDb.db,
      normalizeUserKey: (rawKey) => normalizeCanonicalUserKey(rawKey),
      resolveUserMeta: (userKey, fallback = {}) => {
        const mem = membersStore.find((m) => m.userKey === userKey);
        const customBadges = typeof getCustomBadgesForUser === 'function' ? getCustomBadgesForUser(userKey) : [];
        if (mem) {
          return {
            name: mem.name || fallback.name || userKey,
            avatar: mem.avatar || fallback.avatar || '',
            badge: mem.badge || fallback.badge || '',
            badgeType: mem.badgeType || fallback.badgeType || (mem.isAdmin ? 'gold' : 'tag'),
            isAdmin: Boolean(mem.isAdmin || fallback.isAdmin),
            customBadges: customBadges.length > 0 ? customBadges : (Array.isArray(mem.customBadges) ? mem.customBadges : []),
          };
        }
        const raw = userKey.startsWith('matrix:') ? userKey.slice(7) : userKey;
        const base = raw.split('#')[0];
        const isRelaySubUser = raw.includes('#relay:');
        const baseId = base.startsWith('@') ? base : \`@\${base}\`;
        const profile = !isRelaySubUser && base.includes(':') ? matrixProfileCache.get(baseId) : null;
        return {
          name: stripSiteSuffix(fallback.name || profile?.displayname || '') || fallback.name || base.split(':')[0].replace(/^@/, '') || userKey,
          avatar: fallback.avatar || (profile?.avatar_url ? mxcToHttp(profile.avatar_url) : ''),
          badge: fallback.badge || '',
          badgeType: fallback.badgeType || 'tag',
          isAdmin: Boolean(fallback.isAdmin),
          customBadges,
        };
      },
      resolveSiteMeta: (userKey, fallback = {}) => {
        if (
          userKey.startsWith('waline:') ||
          userKey.startsWith('guest:') ||
          userKey.includes('matrix.lengxiqwq.com')
        ) {
          return { siteKey: 'local', siteName: LOCAL_CHAT_SITE_NAME, color: '' };
        }
        const raw = userKey.startsWith('matrix:') ? userKey.slice(7) : userKey;
        const base = raw.split('#')[0];
        const isRelaySubUser = raw.includes('#relay:');
        const baseId = base.startsWith('@') ? base : \`@\${base}\`;
        const profile = !isRelaySubUser && base.includes(':') ? matrixProfileCache.get(baseId) : null;
        const rawSenderName = String(fallback.senderName || '').trim();
        const suffixMatch = rawSenderName.match(/\s[·\-]\s([^·\-]{2,24})$/);
        const nameSiteHint = isRelaySubUser && suffixMatch ? suffixMatch[1].trim() : '';
        const relayMeta = resolveMatrixRelayMeta({
          sender: baseId,
          senderDisplayname: profile?.displayname || '',
          siteHint: nameSiteHint,
        });
        const resolved = resolveInterconnectSiteForUser({
          sender: baseId,
          userKey,
          siteUrl: relayMeta.siteUrl || '',
          siteHint: nameSiteHint || relayMeta.siteName || '',
        });
        const siteName = resolved.chatBadge || resolved.siteName || relayMeta.siteName || normalizeSiteBadge(raw, fallback.badge || '外部站点');
        const siteKey = resolved.site?.name || resolved.siteName || relayMeta.siteName || (base.split(':')[1] || siteName);
        return {
          siteKey,
          siteName,
          color: resolved.site?.color || '',
        };
      },
    });
    console.log('[Stats] ChatStatsEngine initialized.');
  } catch (e) {
    console.error('[Stats] Init failed:', e.message);
  }
}`,
    'chat-stats init',
  );

  // 3. Invalidate today's cache when store flushes to SQLite
  output = replaceOnce(
    output,
    `    chatDb.syncRecentMessages('chat', messagesStore.chat.slice(-50));
    chatDb.syncRecentMessages('interconnect', messagesStore.interconnect.slice(-50));`,
    `    chatDb.syncRecentMessages('chat', messagesStore.chat.slice(-50));
    chatDb.syncRecentMessages('interconnect', messagesStore.interconnect.slice(-50));
    chatStats?.invalidateDay('chat');
    chatStats?.invalidateDay('interconnect');`,
    'flushStoreToSqlite cache invalidation',
  );

  // 4. Persist reactions in SQLite on WS chat:reaction
  output = replaceOnce(
    output,
    `          targetMsg.reactions[emoji] = userList;
        }
        saveStoreDebounced();
        broadcastToRoom(ws.currentRoom, {
          type: 'chat:reaction_updated',`,
    `          targetMsg.reactions[emoji] = userList;
        }
        if (chatDb?.db) {
          const rEvId = targetMsg.matrixEventId || targetMsg.msgUid;
          if (action === 'add') {
            upsertReactionRecord(chatDb.db, {
              messageEventId: rEvId,
              senderKey: uKey,
              senderName: ws.user?.name || '',
              reactionKey: emoji,
              createdAt: Date.now(),
            });
          } else {
            for (const k of keysForUser) {
              removeReactionRecord(chatDb.db, {
                messageEventId: rEvId,
                senderKey: k,
                reactionKey: emoji,
              });
            }
          }
          chatStats?.invalidateDay(ws.currentRoom, Date.now());
        }
        saveStoreDebounced();
        broadcastToRoom(ws.currentRoom, {
          type: 'chat:reaction_updated',`,
    'ws chat:reaction sqlite sync',
  );

  // 5. Persist reactions in SQLite on Matrix m.annotation
  output = replaceOnce(
    output,
    `              if (!targetMsg.reactions[emoji].includes(senderKey)) {
                targetMsg.reactions[emoji].push(senderKey);
                saveStoreDebounced();`,
    `              if (!targetMsg.reactions[emoji].includes(senderKey)) {
                targetMsg.reactions[emoji].push(senderKey);
                if (chatDb?.db) {
                  upsertReactionRecord(chatDb.db, {
                    messageEventId: targetMsg.matrixEventId || targetMsg.msgUid,
                    senderKey,
                    reactionKey: emoji,
                    createdAt: ev.origin_server_ts || Date.now(),
                  });
                  chatStats?.invalidateDay('interconnect', ev.origin_server_ts || Date.now());
                }
                saveStoreDebounced();`,
    'matrix reaction sqlite sync',
  );

  // 6. Remove reaction from SQLite on Matrix m.room.redaction
  output = replaceOnce(
    output,
    `                if (targetMsg.reactions[details.emoji].length === 0) {
                  delete targetMsg.reactions[details.emoji];
                }
                saveStoreDebounced();`,
    `                if (targetMsg.reactions[details.emoji].length === 0) {
                  delete targetMsg.reactions[details.emoji];
                }
                if (chatDb?.db) {
                  const rEvId = targetMsg.matrixEventId || targetMsg.msgUid;
                  removeReactionRecord(chatDb.db, { messageEventId: rEvId, senderKey: details.userKey, reactionKey: details.emoji });
                  if (shadowId) removeReactionRecord(chatDb.db, { messageEventId: rEvId, senderKey: \`matrix:\${shadowId}\`, reactionKey: details.emoji });
                  chatStats?.invalidateDay('interconnect', targetMsg.createdAt || Date.now());
                }
                saveStoreDebounced();`,
    'matrix reaction redaction sqlite sync',
  );

  // 7. Invalidate recalled message's day cache on WS recall/delete
  output = replaceOnce(
    output,
    `chatDb?.insertMessage?.({ ...targetMsg, roomId: ws.currentRoom });`,
    `chatDb?.insertMessage?.({ ...targetMsg, roomId: ws.currentRoom });
      chatStats?.invalidateDay(ws.currentRoom, targetMsg.createdAt || Date.now());`,
    'ws recall cache invalidation',
  );

  // 8. Add GET /api/chat/stats endpoint
  output = replaceOnce(
    output,
    "  // Rooms Summary\n  if (url.pathname === '/api/rooms/summary') {",
    `  // Chatroom Statistics: GET /api/chat/stats
  if (url.pathname === '/api/chat/stats' && req.method === 'GET') {
    if (!chatStats) {
      res.writeHead(503, NO_CACHE_HEADERS);
      res.end(JSON.stringify({ ok: false, error: '统计引擎尚未就绪' }));
      return;
    }
    if (saveStoreDebounced._dirty) {
      saveStoreDebounced._dirty = false;
      clearTimeout(saveStoreDebounced._timer);
      flushStoreToSqlite();
    }
    try {
      const room = url.searchParams.get('room') || 'interconnect';
      const range = url.searchParams.get('range') || 'week';
      const date = url.searchParams.get('date') || '';
      const tzOffset = url.searchParams.get('tzOffset') ?? '480';
      const site = url.searchParams.get('site') || 'all';
      const data = chatStats.getStats({ room, range, date, tzOffset, site });
      res.writeHead(200, NO_CACHE_HEADERS);
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('[Stats] Query failed:', err?.message || err);
      res.writeHead(500, NO_CACHE_HEADERS);
      res.end(JSON.stringify({ ok: false, error: '统计查询失败' }));
    }
    return;
  }

  // Rooms Summary
  if (url.pathname === '/api/rooms/summary') {`,
    'GET /api/chat/stats endpoint',
  );

  return output;
}

async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    throw new Error('Usage: node scripts/patch-chat-stats.mjs <input-server.mjs> <output-server.mjs>');
  }
  const source = await readFile(resolve(inputPath), 'utf8');
  const patched = patchGateway(source);
  await writeFile(resolve(outputPath), patched, 'utf8');
  console.log(`Patched gateway written to ${resolve(outputPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
