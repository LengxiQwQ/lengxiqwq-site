import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	issueGuestSession,
	type VerifiedUser,
	verifyWalineToken,
} from "./auth/verify.js";
import { INTERCONNECT_ROOM } from "./do/matrix-bridge.js";
import { RoomDO } from "./do/room.js";
import { isValidRoomId, LIBRARY_ROOM_ID } from "./do/room-ids.js";
import type { Env } from "./env.js";
import { createMusicRegistry } from "./music/registry.js";
import { verifyStreamProxyToken } from "./music/stream-signer.js";
import { isOriginAllowed } from "./utils/cors.js";

export { RoomDO };

const app = new Hono<{ Bindings: Env }>();

function getEdgeCache(): Cache | undefined {
	if (typeof caches === "undefined") return undefined;
	return (caches as unknown as { default?: Cache }).default;
}

app.use(
	"*",
	cors({
		origin: (origin, c) => {
			if (!origin) return "*";
			return isOriginAllowed(origin, c.env.ALLOWED_ORIGINS) ? origin : "";
		},
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization", "Range"],
		exposeHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
		maxAge: 86400,
	}),
);

app.get("/api/health", (c) => {
	const registry = createMusicRegistry(c.env);
	return c.json({
		ok: true,
		service: "lengxiqwq-chat-worker",
		providers: registry.listProviders(),
	});
});

app.get("/ws", async (c) => {
	const origin = c.req.header("Origin");
	if (origin && !isOriginAllowed(origin, c.env.ALLOWED_ORIGINS)) {
		return c.json({ ok: false, error: "Forbidden origin" }, 403);
	}

	const roomId = (c.req.query("room") || "chat").trim().toLowerCase();
	if (!isValidRoomId(roomId)) {
		return c.json({ ok: false, error: "Invalid room id" }, 400);
	}

	const stub = c.env.CHAT_ROOMS.get(c.env.CHAT_ROOMS.idFromName(roomId));
	return stub.fetch(c.req.raw);
});

app.get("/api/interconnect/media/:id", (c) => {
	const id = c.req.param("id");
	if (!/^[a-f0-9-]{36}$/.test(id)) return c.notFound();
	const rooms = c.env.CHAT_ROOMS;
	return rooms.get(rooms.idFromName(INTERCONNECT_ROOM)).fetch(
		`https://room.internal/interconnect/media/${id}?room=${INTERCONNECT_ROOM}`,
	);
});

async function requireAdmin(
	c: Context<{ Bindings: Env }>,
): Promise<Response | null> {
	const authHeader = c.req.header("Authorization") || "";
	const token = authHeader.replace(/^Bearer\s+/i, "").trim();
	if (!token) {
		return c.json({ ok: false, error: "缺少管理员认证令牌" }, 401);
	}
	const user = await verifyWalineToken(c.env, token);
	if (!user) {
		return c.json({ ok: false, error: "登录已过期或无效" }, 401);
	}
	if (!user.isAdmin) {
		return c.json({ ok: false, error: "仅站长可执行该管理操作" }, 403);
	}
	return null;
}

app.get("/api/admin/messages", async (c) => {
	const denied = await requireAdmin(c);
	if (denied) return denied;

	const roomId = (c.req.query("room") || "chat").trim().toLowerCase();
	if (!/^[a-z0-9_-]{1,24}$/.test(roomId)) {
		return c.json({ ok: false, error: "Invalid room id" }, 400);
	}

	const filter = (c.req.query("filter") || "all").trim();
	const limit = (c.req.query("limit") || "100").trim();
	const beforeId = (c.req.query("beforeId") || "0").trim();

	const stub = c.env.CHAT_ROOMS.get(c.env.CHAT_ROOMS.idFromName(roomId));
	const internalUrl = new URL("https://room.internal/admin/messages");
	internalUrl.searchParams.set("room", roomId);
	internalUrl.searchParams.set("filter", filter);
	internalUrl.searchParams.set("limit", limit);
	if (beforeId !== "0") {
		internalUrl.searchParams.set("beforeId", beforeId);
	}

	const resp = await stub.fetch(internalUrl.toString());
	const data = await resp.json();
	return c.json(data, resp.status as 200 | 400 | 500);
});

