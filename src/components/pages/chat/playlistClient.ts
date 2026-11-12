import { normalizeServerUrl } from "./chatClient";
import type {
	PlaylistDetail,
	PlaylistImportPayload,
	PlaylistSummary,
	PlaylistsResponse,
	PlaylistTrackItem,
} from "./chatTypes";
import type { ChatMusicTrack } from "./musicTypes";

export const DEFAULT_PLAYLISTOUT_API_URL =
	"https://playlistout-api.lengxiqwq.com";
export const MAX_PLAYLIST_TRACKS = 3000;

interface RawPlaylistOutTrack {
	title?: unknown;
	artist?: unknown;
	album?: unknown;
	id?: unknown;
	durationMs?: unknown;
	sourceUrl?: unknown;
	coverUrl?: unknown;
}

interface RawPlaylistOutPlaylist {
	platform?: unknown;
	id?: unknown;
	name?: unknown;
	creator?: unknown;
	coverUrl?: unknown;
	sourceUrl?: unknown;
	tracks?: unknown;
	retrieval?: {
		mode?: unknown;
		message?: unknown;
	};
}

export interface UserPlaylistCandidate {
	id: string;
	name: string;
	coverUrl: string;
	trackCount: number;
	sourceUrl: string;
	platform: string;
}

export interface AmbiguousResolveCandidate {
	id: string;
	kind: "playlist" | "user";
	platform: string;
	title: string;
	subtitle?: string;
	trackCount?: number;
	coverUrl?: string;
}

export type PlaylistOutResolveResult =
	| {
			kind: "playlist";
			payload: PlaylistImportPayload;
			retrievalMessage?: string;
	  }
	| {
			kind: "user";
			platform: string;
			nickname: string;
			playlists: UserPlaylistCandidate[];
	  }
	| {
			kind: "ambiguous";
			query: string;
			candidates: AmbiguousResolveCandidate[];
	  };

const PLATFORM_LABELS: Record<string, string> = {
	qqmusic: "QQ 音乐",
	netease: "网易云音乐",
	kugou: "酷狗音乐",
	kuwo: "酷我音乐",
	qishui: "汽水音乐",
	migu: "咪咕音乐",
};

export function formatPlatformLabel(platform: string): string {
	const key = platform.trim().toLowerCase();
	return PLATFORM_LABELS[key] || (platform ? platform.toUpperCase() : "外链");
}

function normalizePlaylistOutPlaylist(
	raw: RawPlaylistOutPlaylist,
	fallbackInputUrl: string,
): { payload: PlaylistImportPayload; retrievalMessage?: string } {
	const platform =
		typeof raw.platform === "string" && raw.platform.trim()
			? raw.platform.trim().toLowerCase()
			: "external";
	const title =
		typeof raw.name === "string" && raw.name.trim()
			? raw.name.trim().slice(0, 80)
			: "未命名歌单";
	const sourceUrl =
		typeof raw.sourceUrl === "string" && raw.sourceUrl.trim()
			? raw.sourceUrl.trim()
			: fallbackInputUrl.trim();
	const coverUrl =
		typeof raw.coverUrl === "string" && raw.coverUrl.startsWith("https://")
			? raw.coverUrl
			: "";
	const creator =
		typeof raw.creator === "string" ? raw.creator.trim().slice(0, 80) : "";
	const retrievalMode =
		raw.retrieval?.mode === "preview" ? "preview" : ("full" as const);
	const retrievalMessage =
		typeof raw.retrieval?.message === "string" && raw.retrieval.message.trim()
			? raw.retrieval.message.trim()
			: undefined;

	const rawTracks = Array.isArray(raw.tracks)
		? (raw.tracks as RawPlaylistOutTrack[])
		: [];
	const truncatedNotice =
		rawTracks.length > MAX_PLAYLIST_TRACKS
			? `原歌单共 ${rawTracks.length} 首，已保留前 ${MAX_PLAYLIST_TRACKS} 首`
			: undefined;

	const tracks = rawTracks
		.slice(0, MAX_PLAYLIST_TRACKS)
		.map((item) => {
			const trackTitle =
				typeof item.title === "string" ? item.title.trim().slice(0, 120) : "";
			if (!trackTitle) return null;
			const artist =
				(typeof item.artist === "string"
					? item.artist.trim().slice(0, 120)
					: "") || "未知歌手";
			const album =
				typeof item.album === "string" ? item.album.trim().slice(0, 120) : "";
			const sourceTrackId =
				typeof item.id === "string" || typeof item.id === "number"
					? String(item.id).trim().slice(0, 80)
					: "";
			const cover =
				typeof item.coverUrl === "string" &&
				item.coverUrl.startsWith("https://")
					? item.coverUrl
					: "";
			const durationMs =
				typeof item.durationMs === "number" && Number.isFinite(item.durationMs)
					? item.durationMs
					: 0;
			const durationSec =
				durationMs > 0 ? Math.min(7200, Math.round(durationMs / 1000)) : 0;
			const trackSourceUrl =
				typeof item.sourceUrl === "string" &&
				item.sourceUrl.startsWith("https://")
					? item.sourceUrl
					: "";

			return {
				sourcePlatform: platform,
				sourceTrackId,
				title: trackTitle,
				artist,
				album,
				cover,
				durationSec,
				sourceUrl: trackSourceUrl,
			};
		})
		.filter((t): t is NonNullable<typeof t> => Boolean(t));

	if (tracks.length === 0) {
		throw new Error("未能在该链接中解析到任何歌曲，请检查歌单是否公开");
	}

	return {
		payload: {
			title,
			platform,
			sourceUrl,
			coverUrl: coverUrl || tracks.find((t) => t.cover)?.cover || "",
			creator,
			retrievalMode,
			tracks,
		},
		retrievalMessage: retrievalMessage || truncatedNotice,
	};
}

