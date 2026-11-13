import { createHash } from "node:crypto";
import type { Env } from "../env.js";

export type BadgeType = "host" | "accent" | "tag";

export interface VerifiedUser {
	userKey: string;
	authType: "waline" | "guest";
	name: string;
	avatar: string;
	url: string;
	badge: string;
	badgeType: BadgeType;
	isAdmin: boolean;
	isolated?: boolean;
	status?: string;
	bio?: string;
	notifyEmail?: boolean;
}

export interface VerifiedSession {
	user: VerifiedUser;
	email: string;
	isolated?: boolean;
}

const RESERVED_BADGES = new Set([
	"博主",
	"站长",
	"管理员",
	"房主",
	"官方",
	"系统",
	"已认证",
	"认证",
	"访客",
	"admin",
	"host",
	"owner",
]);

const RESERVED_GUEST_NAMES = new Set([
	"冷汐",
	"冷汐oωo",
	"冷汐owo",
	"lengxi",
	"lengxiqwq",
	"博主",
	"站长",
	"管理员",
	"系统",
	"system",
	"admin",
]);

const GUEST_TOKEN_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

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

async function importHmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

function stripControlChars(input: string, replaceWith: string): string {
	let out = "";
	for (const ch of input) {
		const code = ch.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) {
			out += replaceWith;
		} else {
			out += ch;
		}
	}
	return out;
}

export function sanitizeDisplayName(raw: string): string {
	return stripControlChars(raw, " ").replace(/\s+/g, " ").trim().slice(0, 16);
}

export function sanitizeWebsiteUrl(raw?: string): string {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "";
	const candidate = /^https?:\/\//i.test(trimmed)
		? trimmed
		: `https://${trimmed}`;
	try {
		const parsed = new URL(candidate);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return "";
		}
		return parsed.toString().slice(0, 200);
	} catch {
		return "";
	}
}