app.get("/api/admin/members", async (c) => {
	const denied = await requireAdmin(c);
	if (denied) return denied;

	const roomId = (c.req.query("room") || "chat").trim().toLowerCase();
	if (!/^[a-z0-9_-]{1,24}$/.test(roomId)) {
		return c.json({ ok: false, error: "Invalid room id" }, 400);
	}

	const stub = c.env.CHAT_ROOMS.get(c.env.CHAT_ROOMS.idFromName(roomId));
	const resp = await stub.fetch(
		`https://room.internal/admin/members?room=${encodeURIComponent(roomId)}`,
	);
	const data = await resp.json();
	return c.json(data, resp.status as 200 | 400 | 500);
});

app.post("/api/admin/members/merge", async (c) => {
	const denied = await requireAdmin(c);
	if (denied) return denied;

	const roomId = (c.req.query("room") || "chat").trim().toLowerCase();
	if (!/^[a-z0-9_-]{1,24}$/.test(roomId)) {
		return c.json({ ok: false, error: "Invalid room id" }, 400);
	}

	const bodyText = await c.req.text();
	const stub = c.env.CHAT_ROOMS.get(c.env.CHAT_ROOMS.idFromName(roomId));
	const resp = await stub.fetch(
		`https://room.internal/admin/members/merge?room=${encodeURIComponent(roomId)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: bodyText,
		},
	);
	const data = await resp.json();
	return c.json(data, resp.status as 200 | 400 | 404 | 500);
});

app.post("/api/admin/members/delete", async (c) => {
	const denied = await requireAdmin(c);
	if (denied) return denied;

	const roomId = (c.req.query("room") || "chat").trim().toLowerCase();
	if (!/^[a-z0-9_-]{1,24}$/.test(roomId)) {
		return c.json({ ok: false, error: "Invalid room id" }, 400);
	}

	const bodyText = await c.req.text();
	const stub = c.env.CHAT_ROOMS.get(c.env.CHAT_ROOMS.idFromName(roomId));
	const resp = await stub.fetch(
		`https://room.internal/admin/members/delete?room=${encodeURIComponent(roomId)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: bodyText,
		},
	);
	const data = await resp.json();
	return c.json(data, resp.status as 200 | 400 | 500);
});

app.get("/api/rooms/summary", async (c) => {
	const rooms = (c.env.DEFAULT_ROOMS || "chat")
		.split(",")
		.map((r) => r.trim().toLowerCase())
		.filter((r) => /^[a-z0-9_-]{1,24}$/.test(r));

	const summaries = await Promise.all(
		rooms.map(async (roomId) => {
			const stub = c.env.CHAT_ROOMS.get(c.env.CHAT_ROOMS.idFromName(roomId));
			const resp = await stub.fetch(
				`https://room.internal/summary?room=${encodeURIComponent(roomId)}`,
			);
			return resp.json();
		}),
	);

	return c.json({ ok: true, rooms: summaries });
});

