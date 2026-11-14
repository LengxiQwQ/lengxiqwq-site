import type { InterconnectSite } from "@/types/chatConfig";
import type {
	ChatCustomBadge,
	ChatMentionCandidate,
	ChatMessageRecord,
	ChatOnlineMember,
	ChatSessionUser,
	ChatUserDetailProfile,
	ChatUserTracksPage,
	RoomMusicState,
} from "./chatTypes";
import type { ChatMusicTrack } from "./musicTypes";

export const GUEST_TOKEN_STORAGE_KEY = "fireflyChatGuestToken";
export const GUEST_EMAIL_STORAGE_KEY = "fireflyChatGuestMeta";
export const WALINE_USER_META_KEY = "WALINE_USER_META";

export interface StoredGuestMeta {
	nickname: string;
	email: string;
	url: string;
}

export interface RoomInitPacket {
	type: "room:init";
	interconnected?: boolean;
	roomId: string;
	self: ChatSessionUser | null;
	mergedGuestHistory?: boolean;
	messages: ChatMessageRecord[];
	hasMoreHistory?: boolean;
	lastReadAt?: number;
	unreadCount?: number;
	unreadUserCount?: number;
	members: ChatOnlineMember[];
	observers?: ChatOnlineMember[];
	mentionMembers?: ChatMentionCandidate[];
	observerCount: number;
	totalCount: number;
	totalChatters?: number;
	music: RoomMusicState;
}

export type ServerPacket =
	| RoomInitPacket
	| { type: "pong"; serverTime: number }
	| {
			type: "auth:result";
			user: ChatSessionUser | null;
			mergedGuestHistory?: boolean;
	  }
	| {
			type: "member:merged";
			roomId: string;
			fromUserKeys: string[];
			user: ChatSessionUser;
	  }
	| {
			type: "member:badges_updated";
			roomId: string;
			userKey: string;
			customBadges: ChatCustomBadge[];
	  }
	| {
			type: "presence:update";
			roomId: string;
			members: ChatOnlineMember[];
			observers?: ChatOnlineMember[];
			mentionMembers?: ChatMentionCandidate[];
			observerCount: number;
			totalCount: number;
			totalChatters?: number;
	  }
	| { type: "chat:message" | "chat:updated"; roomId: string; message: ChatMessageRecord }
	| {
			type: "chat:history_batch";
			roomId: string;
			messages: ChatMessageRecord[];
			hasMoreHistory: boolean;
			jumpTarget?: boolean;
	  }
	| { type: "chat:deleted"; roomId: string; msgUid: string; recalled?: boolean }
	| { type: "chat:recalled"; roomId: string; msgUid: string }
	| ({ type: "music:state"; roomId: string } & RoomMusicState)
	| { type: "playlist:updated"; roomId: string }
	| {
			type: "error";
			code?: string;
			authKind?: "waline" | "guest";
			message: string;
	  };

export function normalizeServerUrl(raw?: string): string {
	return (raw || "").trim().replace(/\/+$/, "");
}