/**
 * Call PlaylistOut public API directly from the browser to parse a playlist link or user profile.
 */
export async function resolvePlaylistFromPlaylistOut(
	apiBaseUrl: string,
	rawInput: string,
	options?: { type?: "playlist" | "user"; platform?: string },
): Promise<PlaylistOutResolveResult> {
	const base = normalizeServerUrl(apiBaseUrl) || DEFAULT_PLAYLISTOUT_API_URL;
	const q = rawInput.trim();
	if (!q) {
		throw new Error("请粘贴歌单链接或分享文本");
	}

	const params = new URLSearchParams({ q });
	if (options?.type) params.set("type", options.type);
	if (options?.platform) params.set("platform", options.platform);

	let resp: Response;
	try {
		resp = await fetch(`${base}/api/v1/resolve?${params.toString()}`, {
			method: "GET",
			signal: AbortSignal.timeout(20000),
		});
	} catch {
		throw new Error("无法连接 Playlist Out 解析服务，请稍后再试");
	}

	const json = (await resp.json().catch(() => null)) as {
		success?: boolean;
		data?: {
			kind?: string;
			platform?: string;
			result?: unknown;
		};
		error?: {
			code?: string;
			message?: string;
			details?: {
				candidates?: AmbiguousResolveCandidate[];
			};
		};
	} | null;

	if (
		resp.status === 409 &&
		json?.error?.code === "AMBIGUOUS_INPUT" &&
		Array.isArray(json.error.details?.candidates) &&
		json.error.details.candidates.length > 0
	) {
		return {
			kind: "ambiguous",
			query: q,
			candidates: json.error.details.candidates,
		};
	}

	if (!resp.ok || !json?.success || !json.data) {
		throw new Error(
			json?.error?.message || `歌单解析失败（${resp.status || "网络错误"}）`,
		);
	}

	if (json.data.kind === "playlist") {
		const normalized = normalizePlaylistOutPlaylist(
			(json.data.result || {}) as RawPlaylistOutPlaylist,
			q,
		);
		return {
			kind: "playlist",
			payload: normalized.payload,
			retrievalMessage: normalized.retrievalMessage,
		};
	}

	if (json.data.kind === "user") {
		const userResult = (json.data.result || {}) as {
			platform?: string;
			nickname?: string;
			playlists?: Array<{
				id?: string;
				name?: string;
				coverUrl?: string;
				trackCount?: number;
				sourceUrl?: string;
			}>;
		};
		const platform =
			(typeof userResult.platform === "string" && userResult.platform) ||
			json.data.platform ||
			"external";
		const playlists = (userResult.playlists ?? [])
			.filter((p) => p && typeof p.sourceUrl === "string" && p.sourceUrl)
			.map((p) => ({
				id: String(p.id || ""),
				name: String(p.name || "未命名歌单"),
				coverUrl:
					typeof p.coverUrl === "string" && p.coverUrl.startsWith("https://")
						? p.coverUrl
						: "",
				trackCount: typeof p.trackCount === "number" ? p.trackCount : 0,
				sourceUrl: String(p.sourceUrl || ""),
				platform,
			}));
		if (playlists.length === 0) {
			throw new Error("该用户主页下没有找到公开歌单");
		}
		return {
			kind: "user",
			platform,
			nickname: String(userResult.nickname || "音乐用户"),
			playlists,
		};
	}

	throw new Error("暂不支持该链接类型的解析结果");
}