export function sanitizeStatus(raw?: string): string {
	const cleaned = stripControlChars(raw ?? "", " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 16);
	return cleaned || "在线";
}

export function sanitizeBio(raw?: string): string {
	return stripControlChars(raw ?? "", " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}

export function sanitizeAvatarUrl(raw?: string): string {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "";
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return "";
		}
		return parsed.toString().slice(0, 400);
	} catch {
		return "";
	}
}

export function resolveRoleBadge(
	authType: "waline" | "guest",
	isAdmin: boolean,
): { badge: string; badgeType: BadgeType } {
	if (isAdmin) {
		return { badge: "站长", badgeType: "host" };
	}
	if (authType === "waline") {
		return { badge: "认证", badgeType: "accent" };
	}
	return { badge: "访客", badgeType: "tag" };
}

export function sanitizePublicBadge(
	raw: string | undefined,
	isAdmin: boolean,
): { badge: string; badgeType: BadgeType } {
	const cleaned = stripControlChars(raw ?? "", "")
		.trim()
		.slice(0, 10);

	if (isAdmin) {
		return {
			badge: "站长",
			badgeType: "host",
		};
	}

	if (!cleaned || RESERVED_BADGES.has(cleaned.toLowerCase())) {
		return { badge: "", badgeType: "tag" };
	}

	return {
		badge: cleaned,
		badgeType:
			cleaned === "点歌王" || cleaned === "点歌达人" ? "accent" : "tag",
	};
}

export function buildAvatarFromEmail(
	email: string,
	gravatarStr?: string,
	avatarProxy?: string,
): string {
	const trimmed = email.trim().toLowerCase();
	if (!trimmed) return "";

	let avatarUrl = "";
	const qqMatch = trimmed.match(/^([1-9]\d{4,10})@qq\.com$/);
	if (qqMatch) {
		avatarUrl = `https://q1.qlogo.cn/g?b=qq&nk=${qqMatch[1]}&s=100`;
	} else {
		const hash = createHash("md5").update(trimmed).digest("hex");
		const base = (gravatarStr || "https://cravatar.cn/avatar/").trim();
		if (base.includes("{{")) {
			avatarUrl = base
				.replace(
					/\{\{\s*mail\s*\|\s*(?:lower\s*\|\s*trim\s*\|\s*)?md5\s*\}\}/gi,
					hash,
				)
				.replace(/\{\{\s*mail\s*\}\}/gi, hash);
		} else {
			const normalizedBase = base.endsWith("/") ? base : `${base}/`;
			avatarUrl = `${normalizedBase}${hash}?d=404`;
		}
	}

	if (avatarProxy?.trim()) {
		try {
			const proxyUrl = new URL(avatarProxy.trim());
			if (proxyUrl.protocol === "https:" || proxyUrl.protocol === "http:") {
				proxyUrl.searchParams.set("url", avatarUrl);
				return proxyUrl.toString();
			}
		} catch {
			// Ignore malformed proxy config
		}
	}

	return avatarUrl;
}

export function getAdminEmailSet(env: Env): Set<string> {
	const raw = env.ADMIN_EMAILS || "";
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}

export function isAdminEmail(env: Env, email: string): boolean {
	const clean = email.trim().toLowerCase();
	return clean !== "" && getAdminEmailSet(env).has(clean);
}

const WALINE_TOKEN_CACHE_TTL_MS = 2 * 60 * 1000;
const WALINE_TOKEN_CACHE_MAX_SIZE = 200;
const walineTokenCache = new Map<
	string,
	{ session: VerifiedSession; expiresAt: number }
>();

export async function verifyWalineTokenWithEmail(
	env: Env,
	token: string,
): Promise<VerifiedSession | null> {
	const cleanToken = token.trim();
	if (!cleanToken) return null;

	const cacheKey = `${env.WALINE_SERVER_URL || ""}|${env.ADMIN_EMAILS || ""}|${cleanToken}`;
	const now = Date.now();
	const cached = walineTokenCache.get(cacheKey);
	if (cached && cached.expiresAt > now) {
		return cached.session;
	}
	if (cached) {
		walineTokenCache.delete(cacheKey);
	}

	let resp: Response | null = null;
	if (env.WALINE) {
		try {
			resp = await env.WALINE.fetch("https://waline.internal/api/token", {
				method: "GET",
				headers: { Authorization: `Bearer ${cleanToken}` },
			});
		} catch {
			resp = null;
		}
	}

	if (!resp && env.WALINE_SERVER_URL) {
		try {
			const base = env.WALINE_SERVER_URL.replace(/\/+$/, "");
			resp = await fetch(`${base}/api/token`, {
				method: "GET",
				headers: { Authorization: `Bearer ${cleanToken}` },
				signal: AbortSignal.timeout(5000),
			});
		} catch {
			return null;
		}
	}

	if (!resp?.ok) return null;

	try {
		const payload = (await resp.json()) as {
			errno?: number;
			data?: {
				objectId?: number | string;
				display_name?: string;
				email?: string;
				type?: string;
				url?: string;
				avatar?: string;
				label?: string;
			};
		};
		if (payload.errno !== 0 || !payload.data?.objectId) return null;

		const data = payload.data;
		const email = (data.email || "").trim().toLowerCase();
		const adminEmails = getAdminEmailSet(env);
		const isAdmin =
			data.type === "administrator" ||
			data.type === "admin" ||
			(email !== "" && adminEmails.has(email));

		const rawName = sanitizeDisplayName(data.display_name || "");
		const name =
			rawName && (isAdmin || !isReservedGuestName(rawName))
				? rawName
				: isAdmin
					? "站长"
					: `用户#${data.objectId}`;
		const avatar =
			typeof data.avatar === "string" && data.avatar.startsWith("http")
				? data.avatar
				: buildAvatarFromEmail(email, env.GRAVATAR_STR, env.AVATAR_PROXY);
		const url = sanitizeWebsiteUrl(data.url);
		const badgeInfo = resolveRoleBadge("waline", isAdmin);

		const session: VerifiedSession = {
			user: {
				userKey: `waline:${String(data.objectId)}`,
				authType: "waline",
				name,
				avatar,
				url,
				badge: badgeInfo.badge,
				badgeType: badgeInfo.badgeType,
				isAdmin,
			},
			email,
		};
		if (walineTokenCache.size >= WALINE_TOKEN_CACHE_MAX_SIZE) {
			const oldestKey = walineTokenCache.keys().next().value;
			if (oldestKey) walineTokenCache.delete(oldestKey);
		}
		walineTokenCache.set(cacheKey, {
			session,
			expiresAt: Date.now() + WALINE_TOKEN_CACHE_TTL_MS,
		});
		return session;
	} catch {
		return null;
	}
}

export async function verifyWalineToken(
	env: Env,
	token: string,
): Promise<VerifiedUser | null> {
	const session = await verifyWalineTokenWithEmail(env, token);
	return session ? session.user : null;
}

export function computeGuestUserKey(email: string, secret: string): string {
	const cleanEmail = email.trim().toLowerCase();
	const userHash = createHash("sha256")
		.update(`${cleanEmail}:${secret}`)
		.digest("hex")
		.slice(0, 20);
	return `guest:${userHash}`;
}

export function computeIsolatedGuestUserKey(): string {
	const rawHex = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
	return `guest:iso_${rawHex}`;
}

export function isIsolatedGuestUserKey(userKey: string): boolean {
	return userKey.trim().startsWith("guest:iso_");
}

export function shouldBlockGuestByWaline(params: {
	isAdminEmail: boolean;
	hasWalineMember: boolean;
	isolated?: boolean;
}): boolean {
	// 站长邮箱永远拦截，不允许通过独立临时身份绕过
	if (params.isAdminEmail) return true;
	// 明确经确认创建的独立临时身份不与普通 Waline 账号冲突，直接放行
	if (params.isolated) return false;
	return params.hasWalineMember;
}

export async function issueGuestSession(
	env: Env,
	input: {
		nickname: string;
		email: string;
		url?: string;
		badge?: string;
		allowSplitGuest?: boolean;
	},
): Promise<
	| { ok: true; token: string; user: VerifiedUser; email: string }
	| {
			ok: false;
			error: string;
			status: number;
			code?: string;
			allowSplitGuest?: boolean;
	  }
> {
	const name = sanitizeDisplayName(input.nickname || "");
	if (!name) {
		return { ok: false, error: "请输入昵称（1-16个字符）", status: 400 };
	}

	const normalizedName = name.toLowerCase();
	if (RESERVED_GUEST_NAMES.has(normalizedName)) {
		return {
			ok: false,
			error: "该昵称为站长/系统保留名称，请更换昵称或使用账号登录",
			status: 400,
			allowSplitGuest: false,
		};
	}

	const email = (input.email || "").trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 128) {
		return { ok: false, error: "请输入有效的邮箱地址", status: 400 };
	}

	if (isAdminEmail(env, email)) {
		return {
			ok: false,
			error: "该邮箱为站长专用邮箱，请通过 Waline 账号登录验证身份",
			status: 403,
			code: "WALINE_LOGIN_REQUIRED",
			allowSplitGuest: false,
		};
	}

	const secret = env.CHAT_GUEST_SECRET;
	if (!secret) {
		return { ok: false, error: "服务端未配置访客凭证密钥", status: 500 };
	}

	const isolated = input.allowSplitGuest === true;
	const userKey = isolated
		? computeIsolatedGuestUserKey()
		: computeGuestUserKey(email, secret);
	const avatar = buildAvatarFromEmail(
		email,
		env.GRAVATAR_STR,
		env.AVATAR_PROXY,
	);
	const url = sanitizeWebsiteUrl(input.url);
	const { badge, badgeType } = resolveRoleBadge("guest", false);

	const user: VerifiedUser = {
		userKey,
		authType: "guest",
		name,
		avatar,
		url,
		badge,
		badgeType,
		isAdmin: false,
		...(isolated ? { isolated: true, notifyEmail: false } : {}),
	};

	const exp = Math.floor(Date.now() / 1000) + GUEST_TOKEN_TTL_SEC;
	const payloadJson = JSON.stringify(
		isolated ? { user, email, isolated: true, exp } : { user, email, exp },
	);
	const encodedPayload = toBase64Url(new TextEncoder().encode(payloadJson));
	const key = await importHmacKey(secret);
	const sig = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(encodedPayload),
	);
	const token = `${encodedPayload}.${toBase64Url(sig)}`;

	return { ok: true, token, user, email };
}

