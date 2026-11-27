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

function insertAfterLineOnce(source, marker, insertion, label) {
	const first = source.indexOf(marker);
	if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
		throw new Error(`Gateway marker is missing or ambiguous: ${label}`);
	}
	const lineEnd = source.indexOf('\n', first);
	if (lineEnd < 0) throw new Error(`Gateway marker has no line ending: ${label}`);
	return source.slice(0, lineEnd + 1) + insertion + source.slice(lineEnd + 1);
}

export function patchGateway(source) {
  let output = source;
  output = replaceOnce(
    output,
    "import { createMatrixMediaHandler } from './src/matrix-media.mjs';",
    "import { createMatrixMediaHandler } from './src/matrix-media.mjs';\nimport { createMatrixRecallArchive } from './src/matrix-recall-archive.mjs';",
    'recall archive import',
  );

  output = insertAfterLineOnce(
    output,
    'const MATRIX_ADMIN_TOKEN =',
    `const recallArchiveOwnerKey = (process.env.CHAT_RECALL_ARCHIVE_OWNER_KEY || 'waline:1').trim();
const recallArchive = MATRIX_INTERNAL_URL && MATRIX_ADMIN_TOKEN
  ? createMatrixRecallArchive({
      directory: DATA_DIR,
      baseUrl: MATRIX_INTERNAL_URL,
      token: MATRIX_ADMIN_TOKEN,
      signingSecret: process.env.CHAT_RECALL_MEDIA_SIGNING_SECRET || MATRIX_ADMIN_TOKEN
    })
  : null;

function isRecallArchiveOwner(user) {
  return Boolean(recallArchiveOwnerKey && user?.userKey === recallArchiveOwnerKey);
}

function clearPublicRecallReplies(roomMessages, msgUid) {
  for (const message of roomMessages || []) {
    if (message?.replyTo?.msgUid !== msgUid) continue;
    message.replyTo = { ...message.replyTo, content: '', attachmentKind: null, hasImage: false, isRecalled: true };
  }
}

async function archiveRecalledMessage(roomId, message, recalledBy) {
  const pendingKey = \`\${roomId}:\${message.msgUid}\`;
  const pending = pendingRecallArchives.get(pendingKey);
  if (pending) await pending.catch(() => {});
  let original = chatDb?.getRecallCandidate?.(roomId, message.msgUid) || null;
  if (!original || original.recallArchiveIncomplete) original = await archiveMessageForRecall(roomId, original || message);
  original = { ...original, isRedacted: true };
  chatDb?.archiveRecalledMessage?.({
    roomId,
    message: original,
    recalledByKey: recalledBy?.userKey || '',
    recalledByName: recalledBy?.name || '',
    recalledAt: Date.now()
  });
  return original;
}

async function archiveMessageForRecall(roomId, message) {
  let original = { ...message, isRedacted: false };
  chatDb?.storeRecallCandidate?.({ roomId, message: original });
  if (recallArchive) {
    original = await recallArchive.archiveMessage(original, \`\${roomId}:\${message.msgUid}\`);
  } else if (Array.isArray(original.attachments) && original.attachments.length) {
    original.recallArchiveIncomplete = true;
  }
  chatDb?.storeRecallCandidate?.({ roomId, message: original });
  return original;
}

const pendingRecallArchives = new Map();
function scheduleRecallArchive(roomId, message) {
  const key = \`\${roomId}:\${message.msgUid}\`;
  if (pendingRecallArchives.has(key)) return pendingRecallArchives.get(key);
  const pending = archiveMessageForRecall(roomId, message).catch((error) => {
    console.error('[RecallArchive] Media copy failed:', error?.message || 'unknown error');
    const fallback = { ...message, recallArchiveIncomplete: Boolean(message.attachments?.length) };
    chatDb?.storeRecallCandidate?.({ roomId, message: fallback });
    return fallback;
  }).finally(() => {
    if (pendingRecallArchives.get(key) === pending) pendingRecallArchives.delete(key);
  });
  pendingRecallArchives.set(key, pending);
  return pending;
}

function privateRecallMessagesFor(user, roomId, publicMessages) {
  if (!isRecallArchiveOwner(user) || !Array.isArray(publicMessages) || !chatDb?.getRecalledMessages) return [];
  const msgUids = publicMessages.filter((message) => message?.recalledMsgUid).map((message) => message.recalledMsgUid);
  if (!msgUids.length) return [];
  return chatDb.getRecalledMessages({ roomId, msgUids, limit: Math.min(500, msgUids.length) }).map((message) => recallArchive?.hydrateMessage(message) || message);
}

function sendPrivateRecallMessage(roomId, message) {
  if (!recallArchiveOwnerKey) return;
  const packet = JSON.stringify({
    type: 'chat:recall_archive',
    roomId,
    message: recallArchive?.hydrateMessage(message) || message
  });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN && client.currentRoom === roomId && client.user?.userKey === recallArchiveOwnerKey) {
      client.send(packet);
    }
  }
}`,
    'Matrix token configuration',
  );

  output = replaceOnce(
    output,
    "  if (url.pathname.startsWith('/api/media/')) {\n    await handleMatrixMedia(req, res, url.pathname);",
    `  if (url.pathname.startsWith('/api/chat/recall-media/')) {
    if (recallArchive && await recallArchive.handleRequest(req, res, url.pathname)) return;
    res.writeHead(404, { 'Cache-Control': 'no-store' }).end();
    return;
  }

  if (url.pathname.startsWith('/api/media/')) {
    await handleMatrixMedia(req, res, url.pathname);`,
    'recall media route',
  );

  output = replaceOnce(
    output,
    '    messages: initialMessagesWithThreads,',
    '    messages: initialMessagesWithThreads,\n    ...(isRecallArchiveOwner(ws.user) ? { privateRecallMessages: privateRecallMessagesFor(ws.user, roomId, initialMessages) } : {}),',
    'initial room recall records',
  );
  output = replaceOnce(
    output,
    '          messages: initSliceWithThreads,',
    '          messages: initSliceWithThreads,\n          ...(isRecallArchiveOwner(ws.user) ? { privateRecallMessages: privateRecallMessagesFor(ws.user, ws.currentRoom, initSlice) } : {}),',
    'room switch recall records',
  );
  output = replaceOnce(
    output,
    '          messages: sliceWithThreads,',
    '          messages: sliceWithThreads,\n          ...(isRecallArchiveOwner(ws.user) ? { privateRecallMessages: privateRecallMessagesFor(ws.user, ws.currentRoom, slice) } : {}),',
    'history recall records',
  );

  output = replaceOnce(
    output,
    '        const canRecall = isAdmin || (isOwner && Date.now() - targetMsg.createdAt < 5 * 60 * 1000);\n        if (!canRecall) return;\n\n        // 1. Remove original message from store',
    `        const canRecall = isAdmin || (isOwner && Date.now() - targetMsg.createdAt < 5 * 60 * 1000);
        if (!canRecall) return;

        const archivedOriginal = await archiveRecalledMessage(ws.currentRoom, targetMsg, ws.user);
        clearPublicRecallReplies(roomMsgs, targetMsg.msgUid);

        // 1. Remove original message from store`,
    'local recall archive',
  );
  output = replaceOnce(
    output,
    "        // 5. If interconnect room, redact all associated Matrix events (text + attachments)",
    '        sendPrivateRecallMessage(ws.currentRoom, archivedOriginal);\n\n        // 5. If interconnect room, redact all associated Matrix events (text + attachments)',
    'local live owner delivery',
  );

  output = replaceOnce(
    output,
    '              const targetMsg = interconnectMsgs.splice(targetIdx, 1)[0];\n              mentionMailer.removeMessageFromPending(targetMsg.msgUid);\n              const senderKey = resolveLocalUserKey(ev.sender) || \'matrix:\' + ev.sender;\n              const senderName = matrixActivityName(ev.sender);',
    `              const targetMsg = interconnectMsgs[targetIdx];
              const senderKey = resolveLocalUserKey(ev.sender) || 'matrix:' + ev.sender;
              const senderName = matrixActivityName(ev.sender);
              let archivedOriginal = { ...targetMsg, isRedacted: true, recallArchiveIncomplete: true };
              try {
                archivedOriginal = await archiveRecalledMessage('interconnect', targetMsg, {
                  userKey: senderKey,
                  name: senderName
                });
              } catch (error) {
                console.error('[RecallArchive] Could not persist recalled Matrix message:', error?.message || 'unknown error');
              }
              interconnectMsgs.splice(targetIdx, 1);
              clearPublicRecallReplies(interconnectMsgs, targetMsg.msgUid);
              mentionMailer.removeMessageFromPending(targetMsg.msgUid);`,
    'Matrix redaction archive',
  );

  output = replaceOnce(
    output,
    '        const activity = await roomActivityRecord(ev, true);',
    `        if (ev.unsigned?.redacted_because && REDACTABLE_TIMELINE_TYPES.has(ev.type)) {
          const redactionEvent = ev.unsigned.redacted_because;
          const targetIdx = existing.findIndex((item) => matchMessageById(item, ev.event_id));
          if (targetIdx >= 0) {
            const targetMsg = existing[targetIdx];
            const senderKey = resolveLocalUserKey(redactionEvent.sender) || 'matrix:' + redactionEvent.sender;
            const senderName = matrixActivityName(redactionEvent.sender);
            try {
              await archiveRecalledMessage('interconnect', targetMsg, { userKey: senderKey, name: senderName });
            } catch (error) {
              console.error('[RecallArchive] Could not recover recalled Matrix history:', error?.message || 'unknown error');
            }
            existing.splice(targetIdx, 1);
            clearPublicRecallReplies(existing, targetMsg.msgUid);
            mentionMailer.removeMessageFromPending(targetMsg.msgUid);
            chatDb?.deleteMessage?.('interconnect', targetMsg.msgUid);
          }
        }
        const activity = await roomActivityRecord(ev, true);`,
    'Matrix history redaction recovery',
  );
  output = replaceOnce(
    output,
    '        if (activity) {\n          if (insertMatrixActivity(activity)) added++;\n          continue;\n        }',
    `        if (activity) {
          const inserted = insertMatrixActivity(activity);
          if (activity.recalledMsgUid) chatDb?.insertMessage?.({ ...activity, roomId: 'interconnect' });
          if (inserted) added++;
          continue;
        }`,
    'Matrix history recall notice persistence',
  );

  output = replaceOnce(
    output,
    '    for (const ev of (data.chunk || []).slice().reverse()) {\n      const notice = await roomActivityRecord(ev, true);\n      if (!notice || !insertMatrixActivity(notice)) continue;',
    `    for (const ev of (data.chunk || []).slice().reverse()) {
      if (ev.unsigned?.redacted_because && REDACTABLE_TIMELINE_TYPES.has(ev.type)) {
        const redactionEvent = ev.unsigned.redacted_because;
        const targetIdx = messagesStore.interconnect.findIndex((item) => matchMessageById(item, ev.event_id));
        const targetMsg = targetIdx >= 0
          ? messagesStore.interconnect[targetIdx]
          : chatDb?.getRecallCandidate?.('interconnect', ev.event_id);
        if (targetMsg) {
          const senderKey = resolveLocalUserKey(redactionEvent.sender) || 'matrix:' + redactionEvent.sender;
          const senderName = matrixActivityName(redactionEvent.sender);
          try {
            await archiveRecalledMessage('interconnect', targetMsg, { userKey: senderKey, name: senderName });
          } catch (error) {
            console.error('[RecallArchive] Could not recover recalled Matrix history:', error?.message || 'unknown error');
          }
          if (targetIdx >= 0) messagesStore.interconnect.splice(targetIdx, 1);
          clearPublicRecallReplies(messagesStore.interconnect, targetMsg.msgUid);
          mentionMailer.removeMessageFromPending(targetMsg.msgUid);
          chatDb?.deleteMessage?.('interconnect', targetMsg.msgUid);
        }
      }
      const notice = await roomActivityRecord(ev, true);
      if (!notice) continue;
      const inserted = insertMatrixActivity(notice);
      if (notice.recalledMsgUid) chatDb?.insertMessage?.({ ...notice, roomId: 'interconnect' });
      if (!inserted) continue;`,
    'Matrix recent redaction recovery',
  );

  output = replaceOnce(
    output,
    '  const redaction = ev.unsigned?.redacted_because;\n  if (!activity && history && REDACTABLE_TIMELINE_TYPES.has(ev.type) &&\n      redaction?.sender && redaction.event_id &&\n      !messagesStore.interconnect.some((item) =>\n        item.recalledMsgUid === ev.event_id || matchMessageById(item, ev.event_id)\n      )) {',
    `  const redaction = ev.unsigned?.redacted_because;
  let recalledMsgUid = '';
  if (!activity && history && REDACTABLE_TIMELINE_TYPES.has(ev.type) &&
      redaction?.sender && redaction.event_id &&
      !messagesStore.interconnect.some((item) =>
        item.recalledMsgUid === ev.event_id || item.msgUid === redaction.event_id || item.matrixEventId === redaction.event_id
      )) {`,
    'Matrix history recall notice deduplication',
  );
  output = replaceOnce(
    output,
    '    actorId = redaction.sender;\n    eventId = redaction.event_id;\n    const actor = matrixActivityName(actorId);',
    '    actorId = redaction.sender;\n    eventId = redaction.event_id;\n    recalledMsgUid = ev.event_id;\n    const actor = matrixActivityName(actorId);',
    'Matrix history recall target link',
  );
  output = replaceOnce(
    output,
    '    matrixEventId: eventId,\n    kind: \'system\',',
    '    matrixEventId: eventId,\n    ...(recalledMsgUid ? { recalledMsgUid } : {}),\n    kind: \'system\',',
    'Matrix history recall notice identifier',
  );

  output = replaceOnce(
    output,
    '        const msg = await parseMatrixEvent(ev);\n        if (msg) {\n          existing.push(msg);',
    '        const msg = await parseMatrixEvent(ev);\n        if (msg) {\n          scheduleRecallArchive(\'interconnect\', msg);\n          existing.push(msg);',
    'Matrix backfill media archive',
  );
  output = replaceOnce(
    output,
    "          if (msg) {\n            messagesStore.interconnect.push(msg);",
    "          if (msg) {\n            scheduleRecallArchive('interconnect', msg);\n            messagesStore.interconnect.push(msg);",
    'Matrix live media archive',
  );
  output = replaceOnce(
    output,
    "              broadcastToRoom('interconnect', {\n                type: 'chat:message',\n                roomId: 'interconnect',\n                message: noticeMsg\n              });",
    "              broadcastToRoom('interconnect', {\n                type: 'chat:message',\n                roomId: 'interconnect',\n                message: noticeMsg\n              });\n              sendPrivateRecallMessage('interconnect', archivedOriginal);",
    'Matrix live owner delivery',
  );

  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error('Usage: node patch-recall-archive.mjs <server.mjs> <patched-server.mjs>');
  const source = await readFile(inputPath, 'utf8');
  await writeFile(outputPath, patchGateway(source), 'utf8');
  process.stdout.write(`Recall archive gateway candidate written to ${outputPath}\n`);
}