export function formatClockSeconds(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
	const mins = Math.floor(seconds / 60);
	const secs = Math.floor(seconds % 60);
	return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

const VISITOR_ID_STORAGE_KEY = "lengxi_chat_visitor_id";

export function getOrCreateVisitorId(): string {
	if (typeof localStorage === "undefined") return "";
	try {
		let vid = localStorage.getItem(VISITOR_ID_STORAGE_KEY)?.trim() || "";
		if (!vid) {
			vid = `v_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
			localStorage.setItem(VISITOR_ID_STORAGE_KEY, vid);
		}
		return vid;
	} catch {
		return "";
	}
}

export function buildWsUrl(
	serverUrl: string,
	roomId: string,
	auth?: { kind: "waline" | "guest"; token: string } | null,
	lastReadAt = 0,
): string {
	const cleanBase = normalizeServerUrl(serverUrl);
	const wsBase = cleanBase
		.replace(/^https:\/\//i, "wss://")
		.replace(/^http:\/\//i, "ws://");
	const params = new URLSearchParams({ room: roomId });
	if (auth?.token) {
		params.set("authKind", auth.kind);
		params.set("token", auth.token);
	} else {
		const vid = getOrCreateVisitorId();
		if (vid) {
			params.set("visitorId", vid);
		}
	}
	if (lastReadAt > 0) {
		params.set("lastReadAt", String(Math.floor(lastReadAt)));
	}
	return `${wsBase}/ws?${params.toString()}`;
}

export function readStoredWalineToken(): string {
	if (typeof localStorage === "undefined") return "";
	try {
		const rawUser = localStorage.getItem("WALINE_USER");
		if (rawUser) {
			const parsed = JSON.parse(rawUser) as { token?: unknown };
			if (typeof parsed.token === "string" && parsed.token.trim()) {
				return parsed.token.trim();
			}
		}
		const adminToken = localStorage.getItem("WALINE_ADMIN_TOKEN");
		if (adminToken?.trim()) return adminToken.trim();
		const token = localStorage.getItem("TOKEN");
		if (token?.trim()) return token.trim();
	} catch {
		// Ignore invalid localStorage
	}
	return "";
}

export function persistWalineAuth(userData: {
	token: string;
	display_name?: string;
	email?: string;
	type?: string;
	avatar?: string;
	url?: string;
	label?: string;
	objectId?: string | number;
	mailMd5?: string;
}): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem("WALINE_USER", JSON.stringify(userData));
		localStorage.setItem("TOKEN", userData.token);
		if (userData.type === "administrator" || userData.type === "admin") {
			localStorage.setItem("WALINE_ADMIN_TOKEN", userData.token);
		}
	} catch {
		// Ignore storage limits
	}
}

export function clearWalineAuth(): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.removeItem("WALINE_USER");
		localStorage.removeItem("WALINE_ADMIN_TOKEN");
		localStorage.removeItem("TOKEN");
	} catch {
		// Ignore
	}
}

export function readStoredGuestToken(): string {
	if (typeof localStorage === "undefined") return "";
	try {
		return localStorage.getItem(GUEST_TOKEN_STORAGE_KEY)?.trim() || "";
	} catch {
		return "";
	}
}

export function readWalineCommentMeta(): StoredGuestMeta {
	if (typeof localStorage === "undefined") {
		return { nickname: "", email: "", url: "" };
	}
	try {
		const raw = localStorage.getItem(WALINE_USER_META_KEY);
		if (!raw) return { nickname: "", email: "", url: "" };
		const parsed = JSON.parse(raw) as {
			nick?: unknown;
			mail?: unknown;
			link?: unknown;
		};
		return {
			nickname: typeof parsed.nick === "string" ? parsed.nick.trim() : "",
			email: typeof parsed.mail === "string" ? parsed.mail.trim() : "",
			url: typeof parsed.link === "string" ? parsed.link.trim() : "",
		};
	} catch {
		return { nickname: "", email: "", url: "" };
	}
}

export function persistWalineCommentMeta(meta: StoredGuestMeta): void {
	if (typeof localStorage === "undefined") return;
	try {
		const existing = readWalineCommentMeta();
		localStorage.setItem(
			WALINE_USER_META_KEY,
			JSON.stringify({
				nick: meta.nickname.trim() || existing.nickname,
				mail: meta.email.trim() || existing.email,
				link: meta.url.trim() || existing.url,
			}),
		);
	} catch {
		// Ignore
	}
}

export function persistGuestAuth(
	token: string,
	meta: StoredGuestMeta,
	options?: { skipCommentMeta?: boolean },
): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(GUEST_TOKEN_STORAGE_KEY, token);
		localStorage.setItem(GUEST_EMAIL_STORAGE_KEY, JSON.stringify(meta));
		if (!options?.skipCommentMeta) {
			persistWalineCommentMeta(meta);
		}
	} catch {
		// Ignore
	}
}

export function clearGuestAuth(): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.removeItem(GUEST_TOKEN_STORAGE_KEY);
	} catch {
		// Ignore
	}
}

export function readStoredGuestMeta(): StoredGuestMeta {
	if (typeof localStorage === "undefined") {
		return { nickname: "", email: "", url: "" };
	}
	const commentMeta = readWalineCommentMeta();
	try {
		const raw = localStorage.getItem(GUEST_EMAIL_STORAGE_KEY);
		if (!raw) return commentMeta;
		const parsed = JSON.parse(raw) as Partial<StoredGuestMeta>;
		return {
			nickname:
				(typeof parsed.nickname === "string" ? parsed.nickname.trim() : "") ||
				commentMeta.nickname,
			email:
				(typeof parsed.email === "string" ? parsed.email.trim() : "") ||
				commentMeta.email,
			url:
				(typeof parsed.url === "string" ? parsed.url.trim() : "") ||
				commentMeta.url,
		};
	} catch {
		return commentMeta;
	}
}

export function resolveInitialAuth(): {
	kind: "waline" | "guest";
	token: string;
} | null {
	const walineToken = readStoredWalineToken();
	if (walineToken) {
		return { kind: "waline", token: walineToken };
	}
	const guestToken = readStoredGuestToken();
	if (guestToken) {
		return { kind: "guest", token: guestToken };
	}
	return null;
}

export async function loginWalineWithPassword(
	walineServerUrl: string,
	email: string,
	password: string,
	code?: string,
): Promise<{
	ok: boolean;
	error?: string;
	need2fa?: boolean;
	token?: string;
}> {
	const base = normalizeServerUrl(walineServerUrl);
	if (!base) {
		return { ok: false, error: "未配置 Waline 服务端地址" };
	}
	try {
		const resp = await fetch(`${base}/api/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: email.trim(),
				password,
				...(code?.trim() ? { code: code.trim() } : {}),
			}),
		});
		const data = (await resp.json()) as {
			errno?: number;
			errmsg?: string;
			data?: {
				token?: string;
				"2fa"?: boolean;
				display_name?: string;
				email?: string;
				type?: string;
				avatar?: string;
				url?: string;
				label?: string;
				objectId?: string | number;
				mailMd5?: string;
			};
		};
		if (data.errno !== 0 || !data.data?.token) {
			return {
				ok: false,
				need2fa: Boolean(data.data?.["2fa"]),
				error: data.errmsg || "邮箱或密码错误",
			};
		}
		persistWalineAuth({
			token: data.data.token,
			display_name: data.data.display_name,
			email: data.data.email,
			type: data.data.type,
			avatar: data.data.avatar,
			url: data.data.url,
			label: data.data.label,
			objectId: data.data.objectId,
			mailMd5: data.data.mailMd5,
		});
		return { ok: true, token: data.data.token };
	} catch {
		return { ok: false, error: "网络异常，无法连接 Waline 服务" };
	}
}