app.get("/api/presence", async (c) => {
	const rooms = (c.env.DEFAULT_ROOMS || "chat").split(",")
		.map((room) => room.trim().toLowerCase())
		.filter((room) => /^[a-z0-9_-]{1,24}$/.test(room));
	const snapshots = await Promise.all(rooms.map(async (room) => {
		const stub = c.env.CHAT_ROOMS.get(c.env.CHAT_ROOMS.idFromName(room));
		const response = await stub.fetch(`https://room.internal/presence-snapshot?room=${encodeURIComponent(room)}`);
		if (!response.ok) throw new Error("Presence unavailable");
		return response.json() as Promise<{ members: Array<{ userKey: string; isAdmin: boolean; name: string }>; observerCount: number }>;
	}));
	const members = new Map<string, (typeof snapshots)[number]["members"][number]>();
	let observerCount = 0;
	for (const snapshot of snapshots) {
		for (const member of snapshot.members) members.set(member.userKey, member);
		observerCount += snapshot.observerCount;
	}
	return c.json({ members: [...members.values()].sort((a, b) => Number(b.isAdmin) - Number(a.isAdmin) || a.name.localeCompare(b.name, "zh-CN")), observerCount, totalCount: members.size + observerCount });
});

type MemberDirectoryRow = {
	userKey: string;
	authType: string;
	name: string;
	avatar: string;
	url: string;
	badge: string;
	badgeType: string;
	isAdmin: boolean;
	bio: string;
	status: string;
	lastSeenAt: number;
};

app.get("/api/members", async (c) => {
	const rooms = getRoomIdsForAuthCheck(c.env);
	const directories = await Promise.all(
		rooms.map(async (room) => {
			const stub = c.env.CHAT_ROOMS.get(c.env.CHAT_ROOMS.idFromName(room));
			try {
				const response = await stub.fetch(
					`https://room.internal/member-directory?room=${encodeURIComponent(room)}`,
				);
				if (!response.ok) return [] as MemberDirectoryRow[];
				const data = (await response.json()) as {
					members: MemberDirectoryRow[];
				};
				return data.members;
			} catch {
				return [] as MemberDirectoryRow[];
			}
		}),
	);
	const merged = new Map<string, MemberDirectoryRow>();
	for (const members of directories) {
		for (const member of members) {
			const previous = merged.get(member.userKey);
			if (!previous || (member.lastSeenAt || 0) > (previous.lastSeenAt || 0)) {
				merged.set(member.userKey, member);
			}
		}
	}
	const list = [...merged.values()].sort(
		(a, b) =>
			Number(b.isAdmin) - Number(a.isAdmin) ||
			(b.lastSeenAt || 0) - (a.lastSeenAt || 0) ||
			a.name.localeCompare(b.name, "zh-CN"),
	);
	return c.json({ ok: true, members: list });
});

app.get("/api/rooms/member", async (c) => {
	const roomId = (c.req.query("room") || "chat").trim().toLowerCase();
	if (!/^[a-z0-9_-]{1,24}$/.test(roomId)) {
		return c.json({ ok: false, error: "Invalid room id" }, 400);
	}
	const userKey = (c.req.query("userKey") || "").trim();
	if (!userKey) {
		return c.json({ ok: false, error: "缺少 userKey" }, 400);
	}

	const tracksLimit = c.req.query("tracksLimit");
	const authHeader = c.req.header("Authorization") || "";
	const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
	const token = bearerMatch ? bearerMatch[1].trim() : "";
	const headers = new Headers();
	if (token) {
		const viewer = await verifyWalineToken(c.env, token);
		if (viewer) {
			headers.set("X-Chat-User", JSON.stringify(viewer));
		}
	}

	// 成员资料在各房间各有一份副本，当前房间查不到时依次回退到其它房间。
	const candidates = [
		roomId,
		...getRoomIdsForAuthCheck(c.env, roomId).filter((id) => id !== roomId),
	];
	let data: { ok: boolean; profile?: { playlists: unknown[] } } | null = null;
	let status = 404;
	for (const candidate of candidates) {
		const stub = c.env.CHAT_ROOMS.get(
			c.env.CHAT_ROOMS.idFromName(candidate),
		);
		const targetUrl = new URL("https://room.internal/member-profile");
		targetUrl.searchParams.set("room", candidate);
		targetUrl.searchParams.set("userKey", userKey);
		if (tracksLimit) {
			targetUrl.searchParams.set("tracksLimit", tracksLimit);
		}
		const resp = await stub.fetch(targetUrl.toString(), { headers });
		const payload = (await resp.json()) as {
			ok: boolean;
			profile?: { playlists: unknown[] };
		};
		if (resp.ok && payload.profile) {
			data = payload;
			status = resp.status;
			break;
		}
		if (!data) {
			data = payload;
			status = resp.status;
		}
	}
	if (!data?.profile) {
		return c.json(
			data ?? { ok: false, error: "成员不存在" },
			status as 200 | 400 | 404 | 500,
		);
	}

	const library = c.env.CHAT_ROOMS.get(
		c.env.CHAT_ROOMS.idFromName(LIBRARY_ROOM_ID),
	);
	const migration = await library.fetch(
		"https://room.internal/library-migrate?room=library",
	);
	if (migration.ok) {
		const playlistUrl = new URL("https://room.internal/member-playlists");
		playlistUrl.searchParams.set("room", LIBRARY_ROOM_ID);
		playlistUrl.searchParams.set("featuredRoom", roomId);
		playlistUrl.searchParams.set("userKey", userKey);
		const playlistResponse = await library.fetch(playlistUrl.toString(), {
			headers,
		});
		if (playlistResponse.ok) {
			const sharedData = (await playlistResponse.json()) as {
				playlists: unknown[];
			};
			data.profile.playlists = sharedData.playlists;
		}
	}
	return c.json(data, status as 200 | 400 | 404 | 500);
});