/**
 * Fetch a specific playlist by URL/ID directly from PlaylistOut `/api/playlist`.
 */
export async function fetchPlaylistByUrlFromPlaylistOut(
	apiBaseUrl: string,
	sourceUrl: string,
	platform?: string,
): Promise<{ payload: PlaylistImportPayload; retrievalMessage?: string }> {
	const base = normalizeServerUrl(apiBaseUrl) || DEFAULT_PLAYLISTOUT_API_URL;
	const params = new URLSearchParams({ url: sourceUrl });
	if (platform) params.set("platform", platform);

	let resp: Response;
	try {
		resp = await fetch(`${base}/api/playlist?${params.toString()}`, {
			method: "GET",
			signal: AbortSignal.timeout(20000),
		});
	} catch {
		throw new Error("无法连接 Playlist Out 解析服务，请稍后再试");
	}

	const json = (await resp.json().catch(() => null)) as {
		success?: boolean;
		data?: RawPlaylistOutPlaylist;
		error?: { message?: string };
	} | null;

	if (!resp.ok || !json?.success || !json.data) {
		throw new Error(
			json?.error?.message || `歌单拉取失败（${resp.status || "网络错误"}）`,
		);
	}

	return normalizePlaylistOutPlaylist(json.data, sourceUrl);
}

function buildAuthHeaders(walineToken?: string, hasBody = false): HeadersInit {
	const headers: Record<string, string> = {};
	if (hasBody) {
		headers["Content-Type"] = "application/json";
	}
	if (walineToken?.trim()) {
		headers.Authorization = `Bearer ${walineToken.trim()}`;
	}
	return headers;
}

export async function fetchRoomPlaylists(
	chatServerUrl: string,
	roomId: string,
	walineToken?: string,
): Promise<PlaylistsResponse> {
	const base = normalizeServerUrl(chatServerUrl);
	if (!base) return { featured: [], mine: [], shared: [] };
	const resp = await fetch(
		`${base}/api/playlists?room=${encodeURIComponent(roomId)}`,
		{
			method: "GET",
			headers: buildAuthHeaders(walineToken),
		},
	);
	const json = (await resp.json().catch(() => null)) as {
		ok?: boolean;
		featured?: PlaylistSummary[];
		mine?: PlaylistSummary[];
		shared?: PlaylistSummary[];
		error?: string;
	} | null;
	if (!resp.ok || !json?.ok) {
		if (resp.status === 404) {
			throw new Error("歌单接口尚未部署到聊天室后端（请先部署 chat-worker）");
		}
		throw new Error(json?.error || "获取歌单列表失败");
	}
	return {
		featured: Array.isArray(json.featured) ? json.featured : [],
		mine: Array.isArray(json.mine) ? json.mine : [],
		shared: Array.isArray(json.shared) ? json.shared : [],
	};
}

export async function fetchPlaylistDetail(
	chatServerUrl: string,
	roomId: string,
	playlistId: string,
	walineToken?: string,
): Promise<PlaylistDetail> {
	const base = normalizeServerUrl(chatServerUrl);
	const resp = await fetch(
		`${base}/api/playlists/detail?room=${encodeURIComponent(roomId)}&id=${encodeURIComponent(playlistId)}`,
		{
			method: "GET",
			headers: buildAuthHeaders(walineToken),
		},
	);
	const json = (await resp.json().catch(() => null)) as {
		ok?: boolean;
		playlist?: PlaylistDetail;
		error?: string;
	} | null;
	if (!resp.ok || !json?.ok || !json.playlist) {
		throw new Error(json?.error || "加载歌单详情失败");
	}
	return json.playlist;
}

