export const LX_ARTICLE_SHARE_TAG = "[LX:文章分享]";
export const LX_MOMENT_SHARE_TAG = "[LX:动态分享]";
export const LX_FRIEND_SHARE_TAG = "[LX:友链分享]";
export const LX_MUSIC_SHARE_TAG = "[LX:音乐分享]";

export interface ChatArticleShareData {
	kind: "article";
	title: string;
	description: string;
	url: string;
	cover?: string;
	host: string;
}

export interface ChatMomentShareData {
	kind: "moment";
	date: string;
	content: string;
	url: string;
	cover?: string;
	host: string;
}

export interface ChatFriendShareData {
	kind: "friend";
	name: string;
	description: string;
	url: string;
	avatar?: string;
	host: string;
}

export interface ChatMusicShareData {
	kind: "music";
	id: string;
	provider?: string;
	sourceId?: string;
	sourcePlatform?: string;
	title: string;
	artist: string;
	album?: string;
	cover?: string;
	url: string;
	sourceUrl?: string;
	sharedAudioUrl?: string;
	sharedExpiresAt?: number;
	durationSec?: number;
	host: string;
}

export type ChatShareData =
	| ChatArticleShareData
	| ChatMomentShareData
	| ChatFriendShareData
	| ChatMusicShareData;

export function parseLxShareCard(raw: string): ChatShareData | null {
	return (
		parseLxArticleShare(raw) ??
		parseLxMomentShare(raw) ??
		parseLxFriendShare(raw) ??
		parseLxMusicShare(raw)
	);
}

export function extractHostname(rawUrl: string): string {
	try {
		const u = new URL(
			rawUrl,
			typeof window !== "undefined"
				? window.location.origin
				: "https://lengxiqwq.com",
		);
		return u.hostname || "";
	} catch {
		return "";
	}
}

/**
 * 清洗封面链接：
 * 支持从类似 "https://example.com/cover.webp ![alt](https://...)" 中提取有效图片 URL
 */
export function cleanShareCoverUrl(raw: string): string {
	const trimmed = (raw || "").trim();
	if (!trimmed) return "";

	// 优先匹配 Markdown 嵌入图片语法 ![alt](src)
	const mdMatch = trimmed.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/i);
	if (mdMatch) return mdMatch[1].trim();

	// 匹配首个 http/https URL
	const urlMatch = trimmed.match(/https?:\/\/[^\s]+/i);
	if (urlMatch) return urlMatch[0].trim();

	// 本地站内相对路径 /assets/...
	if (trimmed.startsWith("/")) return trimmed;

	return "";
}

/**
 * 解析引用的统一逻辑
 */
function parseLxQuotedLines(raw: string, tag: string): string[] | null {
	const text = String(raw || "")
		.replace(/^\uFEFF/, "")
		.trim();
	if (!text) return null;

	const lines = text.split(/\r?\n/);
	if (String(lines[0] || "").trim() !== tag) return null;

	const quotes: string[] = [];
	for (let i = 1; i < lines.length; i += 1) {
		const line = String(lines[i] || "");
		if (!line.trim()) continue;
		const m = line.match(/^>\s?(.*)$/);
		if (!m) break;
		quotes.push(String(m[1] || "").trim());
	}

	return quotes;
}

/**
 * 解析 [LX:文章分享]
 * 结构：
 * > 标题
 * > 简介
 * > 链接
 * > 封面（可选）
 */
export function parseLxArticleShare(raw: string): ChatArticleShareData | null {
	const quotes = parseLxQuotedLines(raw, LX_ARTICLE_SHARE_TAG);
	if (!quotes || quotes.length < 3) return null;

	const title = quotes[0] || "未命名文章";
	const description = quotes[1] || "";
	const rawUrl = quotes[2] || "";
	if (
		!rawUrl ||
		(!rawUrl.startsWith("http://") &&
			!rawUrl.startsWith("https://") &&
			!rawUrl.startsWith("/"))
	) {
		return null;
	}

	const cover = quotes[3] ? cleanShareCoverUrl(quotes[3]) : undefined;
	const host = extractHostname(rawUrl);

	return {
		kind: "article",
		title,
		description,
		url: rawUrl,
		cover,
		host,
	};
}