app.get("/api/rooms/member/tracks", async (c) => {
	const roomId = (c.req.query("room") || "chat").trim().toLowerCase();
	if (!/^[a-z0-9_-]{1,24}$/.test(roomId)) {
		return c.json({ ok: false, error: "Invalid room id" }, 400);
	}
	const userKey = (c.req.query("userKey") || "").trim();
	if (!userKey) {
		return c.json({ ok: false, error: "缺少 userKey" }, 400);
	}

	const stub = c.env.CHAT_ROOMS.get(c.env.CHAT_ROOMS.idFromName(roomId));
	const targetUrl = new URL("https://room.internal/member-tracks");
	targetUrl.searchParams.set("room", roomId);
	targetUrl.searchParams.set("userKey", userKey);
	const limit = c.req.query("limit");
	const beforeId = c.req.query("beforeId");
	if (limit) targetUrl.searchParams.set("limit", limit);
	if (beforeId) targetUrl.searchParams.set("beforeId", beforeId);
	const edgeCache = getEdgeCache();
	const tracksCacheUrl = new URL(
		"https://cache.internal/api/rooms/member/tracks",
	);
	tracksCacheUrl.searchParams.set("room", roomId);
	tracksCacheUrl.searchParams.set("userKey", userKey);
	if (limit) tracksCacheUrl.searchParams.set("limit", limit);
	if (beforeId) tracksCacheUrl.searchParams.set("beforeId", beforeId);
	const tracksCacheKey = new Request(tracksCacheUrl.toString(), {
		method: "GET",
	});
	if (edgeCache) {
		const cached = await edgeCache.match(tracksCacheKey);
		if (cached) {
			return new Response(cached.body, cached);
		}
	}

	const resp = await stub.fetch(targetUrl.toString());
	const data = await resp.json();
	if (resp.ok) {
		const out = new Response(JSON.stringify(data), {
			status: resp.status,
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": "public, max-age=180",
			},
		});
		if (edgeCache) {
			c.executionCtx.waitUntil(edgeCache.put(tracksCacheKey, out.clone()));
		}
		return out;
	}
	return c.json(data, resp.status as 200 | 400 | 404 | 500);
});

function getRoomIdsForAuthCheck(env: Env, preferredRoom?: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const pushIfValid = (raw: string | undefined) => {
		const id = (raw || "").trim().toLowerCase();
		if (!id || !isValidRoomId(id) || seen.has(id)) return;
		seen.add(id);
		out.push(id);
	};
	pushIfValid(preferredRoom);
	for (const r of (env.DEFAULT_ROOMS || "chat").split(",")) {
		pushIfValid(r);
	}
	if (out.length === 0) {
		out.push("chat");
	}
	return out;
}

