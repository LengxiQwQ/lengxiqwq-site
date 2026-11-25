import { siteConfig } from "@/config/siteConfig";

export type ShareThumbPreset =
	| "article-sm"
	| "square-sm"
	| "card-avatar"
	| "card-cover";

const PRESET_SPECS: Record<
	ShareThumbPreset,
	{ width: number; height: number; quality: number }
> = {
	"article-sm": { width: 160, height: 100, quality: 55 },
	"square-sm": { width: 96, height: 96, quality: 55 },
	"card-avatar": { width: 112, height: 112, quality: 60 },
	"card-cover": { width: 520, height: 260, quality: 68 },
};

let cachedShareThumbs: Record<string, string> | null = null;
let inflightShareThumbs: Promise<Record<string, string>> | null = null;

function isLocalHostname(hostname: string): boolean {
	const h = hostname.toLowerCase();
	return (
		h === "localhost" ||
		h === "127.0.0.1" ||
		h === "0.0.0.0" ||
		h === "::1" ||
		h === "[::1]" ||
		h.endsWith(".local") ||
		/^192\.168\./.test(h) ||
		/^10\./.test(h) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(h)
	);
}

export function getCachedShareThumbs(): Record<string, string> {
	return cachedShareThumbs ?? {};
}

export async function fetchShareThumbsCached(
	force = false,
): Promise<Record<string, string>> {
	if (cachedShareThumbs && !force) return cachedShareThumbs;
	if (inflightShareThumbs && !force) return inflightShareThumbs;
	const task = (async () => {
		try {
			const resp = await fetch("/api/chat-share-thumbs.json");
			if (!resp.ok) return cachedShareThumbs ?? {};
			const json = (await resp.json()) as unknown;
			if (json && typeof json === "object" && !Array.isArray(json)) {
				const map: Record<string, string> = {};
				for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
					if (typeof v === "string" && v.startsWith("data:image/")) {
						map[k] = v;
					}
				}
				cachedShareThumbs = map;
				return map;
			}
		} catch {
			// 缩略图索引读取失败时自动回退到远程或原始 URL
		}
		return cachedShareThumbs ?? {};
	})().finally(() => {
		if (inflightShareThumbs === task) inflightShareThumbs = null;
	});
	inflightShareThumbs = task;
	return task;
}

export function resolveShareThumbUrl(
	rawUrl: string,
	preset: ShareThumbPreset,
	localThumbs: Record<string, string> = getCachedShareThumbs(),
): string {
	const trimmed = (rawUrl || "").trim();
	if (!trimmed) return "";

	if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) {
		return trimmed;
	}

	const precomputed = localThumbs[trimmed];
	if (precomputed && preset !== "card-cover") {
		return precomputed;
	}

	const lowerPath = trimmed.split(/[?#]/)[0].toLowerCase();
	if (lowerPath.endsWith(".svg")) {
		return trimmed;
	}

	if (trimmed.includes("wsrv.nl/") || trimmed.includes("images.weserv.nl/")) {
		return trimmed;
	}

	let absUrl = trimmed;
	if (trimmed.startsWith("/")) {
		if (trimmed.startsWith("//")) {
			absUrl = `https:${trimmed}`;
		} else if (typeof window !== "undefined") {
			if (isLocalHostname(window.location.hostname)) {
				return precomputed || trimmed;
			}
			absUrl = `${window.location.origin}${trimmed}`;
		} else {
			const configuredOrigin = (siteConfig.site_url || "https://lengxiqwq.com")
				.trim()
				.replace(/\/+$/, "");
			absUrl = `${configuredOrigin}${trimmed}`;
		}
	}

	try {
		const parsed = new URL(absUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return precomputed || trimmed;
		}
		if (isLocalHostname(parsed.hostname)) {
			return precomputed || trimmed;
		}
		const spec = PRESET_SPECS[preset];
		const isGif = parsed.pathname.toLowerCase().endsWith(".gif");
		const params = new URLSearchParams({
			url: parsed.href,
			w: String(spec.width),
			h: String(spec.height),
			fit: "cover",
			output: "webp",
			q: String(spec.quality),
		});
		if (isGif) {
			params.set("n", "-1");
		}
		return `https://wsrv.nl/?${params.toString()}`;
	} catch {
		return precomputed || trimmed;
	}
}