/**
 * 解析 [LX:动态分享]
 * 结构：
 * > 日期
 * > 正文
 * > 链接
 * > 配图（可选）
 */
export function parseLxMomentShare(raw: string): ChatMomentShareData | null {
	const quotes = parseLxQuotedLines(raw, LX_MOMENT_SHARE_TAG);
	if (!quotes || quotes.length < 3) return null;

	const date = quotes[0] || "未知日期";
	const content = quotes[1] || "";
	const rawUrl = quotes[2] || "";
	if (
		!rawUrl ||
		(!rawUrl.startsWith("http://") &&
			!rawUrl.startsWith("https://") &&
			!rawUrl.startsWith("/"))
	) {
		return null;
	}

	const cover = quotes[3] ? cleanShareCoverUrl(quotes[3]) : undefined;
	const host = extractHostname(rawUrl);

	return {
		kind: "moment",
		date,
		content,
		url: rawUrl,
		cover,
		host,
	};
}

function isHttpOrRootPath(raw: string): boolean {
	return (
		raw.startsWith("http://") ||
		raw.startsWith("https://") ||
		raw.startsWith("/")
	);
}

/**
 * 解析 [LX:友链分享]
 * 优先从末尾隐藏注释 <!--lx-friend:...--> 读取完整结构化字段（含 desc、avatar）；
 * 兼容 3 行引用（> 名称 / > 链接 / > 头像）与 4 行引用（> 名称 / > 简介 / > 链接 / > 头像）。
 */
export function parseLxFriendShare(raw: string): ChatFriendShareData | null {
	const text = String(raw || "")
		.replace(/^\uFEFF/, "")
		.trim();
	if (!text) return null;

	const lines = text.split(/\r?\n/);
	if (String(lines[0] || "").trim() !== LX_FRIEND_SHARE_TAG) return null;

	const commentMatch = text.match(/<!--\s*lx-friend:([A-Za-z0-9_-]+)\s*-->/);
	if (commentMatch?.[1]) {
		try {
			const parsed = JSON.parse(decodeBase64UrlUtf8(commentMatch[1])) as Record<
				string,
				unknown
			>;
			const url =
				typeof parsed.url === "string" ? parsed.url.trim() : "";
			if (url && isHttpOrRootPath(url)) {
				const name =
					typeof parsed.name === "string" && parsed.name.trim()
						? parsed.name.trim()
						: extractHostname(url) || "友链分享";
				const description =
					typeof parsed.desc === "string"
						? parsed.desc.trim()
						: typeof parsed.description === "string"
							? parsed.description.trim()
							: "";
				const avatarRaw =
					typeof parsed.avatar === "string" ? parsed.avatar.trim() : "";
				const avatar = avatarRaw
					? cleanShareCoverUrl(avatarRaw) || undefined
					: undefined;
				return {
					kind: "friend",
					name,
					description,
					url,
					avatar,
					host: extractHostname(url),
				};
			}
		} catch {
			// Fall back to quoted lines
		}
	}

	const quotes = parseLxQuotedLines(raw, LX_FRIEND_SHARE_TAG);
	if (!quotes || quotes.length < 2) return null;

	const name = quotes[0] || "友链分享";
	let description = "";
	let rawUrl = "";
	let avatar: string | undefined;

	if (isHttpOrRootPath(quotes[1] || "")) {
		rawUrl = quotes[1];
		avatar = quotes[2] ? cleanShareCoverUrl(quotes[2]) || undefined : undefined;
	} else if (quotes.length >= 3 && isHttpOrRootPath(quotes[2] || "")) {
		description = quotes[1] || "";
		rawUrl = quotes[2];
		avatar = quotes[3] ? cleanShareCoverUrl(quotes[3]) || undefined : undefined;
	} else {
		return null;
	}

	return {
		kind: "friend",
		name,
		description,
		url: rawUrl,
		avatar,
		host: extractHostname(rawUrl),
	};
}

/**
 * 组装 [LX:友链分享] 文本
 */