export function openWalineLoginPopup(
	walineServerUrl: string,
	onSuccess: (token: string) => void,
	onCancel?: () => void,
	onBlocked?: () => void,
): () => void {
	const base = normalizeServerUrl(walineServerUrl);
	let walineOrigin = "";
	try {
		walineOrigin = new URL(base).origin;
	} catch {
		walineOrigin = "";
	}
	const initialToken = readStoredWalineToken();
	const width = 960;
	const height = 620;
	const left = Math.max(
		0,
		Math.floor((window.innerWidth - width) / 2 + (window.screenX || 0)),
	);
	const top = Math.max(
		0,
		Math.floor((window.innerHeight - height) / 2 + (window.screenY || 0)),
	);

	const loginUrl = `${base}/ui/login?lng=zh-CN`;
	const popup = window.open(
		loginUrl,
		"waline_chat_login",
		`width=${width},height=${height},left=${left},top=${top},menubar=no,status=no,toolbar=no,scrollbars=yes,resizable=yes`,
	);

	if (!popup) {
		onBlocked?.();
		onCancel?.();
		return () => {};
	}

	let finished = false;
	const cleanup = () => {
		window.removeEventListener("message", onMessage);
		window.clearInterval(pollTimer);
	};

	const onMessage = (event: MessageEvent) => {
		if (walineOrigin && event.origin !== walineOrigin) return;
		if (event.source && event.source !== popup) return;
		const payload = event.data as {
			type?: string;
			data?: {
				token?: string;
				display_name?: string;
				nick?: string;
				email?: string;
				type?: string;
				avatar?: string;
				url?: string;
				label?: string;
				objectId?: string | number;
				mailMd5?: string;
			};
		};
		if (
			payload &&
			typeof payload === "object" &&
			payload.type === "userInfo" &&
			payload.data?.token
		) {
			finished = true;
			cleanup();
			persistWalineAuth({
				token: payload.data.token,
				display_name: payload.data.display_name || payload.data.nick,
				email: payload.data.email,
				type: payload.data.type,
				avatar: payload.data.avatar,
				url: payload.data.url,
				label: payload.data.label,
				objectId: payload.data.objectId,
				mailMd5: payload.data.mailMd5,
			});
			try {
				if (!popup.closed) popup.close();
			} catch {
				// Ignore close failure
			}
			onSuccess(payload.data.token);
		}
	};

	window.addEventListener("message", onMessage);

	const pollTimer = window.setInterval(() => {
		if (popup.closed && !finished) {
			finished = true;
			cleanup();
			const maybeToken = readStoredWalineToken();
			if (maybeToken && maybeToken !== initialToken) {
				onSuccess(maybeToken);
			} else {
				onCancel?.();
			}
		}
	}, 600);

	return () => {
		finished = true;
		cleanup();
	};
}

