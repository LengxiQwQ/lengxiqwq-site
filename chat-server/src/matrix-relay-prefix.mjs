const relayPrefix = /^\[ID:(?<name>[^\]\r\n]+)\];\[URL:(?:\[(?:\\[^\r\n]|[^\]\\\r\n])*\]\((?<markdownAvatar>(?:\\[^\r\n]|[^\\\r\n])*?)\)|(?<plainAvatar>[^[\]\r\n]*))\](?:;\[KEY:(?<userKey>[^\]\r\n]+)\])?(?:;\[SITE:(?<site>[^\]\r\n]+)\])?(?:\r?\n)?(?<content>[\s\S]*)$/;

function normalizeAvatar(value) {
  const avatar = value.trim()
    .replace(/^<([^<>]+)>$/, '$1')
    .replace(/\\([!-/:-@[-\x60{-~])/g, '$1')
    .replace(/&amp;/gi, '&');
  if (/\s/.test(avatar)) return '';
  if (avatar.startsWith('/') && !avatar.startsWith('//')) return avatar;
  try {
    const url = new URL(avatar);
    return ['http:', 'https:', 'mxc:'].includes(url.protocol) ? avatar : '';
  } catch {
    return '';
  }
}

export function parseMatrixRelayPrefix(body) {
  if (typeof body !== 'string' || !body.startsWith('[ID:')) return null;
  const match = relayPrefix.exec(body);
  if (!match) return null;
  const { markdownAvatar, plainAvatar, ...fields } = match.groups;
  return {
    ...fields,
    avatar: normalizeAvatar(markdownAvatar ?? plainAvatar),
    header: body.slice(0, body.length - fields.content.length).trimEnd()
  };
}