export function formatLxFriendShare(data: {
	name: string;
	description?: string;
	url: string;
	avatar?: string;
}): string {
	const name = (data.name || "").trim() || "友链分享";
	const description = (data.description || "").trim();
	const url = (data.url || "").trim();
	const avatar = (data.avatar || "").trim();

	const lines = [LX_FRIEND_SHARE_TAG, `> ${name}`, `> ${url}`];
	if (avatar) {
		lines.push(`> ${avatar}`);
	}
	if (description) {
		const encoded = encodeBase64UrlUtf8(
			JSON.stringify({ name, desc: description, url, ...(avatar ? { avatar } : {}) }),
		);
		lines.push(`<!--lx-friend:${encoded}-->`);
	}
	return lines.join("\n");
}

/**
 * 组装 [LX:文章分享] 文本
 */
export function formatLxArticleShare(data: {
	title: string;
	description?: string;
	url: string;
	cover?: string;
}): string {
	const title = (data.title || "").trim() || "未命名文章";
	const description = (data.description || "").trim() || "暂无简介";
	const url = (data.url || "").trim();
	const cover = (data.cover || "").trim();

	const lines = [
		LX_ARTICLE_SHARE_TAG,
		`> ${title}`,
		`> ${description}`,
		`> ${url}`,
	];
	if (cover) {
		lines.push(`> ${cover}`);
	}
	return lines.join("\n");
}

/**
 * 组装 [LX:动态分享] 文本
 */
export function formatLxMomentShare(data: {
	date: string;
	content?: string;
	url: string;
	cover?: string;
}): string {
	const date = (data.date || "").trim() || "未知日期";
	const content =
		(data.content || "").replace(/\s+/g, " ").trim().slice(0, 280) ||
		"暂无内容";
	const url = (data.url || "").trim();
	const cover = (data.cover || "").trim();

	const lines = [LX_MOMENT_SHARE_TAG, `> ${date}`, `> ${content}`, `> ${url}`];
	if (cover) {
		lines.push(`> ${cover}`);
	}
	return lines.join("\n");
}

function encodeBase64UrlUtf8(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 1) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64UrlUtf8(encoded: string): string {
	const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new TextDecoder().decode(bytes);
}

export function inferMusicSourcePageUrl(data: {
	sourceTrackId?: string;
	url?: string;
	sourceUrl?: string;
	provider?: string;
	sourcePlatform?: string;
	sourceId?: string;
	id?: string;
}): string {
	const direct = (data.sourceUrl || data.url || "").trim();
	if (/^https?:\/\//i.test(direct) && !direct.includes("/api/music/stream")) {
		return direct;
	}
	const platform = (data.sourcePlatform || data.provider || "").toLowerCase();
	const rawId = (data.sourceTrackId || data.sourceId || data.id || "").replace(/^[a-z_]+:/i, "").trim();
	if (!rawId) return "";
	if (platform === "qq" || platform === "qqmusic" || platform === "tencent") {
		return `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(rawId)}`;
	}
	if (platform === "netease" || platform === "ncm") {
		return `https://music.163.com/#/song?id=${encodeURIComponent(rawId)}`;
	}
	if (platform === "applemusic" && /^\d+$/.test(rawId)) return "https://music.apple.com/song/" + rawId;
	if (platform === "spotify" && /^[a-zA-Z0-9]+$/.test(rawId)) return "https://open.spotify.com/track/" + rawId;
	if (platform === "youtube" || platform === "yt") {
		return `https://www.youtube.com/watch?v=${encodeURIComponent(rawId)}`;
	}
	return "";
}

function formatMusicPlatformName(platform?: string): string {
	const p = (platform || "").toLowerCase();
	if (p === "qq" || p === "tencent") return "QQ音乐";
	if (p === "netease" || p === "ncm") return "网易云音乐";
	if (p === "kugou") return "酷狗音乐";
	if (p === "youtube" || p === "yt") return "YouTube";
	return p || "点歌台";
}

/**
 * 解析 [LX:音乐分享]
 * 优先从末尾隐藏注释 <!--lx-music:...--> 读取完整结构化元数据；
 * 若注释在极端转发链路中被清洗，自动降级从上方 Markdown 引用行提取歌名/歌手/链接/封面。
 */
