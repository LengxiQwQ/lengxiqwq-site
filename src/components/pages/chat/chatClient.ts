import type {
	ChatMentionCandidate,
	ChatMessageRecord,
	ChatOnlineMember,
	ChatSessionUser,
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
	roomId: string;
	self: ChatSessionUser | null;
	messages: ChatMessageRecord[];
	hasMoreHistory?: boolean;
	lastReadAt?: number;
	unreadCount?: number;
	unreadUserCount?: number;
	members: ChatOnlineMember[];
	mentionMembers?: ChatMentionCandidate[];
	observerCount: number;
	totalCount: number;
	music: RoomMusicState;
}

export type ServerPacket =
	| RoomInitPacket
	| { type: "pong"; serverTime: number }
	| { type: "auth:result"; user: ChatSessionUser | null }
	| {
			type: "presence:update";
			roomId: string;
			members: ChatOnlineMember[];
			mentionMembers?: ChatMentionCandidate[];
			observerCount: number;
			totalCount: number;
	  }
	| { type: "chat:message"; roomId: string; message: ChatMessageRecord }
	| {
			type: "chat:history_batch";
			roomId: string;
			messages: ChatMessageRecord[];
			hasMoreHistory: boolean;
			jumpTarget?: boolean;
	  }
	| { type: "chat:deleted"; roomId: string; msgUid: string }
	| ({ type: "music:state"; roomId: string } & RoomMusicState)
	| { type: "error"; code?: string; message: string };

export function normalizeServerUrl(raw?: string): string {
	return (raw || "").trim().replace(/\/+$/, "");
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

export function persistGuestAuth(token: string, meta: StoredGuestMeta): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(GUEST_TOKEN_STORAGE_KEY, token);
		localStorage.setItem(GUEST_EMAIL_STORAGE_KEY, JSON.stringify(meta));
		persistWalineCommentMeta(meta);
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
): () => void {
	const base = normalizeServerUrl(walineServerUrl);
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
		onCancel?.();
		return () => {};
	}

	let finished = false;
	const cleanup = () => {
		window.removeEventListener("message", onMessage);
		window.clearInterval(pollTimer);
	};

	const onMessage = (event: MessageEvent) => {
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
			if (maybeToken) {
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
	input: StoredGuestMeta,
): Promise<{
	ok: boolean;
	token?: string;
	user?: ChatSessionUser;
	error?: string;
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
		};
		if (!resp.ok || !data.ok || !data.token || !data.user) {
			return { ok: false, error: data.error || "访客认证失败" };
		}
		persistGuestAuth(data.token, input);
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

export function previewAvatarFromEmail(email: string): string {
	const trimmed = email.trim().toLowerCase();
	const qqMatch = trimmed.match(/^([1-9]\d{4,10})@qq\.com$/);
	if (qqMatch) {
		return `https://q1.qlogo.cn/g?b=qq&nk=${qqMatch[1]}&s=100`;
	}
	return "";
}