export async function registerGuestSession(
	chatServerUrl: string,
	input: StoredGuestMeta & { room?: string; allowSplitGuest?: boolean },
): Promise<{
	ok: boolean;
	token?: string;
	user?: ChatSessionUser;
	error?: string;
	code?: string;
	allowSplitGuest?: boolean;
}> {
	const base = normalizeServerUrl(chatServerUrl);
	if (!base) {
		return { ok: false, error: "聊天室后端地址未配置" };
	}
	try {
		const resp = await fetch(`${base}/api/auth/guest`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		const data = (await resp.json()) as {
			ok?: boolean;
			token?: string;
			user?: ChatSessionUser;
			error?: string;
			code?: string;
			allowSplitGuest?: boolean;
		};
		if (!resp.ok || !data.ok || !data.token || !data.user) {
			return {
				ok: false,
				error: data.error || "访客认证失败",
				code: data.code,
				allowSplitGuest: resp.status === 403 ? false : data.allowSplitGuest,
			};
		}
		persistGuestAuth(
			data.token,
			{
				nickname: input.nickname,
				email: input.email,
				url: input.url,
			},
			{
				skipCommentMeta: Boolean(data.user.isolated || input.allowSplitGuest),
			},
		);
		return { ok: true, token: data.token, user: data.user };
	} catch {
		return { ok: false, error: "网络异常，无法连接聊天室服务端" };
	}
}

export async function searchOnlineMusic(
	chatServerUrl: string,
	keyword: string,
): Promise<ChatMusicTrack[]> {
	const base = normalizeServerUrl(chatServerUrl);
	const q = keyword.trim();
	if (!base || !q) return [];
	const resp = await fetch(
		`${base}/api/music/search?q=${encodeURIComponent(q)}&limit=15`,
	);
	if (!resp.ok) {
		throw new Error(`搜索请求失败 (${resp.status})`);
	}
	const data = (await resp.json()) as {
		ok?: boolean;
		tracks?: ChatMusicTrack[];
	};
	return Array.isArray(data.tracks) ? data.tracks : [];
}

async function compressChatImageIfNeeded(file: File): Promise<File> {
	const isGif =
		file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif");
	if (isGif) return file;

	const isPng =
		file.type === "image/png" || file.name.toLowerCase().endsWith(".png");
	const isJpg = file.type === "image/jpeg" || /\.(jpe?g)$/i.test(file.name);

	if (!isPng && !isJpg) return file;
	if (isPng && file.size <= 300 * 1024) return file;

	return new Promise<File>((resolve) => {
		const objectUrl = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(objectUrl);
			const width = img.naturalWidth || img.width;
			const height = img.naturalHeight || img.height;
			const isLandscape = width >= height;
			const maxW = isLandscape ? 2560 : 1440;
			const maxH = isLandscape ? 1440 : 2560;

			let targetWidth = width;
			let targetHeight = height;
			let needResize = false;

			if (width > maxW || height > maxH) {
				needResize = true;
				const scale = Math.min(maxW / width, maxH / height);
				targetWidth = Math.round(width * scale);
				targetHeight = Math.round(height * scale);
			}

			if (isJpg && !needResize && file.size <= 1024 * 1024) {
				resolve(file);
				return;
			}

			const canvas = document.createElement("canvas");
			canvas.width = targetWidth;
			canvas.height = targetHeight;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				resolve(file);
				return;
			}

			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, targetWidth, targetHeight);
			ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

			canvas.toBlob(
				(blob) => {
					if (!blob) {
						resolve(file);
						return;
					}
					const baseName = file.name.replace(/\.[^/.]+$/, "") || "chat-img";
					resolve(new File([blob], `${baseName}.jpg`, { type: "image/jpeg" }));
				},
				"image/jpeg",
				0.82,
			);
		};
		img.onerror = () => {
			URL.revokeObjectURL(objectUrl);
			resolve(file);
		};
		img.src = objectUrl;
	});
}