export function parseLxMusicShare(raw: string): ChatMusicShareData | null {
	const text = String(raw || "")
		.replace(/^\uFEFF/, "")
		.trim();
	if (!text) return null;

	const lines = text.split(/\r?\n/);
	if (String(lines[0] || "").trim() !== LX_MUSIC_SHARE_TAG) return null;

	// 1. 尝试解析隐藏注释中的 Base64URL JSON
	const commentMatch = text.match(/<!--\s*lx-music:([A-Za-z0-9_-]+)\s*-->/);
	if (commentMatch?.[1]) {
		try {
			const parsed = JSON.parse(decodeBase64UrlUtf8(commentMatch[1])) as Record<
				string,
				unknown
			>;
			const title =
				typeof parsed.title === "string" && parsed.title.trim()
					? parsed.title.trim()
					: "";
			if (title) {
				const sharedAudioUrl =
					typeof parsed.sharedAudioUrl === "string" &&
					/^https?:\/\//i.test(parsed.sharedAudioUrl.trim())
						? parsed.sharedAudioUrl.trim()
						: undefined;
				const sourceUrl =
					typeof parsed.sourceUrl === "string" &&
					/^https?:\/\//i.test(parsed.sourceUrl.trim())
						? parsed.sourceUrl.trim()
						: undefined;
				const primaryUrl = sharedAudioUrl || sourceUrl || "";
				const cover =
					typeof parsed.cover === "string"
						? cleanShareCoverUrl(parsed.cover) || undefined
						: undefined;
				return {
					kind: "music",
					id:
						typeof parsed.id === "string" && parsed.id.trim()
							? parsed.id.trim()
							: title,
					provider:
						typeof parsed.provider === "string"
							? parsed.provider.trim()
							: undefined,
					sourceId:
						typeof parsed.sourceId === "string"
							? parsed.sourceId.trim()
							: undefined,
					sourcePlatform:
						typeof parsed.sourcePlatform === "string"
							? parsed.sourcePlatform.trim()
							: undefined,
					title,
					artist:
						typeof parsed.artist === "string" && parsed.artist.trim()
							? parsed.artist.trim()
							: "未知歌手",
					album:
						typeof parsed.album === "string" && parsed.album.trim()
							? parsed.album.trim()
							: undefined,
					cover,
					url: primaryUrl,
					sourceUrl,
					sharedAudioUrl,
					sharedExpiresAt:
						typeof parsed.sharedExpiresAt === "number"
							? parsed.sharedExpiresAt
							: undefined,
					durationSec:
						typeof parsed.durationSec === "number" && parsed.durationSec > 0
							? parsed.durationSec
							: undefined,
					host: primaryUrl ? extractHostname(primaryUrl) : "",
				};
			}
		} catch {
			// Fall back to parsing quoted Markdown lines
		}
	}

	// 2. 容错降级：从引用块中解析
	const quotes = parseLxQuotedLines(raw, LX_MUSIC_SHARE_TAG);
	if (!quotes || quotes.length < 1) return null;

	const headerLine = quotes[0].replace(/^🎵\s*/, "").trim();
	const splitIdx = headerLine.lastIndexOf(" - ");
	const title =
		splitIdx > 0 ? headerLine.slice(0, splitIdx).trim() : headerLine || "未命名歌曲";
	const artist =
		splitIdx > 0 ? headerLine.slice(splitIdx + 3).trim() || "未知歌手" : "未知歌手";

	let album: string | undefined;
	let url = "";
	let cover: string | undefined;

	for (let i = 1; i < quotes.length; i += 1) {
		const line = quotes[i];
		if (!cover && /!\[.*?\]\((https?:\/\/[^\s)]+)\)/i.test(line)) {
			cover = cleanShareCoverUrl(line) || undefined;
			continue;
		}
		const urlMatch = line.match(/https?:\/\/[^\s)]+/i);
		if (!url && urlMatch) {
			url = urlMatch[0].trim();
			continue;
		}
		if (!album) {
			album = line.replace(/^💽\s*/, "").trim() || undefined;
		}
	}

	const isSharedAudio = url.includes("/api/music/shared/");

	return {
		kind: "music",
		id: title,
		title,
		artist,
		album,
		cover,
		url,
		sourceUrl: isSharedAudio ? undefined : url || undefined,
		sharedAudioUrl: isSharedAudio ? url : undefined,
		host: url ? extractHostname(url) : "",
	};
}

/**
 * 组装 [LX:音乐分享] Markdown 文本 + 隐形元数据注释
 */
