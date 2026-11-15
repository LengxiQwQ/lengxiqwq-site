import { isAllowedStreamTarget } from './audio-source.mjs';
import { createHmac, timingSafeEqual } from 'node:crypto';

const STREAM_TTL_SEC = 60 * 60 * 4; // 4 hours

function toBase64Url(str) {
  return Buffer.from(str).toString('base64url');
}

function fromBase64Url(b64url) {
  return Buffer.from(b64url, 'base64url').toString('utf8');
}

export function signStreamProxyUrl(
  origin,
  targetUrl,
  secret,
  referer = 'https://y.qq.com/',
  mimeType = 'audio/mpeg'
) {
  const exp = Math.floor(Date.now() / 1000) + STREAM_TTL_SEC;
  const payload = JSON.stringify({
    u: targetUrl,
    r: referer,
    m: mimeType,
    exp
  });
  const encodedPayload = toBase64Url(payload);
  const sig = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  const base = origin.replace(/\/+$/, '');
  return `${base}/api/music/stream?token=${encodeURIComponent(`${encodedPayload}.${sig}`)}`;
}

export function verifyStreamProxyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSig] = parts;
  if (!encodedPayload || !encodedSig) return null;

  try {
    const expectedSig = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
    if (encodedSig.length !== expectedSig.length ||
        Buffer.byteLength(encodedSig) !== expectedSig.length ||
        !timingSafeEqual(Buffer.from(encodedSig), Buffer.from(expectedSig))) return null;

    const payloadText = fromBase64Url(encodedPayload);
    const parsed = JSON.parse(payloadText);
    if (
      typeof parsed.u !== 'string' ||
      typeof parsed.exp !== 'number' ||
      parsed.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    if (!isAllowedStreamTarget(parsed.u)) {
      return null;
    }
    return {
      url: parsed.u,
      referer: typeof parsed.r === 'string' ? parsed.r : 'https://y.qq.com/',
      mimeType: typeof parsed.m === 'string' ? parsed.m : 'audio/mpeg'
    };
  } catch {
    return null;
  }
}