export async function uploadChatImage(
	file: File,
	walineServerUrl: string,
): Promise<string> {
	const base = normalizeServerUrl(walineServerUrl);
	if (!base) {
		throw new Error("未配置图片上传服务");
	}
	const allowedTypes = new Set([
		"image/jpeg",
		"image/png",
		"image/webp",
		"image/gif",
		"image/avif",
	]);
	if (!allowedTypes.has(file.type.toLowerCase())) {
		throw new Error("仅支持 JPG / PNG / WebP / GIF / AVIF 图片");
	}

	const processed = await compressChatImageIfNeeded(file);
	if (processed.size > 5 * 1024 * 1024) {
		throw new Error("图片压缩后仍超过 5MB 限制");
	}

	const formData = new FormData();
	formData.append("file", processed);

	const headers: Record<string, string> = {};
	const token = readStoredWalineToken();
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const resp = await fetch(`${base}/api/upload`, {
		method: "POST",
		headers,
		body: formData,
	});
	const data = (await resp.json()) as {
		errno?: number;
		errmsg?: string;
		data?: { url?: string };
	};
	if (!resp.ok || data.errno !== 0 || !data.data?.url) {
		throw new Error(data.errmsg || "图片上传失败");
	}
	return data.data.url;
}

export async function uploadChatMedia(
	file: File,
	chatServerUrl: string,
): Promise<{
	url: string;
	name: string;
	size: number;
	type: "image" | "audio" | "video" | "file";
}> {
	const base = normalizeServerUrl(chatServerUrl);
	if (!base) {
		throw new Error("未配置多媒体上传服务");
	}

	if (file.size > 25 * 1024 * 1024) {
		throw new Error("文件大小超过 25MB 限制");
	}

	const resp = await fetch(
		`${base}/api/upload?name=${encodeURIComponent(file.name)}`,
		{
			method: "POST",
			headers: {
				"Content-Type": file.type || "application/octet-stream",
			},
			body: file,
		},
	);

	const data = (await resp.json()) as {
		ok?: boolean;
		error?: string;
		data?: {
			url: string;
			name: string;
			size: number;
			type: "image" | "audio" | "video" | "file";
		};
	};

	if (!resp.ok || !data.ok || !data.data?.url) {
		throw new Error(data.error || "文件上传失败");
	}

	return data.data;
}

export function getAvatarInitials(name?: string, fallback = "?"): string {
	const cleaned = (name || "").replace(/\s+/g, "").trim();
	if (!cleaned) return fallback;
	return Array.from(cleaned).slice(0, 2).join("");
}