export function formatLxMusicShare(data: {
	id?: string;
	provider?: string;
	sourceId?: string;
	sourcePlatform?: string;
	title: string;
	artist?: string;
	album?: string;
	cover?: string;
	url?: string;
	sourceUrl?: string;
	sharedAudioUrl?: string;
	sharedExpiresAt?: number;
	durationSec?: number;
}): string {
	const title = (data.title || "").trim() || "未命名歌曲";
	const artist = (data.artist || "").trim() || "未知歌手";
	const album = (data.album || "").trim();
	const cover = (data.cover || "").trim();
	const sharedAudioUrl = (data.sharedAudioUrl || "").trim();
	const sourceUrl = inferMusicSourcePageUrl(data);
	const displayUrl = sharedAudioUrl || sourceUrl;
	const platformText = formatMusicPlatformName(
		data.provider || data.sourcePlatform,
	);

	const metaParts = [];
	if (album) metaParts.push(album);
	if (platformText) metaParts.push(platformText);
	const metaLine = metaParts.join(" · ") || "点歌台分享";

	const lines = [
		LX_MUSIC_SHARE_TAG,
		`> 🎵 ${title} - ${artist}`,
		`> 💽 ${metaLine}`,
	];
	if (displayUrl) {
		lines.push(`> 🔗 ${displayUrl}`);
	}
	if (cover) {
		lines.push(`> ![封面](${cover})`);
	}

	const payload: Record<string, unknown> = {
		id: data.id || "",
		provider: data.provider || "",
		sourceId: data.sourceId || "",
		sourcePlatform: data.sourcePlatform || data.provider || "",
		title,
		artist,
		album,
		cover,
		sourceUrl,
		sharedAudioUrl,
		sharedExpiresAt: data.sharedExpiresAt || 0,
		durationSec: data.durationSec || 0,
	};
	// Remove empty values to keep comment compact
	for (const key of Object.keys(payload)) {
		if (!payload[key]) delete payload[key];
	}

	const encoded = encodeBase64UrlUtf8(JSON.stringify(payload));
	lines.push(`<!--lx-music:${encoded}-->`);
	return lines.join("\n");
}

/**
 * 调用 VPS /api/music/share 将音频缓存 7 天并生成完整分享 Markdown 消息
 */
export async function buildMusicSharePayload(params: {
	chatServerUrl: string;
	auth?: { kind: "guest" | "waline"; token: string };
	track: {
		id?: string;
		provider?: string;
		sourceId?: string;
		sourcePlatform?: string;
		title: string;
		artist?: string;
		album?: string;
		cover?: string;
		url?: string;
		durationSec?: number;
	};
}): Promise<string> {
	const { chatServerUrl, auth, track } = params;
	const base = chatServerUrl.replace(/\/+$/, "");
	if (!base || !auth?.token?.trim()) throw new Error("请重新连接聊天室后再分享");
	let response: Response;
	try {
		response = await fetch(base + "/api/music/share", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth.token.trim(), "X-Auth-Kind": auth.kind },
			body: JSON.stringify({ track }),
			signal: AbortSignal.timeout(46_000),
		});
	} catch {
		throw new Error("暂时没能准备好音频");
	}
	const result = await response.json().catch(() => null);
	if (!response.ok || !result?.ok) throw new Error(result?.error || "暂时没能准备好音频");
	const url = new URL(result.sharedAudioUrl || "/", base);
	if (url.origin !== new URL(base).origin || !/^\/api\/music\/shared\/[a-f0-9]{16}\.(?:mp3|m4a|flac|ogg|webm)$/i.test(url.pathname) ||
		!(result.size > 0) || !(result.expiresAt > Date.now())) throw new Error("暂时没能生成可试听的分享链接");
	return formatLxMusicShare({
		...track,
		sourceUrl: inferMusicSourcePageUrl(track),
		id: result.track?.id || track.id,
		provider: result.track?.provider || track.provider,
		sourceId: result.track?.sourceId || track.sourceId,
		cover: track.cover || result.track?.cover,
		durationSec: result.track?.durationSec || track.durationSec,
		sharedAudioUrl: url.href,
		sharedExpiresAt: result.expiresAt,
	});
}
