const STREAM_TTL_SEC = 60 * 60 * 4; // 4 hours

function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let bin = "";
	for (const b of arr) {
		bin += String.fromCharCode(b);
	}
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(str: string): Uint8Array {
	const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
	const padLen = (4 - (normalized.length % 4)) % 4;
	const padded = normalized + "=".repeat(padLen);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i += 1) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

export function isAllowedStreamTarget(rawUrl: string): boolean {
	try {
		const parsed = new URL(rawUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return false;
		}
		const host = parsed.hostname.toLowerCase();
		if (
			host === "localhost" ||
			host === "127.0.0.1" ||
			host === "::1" ||
			host.endsWith(".local") ||
			host.endsWith(".internal") ||
			/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
		) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function signStreamProxyUrl(
	origin: string,
	targetUrl: string,
	secret: string,
	referer = "https://y.qq.com/",
	mimeType = "audio/mpeg",
): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + STREAM_TTL_SEC;
	const payload = JSON.stringify({
		u: targetUrl,
		r: referer,
		m: mimeType,
		exp,
	});
	const encodedPayload = toBase64Url(new TextEncoder().encode(payload));
	const key = await importHmacKey(secret);
	const sig = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(encodedPayload),
	);
	const encodedSig = toBase64Url(sig);
	const base = origin.replace(/\/+$/, "");
	return `${base}/api/music/stream?token=${encodeURIComponent(`${encodedPayload}.${encodedSig}`)}`;
}

export async function verifyStreamProxyToken(
	token: string,
	secret: string,
): Promise<{ url: string; referer: string; mimeType: string } | null> {
	const parts = token.split(".");
	if (parts.length !== 2) return null;
	const [encodedPayload, encodedSig] = parts;
	if (!encodedPayload || !encodedSig) return null;

	try {
		const key = await importHmacKey(secret);
		const sigBytes = fromBase64Url(encodedSig);
		const valid = await crypto.subtle.verify(
			"HMAC",
			key,
			sigBytes,
			new TextEncoder().encode(encodedPayload),
		);
		if (!valid) return null;

		const payloadText = new TextDecoder().decode(fromBase64Url(encodedPayload));
		const parsed = JSON.parse(payloadText) as {
			u?: unknown;
			r?: unknown;
			m?: unknown;
			exp?: unknown;
		};
		if (
			typeof parsed.u !== "string" ||
			typeof parsed.exp !== "number" ||
			parsed.exp < Math.floor(Date.now() / 1000)
		) {
			return null;
		}
		if (!isAllowedStreamTarget(parsed.u)) {
			return null;
		}
		return {
			url: parsed.u,
			referer: typeof parsed.r === "string" ? parsed.r : "https://y.qq.com/",
			mimeType: typeof parsed.m === "string" ? parsed.m : "audio/mpeg",
		};
	} catch {
		return null;
	}
}
