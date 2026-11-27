import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchGateway } from '../scripts/patch-recall-archive.mjs';

test('gateway candidate patch adds private recall archive hooks to all required paths', () => {
  const source = [
    "import { createMatrixMediaHandler } from './src/matrix-media.mjs';",
    "const chatDb = new ChatDatabase(join(DATA_DIR, 'chat.db'));",
    "const MATRIX_ADMIN_TOKEN = 'fixture';",
    'async function roomActivityRecord(ev, history = false) {',
    '  let activity = null;',
    '  let actorId = ev.sender;',
    '  let eventId = ev.event_id;',
    '  const redaction = ev.unsigned?.redacted_because;',
    '  if (!activity && history && REDACTABLE_TIMELINE_TYPES.has(ev.type) &&',
    '      redaction?.sender && redaction.event_id &&',
    '      !messagesStore.interconnect.some((item) =>',
    '        item.recalledMsgUid === ev.event_id || matchMessageById(item, ev.event_id)',
    '      )) {',
    '    actorId = redaction.sender;',
    '    eventId = redaction.event_id;',
    '    const actor = matrixActivityName(actorId);',
    '  }',
    '  return {',
    '    matrixEventId: eventId,',
    "    kind: 'system',",
    '  };',
    '}',
    'async function recoverRecentMatrixActivity() {',
    '    for (const ev of (data.chunk || []).slice().reverse()) {',
    '      const notice = await roomActivityRecord(ev, true);',
    '      if (!notice || !insertMatrixActivity(notice)) continue;',
    '    }',
    '}',
    '        for (const ev of chrono) {',
    '          if (!ev?.event_id || !ev.sender) continue;',
    '        const activity = await roomActivityRecord(ev, true);',
    '        if (activity) {',
    '          if (insertMatrixActivity(activity)) added++;',
    '          continue;',
    '        }',
    "  if (url.pathname.startsWith('/api/media/')) {",
    '    await handleMatrixMedia(req, res, url.pathname);',
    '    messages: initialMessagesWithThreads,',
    '          messages: initSliceWithThreads,',
    '          messages: sliceWithThreads,',
    '        const canRecall = isAdmin || (isOwner && Date.now() - targetMsg.createdAt < 5 * 60 * 1000);',
    '        if (!canRecall) return;',
    '',
    '        // 1. Remove original message from store',
    '              const targetMsg = interconnectMsgs.splice(targetIdx, 1)[0];',
    '              mentionMailer.removeMessageFromPending(targetMsg.msgUid);',
    "              const senderKey = resolveLocalUserKey(ev.sender) || 'matrix:' + ev.sender;",
    '              const senderName = matrixActivityName(ev.sender);',
    "              broadcastToRoom('interconnect', {",
    "                type: 'chat:message',",
    "                roomId: 'interconnect',",
    '                message: noticeMsg',
    '              });',
    '        // 5. If interconnect room, redact all associated Matrix events (text + attachments)',
    '        const msg = await parseMatrixEvent(ev);',
    '        if (msg) {',
    '          existing.push(msg);',
    "          if (msg) {\n            messagesStore.interconnect.push(msg);",
  ].join('\n');

  const candidate = patchGateway(source);
  assert.match(candidate, /createMatrixRecallArchive/);
  assert.match(candidate, /CHAT_RECALL_ARCHIVE_OWNER_KEY/);
  assert.match(candidate, /privateRecallMessagesFor\(ws\.user, roomId, initialMessages\)/);
  assert.match(candidate, /archiveRecalledMessage\(ws\.currentRoom, targetMsg, ws\.user\)/);
  assert.match(candidate, /sendPrivateRecallMessage\('interconnect', archivedOriginal\)/);
  assert.match(candidate, /\/api\/chat\/recall-media\//);
  assert.match(candidate, /archiveMessage\(original, `\$\{roomId\}:\$\{message\.msgUid\}`\)/);
  assert.match(candidate, /recalledMsgUid = ev\.event_id;/);
  assert.match(candidate, /item\.matrixEventId === redaction\.event_id/);
  assert.match(candidate, /Could not recover recalled Matrix history/);
  assert.match(candidate, /if \(activity\.recalledMsgUid\) chatDb\?\.insertMessage/);
  assert.match(candidate, /existing\.findIndex\(\(item\) => matchMessageById\(item, ev\.event_id\)\)/);
  assert.match(candidate, /getRecallCandidate\?\.\('interconnect', ev\.event_id\)/);
  const redactionStart = candidate.indexOf('const targetMsg = interconnectMsgs[targetIdx];');
  const redactionEnd = candidate.indexOf('interconnectMsgs.splice(targetIdx, 1);', redactionStart);
  assert.ok(redactionStart >= 0 && redactionEnd > redactionStart);
  const senderKeyAt = candidate.indexOf('const senderKey =', redactionStart);
  const archiveAt = candidate.indexOf('archiveRecalledMessage(', redactionStart);
  assert.ok(senderKeyAt >= redactionStart && archiveAt > senderKeyAt && archiveAt < redactionEnd);
  const helperStart = candidate.indexOf('const recallArchiveOwnerKey =');
  const helperEnd = candidate.indexOf('\n\nfunction privateRecallMessagesFor', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.doesNotThrow(() => new Function(candidate.slice(helperStart, helperEnd)));
});