app.post("/api/auth/guest", async (c) => {
	let body: Record<string, unknown>;
	try {
		body = (await c.req.json()) as Record<string, unknown>;
	} catch {
		return c.json({ ok: false, error: "请求体格式错误" }, 400);
	}

	const allowSplitGuest = body.allowSplitGuest === true;
	const result = await issueGuestSession(c.env, {
		nickname: typeof body.nickname === "string" ? body.nickname : "",
		email: typeof body.email === "string" ? body.email : "",
		url: typeof body.url === "string" ? body.url : "",
		badge: typeof body.badge === "string" ? body.badge : "",
		allowSplitGuest,
	});

	if (!result.ok) {
		return c.json(
			{
				ok: false,
				error: result.error,
				...(result.code ? { code: result.code } : {}),
				...(result.allowSplitGuest !== undefined
					? { allowSplitGuest: result.allowSplitGuest }
					: {}),
			},
			result.status as 400 | 403 | 500,
		);
	}

	if (!allowSplitGuest) {
		const preferredRoom =
			typeof body.room === "string" ? body.room : c.req.query("room") || "";
		const roomIds = getRoomIdsForAuthCheck(c.env, preferredRoom);
		for (const roomId of roomIds) {
			try {
				const stub = c.env.CHAT_ROOMS.get(c.env.CHAT_ROOMS.idFromName(roomId));
				const checkUrl = new URL("https://room.internal/check-waline-email");
				checkUrl.searchParams.set("room", roomId);
				checkUrl.searchParams.set("email", result.email);
				const resp = await stub.fetch(checkUrl.toString());
				if (resp.ok) {
					const checkData = (await resp.json()) as {
						ok?: boolean;
						exists?: boolean;
					};
					if (checkData.ok && checkData.exists) {
						return c.json(
							{
								ok: false,
								code: "WALINE_LOGIN_REQUIRED",
								allowSplitGuest: true,
								error:
									"该邮箱已绑定 Waline 正式账号。如需保留原身份与历史记录请通过 Waline 账号登录；也可选择新建独立临时身份直接进入",
							},
							409,
						);
					}
				}
			} catch {
				// Continue checking remaining rooms if one fails
			}
		}
	}

	return c.json({
		ok: true,
		token: result.token,
		user: result.user,
	});
});

app.post("/api/auth/waline-verify", async (c) => {
	let body: { token?: unknown };
	try {
		body = (await c.req.json()) as { token?: unknown };
	} catch {
		return c.json({ ok: false, error: "请求体格式错误" }, 400);
	}

	const token = typeof body.token === "string" ? body.token : "";
	if (!token) {
		return c.json({ ok: false, error: "缺少登录 Token" }, 400);
	}

	const user = await verifyWalineToken(c.env, token);
	if (!user) {
		return c.json({ ok: false, error: "Waline 登录已过期或无效" }, 401);
	}

	return c.json({ ok: true, user });
});

async function notifyPlaylistRooms(
	env: Env,
	roomIds: string[],
): Promise<void> {
	const seen = new Set<string>();
	await Promise.all(
		roomIds.map(async (roomId) => {
			const id = (roomId || "").trim().toLowerCase();
			if (!id || seen.has(id) || !isValidRoomId(id)) return;
			seen.add(id);
			const stub = env.CHAT_ROOMS.get(env.CHAT_ROOMS.idFromName(id));
			try {
				await stub.fetch(
					`https://room.internal/playlist-changed?room=${encodeURIComponent(id)}`,
					{ method: "POST" },
				);
			} catch {
				// 单个房间同步失败不影响歌单写入结果
			}
		}),
	);
}