export async function verifyGuestTokenWithEmail(
	env: Env,
	token: string,
): Promise<VerifiedSession | null> {
	const secret = env.CHAT_GUEST_SECRET;
	if (!secret || !token) return null;

	const parts = token.trim().split(".");
	if (parts.length !== 2) return null;
	const [encodedPayload, encodedSig] = parts;
	if (!encodedPayload || !encodedSig) return null;

	try {
		const key = await importHmacKey(secret);
		const valid = await crypto.subtle.verify(
			"HMAC",
			key,
			fromBase64Url(encodedSig),
			new TextEncoder().encode(encodedPayload),
		);
		if (!valid) return null;

		const payloadText = new TextDecoder().decode(fromBase64Url(encodedPayload));
		const parsed = JSON.parse(payloadText) as {
			user?: Partial<VerifiedUser>;
			email?: unknown;
			isolated?: unknown;
			exp?: unknown;
		};
		if (
			typeof parsed.exp !== "number" ||
			parsed.exp < Math.floor(Date.now() / 1000) ||
			!parsed.user?.userKey ||
			!parsed.user?.name
		) {
			return null;
		}

		const safeName = sanitizeDisplayName(parsed.user.name);
		if (!safeName || RESERVED_GUEST_NAMES.has(safeName.toLowerCase())) {
			return null;
		}
		const { badge, badgeType } = resolveRoleBadge("guest", false);
		const rawEmail =
			typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() : "";
		const email =
			/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(rawEmail) && rawEmail.length <= 128
				? rawEmail
				: "";
		const userKey = String(parsed.user.userKey);
		const isIsolated =
			parsed.isolated === true ||
			parsed.user.isolated === true ||
			isIsolatedGuestUserKey(userKey);

		return {
			user: {
				userKey,
				authType: "guest",
				name: safeName,
				avatar:
					typeof parsed.user.avatar === "string" &&
					parsed.user.avatar.startsWith("http")
						? parsed.user.avatar
						: "",
				url: sanitizeWebsiteUrl(parsed.user.url),
				badge,
				badgeType,
				isAdmin: false,
				...(isIsolated ? { isolated: true, notifyEmail: false } : {}),
			},
			email,
			...(isIsolated ? { isolated: true } : {}),
		};
	} catch {
		return null;
	}
}

export async function verifyGuestToken(
	env: Env,
	token: string,
): Promise<VerifiedUser | null> {
	const session = await verifyGuestTokenWithEmail(env, token);
	return session ? session.user : null;
}

export function isReservedGuestName(name: string): boolean {
	return RESERVED_GUEST_NAMES.has(sanitizeDisplayName(name).toLowerCase());
}
