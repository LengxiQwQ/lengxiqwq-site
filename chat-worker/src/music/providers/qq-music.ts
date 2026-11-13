import type { MusicProvider, ResolvedStream, StandardTrack } from "../types.js";

const QQ_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	Referer: "https://y.qq.com/",
};

function buildAlbumCoverUrl(albumMid: string): string {
	if (!albumMid) return "";
	return `https://y.gtimg.cn/music/photo_new/T002R300x300M000${encodeURIComponent(albumMid)}.jpg`;
}

function decodeBase64Utf8(b64: string): string {
	const clean = b64.replace(/\s+/g, "");
	const binary = atob(clean);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new TextDecoder("utf-8").decode(bytes);
}

function decodeHtmlEntities(input: string): string {
	return input
		.replace(/&#(\d+);/g, (_m, dec) => {
			const code = Number.parseInt(dec, 10);
			return Number.isFinite(code) ? String.fromCharCode(code) : "";
		})
		.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
			const code = Number.parseInt(hex, 16);
			return Number.isFinite(code) ? String.fromCharCode(code) : "";
		})
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

export class QQMusicProvider implements MusicProvider {
	readonly id = "qq";
	readonly name = "在线曲库";

	constructor(private readonly cyapiKey?: string) {}

	async search(keyword: string, limit = 12): Promise<StandardTrack[]> {
		const trimmed = keyword.trim();
		if (!trimmed) return [];
		const safeLimit = Math.min(20, Math.max(1, limit));

		const primary = await this.searchViaClientSearch(trimmed, safeLimit);
		if (primary.length > 0) {
			return primary;
		}
		return this.searchViaSmartbox(trimmed, safeLimit);
	}

	private async searchViaClientSearch(
		keyword: string,
		limit: number,
	): Promise<StandardTrack[]> {
		try {
			const url = `https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?p=1&n=${limit}&w=${encodeURIComponent(keyword)}&format=json`;
			const resp = await fetch(url, {
				headers: QQ_HEADERS,
				signal: AbortSignal.timeout(6000),
			});

			if (!resp.ok) return [];
			const data = (await resp.json()) as {
				data?: {
					song?: {
						list?: Array<{
							songmid?: string;
							songname?: string;
							singer?: Array<{ name?: string }>;
							albummid?: string;
							albumname?: string;
							interval?: number;
						}>;
					};
				};
			};

			const list = data.data?.song?.list ?? [];
			const tracks: StandardTrack[] = [];
			for (const item of list) {
				const mid = (item.songmid || "").trim();
				const title = (item.songname || "").trim();
				if (!mid || !title) continue;
				const singers = Array.isArray(item.singer)
					? item.singer
							.map((s) => s.name?.trim())
							.filter(Boolean)
							.join(" / ")
					: "";
				const albumMid = (item.albummid || "").trim();
				const albumName = (item.albumname || "").trim();
				const durationSec =
					typeof item.interval === "number" &&
					Number.isFinite(item.interval) &&
					item.interval > 0
						? Math.round(item.interval)
						: 0;

				tracks.push({
					id: `qq:${mid}`,
					provider: this.id,
					sourceId: mid,
					title,
					artist: singers || "未知歌手",
					album: albumName || undefined,
					cover: buildAlbumCoverUrl(albumMid),
					durationSec,
				});
			}
			return tracks.slice(0, limit);
		} catch {
			return [];
		}
	}

	private async searchViaSmartbox(
		keyword: string,
		limit: number,
	): Promise<StandardTrack[]> {
		try {
			const url = `https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=${encodeURIComponent(keyword)}&format=json&inCharset=utf8&outCharset=utf-8`;
			const resp = await fetch(url, {
				headers: QQ_HEADERS,
				signal: AbortSignal.timeout(6000),
			});
			if (!resp.ok) return [];
			const data = (await resp.json()) as {
				data?: {
					song?: {
						itemlist?: Array<{
							mid?: string;
							name?: string;
							singer?: string;
						}>;
					};
				};
			};
			const items = data.data?.song?.itemlist ?? [];
			const tracks: StandardTrack[] = [];
			for (const item of items.slice(0, limit)) {
				const mid = (item.mid || "").trim();
				const title = (item.name || "").trim();
				if (!mid || !title) continue;
				tracks.push({
					id: `qq:${mid}`,
					provider: this.id,
					sourceId: mid,
					title,
					artist: (item.singer || "").trim() || "未知歌手",
					cover: "",
					durationSec: 0,
				});
			}
			return tracks;
		} catch {
			return [];
		}
	}