async function forwardRoomPlaylistRequest(
	c: Context<{ Bindings: Env }>,
	doPath: string,
	options: { requireAuth: boolean; method: "GET" | "POST" },
): Promise<Response> {
	const roomId = (c.req.query("room") || "chat").trim().toLowerCase();
	if (!isValidRoomId(roomId)) {
		return c.json({ ok: false, error: "Invalid room id" }, 400);
	}

	const authHeader = c.req.header("Authorization") || "";
	const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
	const token = bearerMatch ? bearerMatch[1].trim() : "";

	let user: VerifiedUser | null = null;
	if (token) {
		user = await verifyWalineToken(c.env, token);
	}

	if (options.requireAuth && !user) {
		return c.json({ ok: false, error: "请先登录账号后再操作歌单" }, 401);
	}

	const library = c.env.CHAT_ROOMS.get(
		c.env.CHAT_ROOMS.idFromName(LIBRARY_ROOM_ID),
	);
	const migration = await library.fetch(
		"https://room.internal/library-migrate?room=library",
	);
	if (!migration.ok) {
		return c.json({ ok: false, error: "歌单库初始化失败，请稍后重试" }, 503);
	}

	const targetUrl = new URL(`https://room.internal${doPath}`);
	targetUrl.searchParams.set("room", LIBRARY_ROOM_ID);
	targetUrl.searchParams.set("featuredRoom", roomId);
	const idParam = c.req.query("id");
	if (idParam) {
		targetUrl.searchParams.set("id", idParam);
	}
	const includeTracksParam = c.req.query("includeTracks");
	if (includeTracksParam) {
		targetUrl.searchParams.set("includeTracks", includeTracksParam);
	}

	const headers = new Headers();
	if (user) {
		headers.set("X-Chat-User", JSON.stringify(user));
	}
	if (options.method === "POST") {
		headers.set("Content-Type", "application/json");
	}

	const bodyText = options.method === "POST" ? await c.req.text() : undefined;
	const doResp = await library.fetch(targetUrl.toString(), {
		method: options.method,
		headers,
		body: bodyText,
	});
	const result = (await doResp.json()) as Record<string, any>;

	if (doResp.ok && options.method === "POST") {
		await notifyPlaylistRooms(c.env, getRoomIdsForAuthCheck(c.env, roomId));
	}

	const respHeaders: Record<string, string> = {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	};
	return new Response(JSON.stringify(result), {
		status: doResp.status,
		headers: respHeaders,
	});
}

app.get("/api/playlists", (c) =>
	forwardRoomPlaylistRequest(c, "/playlists", {
		requireAuth: false,
		method: "GET",
	}),
);

app.get("/api/playlists/detail", (c) =>
	forwardRoomPlaylistRequest(c, "/playlists/detail", {
		requireAuth: false,
		method: "GET",
	}),
);

app.post("/api/playlists/import", (c) =>
	forwardRoomPlaylistRequest(c, "/playlists/import", {
		requireAuth: true,
		method: "POST",
	}),
);

app.post("/api/playlists/refresh", (c) =>
	forwardRoomPlaylistRequest(c, "/playlists/refresh", {
		requireAuth: true,
		method: "POST",
	}),
);

app.post("/api/playlists/flags", (c) =>
	forwardRoomPlaylistRequest(c, "/playlists/flags", {
		requireAuth: true,
		method: "POST",
	}),
);

app.post("/api/playlists/delete", (c) =>
	forwardRoomPlaylistRequest(c, "/playlists/delete", {
		requireAuth: true,
		method: "POST",
	}),
);

