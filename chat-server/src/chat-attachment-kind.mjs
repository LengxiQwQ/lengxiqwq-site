const matrixAttachmentKinds = new Map([
  ['m.image', 'image'],
  ['m.video', 'video'],
  ['m.audio', 'audio'],
  ['m.file', 'file'],
]);

function fields(attachmentKind) {
  return {
    attachmentKind,
    hasImage: attachmentKind === 'image' || attachmentKind === 'sticker',
  };
}

export function replyAttachmentFields(attachments) {
  const kinds = new Set((attachments || []).map(item => item.isSticker ? 'sticker' : item.type));
  return fields(kinds.size > 1 ? 'attachment' : (kinds.values().next().value ?? null));
}

export function matrixReplyAttachmentFields(event) {
  return fields(event.type === 'm.sticker' ? 'sticker' : (matrixAttachmentKinds.get(event.content?.msgtype) ?? null));
}

export function historicalReplyAttachmentFields(reply, target) {
  if (target) return replyAttachmentFields(target.attachments);
  if (Object.hasOwn(reply, 'attachmentKind')) return fields(reply.attachmentKind);
  return fields(reply.hasImage ? 'attachment' : null);
}