function rewriteDefaultAvatarQuery(rawUrl: string): string {
	const trimmed = rawUrl.trim();
	if (
		!trimmed.startsWith("http://") &&
		!trimmed.startsWith("https://") &&
		!trimmed.startsWith("/")
	) {
		return "";
	}
	try {
		const origin =
			typeof window !== "undefined"
				? window.location.origin
				: "https://example.invalid";
		const parsed = new URL(trimmed, origin);
		const proxiedTarget = parsed.searchParams.get("url");
		if (proxiedTarget) {
			const rewrittenInner = rewriteDefaultAvatarQuery(proxiedTarget);
			if (rewrittenInner && rewrittenInner !== proxiedTarget) {
				parsed.searchParams.set("url", rewrittenInner);
				return trimmed.startsWith("/")
					? `${parsed.pathname}${parsed.search}${parsed.hash}`
					: parsed.toString();
			}
			return trimmed;
		}

		const isAvatarService =
			parsed.hostname.includes("cravatar") ||
			parsed.hostname.includes("gravatar") ||
			parsed.hostname.includes("libravatar") ||
			parsed.hostname.includes("weavatar") ||
			parsed.pathname.includes("/avatar/");
		if (isAvatarService) {
			const dParam = (parsed.searchParams.get("d") || "").toLowerCase();
			const defaultParam = (
				parsed.searchParams.get("default") || ""
			).toLowerCase();
			if (
				dParam === "mp" ||
				dParam === "mm" ||
				dParam === "mystery" ||
				(!dParam && !defaultParam)
			) {
				parsed.searchParams.set("d", "404");
				return parsed.toString();
			}
			if (
				defaultParam === "mp" ||
				defaultParam === "mm" ||
				defaultParam === "mystery"
			) {
				parsed.searchParams.set("default", "404");
				return parsed.toString();
			}
		}
		return trimmed;
	} catch {
		return trimmed.replace(
			/([?&](?:d|default)=)(?:mp|mm|mystery)(?=&|$)/gi,
			"$1404",
		);
	}
}

export function resolveChatAvatarUrl(raw?: string): string {
	if (!raw) return "";
	if (raw.includes("chat-api.lengxiqwq.com/api/interconnect/media/")) {
		return "";
	}
	return rewriteDefaultAvatarQuery(raw);
}

export function previewAvatarFromEmail(email: string): string {
	const trimmed = email.trim().toLowerCase();
	const qqMatch = trimmed.match(/^([1-9]\d{4,10})@qq\.com$/);
	if (qqMatch) {
		return `https://q1.qlogo.cn/g?b=qq&nk=${qqMatch[1]}&s=100`;
	}
	return "";
}

export async function fetchUserDetailProfile(
	chatServerUrl: string,
	roomId: string,
	userKey: string,
	tracksLimit = 50,
	walineToken = "",
): Promise<ChatUserDetailProfile | null> {
	const base = normalizeServerUrl(chatServerUrl);
	const cleanKey = userKey.trim();
	if (!base || !cleanKey) return null;
	try {
		const headers: Record<string, string> = {};
		if (walineToken.trim()) {
			headers.Authorization = `Bearer ${walineToken.trim()}`;
		}
		const resp = await fetch(
			`${base}/api/rooms/member?room=${encodeURIComponent(roomId)}&userKey=${encodeURIComponent(cleanKey)}&tracksLimit=${encodeURIComponent(String(tracksLimit))}&_t=${Date.now()}`,
			{ headers, cache: "no-store" },
		);
		if (!resp.ok) return null;
		const data = (await resp.json()) as {
			ok?: boolean;
			profile?: ChatUserDetailProfile;
		};
		if (!data.ok || !data.profile) return null;
		return data.profile;
	} catch {
		return null;
	}
}

export async function fetchUserDetailTracks(
	chatServerUrl: string,
	roomId: string,
	userKey: string,
	beforeId: number,
	limit = 50,
): Promise<ChatUserTracksPage | null> {
	const base = normalizeServerUrl(chatServerUrl);
	const cleanKey = userKey.trim();
	if (!base || !cleanKey) return null;
	try {
		const resp = await fetch(
			`${base}/api/rooms/member/tracks?room=${encodeURIComponent(roomId)}&userKey=${encodeURIComponent(cleanKey)}&limit=${encodeURIComponent(String(limit))}&beforeId=${encodeURIComponent(String(beforeId))}&_t=${Date.now()}`,
			{ cache: "no-store" },
		);
		if (!resp.ok) return null;
		const data = (await resp.json()) as {
			ok?: boolean;
			items?: ChatUserTracksPage["items"];
			hasMore?: boolean;
			nextBeforeId?: number;
		};
		if (!data.ok || !Array.isArray(data.items)) return null;
		return {
			items: data.items,
			hasMore: Boolean(data.hasMore),
			nextBeforeId: Number(data.nextBeforeId || 0),
		};
	} catch {
		return null;
	}
}