app.get("/api/music/search", async (c) => {
	const q = (c.req.query("q") || "").trim();
	if (!q) {
		return c.json({ ok: true, tracks: [] });
	}
	const provider = (c.req.query("provider") || "").trim() || undefined;
	const limit = Math.min(
		20,
		Math.max(1, Number.parseInt(c.req.query("limit") || "12", 10) || 12),
	);

	const edgeCache = getEdgeCache();
	const cacheUrl = new URL("https://cache.internal/api/music/search");
	cacheUrl.searchParams.set("q", q);
	if (provider) cacheUrl.searchParams.set("provider", provider);
	cacheUrl.searchParams.set("limit", String(limit));
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

	if (edgeCache) {
		const cached = await edgeCache.match(cacheKey);
		if (cached) {
			return new Response(cached.body, cached);
		}
	}

	const registry = createMusicRegistry(c.env);
	const tracks = await registry.search(q, limit, provider);
	const resp = new Response(
		JSON.stringify({
			ok: true,
			providers: registry.listProviders(),
			tracks,
		}),
		{
			status: 200,
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": "public, max-age=600",
			},
		},
	);
	if (edgeCache) {
		c.executionCtx.waitUntil(edgeCache.put(cacheKey, resp.clone()));
	}
	return resp;
});

app.get("/api/music/lyric", async (c) => {
	const provider = (c.req.query("provider") || "qq").trim();
	const id = (c.req.query("id") || "").trim();
	if (!id) {
		return c.text("", 404);
	}

	const edgeCache = getEdgeCache();
	const cacheUrl = new URL("https://cache.internal/api/music/lyric");
	cacheUrl.searchParams.set("provider", provider);
	cacheUrl.searchParams.set("id", id);
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

	if (edgeCache) {
		const cached = await edgeCache.match(cacheKey);
		if (cached) {
			return new Response(cached.body, cached);
		}
	}

	const registry = createMusicRegistry(c.env);
	const lyric = await registry.getLyric(provider, id);
	if (!lyric) {
		return c.text("", 404);
	}

	const resp = new Response(lyric, {
		status: 200,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
	if (edgeCache) {
		c.executionCtx.waitUntil(edgeCache.put(cacheKey, resp.clone()));
	}
	return resp;
});

app.get("/api/music/stream", async (c) => {
	const token = c.req.query("token") || "";
	const signSecret = c.env.STREAM_SIGN_SECRET || "dev-stream-secret";
	const verified = await verifyStreamProxyToken(token, signSecret);
	if (!verified) {
		return c.json({ ok: false, error: "无效或已过期的音频代理签名" }, 403);
	}

	const upstreamHeaders = new Headers();
	upstreamHeaders.set(
		"User-Agent",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	);
	if (verified.referer) {
		upstreamHeaders.set("Referer", verified.referer);
	}
	const rangeHeader = c.req.header("Range");
	if (rangeHeader) {
		upstreamHeaders.set("Range", rangeHeader);
	}

	let upstream: Response;
	try {
		upstream = await fetch(verified.url, {
			method: "GET",
			headers: upstreamHeaders,
			redirect: "follow",
		});
	} catch {
		return c.json({ ok: false, error: "上游音频流拉取失败" }, 502);
	}

	if (!upstream.ok && upstream.status !== 206) {
		return c.json(
			{ ok: false, error: `上游音频服务返回 ${upstream.status}` },
			502,
		);
	}

	const outHeaders = new Headers();
	const passHeaders = [
		"content-length",
		"content-range",
		"accept-ranges",
		"etag",
		"last-modified",
	];
	for (const key of passHeaders) {
		const val = upstream.headers.get(key);
		if (val) outHeaders.set(key, val);
	}
	const upstreamContentType = (
		upstream.headers.get("content-type") || ""
	).toLowerCase();
	outHeaders.set(
		"content-type",
		upstreamContentType.startsWith("audio/")
			? upstreamContentType
			: verified.mimeType,
	);
	if (!outHeaders.has("accept-ranges")) {
		outHeaders.set("accept-ranges", "bytes");
	}
	outHeaders.set("cache-control", "public, max-age=1800");

	return new Response(upstream.body, {
		status: upstream.status,
		headers: outHeaders,
	});
});

export default app;