	async resolveStream(mid: string): Promise<ResolvedStream | null> {
		const cleanMid = mid.trim();
		if (!cleanMid) return null;

		// 1. CYAPI 320k MP3 primary channel
		if (this.cyapiKey) {
			try {
				const cyapiUrl = `https://cyapi.top/API/qq_music.php?apikey=${encodeURIComponent(this.cyapiKey)}&type=json&mid=${encodeURIComponent(cleanMid)}&quality=320`;
				const resp = await fetch(cyapiUrl, {
					headers: QQ_HEADERS,
					signal: AbortSignal.timeout(10000),
				});
				if (resp.ok) {
					const data = (await resp.json()) as {
						url?: unknown;
						pic?: unknown;
						cover?: unknown;
					};
					if (typeof data.url === "string" && data.url.startsWith("http")) {
						const cover =
							typeof data.cover === "string" && data.cover.startsWith("http")
								? data.cover
								: typeof data.pic === "string" && data.pic.startsWith("http")
									? data.pic
									: undefined;
						return {
							url: data.url,
							needsProxy: true,
							quality: "320k",
							ext: "mp3",
							cover,
							providerChannel: "cyapi",
						};
					}
				}
			} catch {
				// Fall through to VKeys backup channel
			}
		}

		// 2. VKeys 96k AAC backup channel
		try {
			const vkeysUrl = `https://api.vkeys.cn/music/tencent/song/link?mid=${encodeURIComponent(cleanMid)}&quality=3`;
			const resp = await fetch(vkeysUrl, {
				headers: QQ_HEADERS,
				signal: AbortSignal.timeout(6000),
			});
			if (resp.ok) {
				const data = (await resp.json()) as {
					code?: number;
					data?: {
						url?: unknown;
						cover?: unknown;
						interval?: unknown;
					};
				};
				const streamUrl = data.data?.url;
				if (typeof streamUrl === "string" && streamUrl.startsWith("http")) {
					const cover =
						typeof data.data?.cover === "string" &&
						data.data.cover.startsWith("http")
							? data.data.cover
							: undefined;
					const durationSec =
						typeof data.data?.interval === "number" &&
						Number.isFinite(data.data.interval) &&
						data.data.interval > 0
							? Math.round(data.data.interval)
							: undefined;
					return {
						url: streamUrl,
						needsProxy: true,
						quality: "96k",
						ext: "m4a",
						cover,
						durationSec,
						providerChannel: "vkeys",
					};
				}
			}
		} catch {
			// Both channels failed
		}

		return null;
	}

	async getLyric(mid: string): Promise<string | null> {
		const cleanMid = mid.trim();
		if (!cleanMid) return null;

		try {
			const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(cleanMid)}&format=json&nobase64=1`;
			const resp = await fetch(url, {
				headers: QQ_HEADERS,
				signal: AbortSignal.timeout(6000),
			});
			if (!resp.ok) return null;

			const rawText = await resp.text();
			const jsonText = rawText
				.trim()
				.replace(/^MusicJsonCallback\(/, "")
				.replace(/\);?$/, "");
			const data = JSON.parse(jsonText) as { lyric?: unknown };
			if (typeof data.lyric !== "string" || !data.lyric.trim()) {
				return null;
			}

			let lyricText = data.lyric.trim();
			if (!lyricText.includes("[") && /^[A-Za-z0-9+/=\r\n]+$/.test(lyricText)) {
				try {
					lyricText = decodeBase64Utf8(lyricText);
				} catch {
					// Keep original text if not valid base64
				}
			}

			return decodeHtmlEntities(lyricText);
		} catch {
			return null;
		}
	}
}