export async function saveMemberBadges(
	chatServerUrl: string,
	roomId: string,
	targetUserKey: string,
	customBadges: ChatCustomBadge[],
	walineToken = "",
): Promise<boolean> {
	const base = normalizeServerUrl(chatServerUrl);
	const cleanKey = targetUserKey.trim();
	if (!base || !cleanKey) return false;
	try {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (walineToken.trim()) {
			headers.Authorization = `Bearer ${walineToken.trim()}`;
		}
		const resp = await fetch(`${base}/api/rooms/member/badges`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				room: roomId,
				userKey: cleanKey,
				customBadges,
			}),
		});
		if (!resp.ok) return false;
		const data = (await resp.json()) as { ok?: boolean };
		return Boolean(data.ok);
	} catch {
		return false;
	}
}

export interface ExternalOriginInfo {
	cleanName: string;
	siteName: string;
	site?: InterconnectSite;
	host: string;
}

export function resolveExternalOrigin(
	member: { name: string; userKey?: string },
	sites: InterconnectSite[] = [],
): ExternalOriginInfo {
	const rawName = (member.name || "").trim();
	const userKey = (member.userKey || "").trim();

	// 1. 优先从昵称中的分隔符（· 或 •）拆分：例如 "朝朝听雨 · 听雨茶室" -> name: "朝朝听雨", site: "听雨茶室"
	const separatorMatch = rawName.match(/^(.+?)\s*[·•]\s*(.+)$/);
	let cleanName = rawName;
	let siteFromSuffix = "";

	if (separatorMatch) {
		cleanName = separatorMatch[1].trim();
		siteFromSuffix = separatorMatch[2].trim();
	}

	// 2. 尝试从 userKey 或 sender Matrix ID 提取域名并与 interconnectSites 匹配
	const hostMatch =
		userKey.match(/@.+?:([^/:]+)/) || userKey.match(/matrix:([^/:]+)/);
	const host = hostMatch ? hostMatch[1].toLowerCase() : "";

	let matchedSite: InterconnectSite | undefined;

	if (host) {
		for (const site of sites) {
			try {
				const siteUrl = new URL(site.url);
				const siteHost = siteUrl.hostname.toLowerCase();
				if (host.includes(siteHost) || siteHost.includes(host)) {
					matchedSite = site;
					break;
				}
				const hostParts = host.split(".").slice(-2).join(".");
				const siteParts = siteHost.split(".").slice(-2).join(".");
				if (hostParts && hostParts === siteParts) {
					matchedSite = site;
					break;
				}
			} catch {
				// invalid URL
			}
		}
	}

	if (host.includes("lengxiqwq.com")) {
		matchedSite = {
			name: "冷汐的杂货铺",
			owner: "冷汐OωO",
			url: "https://lengxiqwq.com",
			avatar: "https://avatars.githubusercontent.com/u/97082679?v=4",
			desc: "冷汐的个人网站",
		};
	}

	if (!matchedSite && siteFromSuffix) {
		matchedSite = sites.find(
			(s) =>
				s.name.includes(siteFromSuffix) ||
				siteFromSuffix.includes(s.name),
		);
	}

	if (!matchedSite) {
		for (const site of sites) {
			if (
				site.owner &&
				cleanName.toLowerCase().includes(site.owner.toLowerCase())
			) {
				matchedSite = site;
				break;
			}
			if (
				cleanName.includes("雪") ||
				cleanName.toLowerCase().includes("aiovtue")
			) {
				if (site.name.includes("雪") || site.owner.includes("雪")) {
					matchedSite = site;
					break;
				}
			}
		}
	}

	const siteName =
		siteFromSuffix ||
		matchedSite?.name ||
		(host.includes("gbk.ink")
			? "GBK.ink"
			: host.includes("somoe.xyz")
				? "Somoe 茶室"
				: host.includes("rainzt.cn")
					? "听雨茶室"
					: host.includes("yybb.us")
						? "雪的茶室"
						: host.includes("detached.online")
							? "Detached 茶室"
							: host || "外部站点");

	return {
		cleanName: cleanName || rawName,
		siteName,
		site: matchedSite,
		host,
	};
}

