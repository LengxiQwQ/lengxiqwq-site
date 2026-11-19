// Deploy as src/matrix/restore-relay-names.mjs alongside the gateway patch.
// Only recover a missing suffix when the original event proves the same identity.
export function recoverRelayName(message, event) {
  const key = String(message?.userKey || '');
  const sender = key.replace(/^matrix:/, '').split('#')[0];
  const current = String(message?.name || '').trim();
  if (message?.kind !== 'user' || sender.toLowerCase() !== '@aiprate:matrix.rainzt.cn' ||
      event?.sender !== sender || !current || /[·•・]/u.test(current)) return '';
  const body = event?.content?.body;
  if (typeof body !== 'string') return '';
  const prefix = /^\[ID:([^\]\r\n]+)\];\[URL:[^\]\r\n]*\]/u.exec(body);
  const parts = prefix?.[1].trim().match(/^(.+?)\s*[·•・]\s*(.+)$/u);
  if (!parts || parts[1].trim() !== current || !parts[2].trim()) return '';
  return `${parts[1].trim()} · ${parts[2].trim()}`;
}

export async function restoreRelayNames({ messages, fetchEvent, save, broadcast }) {
  let restored = 0;
  // Fetch serially so a restart does not flood the Matrix server.
  for (const message of [...messages]) {
    if (message.kind !== 'user' || !String(message.userKey || '').toLowerCase().includes('@aiprate:matrix.rainzt.cn') ||
        !message.name || /[·•・]/u.test(message.name)) continue;
    const eventId = message.matrixEventId || (message.msgUid?.startsWith('$') ? message.msgUid : '');
    if (!eventId) continue;
    const originalName = message.name;
    let result;
    try { result = await fetchEvent(eventId); } catch { continue; }
    if (!result?.ok || !messages.includes(message) || message.name !== originalName) continue;
    const recovered = recoverRelayName(message, result.event);
    if (!recovered) continue;
    message.name = recovered;
    restored++;
    broadcast(message);
    for (const reply of messages) {
      if (reply.replyTo?.msgUid === message.msgUid && reply.replyTo.name === originalName) {
        reply.replyTo.name = recovered;
        broadcast(reply);
      }
    }
    save();
  }
  return restored;
}