export async function saveImportedPlaylist(
	chatServerUrl: string,
	roomId: string,
	walineToken: string,
	payload: PlaylistImportPayload,
): Promise<{ playlist: PlaylistSummary; updatedExisting: boolean }> {
	const base = normalizeServerUrl(chatServerUrl);
	const resp = await fetch(
		`${base}/api/playlists/import?room=${encodeURIComponent(roomId)}`,
		{
			method: "POST",
			headers: buildAuthHeaders(walineToken, true),
			body: JSON.stringify(payload),
		},
	);
	const json = (await resp.json().catch(() => null)) as {
		ok?: boolean;
		playlist?: PlaylistSummary;
		updatedExisting?: boolean;
		error?: string;
	} | null;
	if (!resp.ok || !json?.ok || !json.playlist) {
		throw new Error(json?.error || "保存歌单失败");
	}
	return {
		playlist: json.playlist,
		updatedExisting: Boolean(json.updatedExisting),
	};
}

export async function refreshSavedPlaylist(
	chatServerUrl: string,
	roomId: string,
	walineToken: string,
	playlistId: string,
	payload: PlaylistImportPayload,
): Promise<PlaylistSummary> {
	const base = normalizeServerUrl(chatServerUrl);
	const resp = await fetch(
		`${base}/api/playlists/refresh?room=${encodeURIComponent(roomId)}`,
		{
			method: "POST",
			headers: buildAuthHeaders(walineToken, true),
			body: JSON.stringify({ playlistId, playlist: payload }),
		},
	);
	const json = (await resp.json().catch(() => null)) as {
		ok?: boolean;
		playlist?: PlaylistSummary;
		error?: string;
	} | null;
	if (!resp.ok || !json?.ok || !json.playlist) {
		throw new Error(json?.error || "刷新歌单失败");
	}
	return json.playlist;
}

export async function updatePlaylistFlags(
	chatServerUrl: string,
	roomId: string,
	walineToken: string,
	playlistId: string,
	flags: { isPublic?: boolean; isFeatured?: boolean; isFallback?: boolean },
): Promise<PlaylistSummary> {
	const base = normalizeServerUrl(chatServerUrl);
	const resp = await fetch(
		`${base}/api/playlists/flags?room=${encodeURIComponent(roomId)}`,
		{
			method: "POST",
			headers: buildAuthHeaders(walineToken, true),
			body: JSON.stringify({ playlistId, ...flags }),
		},
	);
	const json = (await resp.json().catch(() => null)) as {
		ok?: boolean;
		playlist?: PlaylistSummary;
		error?: string;
	} | null;
	if (!resp.ok || !json?.ok || !json.playlist) {
		throw new Error(json?.error || "更新歌单设置失败");
	}
	return json.playlist;
}

export async function deleteSavedPlaylist(
	chatServerUrl: string,
	roomId: string,
	walineToken: string,
	playlistId: string,
): Promise<void> {
	const base = normalizeServerUrl(chatServerUrl);
	const resp = await fetch(
		`${base}/api/playlists/delete?room=${encodeURIComponent(roomId)}`,
		{
			method: "POST",
			headers: buildAuthHeaders(walineToken, true),
			body: JSON.stringify({ playlistId }),
		},
	);
	const json = (await resp.json().catch(() => null)) as {
		ok?: boolean;
		error?: string;
	} | null;
	if (!resp.ok || !json?.ok) {
		throw new Error(json?.error || "删除歌单失败");
	}
}

/**
 * Convert a stored playlist track into a ChatMusicTrack ready for music:enqueue.
 */
export function toEnqueueableTrack(
	item: PlaylistTrackItem,
	playlistId: string,
): ChatMusicTrack {
	if (item.matchedTrack) {
		return {
			...item.matchedTrack,
			cover: item.matchedTrack.cover || item.cover,
			durationSec: item.matchedTrack.durationSec || item.durationSec,
		};
	}
	return {
		id: `ext:${playlistId}:${item.position}`,
		provider: "external",
		sourceId: item.sourceTrackId || String(item.position),
		sourcePlatform: item.sourcePlatform,
		playlistId,
		position: item.position,
		title: item.title,
		artist: item.artist,
		album: item.album || undefined,
		cover: item.cover,
		durationSec: item.durationSec,
	};
}
