const MAX_IMAGE_EDGE = 100_000;
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\((?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\)/g;

export function imageDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width <= 0 || height <= 0 || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    return {};
  }
  return { width, height };
}

export function withHistoryImageDimensions(message, dimensionsByUrl) {
  const inlineImageDimensions = Object.create(null);
  const lookup = (url) => {
    if (!Object.hasOwn(dimensionsByUrl, url)) return {};
    const dimensions = dimensionsByUrl[url];
    return imageDimensions(dimensions?.width, dimensions?.height);
  };
  let changed = false;
  const attachments = message.attachments?.map((attachment) => {
    if (attachment.type !== 'image' || attachment.isSticker) return attachment;
    const stored = imageDimensions(attachment.width, attachment.height);
    const dimensions = stored.width ? stored : lookup(attachment.url);
    if (!dimensions.width) return attachment;
    if (message.content?.includes(attachment.url)) {
      inlineImageDimensions[attachment.url] = dimensions;
    }
    if (stored.width) return attachment;
    changed = true;
    return { ...attachment, ...dimensions };
  });
  for (const match of (message.content || '').matchAll(MARKDOWN_IMAGE)) {
    const url = match[1] || match[2];
    if (Object.hasOwn(inlineImageDimensions, url)) continue;
    const dimensions = lookup(url);
    if (dimensions.width) inlineImageDimensions[url] = dimensions;
  }
  if (Object.keys(inlineImageDimensions).length) {
    return { ...message, attachments, inlineImageDimensions };
  }
  return changed ? { ...message, attachments } : message;
}
