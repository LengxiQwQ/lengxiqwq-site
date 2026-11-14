<script lang="ts">
import { onMount, tick, untrack } from "svelte";
import ChatAvatar from "./ChatAvatar.svelte";
import { formatClockSeconds } from "./chatClient";
import type {
	ChatMentionCandidate,
	ChatOnlineMember,
	ChatSessionUser,
	ChatUserDetailSeed,
	MusicHistoryEntry,
	PlaylistDetail,
	PlaylistSummary,
	PlaylistTrackItem,
	QueueEntry,
	RoomMusicState,
} from "./chatTypes";
import MiniPlayerBar from "./MiniPlayerBar.svelte";
import ChatTooltip from "./ChatTooltip.svelte";
import type { ChatMusicTrack } from "./musicTypes";
import {
	type AmbiguousResolveCandidate,
	DEFAULT_PLAYLISTOUT_API_URL,
	deleteSavedPlaylist,
	fetchPlaylistByUrlFromPlaylistOut,
	fetchPlaylistDetail,
	fetchRoomPlaylists,
	formatPlatformLabel,
	refreshSavedPlaylist,
	resolvePlaylistFromPlaylistOut,
	saveImportedPlaylist,
	toEnqueueableTrack,
	type UserPlaylistCandidate,
	updatePlaylistFlags,
} from "./playlistClient";

interface Props {
	roomId: string;
	chatServerUrl?: string;
	playlistOutApiUrl?: string;
	walineToken?: string;
	playlistRefreshSeq?: number;
	fallbackTracks?: ChatMusicTrack[];
	musicState: RoomMusicState | null;
	currentUser: ChatSessionUser | null;
	onlineMemberCount: number;
	onlineMembers?: ChatOnlineMember[];
	mentionMembers?: ChatMentionCandidate[];
	clockOffsetMs: number;
	initialVolume?: number;
	onSearchOnline: (keyword: string) => Promise<ChatMusicTrack[]>;
	onEnqueueTrack: (track: ChatMusicTrack) => void;
	onRemoveQueue: (uid: string) => void;
	onPlayQueued: (uid: string) => void;
	isSkippingTrack?: boolean;
	onSkipTrack: () => void;
	onVoteSkip: () => void;
	onReportDuration: (playUid: string, durationSec: number) => void;
	onTrackEnded: (playUid: string) => void;
	onReportError: (playUid: string) => void;
	onRequestAuth?: () => void;
	onRequestWalineAuth?: () => void;
	walineLoginWaiting?: boolean;
	onOpenUserProfile?: (seed: ChatUserDetailSeed) => void;
	externalPlaylistRequest?: { playlistId: string; seq: number };
	onPlaybackStatusChange?: (status: {
		isListening: boolean;
		isMuted: boolean;
		elapsedSec: number;
		durationSec: number;
		canDirectSkip: boolean;
		isSoloCoolingDown: boolean;
		soloCooldownRemainSec: number;
		hasVotedSkip: boolean;
	}) => void;
	onNotify?: (message: string) => void;
}

interface LyricLine {
	time: number;
	text: string;
}

const {
	roomId,
	chatServerUrl = "",
	playlistOutApiUrl = DEFAULT_PLAYLISTOUT_API_URL,
	walineToken = "",
	playlistRefreshSeq = 0,
	fallbackTracks = [],
	musicState = null,
	currentUser = null,
	onlineMemberCount = 0,
	onlineMembers = [],
	mentionMembers = [],
	clockOffsetMs = 0,
	initialVolume = 1,
	onSearchOnline,
	onEnqueueTrack,
	onRemoveQueue,
	onPlayQueued,
	isSkippingTrack = false,
	onSkipTrack,
	onVoteSkip,
	onReportDuration,
	onTrackEnded,
	onReportError,
	onRequestAuth,
	onRequestWalineAuth,
	walineLoginWaiting = false,
	onOpenUserProfile,
	externalPlaylistRequest,
	onPlaybackStatusChange,
	onNotify,
}: Props = $props();

const initVol = untrack(() => {
	try {
		if (typeof window !== "undefined" && window.sessionStorage) {
			const saved = window.sessionStorage.getItem("chat:player:volume");
			if (saved !== null) {
				const n = Number.parseFloat(saved);
				if (Number.isFinite(n)) return Math.min(1, Math.max(0, n));
			}
		}
	} catch {
		// Ignore storage error
	}
	return Number.isFinite(initialVolume) ? Math.min(1, Math.max(0, initialVolume)) : 1;
});

type MusicTab = "player" | "search" | "playlist" | "history";
type HistorySortMode = "recent" | "count";
type PlayerPaneMode = "split" | "lyrics" | "queue";

interface HistoryRequesterOption {
	key: string;
	name: string;
	avatar: string;
	badge: string;
	trackCount: number;
	totalRequests: number;
	isMe: boolean;
}

let activeTab = $state<MusicTab>("player");
let historySort = $state<HistorySortMode>("recent");
let selectedRequesterKey = $state("");
let showRequesterFilter = $state(false);
let isListening = $state(false);
let hasJoinedAudio = $state(false);
let isSyncingAudio = false;
let syncAudioSeq = 0;
let internalAudioAction = false;
let playerPaneMode = $state<PlayerPaneMode>("split");
let lyricsScrolling = $state(false);
let queueScrolling = $state(false);
let lyricsScrollHideTimer: number | null = null;
let queueScrollHideTimer: number | null = null;
let programmaticLyricScrollUntil = 0;
let roomElapsed = $state(0);

function triggerLyricsScroll() {
	lyricsScrolling = true;
	if (lyricsScrollHideTimer !== null) {
		window.clearTimeout(lyricsScrollHideTimer);
	}
	lyricsScrollHideTimer = window.setTimeout(() => {
		lyricsScrolling = false;
		lyricsScrollHideTimer = null;
	}, 950);
}

function triggerQueueScroll() {
	queueScrolling = true;
	if (queueScrollHideTimer !== null) {
		window.clearTimeout(queueScrollHideTimer);
	}
	queueScrollHideTimer = window.setTimeout(() => {
		queueScrolling = false;
		queueScrollHideTimer = null;
	}, 950);
}

function cyclePlayerPaneMode() {
	playerPaneMode =
		playerPaneMode === "split"
			? "lyrics"
			: playerPaneMode === "lyrics"
				? "queue"
				: "split";
	if (playerPaneMode !== "queue" && activeLyricIndex >= 0) {
		void scrollLyricToCenter(activeLyricIndex, true);
	}
}
let localDuration = $state(0);
let volume = $state(initVol);
let coverLoadFailed = $state(false);

// 搜索相关状态
let searchQuery = $state("");
let searchResults = $state<ChatMusicTrack[]>([]);
let isSearching = $state(false);
let searchError = $state("");
let searchTimer: number | null = null;

// 歌单相关状态
let featuredCollapsed = $state(false);
let myCollapsed = $state(false);
let membersCollapsed = $state(false);
let featuredPlaylists = $state<PlaylistSummary[]>([]);
let myPlaylists = $state<PlaylistSummary[]>([]);
let membersPlaylists = $state<PlaylistSummary[]>([]);

const memberAvatarByKey = $derived.by(() => {
	const map = new Map<string, string>();
	for (const member of mentionMembers) {
		if (member.avatar) map.set(member.userKey, member.avatar);
	}
	return map;
});

const memberPlaylistGroups = $derived.by(() => {
	const groups = new Map<
		string,
		{
			ownerKey: string;
			ownerName: string;
			ownerAvatar: string;
			updatedAt: number;
			playlists: PlaylistSummary[];
		}
	>();
	for (const pl of membersPlaylists) {
		const key = pl.ownerKey || "unknown";
		const existing = groups.get(key);
		if (existing) {
			existing.playlists.push(pl);
			existing.updatedAt = Math.max(existing.updatedAt, pl.updatedAt || 0);
		} else {
			groups.set(key, {
				ownerKey: key,
				ownerName: pl.ownerName || "房友",
				ownerAvatar: pl.ownerAvatar || memberAvatarByKey.get(key) || "",
				updatedAt: pl.updatedAt || 0,
				playlists: [pl],
			});
		}
	}
	return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt);
});
let isLoadingPlaylists = $state(false);
let playlistsError = $state("");
let selectedPlaylist = $state<PlaylistDetail | null>(null);
let isLoadingPlaylistDetail = $state(false);
let enqueuingTrackIds = $state(new Set<string>());
let isRandomizing = $state(false);
let playlistTrackFilter = $state("");
let importInput = $state("");
let isImportingPlaylist = $state(false);
let importStatusText = $state("");
let importError = $state("");
let pendingUserImport = $state<{
	platform: string;
	nickname: string;
	playlists: UserPlaylistCandidate[];
} | null>(null);
let pendingAmbiguousImport = $state<{
	query: string;
	candidates: AmbiguousResolveCandidate[];
} | null>(null);
let isRefreshingPlaylistId = $state("");
let isUpdatingFlagsId = $state("");
let confirmDeletePlaylistId = $state("");
let isDeletingPlaylistId = $state("");
let confirmDeleteTimer: number | null = null;
let playlistVisibleLimit = $state(100);

// 歌词状态
let lyrics = $state<LyricLine[]>([]);
let lyricsStatus = $state<"idle" | "loading" | "ready" | "empty">("idle");
let activeLyricIndex = $state(-1);

let audioEl: HTMLAudioElement | null = $state(null);
let lyricsContainer: HTMLDivElement | null = $state(null);

let lyricFetchSeq = 0;
let lastUserScrollAt = 0;
let lastPlayUid = "";
let lastRoomId = "";
let reportedDurationUid = "";
let reportedEndUid = "";
let reportedErrorUid = "";
let soloCooldownRemainSec = $state(0);
let pendingAutoUnmuteTrackId = "";
let pendingAutoUnmuteAt = 0;
const lyricsCache = new Map<string, LyricLine[]>();

const currentPlay = $derived(musicState?.current ?? null);
const queue = $derived(musicState?.queue ?? []);
const historyRequesters = $derived.by<HistoryRequesterOption[]>(() => {
	const peopleMap = new Map<
		string,
		{
			key: string;
			name: string;
			avatar: string;
			tracks: Set<string>;
			totalRequests: number;
		}
	>();
	const coveredTrackIds = new Set<string>();

	for (const log of musicState?.historyLogs ?? []) {
		coveredTrackIds.add(log.track.id);
		const name = (log.requesterName || "").trim();
		const key = log.requesterKey || (name ? `name:${name}` : "");
		if (!key || !name) continue;
		const existing = peopleMap.get(key);
		if (existing) {
			existing.tracks.add(log.track.id);
			existing.totalRequests += 1;
			if (log.requesterAvatar) existing.avatar = log.requesterAvatar;
		} else {
			peopleMap.set(key, {
				key,
				name,
				avatar: log.requesterAvatar || "",
				tracks: new Set([log.track.id]),
				totalRequests: 1,
			});
		}
	}

	const namesInLogs = new Set(
		Array.from(peopleMap.values()).map((p) => p.name),
	);
	for (const item of musicState?.history ?? []) {
		if (coveredTrackIds.has(item.track.id)) continue;
		const name = (item.lastRequesterName || "").trim();
		if (!name || namesInLogs.has(name)) continue;
		const key = `name:${name}`;
		const existing = peopleMap.get(key);
		if (existing) {
			existing.tracks.add(item.track.id);
			existing.totalRequests += item.requestCount;
		} else {
			peopleMap.set(key, {
				key,
				name,
				avatar: "",
				tracks: new Set([item.track.id]),
				totalRequests: item.requestCount,
			});
		}
	}

	const memberByKey = new Map<string, { badge: string; authType?: string }>();
	for (const m of mentionMembers) {
		memberByKey.set(m.userKey, { badge: m.badge, authType: m.authType });
	}
	for (const m of onlineMembers) {
		memberByKey.set(m.userKey, { badge: m.badge, authType: m.authType });
	}

	return Array.from(peopleMap.values())
		.map((p) => {
			const meta = memberByKey.get(p.key);
			const rawBadge =
				(currentUser && p.key === currentUser.userKey
					? currentUser.badge
					: meta?.badge) || "";
			const badge = p.key.startsWith("waline:")
				? rawBadge === "访客" || !rawBadge
					? "认证"
					: rawBadge
				: rawBadge || (p.key.startsWith("guest:") ? "访客" : "");
			return {
				key: p.key,
				name:
					currentUser && p.key === currentUser.userKey
						? currentUser.name
						: p.name,
				avatar: p.avatar,
				badge,
				trackCount: p.tracks.size,
				totalRequests: p.totalRequests,
				isMe: Boolean(currentUser && p.key === currentUser.userKey),
			};
		})
		.sort((a, b) => {
			if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
			return (
				b.totalRequests - a.totalRequests ||
				a.name.localeCompare(b.name, "zh-CN")
			);
		});
});

const selectedRequester = $derived(
	historyRequesters.find((r) => r.key === selectedRequesterKey) ?? null,
);

const displayedHistoryEntries = $derived.by<MusicHistoryEntry[]>(() => {
	const sortHistory = (list: MusicHistoryEntry[]) =>
		list.sort((a, b) => {
			if (historySort === "recent") {
				return (
					b.lastRequestedAt - a.lastRequestedAt ||
					b.requestCount - a.requestCount
				);
			}
			// 按点播次数降序；次数相同时按时间正序（谁先点过的在最上面）
			return (
				b.requestCount - a.requestCount ||
				a.firstRequestedAt - b.firstRequestedAt ||
				a.lastRequestedAt - b.lastRequestedAt
			);
		});

	if (selectedRequesterKey) {
		const targetMap = new Map<string, MusicHistoryEntry>();
		for (const log of musicState?.historyLogs ?? []) {
			const logKey =
				log.requesterKey ||
				(log.requesterName ? `name:${log.requesterName}` : "");
			if (logKey !== selectedRequesterKey) continue;
			const existing = targetMap.get(log.track.id);
			if (existing) {
				existing.requestCount += 1;
				if (log.requestedAt < existing.firstRequestedAt) {
					existing.firstRequestedAt = log.requestedAt;
				}
				if (log.requestedAt >= existing.lastRequestedAt) {
					existing.lastRequestedAt = log.requestedAt;
					existing.track = log.track;
					existing.lastRequesterName =
						selectedRequester?.name || log.requesterName;
				}
			} else {
				targetMap.set(log.track.id, {
					track: log.track,
					requestCount: 1,
					lastRequesterName: selectedRequester?.name || log.requesterName,
					firstRequestedAt: log.requestedAt,
					lastRequestedAt: log.requestedAt,
				});
			}
		}

		if (targetMap.size === 0 && selectedRequester) {
			for (const item of musicState?.history ?? []) {
				if (item.lastRequesterName === selectedRequester.name) {
					targetMap.set(item.track.id, { ...item });
				}
			}
		}
		return sortHistory([...targetMap.values()]);
	}

	const mergedMap = new Map<string, MusicHistoryEntry>();
	for (const item of musicState?.history ?? []) {
		mergedMap.set(item.track.id, { ...item });
	}
	for (const log of musicState?.historyLogs ?? []) {
		if (!mergedMap.has(log.track.id)) {
			mergedMap.set(log.track.id, {
				track: log.track,
				requestCount: log.requestCount,
				lastRequesterName: log.requesterName,
				firstRequestedAt: log.requestedAt,
				lastRequestedAt: log.requestedAt,
			});
		}
	}
	return sortHistory([...mergedMap.values()]);
});
const effectiveDuration = $derived.by(() => {
	if (currentPlay && currentPlay.durationSec > 0) {
		return currentPlay.durationSec;
	}
	return localDuration;
});

const progressRatio = $derived(
	effectiveDuration > 0
		? Math.min(1, Math.max(0, roomElapsed / effectiveDuration))
		: 0,
);
const volumeRatio = $derived(isListening ? volume : 0);

const queuedTrackIds = $derived(new Set(queue.map((item) => item.track.id)));

$effect(() => {
	if (enqueuingTrackIds.size > 0) {
		const currentId = currentPlay?.track.id;
		let changed = false;
		for (const id of enqueuingTrackIds) {
			if (id === currentId || queue.some((item) => item.track.id === id)) {
				enqueuingTrackIds.delete(id);
				changed = true;
			}
		}
		if (changed) {
			enqueuingTrackIds = new Set(enqueuingTrackIds);
		}
	}
});

const currentRequesterAvatar = $derived.by(() => {
	if (
		!currentPlay ||
		currentPlay.isFallback ||
		!currentPlay.requesterKey ||
		currentPlay.requesterKey === "system:fallback"
	) {
		return "";
	}
	if (
		currentUser &&
		currentPlay.requesterKey === currentUser.userKey &&
		currentUser.avatar
	) {
		return currentUser.avatar;
	}
	const memberMatch = mentionMembers.find(
		(m) => m.userKey === currentPlay.requesterKey && m.avatar,
	);
	if (memberMatch?.avatar) return memberMatch.avatar;
	const logMatch = (musicState?.historyLogs ?? []).find(
		(l) => l.requesterKey === currentPlay.requesterKey && l.requesterAvatar,
	);
	return logMatch?.requesterAvatar || "";
});

const isAdmin = $derived(Boolean(currentUser?.isAdmin));
const isOwnRequest = $derived(
	Boolean(
		currentUser &&
			currentPlay &&
			!currentPlay.isFallback &&
			currentPlay.requesterKey === currentUser.userKey,
	),
);
const isSoloMode = $derived(onlineMemberCount <= 1);
const otherUnmutedCount = $derived(
	onlineMembers.filter(
		(m) =>
			(!currentUser || m.userKey !== currentUser.userKey) &&
			m.isMuted === false,
	).length,
);
const canDirectSkip = $derived(
	Boolean(currentPlay) &&
		(currentPlay.isFallback ||
			(Boolean(currentUser) &&
				(isAdmin ||
					isOwnRequest ||
					(isSoloMode && soloCooldownRemainSec === 0) ||
					(!isSoloMode && otherUnmutedCount === 0)))),
);
const isSoloCoolingDown = $derived(
	Boolean(currentUser && currentPlay) &&
		!currentPlay.isFallback &&
		!isAdmin &&
		!isOwnRequest &&
		isSoloMode &&
		soloCooldownRemainSec > 0,
);

function refreshSoloCooldown(): void {
	const until = musicState?.soloCooldownUntil ?? 0;
	if (!until) {
		soloCooldownRemainSec = 0;
		return;
	}
	const serverNow = Date.now() + clockOffsetMs;
	soloCooldownRemainSec = Math.max(0, Math.ceil((until - serverNow) / 1000));
}

$effect(() => {
	musicState?.soloCooldownUntil;
	clockOffsetMs;
	refreshSoloCooldown();
});

const hasVotedSkip = $derived(
	Boolean(currentUser && currentPlay?.skipVotes.includes(currentUser.userKey)),
);

function canRemoveEntry(entry: QueueEntry): boolean {
	if (!currentUser) return false;
	return currentUser.isAdmin || entry.requesterKey === currentUser.userKey;
}

function canToggleCatalogTrack(song: ChatMusicTrack): boolean {
	if (!currentUser) return true; // Clicking prompts auth modal via parent
	if (currentUser.isAdmin) return true;
	const existing = findQueuedEntryForSong(song);
	return !existing || existing.requesterKey === currentUser.userKey;
}

function switchMusicTab(tab: MusicTab) {
	if (!currentUser && tab !== "player") {
		onRequestAuth?.();
		return;
	}
	activeTab = tab;
}

$effect(() => {
	if (!currentUser && activeTab !== "player") {
		activeTab = "player";
		searchQuery = "";
		searchResults = [];
		searchError = "";
		selectedRequesterKey = "";
		showRequesterFilter = false;
		selectedPlaylist = null;
		playlistTrackFilter = "";
		confirmDeletePlaylistId = "";
	}
});

const isWalineLoggedIn = $derived(
	Boolean(currentUser && currentUser.authType === "waline" && walineToken),
);

function formatPlaylistDate(ts: number): string {
	if (!ts) return "";
	const d = new Date(ts);
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${m}-${day} ${hh}:${mm}`;
}

function canManagePlaylist(playlist: PlaylistSummary | null): boolean {
	if (!playlist || !isWalineLoggedIn || !currentUser) return false;
	return currentUser.isAdmin || playlist.ownerKey === currentUser.userKey;
}

/** 只有歌单主人能删除；站长操作成员歌单时也不给删除入口，避免误删他人歌单 */
function isOwnPlaylist(playlist: PlaylistSummary | null): boolean {
	return Boolean(
		playlist && currentUser && playlist.ownerKey === currentUser.userKey,
	);
}

function resolveSafeExternalUrl(raw?: string): string {
	const trimmed = (raw || "").trim();
	if (!trimmed) return "";
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol === "https:" || parsed.protocol === "http:") {
			return parsed.toString();
		}
	} catch {
		// Ignore non-URL source strings
	}
	return "";
}

const PLAYLIST_CACHE_TTL_MS = 30 * 1000;
const SEARCH_CACHE_TTL_MS = 30 * 1000;
let lastLoadedPlaylistKey = "";
let lastLoadedPlaylistAt = 0;
const playlistDetailCache = new Map<
	string,
	{ detail: PlaylistDetail; fetchedAt: number }
>();
const pendingPlaylistDetails = new Map<string, Promise<PlaylistDetail>>();
let playlistHoverTimer: number | null = null;
const searchResultCache = new Map<
	string,
	{ tracks: ChatMusicTrack[]; fetchedAt: number }
>();

function invalidatePlaylistCaches(playlistId?: string): void {
	lastLoadedPlaylistKey = "";
	lastLoadedPlaylistAt = 0;
	if (playlistId) {
		for (const key of playlistDetailCache.keys()) {
			if (key.endsWith(`|${playlistId}`)) {
				playlistDetailCache.delete(key);
			}
		}
	} else {
		playlistDetailCache.clear();
	}
}

async function loadPlaylists(force = false): Promise<void> {
	if (!chatServerUrl) return;
	const authSeg = isWalineLoggedIn ? walineToken : "";
	const cacheKey = `${roomId}|${authSeg}|${playlistRefreshSeq}`;
	if (
		!force &&
		lastLoadedPlaylistKey === cacheKey &&
		Date.now() - lastLoadedPlaylistAt < PLAYLIST_CACHE_TTL_MS
	) {
		return;
	}
	isLoadingPlaylists = true;
	playlistsError = "";
	try {
		const res = await fetchRoomPlaylists(chatServerUrl, roomId, authSeg, {
			includeTracks: isWalineLoggedIn,
		});
		featuredPlaylists = res.featured;
		myPlaylists = res.mine;
		membersPlaylists = res.members;
		const now = Date.now();
		if (res.details) {
			for (const [pid, detail] of Object.entries(res.details)) {
				playlistDetailCache.set(`${roomId}|${authSeg}|${pid}`, {
					detail,
					fetchedAt: now,
				});
			}
		}
		lastLoadedPlaylistKey = cacheKey;
		lastLoadedPlaylistAt = now;
		if (selectedPlaylist) {
			const stillExists = [...res.featured, ...res.mine, ...res.members].find(
				(p) => p.id === selectedPlaylist?.id,
			);
			if (stillExists) {
				selectedPlaylist = {
					...selectedPlaylist,
					isFeatured: stillExists.isFeatured,
					isFallback: stillExists.isFallback,
					isPublic: stillExists.isPublic,
				};
			} else {
				selectedPlaylist = null;
				playlistTrackFilter = "";
			}
		}
	} catch (err) {
		playlistsError = err instanceof Error ? err.message : "加载歌单列表失败";
	} finally {
		isLoadingPlaylists = false;
	}
}

let lastExternalPlaylistSeq = 0;

$effect(() => {
	if (
		externalPlaylistRequest &&
		externalPlaylistRequest.seq > 0 &&
		externalPlaylistRequest.seq !== lastExternalPlaylistSeq
	) {
		lastExternalPlaylistSeq = externalPlaylistRequest.seq;
		if (!currentUser) {
			onRequestAuth?.();
			return;
		}
		activeTab = "playlist";
		void openPlaylistDetail(externalPlaylistRequest.playlistId);
	}
});

function openRequesterProfile(requesterKey: string, requesterName: string) {
	if (
		!onOpenUserProfile ||
		!requesterKey ||
		requesterKey === "system:fallback"
	) {
		return;
	}
	onOpenUserProfile({
		userKey: requesterKey,
		name: requesterName || "房友",
	});
}

async function getOrFetchPlaylistDetail(
	playlistId: string,
	authSeg: string,
	force = false,
): Promise<PlaylistDetail> {
	const detailKey = `${roomId}|${authSeg}|${playlistId}`;
	if (!force) {
		const cached = playlistDetailCache.get(detailKey);
		if (cached && Date.now() - cached.fetchedAt < PLAYLIST_CACHE_TTL_MS) {
			return cached.detail;
		}
		const pending = pendingPlaylistDetails.get(detailKey);
		if (pending) return pending;
	}

	const task = fetchPlaylistDetail(
		chatServerUrl,
		roomId,
		playlistId,
		authSeg,
	).then((detail) => {
		playlistDetailCache.set(detailKey, { detail, fetchedAt: Date.now() });
		return detail;
	});
	pendingPlaylistDetails.set(detailKey, task);
	try {
		return await task;
	} finally {
		if (pendingPlaylistDetails.get(detailKey) === task) {
			pendingPlaylistDetails.delete(detailKey);
		}
	}
}

function cancelPlaylistDetailPrefetch(): void {
	if (playlistHoverTimer !== null) {
		window.clearTimeout(playlistHoverTimer);
		playlistHoverTimer = null;
	}
}

function schedulePlaylistDetailPrefetch(playlistId: string): void {
	if (!chatServerUrl || !playlistId) return;
	cancelPlaylistDetailPrefetch();
	const authSeg = isWalineLoggedIn ? walineToken : "";
	const detailKey = `${roomId}|${authSeg}|${playlistId}`;
	const cached = playlistDetailCache.get(detailKey);
	if (cached && Date.now() - cached.fetchedAt < PLAYLIST_CACHE_TTL_MS) return;
	if (pendingPlaylistDetails.has(detailKey)) return;

	playlistHoverTimer = window.setTimeout(() => {
		playlistHoverTimer = null;
		void getOrFetchPlaylistDetail(playlistId, authSeg).catch(() => {});
	}, 180);
}

function syncDetailFlags(detail: PlaylistDetail): PlaylistDetail {
	const inFeatured = featuredPlaylists.some((p) => p.id === detail.id);
	const inFallback = [...featuredPlaylists, ...myPlaylists, ...membersPlaylists].some(
		(p) => p.id === detail.id && p.isFallback,
	);
	return {
		...detail,
		isFeatured: inFeatured || Boolean(detail.isFeatured),
		isFallback: inFallback || Boolean(detail.isFallback),
	};
}

async function openPlaylistDetail(
	playlistId: string,
	force = false,
): Promise<void> {
	if (!chatServerUrl) return;
	cancelPlaylistDetailPrefetch();
	const authSeg = isWalineLoggedIn ? walineToken : "";
	const detailKey = `${roomId}|${authSeg}|${playlistId}`;
	if (!force) {
		const cached = playlistDetailCache.get(detailKey);
		if (cached && Date.now() - cached.fetchedAt < PLAYLIST_CACHE_TTL_MS) {
			selectedPlaylist = syncDetailFlags(cached.detail);
			playlistTrackFilter = "";
			confirmDeletePlaylistId = "";
			playlistsError = "";
			return;
		}
	}
	isLoadingPlaylistDetail = true;
	playlistsError = "";
	confirmDeletePlaylistId = "";
	try {
		const detail = await getOrFetchPlaylistDetail(playlistId, authSeg, force);
		selectedPlaylist = syncDetailFlags(detail);
		playlistTrackFilter = "";
	} catch (err) {
		const msg = err instanceof Error ? err.message : "加载歌单详情失败";
		playlistsError = msg;
		onNotify?.(msg);
	} finally {
		isLoadingPlaylistDetail = false;
	}
}

async function handleImportSubmit(overrideOptions?: {
	type?: "playlist" | "user";
	platform?: string;
}): Promise<void> {
	if (!isWalineLoggedIn) {
		onRequestAuth?.();
		return;
	}
	const raw = importInput.trim();
	if (!raw) {
		importError = "请粘贴歌单链接或分享文本";
		return;
	}
	isImportingPlaylist = true;
	importError = "";
	importStatusText = "";
	pendingUserImport = null;
	pendingAmbiguousImport = null;
	try {
		const resolved = await resolvePlaylistFromPlaylistOut(
			playlistOutApiUrl,
			raw,
			overrideOptions,
		);
		if (resolved.kind === "ambiguous") {
			pendingAmbiguousImport = {
				query: resolved.query,
				candidates: resolved.candidates,
			};
			return;
		}
		if (resolved.kind === "user") {
			pendingUserImport = {
				platform: resolved.platform,
				nickname: resolved.nickname,
				playlists: resolved.playlists,
			};
			return;
		}
		const saved = await saveImportedPlaylist(
			chatServerUrl,
			roomId,
			walineToken,
			resolved.payload,
		);
		importInput = "";
		if (resolved.retrievalMessage) {
			importStatusText = resolved.retrievalMessage;
		}
		onNotify?.(
			saved.updatedExisting
				? `已同步更新歌单《${saved.playlist.title}》`
				: `已导入歌单《${saved.playlist.title}》`,
		);
		invalidatePlaylistCaches(saved.playlist.id);
		await loadPlaylists(true);
		await openPlaylistDetail(saved.playlist.id, true);
	} catch (err) {
		importError = err instanceof Error ? err.message : "歌单导入失败";
	} finally {
		isImportingPlaylist = false;
	}
}

async function handleImportUserCandidate(
	candidate: UserPlaylistCandidate,
): Promise<void> {
	if (!isWalineLoggedIn) return;
	isImportingPlaylist = true;
	importError = "";
	importStatusText = "";
	try {
		const parsed = await fetchPlaylistByUrlFromPlaylistOut(
			playlistOutApiUrl,
			candidate.sourceUrl,
			candidate.platform,
		);
		const saved = await saveImportedPlaylist(
			chatServerUrl,
			roomId,
			walineToken,
			parsed.payload,
		);
		pendingUserImport = null;
		importInput = "";
		if (parsed.retrievalMessage) {
			importStatusText = parsed.retrievalMessage;
		}
		onNotify?.(`已导入歌单《${saved.playlist.title}》`);
		invalidatePlaylistCaches(saved.playlist.id);
		await loadPlaylists(true);
		await openPlaylistDetail(saved.playlist.id, true);
	} catch (err) {
		importError = err instanceof Error ? err.message : "拉取选定歌单失败";
	} finally {
		isImportingPlaylist = false;
	}
}

async function handleRefreshPlaylist(playlist: PlaylistSummary): Promise<void> {
	if (!isWalineLoggedIn || isRefreshingPlaylistId) return;
	isRefreshingPlaylistId = playlist.id;
	try {
		const fresh = await fetchPlaylistByUrlFromPlaylistOut(
			playlistOutApiUrl,
			playlist.sourceUrl,
			playlist.platform !== "external" ? playlist.platform : undefined,
		);
		const updated = await refreshSavedPlaylist(
			chatServerUrl,
			roomId,
			walineToken,
			playlist.id,
			fresh.payload,
		);
		onNotify?.(`已刷新《${updated.title}》（共 ${updated.trackCount} 首）`);
		invalidatePlaylistCaches(playlist.id);
		await loadPlaylists(true);
		if (selectedPlaylist?.id === playlist.id) {
			await openPlaylistDetail(playlist.id, true);
		}
	} catch (err) {
		onNotify?.(err instanceof Error ? err.message : "刷新歌单失败");
	} finally {
		isRefreshingPlaylistId = "";
	}
}

async function handleTogglePlaylistFlag(
	playlist: PlaylistSummary,
	flag: "isPublic" | "isFeatured" | "isFallback",
): Promise<void> {
	if (!walineToken || isUpdatingFlagsId) return;
	if (flag === "isPublic" && !canManagePlaylist(playlist)) return;
	if (flag !== "isPublic" && !currentUser?.isAdmin) return;
	isUpdatingFlagsId = playlist.id;
	try {
		const nextFlags =
			flag === "isPublic"
				? { isPublic: !playlist.isPublic }
				: flag === "isFeatured"
					? {
							isFeatured: !playlist.isFeatured,
							isFallback: playlist.isFeatured ? false : playlist.isFallback,
						}
					: { isFallback: !playlist.isFallback };
		const updated = await updatePlaylistFlags(
			chatServerUrl,
			roomId,
			walineToken,
			playlist.id,
			nextFlags,
		);
		if (selectedPlaylist?.id === updated.id) {
			selectedPlaylist = {
				...selectedPlaylist,
				isPublic: updated.isPublic,
				isFeatured: updated.isFeatured,
				isFallback: updated.isFallback,
				updatedAt: updated.updatedAt,
			};
		}
		if (flag === "isPublic") {
			onNotify?.(
				updated.isPublic
					? `已共享《${updated.title}》到共享歌单`
					: `已取消共享《${updated.title}》`,
			);
		} else if (flag === "isFeatured") {
			onNotify?.(
				updated.isFeatured
					? `已将《${updated.title}》设为房间精选`
					: `已取消《${updated.title}》的房间精选`,
			);
		} else if (flag === "isFallback") {
			onNotify?.(
				updated.isFallback
					? `已将《${updated.title}》设为冷场轮播歌单`
					: `已取消《${updated.title}》的冷场轮播`,
			);
		}
		invalidatePlaylistCaches(playlist.id);
		await loadPlaylists(true);
	} catch (err) {
		onNotify?.(err instanceof Error ? err.message : "更新歌单权限失败");
	} finally {
		isUpdatingFlagsId = "";
	}
}

async function handleDeletePlaylist(playlist: PlaylistSummary): Promise<void> {
	if (!isWalineLoggedIn || isDeletingPlaylistId) return;
	if (confirmDeletePlaylistId !== playlist.id) {
		confirmDeletePlaylistId = playlist.id;
		if (confirmDeleteTimer !== null) {
			window.clearTimeout(confirmDeleteTimer);
		}
		confirmDeleteTimer = window.setTimeout(() => {
			confirmDeletePlaylistId = "";
			confirmDeleteTimer = null;
		}, 3500);
		return;
	}
	if (confirmDeleteTimer !== null) {
		window.clearTimeout(confirmDeleteTimer);
		confirmDeleteTimer = null;
	}
	isDeletingPlaylistId = playlist.id;
	try {
		await deleteSavedPlaylist(chatServerUrl, roomId, walineToken, playlist.id);
		confirmDeletePlaylistId = "";
		if (selectedPlaylist?.id === playlist.id) {
			selectedPlaylist = null;
			playlistTrackFilter = "";
		}
		onNotify?.(`已删除歌单《${playlist.title}》`);
		invalidatePlaylistCaches(playlist.id);
		await loadPlaylists(true);
	} catch (err) {
		onNotify?.(err instanceof Error ? err.message : "删除歌单失败");
	} finally {
		isDeletingPlaylistId = "";
	}
}

function handleRandomPlayFromPlaylist(detail: PlaylistDetail): void {
	if (!currentUser) {
		onRequestAuth?.();
		return;
	}
	if (isRandomizing) return;
	const candidates = detail.tracks.filter((item) => {
		const track = toEnqueueableTrack(item, detail.id);
		return !isTrackCurrent(track) && !isTrackQueued(track);
	});
	const pool = candidates.length > 0 ? candidates : detail.tracks;
	if (pool.length === 0) {
		onNotify?.("歌单内暂无可点播的曲目");
		return;
	}
	const chosen = pool[Math.floor(Math.random() * pool.length)];
	if (!chosen) return;
	const track = toEnqueueableTrack(chosen, detail.id);
	isRandomizing = true;
	enqueuingTrackIds.add(track.id);
	enqueuingTrackIds = new Set(enqueuingTrackIds);
	window.setTimeout(() => {
		if (enqueuingTrackIds.has(track.id)) {
			enqueuingTrackIds.delete(track.id);
			enqueuingTrackIds = new Set(enqueuingTrackIds);
		}
	}, 4000);
	markPendingAutoUnmuteIfImmediate(track.id);
	onEnqueueTrack(track);
	onNotify?.(`已随机点播《${track.title}》`);
	window.setTimeout(() => {
		isRandomizing = false;
	}, 600);
}

function normalizeMatchTitle(raw: string): string {
	return raw.toLowerCase().replace(/[\s\-_·.,'"!?！？，。、()（）]+/g, "");
}

function isTrackCurrent(song: ChatMusicTrack): boolean {
	if (!currentPlay) return false;
	if (currentPlay.track.id === song.id) return true;
	if (song.provider === "external") {
		return (
			normalizeMatchTitle(currentPlay.track.title) ===
				normalizeMatchTitle(song.title) &&
			normalizeMatchTitle(currentPlay.track.artist).includes(
				normalizeMatchTitle(song.artist.split(/[/,&、;；]+/)[0] || ""),
			)
		);
	}
	return false;
}

function findQueuedEntryForSong(song: ChatMusicTrack): QueueEntry | undefined {
	const direct = queue.find((item) => item.track.id === song.id);
	if (direct) return direct;
	if (song.provider === "external") {
		const targetTitle = normalizeMatchTitle(song.title);
		const targetArtist = normalizeMatchTitle(
			song.artist.split(/[/,&、;；]+/)[0] || "",
		);
		return queue.find(
			(item) =>
				normalizeMatchTitle(item.track.title) === targetTitle &&
				(!targetArtist ||
					normalizeMatchTitle(item.track.artist).includes(targetArtist)),
		);
	}
	return undefined;
}

function isTrackQueued(song: ChatMusicTrack): boolean {
	return Boolean(findQueuedEntryForSong(song));
}

const filteredPlaylistTracks = $derived.by<PlaylistTrackItem[]>(() => {
	if (!selectedPlaylist) return [];
	const q = playlistTrackFilter.trim().toLowerCase();
	if (!q) return selectedPlaylist.tracks;
	return selectedPlaylist.tracks.filter(
		(t) =>
			t.title.toLowerCase().includes(q) ||
			t.artist.toLowerCase().includes(q) ||
			t.album.toLowerCase().includes(q),
	);
});

const displayedPlaylistTracks = $derived(
	filteredPlaylistTracks.slice(0, playlistVisibleLimit),
);
const hasMorePlaylistTracks = $derived(
	filteredPlaylistTracks.length > playlistVisibleLimit,
);

$effect(() => {
	selectedPlaylist?.id;
	playlistTrackFilter;
	playlistVisibleLimit = 100;
});

function handlePlaylistScroll(e: Event): void {
	const el = e.currentTarget as HTMLDivElement | null;
	if (!el || !hasMorePlaylistTracks) return;
	if (el.scrollHeight - el.scrollTop - el.clientHeight < 180) {
		playlistVisibleLimit += 100;
	}
}

let lastObservedRefreshSeq = 0;

$effect(() => {
	roomId;
	chatServerUrl;
	walineToken;
	const seq = playlistRefreshSeq;
	if (seq !== lastObservedRefreshSeq) {
		lastObservedRefreshSeq = seq;
		playlistDetailCache.clear();
	}
	if (activeTab === "playlist") {
		void loadPlaylists();
	}
});

function computeExpectedElapsed(): number {
	if (!currentPlay) return 0;
	const raw = (Date.now() + clockOffsetMs - currentPlay.startedAt) / 1000;
	const clamped = Math.max(0, raw);
	if (effectiveDuration > 0) {
		return Math.min(clamped, effectiveDuration);
	}
	return clamped;
}

const formatTime = formatClockSeconds;

const TRAILING_PAREN_RE = /^(.*?)\s*[(（](.+?)[)）]\s*$/;
const HAN_RE = /[\u4e00-\u9fff]/;
const NON_HAN_SCRIPT_RE = /[\u3040-\u30ff\uac00-\ud7afA-Za-z]/;
const KANA_RE = /[\u3040-\u30ff]/;

function parseLrc(raw: string): LyricLine[] {
	const timeReg = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
	const offsetReg = /^\[offset:([+-]?\d+)\]$/i;
	const rawEntries: { time: number; rawText: string }[] = [];
	let offsetSec = 0;

	for (const rawLine of raw.split(/\r?\n/)) {
		const trimmedLine = rawLine.trim();
		const offsetMatch = trimmedLine.match(offsetReg);
		if (offsetMatch) {
			offsetSec = Number.parseInt(offsetMatch[1], 10) / 1000;
			continue;
		}

		const timestamps: number[] = [];
		timeReg.lastIndex = 0;
		let match: RegExpExecArray | null = timeReg.exec(rawLine);
		while (match !== null) {
			const min = Number.parseInt(match[1], 10);
			const sec = Number.parseInt(match[2], 10);
			const msRaw = match[3] ?? "0";
			const divisor = msRaw.length === 3 ? 1000 : msRaw.length === 2 ? 100 : 10;
			const ms = Number.parseInt(msRaw, 10) / divisor;
			timestamps.push(Math.max(0, min * 60 + sec + ms - offsetSec));
			match = timeReg.exec(rawLine);
		}
		if (timestamps.length === 0) continue;

		const rawText = rawLine.replace(timeReg, "").trim();
		if (!rawText) continue;

		for (const time of timestamps) {
			rawEntries.push({ time, rawText });
		}
	}

	let parenLineCount = 0;
	for (const entry of rawEntries) {
		const m = entry.rawText.match(TRAILING_PAREN_RE);
		if (m?.[1]?.trim() && m?.[2]?.trim()) {
			parenLineCount += 1;
		}
	}
	const isInlineBilingualTrack =
		rawEntries.length >= 4 && parenLineCount / rawEntries.length >= 0.4;

	const parsed: LyricLine[] = [];
	for (const entry of rawEntries) {
		let cleanText = entry.rawText;
		const splitMatch = cleanText.match(TRAILING_PAREN_RE);
		if (splitMatch?.[1]?.trim() && splitMatch?.[2]?.trim()) {
			const head = splitMatch[1].trim();
			const tail = splitMatch[2].trim();
			const isScriptTranslationPair =
				(NON_HAN_SCRIPT_RE.test(head) &&
					HAN_RE.test(tail) &&
					(!HAN_RE.test(head) ||
						(KANA_RE.test(head) && !KANA_RE.test(tail)))) ||
				(KANA_RE.test(head) && /[A-Za-z]{2,}/.test(tail) && !HAN_RE.test(tail));

			if (isInlineBilingualTrack || isScriptTranslationPair) {
				cleanText = head;
			}
		}

		if (cleanText) {
			parsed.push({ time: entry.time, text: cleanText });
		}
	}

	parsed.sort((a, b) => a.time - b.time);

	const deduped: LyricLine[] = [];
	for (const line of parsed) {
		const prev = deduped[deduped.length - 1];
		if (
			prev &&
			Math.abs(line.time - prev.time) < 0.01 &&
			NON_HAN_SCRIPT_RE.test(prev.text) &&
			!HAN_RE.test(prev.text) &&
			HAN_RE.test(line.text)
		) {
			continue;
		}
		deduped.push(line);
	}

	return deduped;
}

async function loadLyricsForUrl(lrcUrl?: string) {
	lyricFetchSeq += 1;
	const reqId = lyricFetchSeq;
	activeLyricIndex = -1;

	if (!lrcUrl) {
		lyrics = [];
		lyricsStatus = "empty";
		return;
	}

	const cached = lyricsCache.get(lrcUrl);
	if (cached) {
		lyrics = cached;
		lyricsStatus = cached.length > 0 ? "ready" : "empty";
		syncLyricIndex(roomElapsed, true);
		return;
	}

	lyricsStatus = "loading";
	lyrics = [];

	try {
		const resp = await fetch(lrcUrl);
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const text = await resp.text();
		if (reqId !== lyricFetchSeq) return;
		const parsed = parseLrc(text);
		lyricsCache.set(lrcUrl, parsed);
		lyrics = parsed;
		lyricsStatus = parsed.length > 0 ? "ready" : "empty";
		syncLyricIndex(roomElapsed, true);
	} catch {
		if (reqId !== lyricFetchSeq) return;
		lyrics = [];
		lyricsStatus = "empty";
	}
}

function syncLyricIndex(timeSec: number, instant = false) {
	if (lyrics.length === 0) {
		activeLyricIndex = -1;
		return;
	}
	let matched = -1;
	const lookupTime = timeSec + 0.12;
	for (let i = 0; i < lyrics.length; i += 1) {
		if (lyrics[i].time <= lookupTime) {
			matched = i;
		} else {
			break;
		}
	}
	if (matched !== activeLyricIndex) {
		activeLyricIndex = matched;
		if (matched >= 0) {
			void scrollLyricToCenter(matched, instant);
		}
	}
}

async function scrollLyricToCenter(index: number, instant = false) {
	await tick();
	if (!lyricsContainer) return;
	if (!instant && Date.now() - lastUserScrollAt < 2500) return;
	const lineEl = lyricsContainer.querySelector<HTMLElement>(
		`[data-lyric-idx="${index}"]`,
	);
	if (!lineEl) return;

	const containerRect = lyricsContainer.getBoundingClientRect();
	const lineRect = lineEl.getBoundingClientRect();
	const target =
		lyricsContainer.scrollTop +
		(lineRect.top - containerRect.top) -
		lyricsContainer.clientHeight / 2 +
		lineRect.height / 2;

	programmaticLyricScrollUntil = Date.now() + 650;
	lyricsContainer.scrollTo({
		top: Math.max(0, target),
		behavior: instant ? "auto" : "smooth",
	});
}

function updateMediaSessionMetadata() {
	if (typeof navigator === "undefined" || !("mediaSession" in navigator))
		return;
	if (!hasJoinedAudio || !currentPlay) return;

	const coverUrl = currentPlay.track.cover
		? new URL(currentPlay.track.cover, window.location.origin).toString()
		: "";
	navigator.mediaSession.metadata = new MediaMetadata({
		title: currentPlay.track.title,
		artist: currentPlay.track.artist,
		album: `#${roomId} 同步电台 · 点歌：${currentPlay.requesterName}`,
		artwork: coverUrl
			? [{ src: coverUrl, sizes: "300x300", type: "image/jpeg" }]
			: [],
	});
	navigator.mediaSession.playbackState = isListening ? "playing" : "paused";
}

function registerMediaSessionHandlers() {
	if (typeof navigator === "undefined" || !("mediaSession" in navigator))
		return;

	navigator.mediaSession.setActionHandler("play", () => {
		if (!isListening) {
			void startOrResumeAudio();
		}
	});
	navigator.mediaSession.setActionHandler("pause", () => {
		muteLocally();
	});
	navigator.mediaSession.setActionHandler("stop", () => {
		muteLocally();
	});
	// 禁止系统控件快进/拖拽进度，防止破坏全网电台同步
	const blockedActions: MediaSessionAction[] = [
		"seekbackward",
		"seekforward",
		"seekto",
		"previoustrack",
		"nexttrack",
	];
	for (const action of blockedActions) {
		try {
			navigator.mediaSession.setActionHandler(action, null);
		} catch {
			// 忽略个别浏览器不支持的 action
		}
	}
}

function muteLocally() {
	if (!audioEl) return;
	isListening = false;
	internalAudioAction = true;
	audioEl.muted = true;
	// 暂停本地出声并将 SMTC 标为 paused，确保系统媒体中心保留当前页控制权以便再次按播放键唤醒
	audioEl.pause();
	window.setTimeout(() => {
		internalAudioAction = false;
	}, 50);
	if (
		typeof navigator !== "undefined" &&
		"mediaSession" in navigator &&
		hasJoinedAudio
	) {
		navigator.mediaSession.playbackState = "paused";
	}
}

async function seekAndPlayCurrent(el: HTMLAudioElement, expectedUid?: string) {
	const mySeq = ++syncAudioSeq;
	isSyncingAudio = true;
	try {
		if (el.readyState < 1) {
			await new Promise<void>((resolve) => {
				el.addEventListener("loadedmetadata", () => resolve(), { once: true });
				window.setTimeout(resolve, 1800);
			});
		}
		if (
			!isListening ||
			syncAudioSeq !== mySeq ||
			(expectedUid && currentPlay?.uid !== expectedUid)
		) {
			return;
		}

		const target = computeExpectedElapsed();
		const maxSeek =
			Number.isFinite(el.duration) && el.duration > 0
				? Math.max(0, el.duration - 0.5)
				: target;
		const clamped = Math.min(target, maxSeek);
		if (clamped > 0.4 && Math.abs(el.currentTime - clamped) > 0.8) {
			el.currentTime = clamped;
			await new Promise<void>((resolve) => {
				el.addEventListener("seeked", () => resolve(), { once: true });
				window.setTimeout(resolve, 900);
			});
		}
		if (
			!isListening ||
			syncAudioSeq !== mySeq ||
			(expectedUid && currentPlay?.uid !== expectedUid)
		) {
			return;
		}
		await el.play();
		roomElapsed = computeExpectedElapsed();
	} catch (err) {
		const isSupersededOrAbort =
			(err instanceof DOMException && err.name === "AbortError") ||
			(expectedUid !== undefined && currentPlay?.uid !== expectedUid);
		if (!isSupersededOrAbort) {
			if (err instanceof DOMException && err.name === "NotAllowedError") {
				isListening = false;
				el.muted = true;
			} else if (expectedUid && reportedErrorUid !== expectedUid) {
				// 单曲音源失效（如 NotSupportedError）时仅上报切歌，不关闭用户的持续收听状态
				reportedErrorUid = expectedUid;
				onReportError(expectedUid);
			}
		}
	} finally {
		if (syncAudioSeq === mySeq) {
			isSyncingAudio = false;
		}
	}
}

async function startOrResumeAudio() {
	if (!audioEl || !currentPlay) return;
	const targetUid = currentPlay.uid;
	if (volume === 0) {
		volume = 0.5;
		try {
			if (typeof window !== "undefined" && window.sessionStorage) {
				window.sessionStorage.setItem("chat:player:volume", "0.5");
			}
		} catch {
			// Ignore storage error
		}
	}
	hasJoinedAudio = true;
	isListening = true;

	// 等待 Svelte 把 streamUrl 绑定到 <audio src> 上再起播，避免静音阶段预加载浪费请求
	await tick();
	if (!audioEl || currentPlay?.uid !== targetUid) return;

	registerMediaSessionHandlers();
	updateMediaSessionMetadata();

	internalAudioAction = true;
	audioEl.muted = false;
	audioEl.volume = volume;
	if (audioEl.readyState === 0) {
		audioEl.load();
	}
	window.setTimeout(() => {
		internalAudioAction = false;
	}, 50);

	await seekAndPlayCurrent(audioEl, targetUid);
	updateMediaSessionMetadata();
}

async function toggleListen() {
	if (isListening) {
		muteLocally();
		return;
	}
	await startOrResumeAudio();
}

let isDraggingVolume = $state(false);
let volumeSliderEl: HTMLDivElement | null = $state(null);

function updateVolumeFromPointer(clientX: number) {
	if (!volumeSliderEl) return;
	const rect = volumeSliderEl.getBoundingClientRect();
	if (rect.width <= 0) return;
	const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
	handleVolumeInput(Math.round(ratio * 100) / 100);
}

function handleVolumePointerDown(e: PointerEvent) {
	if (e.button !== 0 && e.pointerType === "mouse") return;
	e.preventDefault();
	isDraggingVolume = true;
	volumeSliderEl?.setPointerCapture(e.pointerId);
	updateVolumeFromPointer(e.clientX);
}

function handleVolumePointerMove(e: PointerEvent) {
	if (!isDraggingVolume) return;
	updateVolumeFromPointer(e.clientX);
}

function handleVolumePointerEnd(e: PointerEvent) {
	if (!isDraggingVolume) return;
	isDraggingVolume = false;
	if (volumeSliderEl?.hasPointerCapture(e.pointerId)) {
		volumeSliderEl.releasePointerCapture(e.pointerId);
	}
}

function handleVolumeKeyDown(e: KeyboardEvent) {
	if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
		e.preventDefault();
		handleVolumeInput(Math.round(Math.max(0, volumeRatio - 0.05) * 100) / 100);
	} else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
		e.preventDefault();
		handleVolumeInput(Math.round(Math.min(1, volumeRatio + 0.05) * 100) / 100);
	}
}

function handleVolumeInput(value: number) {
	const clamped = Math.min(1, Math.max(0, value));
	volume = clamped;
	try {
		if (typeof window !== "undefined" && window.sessionStorage) {
			window.sessionStorage.setItem("chat:player:volume", String(clamped));
		}
	} catch {
		// Ignore storage error
	}
	if (clamped > 0 && !isListening) {
		void startOrResumeAudio();
	} else if (clamped === 0 && isListening) {
		muteLocally();
	} else if (audioEl) {
		audioEl.volume = clamped;
	}
}

function syncDurationFromAudio() {
	if (!audioEl || !Number.isFinite(audioEl.duration) || audioEl.duration <= 0) {
		return;
	}
	localDuration = audioEl.duration;
	if (
		currentPlay &&
		currentPlay.durationSec <= 0 &&
		reportedDurationUid !== currentPlay.uid
	) {
		reportedDurationUid = currentPlay.uid;
		onReportDuration(currentPlay.uid, Math.round(audioEl.duration));
	}
}

// 房间或当前曲目切换时，重载音轨、对齐进度、刷新歌词与系统媒体面板
$effect(() => {
	const active = currentPlay;
	const activeRoom = roomId;
	if (!active) {
		lastPlayUid = "";
		lastRoomId = activeRoom;
		roomElapsed = 0;
		localDuration = 0;
		lyrics = [];
		lyricsStatus = "empty";
		if (audioEl) {
			internalAudioAction = true;
			audioEl.pause();
			window.setTimeout(() => {
				internalAudioAction = false;
			}, 50);
		}
		return;
	}

	if (active.uid === lastPlayUid && activeRoom === lastRoomId) return;
	lastPlayUid = active.uid;
	lastRoomId = activeRoom;
	coverLoadFailed = false;
	localDuration = active.durationSec;
	roomElapsed = computeExpectedElapsed();
	lastUserScrollAt = 0;

	const shouldAutoUnmute = Boolean(
		pendingAutoUnmuteTrackId &&
			(pendingAutoUnmuteTrackId === active.track.id ||
				pendingAutoUnmuteTrackId.startsWith("ext:")) &&
			Date.now() - pendingAutoUnmuteAt < 12_000 &&
			currentUser &&
			active.requesterKey === currentUser.userKey,
	);
	if (shouldAutoUnmute) {
		pendingAutoUnmuteTrackId = "";
	}

	void loadLyricsForUrl(active.track.lrcUrl || active.track.lrc);
	updateMediaSessionMetadata();

	const targetUid = active.uid;
	void tick().then(async () => {
		if (!audioEl || currentPlay?.uid !== targetUid) return;
		internalAudioAction = true;
		audioEl.load();
		window.setTimeout(() => {
			internalAudioAction = false;
		}, 50);

		if (shouldAutoUnmute) {
			await startOrResumeAudio();
		} else if (isListening) {
			audioEl.muted = false;
			audioEl.volume = volume;
			await seekAndPlayCurrent(audioEl, targetUid);
		}
	});
});

// 搜索防抖
$effect(() => {
	const q = searchQuery.trim();
	if (searchTimer !== null) {
		window.clearTimeout(searchTimer);
		searchTimer = null;
	}
	if (!q) {
		searchResults = [];
		isSearching = false;
		searchError = "";
		return;
	}

	const cacheKey = q.toLowerCase();
	const cached = searchResultCache.get(cacheKey);
	if (cached && Date.now() - cached.fetchedAt < SEARCH_CACHE_TTL_MS) {
		searchResults = cached.tracks;
		isSearching = false;
		searchError = "";
		return;
	}

	isSearching = true;
	searchError = "";
	searchTimer = window.setTimeout(() => {
		void runSearch(q);
	}, 700);
});

async function runSearch(q: string) {
	try {
		const tracks = await onSearchOnline(q);
		searchResultCache.set(q.toLowerCase(), {
			tracks,
			fetchedAt: Date.now(),
		});
		if (searchQuery.trim() === q) {
			searchResults = tracks;
			searchError = "";
		}
	} catch (err) {
		if (searchQuery.trim() === q) {
			searchError = err instanceof Error ? err.message : "搜索失败，请稍后重试";
		}
	} finally {
		if (searchQuery.trim() === q) {
			isSearching = false;
		}
	}
}

function markPendingAutoUnmuteIfImmediate(songId: string): void {
	// 当前没有歌或正在冷场轮播时，点歌会立即切播，自动取消静音开播；已有用户点播在放则保持静音
	if ((!currentPlay || currentPlay.isFallback) && currentUser) {
		pendingAutoUnmuteTrackId = songId;
		pendingAutoUnmuteAt = Date.now();
	}
}

function handleToggleQueueTrack(song: ChatMusicTrack) {
	if (isTrackCurrent(song)) return;
	const existing = findQueuedEntryForSong(song);
	if (existing) {
		if (!canRemoveEntry(existing)) return;
		onRemoveQueue(existing.uid);
	} else {
		enqueuingTrackIds.add(song.id);
		enqueuingTrackIds = new Set(enqueuingTrackIds);
		window.setTimeout(() => {
			if (enqueuingTrackIds.has(song.id)) {
				enqueuingTrackIds.delete(song.id);
				enqueuingTrackIds = new Set(enqueuingTrackIds);
			}
		}, 4000);
		markPendingAutoUnmuteIfImmediate(song.id);
		onEnqueueTrack(song);
	}
}

onMount(() => {
	// 房间时钟独立走时（即使本地处于静音模式也始终跟随全网进度推进与滚动歌词）
	const roomClock = window.setInterval(() => {
		refreshSoloCooldown();
		syncDurationFromAudio();
		if (!currentPlay) return;

		const expected = computeExpectedElapsed();
		roomElapsed = expected;
		syncLyricIndex(expected);

		if (
			isListening &&
			!isSyncingAudio &&
			audioEl &&
			!audioEl.paused &&
			!audioEl.seeking
		) {
			const drift = Math.abs(audioEl.currentTime - expected);
			if (
				drift > 1.8 &&
				(effectiveDuration === 0 || expected < effectiveDuration - 1.5)
			) {
				audioEl.currentTime = expected;
			}
		}
	}, 250);

	const handlePointerDown = (e: PointerEvent) => {
		if (!showRequesterFilter) return;
		const target = e.target as HTMLElement | null;
		if (!target?.closest("[data-history-filter-wrap]")) {
			showRequesterFilter = false;
		}
	};
	const handleKeydown = (e: KeyboardEvent) => {
		if (showRequesterFilter && e.key === "Escape") {
			showRequesterFilter = false;
		}
	};
	document.addEventListener("pointerdown", handlePointerDown);
	document.addEventListener("keydown", handleKeydown);

	return () => {
		document.removeEventListener("pointerdown", handlePointerDown);
		document.removeEventListener("keydown", handleKeydown);
		window.clearInterval(roomClock);
		if (searchTimer !== null) {
			window.clearTimeout(searchTimer);
		}
		if (confirmDeleteTimer !== null) {
			window.clearTimeout(confirmDeleteTimer);
		}
		if (lyricsScrollHideTimer !== null) {
			window.clearTimeout(lyricsScrollHideTimer);
		}
		if (queueScrollHideTimer !== null) {
			window.clearTimeout(queueScrollHideTimer);
		}
		if (audioEl) {
			internalAudioAction = true;
			audioEl.pause();
		}
		if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
			navigator.mediaSession.playbackState = "none";
		}
	};
});

export function toggleListenControl(): void {
	void toggleListen();
}

export function openPlayerTab(): void {
	activeTab = "player";
}

const displayedBrowseTracks = $derived(
	searchQuery.trim() ? searchResults : fallbackTracks,
);

$effect(() => {
	onPlaybackStatusChange?.({
		isListening,
		isMuted: !isListening || volume <= 0,
		elapsedSec: Math.floor(roomElapsed),
		durationSec: effectiveDuration,
		canDirectSkip,
		isSoloCoolingDown,
		soloCooldownRemainSec,
		hasVotedSkip,
	});
});
</script>

<aside class="flex flex-col h-full w-full min-h-0 overflow-hidden select-none" aria-label="点歌台">
  <audio
    bind:this={audioEl}
    src={isListening && currentPlay?.track.streamUrl ? currentPlay.track.streamUrl : undefined}
    preload="metadata"
    muted={!isListening}
    onloadedmetadata={syncDurationFromAudio}
    ondurationchange={syncDurationFromAudio}
    oncanplay={syncDurationFromAudio}
    onpause={() => {
      // 自然播完（ended）、曲目切换/校时中或内部主动暂停触发的 pause 不视为硬件暂停，保持收听状态不断开
      if (
        internalAudioAction ||
        isSyncingAudio ||
        !isListening ||
        !currentPlay ||
        audioEl?.ended
      ) {
        return;
      }
      isListening = false;
      if (audioEl) audioEl.muted = true;
      if (typeof navigator !== "undefined" && "mediaSession" in navigator && hasJoinedAudio) {
        navigator.mediaSession.playbackState = "paused";
      }
    }}
    onended={() => {
      if (currentPlay && reportedEndUid !== currentPlay.uid) {
        reportedEndUid = currentPlay.uid;
        onTrackEnded(currentPlay.uid);
      }
    }}
    onerror={() => {
      if (isListening && currentPlay && reportedErrorUid !== currentPlay.uid) {
        reportedErrorUid = currentPlay.uid;
        onReportError(currentPlay.uid);
      }
    }}
  ></audio>

  <!-- 顶栏标题 -->
  <div class="chat-panel-header">
    <div class="font-bold text-sm text-[var(--deep-text)] dark:text-white/90 flex items-center gap-2">
      <svg class="w-4 h-4 text-[var(--primary)] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
      <span>点歌台</span>
    </div>

    <button
      type="button"
      disabled={!currentPlay}
      class="text-[0.6875rem] px-2.5 py-0.5 rounded-full border font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed
        {isListening && currentPlay
          ? 'bg-(--primary)/14 border-(--primary)/30 text-[var(--chat-accent-text)] hover:bg-(--primary)/22'
          : 'bg-[var(--card-bg)]/60 border-[var(--chat-divider-color)] text-[var(--chat-meta-color)] hover:text-[var(--deep-text)] hover:bg-[var(--card-bg)]/85'}"
      aria-label={isListening ? "停止收听" : "开始收听"}
      onclick={toggleListen}
    >
      {#if isListening && currentPlay}
        <span class="chat-eq-bars" aria-hidden="true">
          <span class="chat-eq-bar"></span>
          <span class="chat-eq-bar"></span>
          <span class="chat-eq-bar"></span>
        </span>
        <span>收听中</span>
      {:else}
        <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
        </svg>
        <span>{currentPlay ? "静音同步" : "未在播放"}</span>
      {/if}
    </button>
  </div>

  <!-- 4-Tab 切换栏：歌词 / 搜索 / 歌单 / 历史 -->
  <div class="grid grid-cols-4 gap-1 border-b border-[var(--chat-divider-color)] px-2.5 py-1 shrink-0" role="tablist" aria-label="点歌台视图切换">
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === "player"}
      class="flex items-center justify-center gap-1 py-1 px-1 text-[11px] font-medium whitespace-nowrap transition-colors rounded-lg cursor-pointer border-none
        {activeTab === 'player'
          ? 'bg-(--btn-plain-bg-hover) text-(--primary)'
          : 'bg-transparent text-[var(--chat-meta-color)] hover:bg-(--btn-plain-bg-hover) hover:text-[var(--deep-text)]'}"
      onclick={() => switchMusicTab("player")}
    >
      <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
        <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
      </svg>
      <span>歌词</span>
    </button>

    <button
      type="button"
      role="tab"
      aria-selected={activeTab === "search"}
      class="flex items-center justify-center gap-1 py-1 px-1 text-[11px] font-medium whitespace-nowrap transition-colors rounded-lg cursor-pointer border-none
        {activeTab === 'search'
          ? 'bg-(--btn-plain-bg-hover) text-(--primary)'
          : 'bg-transparent text-[var(--chat-meta-color)] hover:bg-(--btn-plain-bg-hover) hover:text-[var(--deep-text)]'}"
      onclick={() => switchMusicTab("search")}
    >
      <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <span>搜索</span>
    </button>

    <button
      type="button"
      role="tab"
      aria-selected={activeTab === "playlist"}
      class="flex items-center justify-center gap-1 py-1 px-1 text-[11px] font-medium whitespace-nowrap transition-colors rounded-lg cursor-pointer border-none
        {activeTab === 'playlist'
          ? 'bg-(--btn-plain-bg-hover) text-(--primary)'
          : 'bg-transparent text-[var(--chat-meta-color)] hover:bg-(--btn-plain-bg-hover) hover:text-[var(--deep-text)]'}"
      onmouseenter={() => void loadPlaylists()}
      onfocus={() => void loadPlaylists()}
      onclick={() => switchMusicTab("playlist")}
    >
      <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
      <span>歌单</span>
    </button>

    <button
      type="button"
      role="tab"
      aria-selected={activeTab === "history"}
      class="flex items-center justify-center gap-1 py-1 px-1 text-[11px] font-medium whitespace-nowrap transition-colors rounded-lg cursor-pointer border-none
        {activeTab === 'history'
          ? 'bg-(--btn-plain-bg-hover) text-(--primary)'
          : 'bg-transparent text-[var(--chat-meta-color)] hover:bg-(--btn-plain-bg-hover) hover:text-[var(--deep-text)]'}"
      onclick={() => switchMusicTab("history")}
    >
      <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <polyline points="12 7 12 12 15.5 14" />
      </svg>
      <span>历史</span>
    </button>
  </div>

  {#snippet trackRequestRow(song: ChatMusicTrack, subtitle: string, countBadge?: string)}
    {@const isCurrent = isTrackCurrent(song)}
    {@const isQueued = isTrackQueued(song)}
    <div class="flex items-center gap-2.5 p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
      <div class="w-8 h-8 rounded-md overflow-hidden shrink-0 relative bg-(--primary)/10 flex items-center justify-center">
        {#if song.cover}
          <img src={song.cover} alt="" loading="lazy" class="w-full h-full object-cover" />
        {:else}
          <span class="text-xs text-(--primary)">♪</span>
        {/if}
        {#if isCurrent}
          <div class="absolute inset-0 bg-black/45 flex items-center justify-center" aria-hidden="true">
            <span class="chat-eq-bars chat-eq-bars--light">
              <span class="chat-eq-bar"></span>
              <span class="chat-eq-bar"></span>
              <span class="chat-eq-bar"></span>
            </span>
          </div>
        {/if}
      </div>

      <div class="min-w-0 flex-1">
        <div class="text-xs font-bold truncate {isCurrent ? 'text-[var(--chat-accent-text)]' : 'text-[var(--deep-text)]'}">
          {song.title}
        </div>
        <div class="text-[10px] text-[var(--chat-meta-color)] truncate">
          {subtitle}
        </div>
      </div>

      {#if isCurrent}
        <span
          class="{countBadge ? 'w-9 h-9 flex-col gap-0.5' : 'w-7 h-7'} rounded-lg inline-flex items-center justify-center bg-(--primary)/12 text-[var(--chat-accent-text)] shrink-0 aspect-square"
          aria-label="播放中"
        >
          <span class="chat-eq-bars" aria-hidden="true">
            <span class="chat-eq-bar"></span>
            <span class="chat-eq-bar"></span>
            <span class="chat-eq-bar"></span>
          </span>
          {#if countBadge}
            <span class="text-[9px] leading-none font-semibold tabular-nums">{countBadge}</span>
          {/if}
        </span>
      {:else if isQueued && !canToggleCatalogTrack(song)}
        <span
          class="{countBadge ? 'w-9 h-9 flex-col gap-0.5' : 'w-7 h-7'} rounded-lg inline-flex items-center justify-center text-[var(--chat-meta-color)] shrink-0 aspect-square"
          aria-label="已入列"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          {#if countBadge}
            <span class="text-[9px] leading-none font-semibold tabular-nums">{countBadge}</span>
          {/if}
        </span>
      {:else if isQueued}
        <button
          type="button"
          class="chat-queue-icon-btn {countBadge ? 'w-9! h-9! flex-col gap-0.5' : 'w-7! h-7!'} shrink-0 aspect-square text-red-500/85 hover:text-red-500!"
          aria-label={`移除 ${song.title}`}
          onclick={() => handleToggleQueueTrack(song)}
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" aria-hidden="true">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {#if countBadge}
            <span class="text-[9px] leading-none font-semibold tabular-nums">{countBadge}</span>
          {/if}
        </button>
      {:else if enqueuingTrackIds.has(song.id)}
        <button
          type="button"
          disabled
          class="chat-queue-icon-btn {countBadge ? 'w-9! h-9! flex-col gap-0.5' : 'w-7! h-7!'} shrink-0 aspect-square text-[var(--chat-accent-text)] bg-(--primary)/10 opacity-75 cursor-wait!"
          aria-label={`正在点歌 ${song.title}...`}
        >
          <svg class="w-3.5 h-3.5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
          </svg>
          {#if countBadge}
            <span class="text-[9px] leading-none font-semibold tabular-nums">{countBadge}</span>
          {/if}
        </button>
      {:else}
        <button
          type="button"
          class="chat-queue-icon-btn {countBadge ? 'w-9! h-9! flex-col gap-0.5' : 'w-7! h-7!'} shrink-0 aspect-square text-[var(--chat-accent-text)] bg-(--primary)/10 hover:bg-(--primary)/20!"
          aria-label={`点歌 ${song.title}`}
          onclick={() => handleToggleQueueTrack(song)}
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {#if countBadge}
            <span class="text-[9px] leading-none font-semibold tabular-nums">{countBadge}</span>
          {/if}
        </button>
      {/if}
    </div>
  {/snippet}

  <!-- 迷你播放条：紧跟 4 个 Tab 下方，切换其它页签时常驻 -->
  {#if activeTab !== "player" && currentPlay}
    <MiniPlayerBar
      currentPlay={currentPlay}
      isListening={isListening}
      elapsedSec={roomElapsed}
      durationSec={effectiveDuration}
      canDirectSkip={canDirectSkip}
      isSoloCoolingDown={isSoloCoolingDown}
      soloCooldownRemainSec={soloCooldownRemainSec}
      hasVotedSkip={hasVotedSkip}
      voteCount={musicState?.voteCount ?? 0}
      voteThreshold={musicState?.voteThreshold ?? 2}
      isSkippingTrack={isSkippingTrack}
      variant="panel"
      onOpenLyrics={() => switchMusicTab("player")}
      onToggleListen={() => void toggleListen()}
      onSkipTrack={onSkipTrack}
      onVoteSkip={onVoteSkip}
    />
  {/if}

  {#if activeTab === "player"}
    <div class="flex-1 min-h-0 flex flex-col">
      <div class="px-4 pt-3 pb-1.5 shrink-0">
        <!-- 顶部行：左 w-14 圆封面转盘 + 右 歌名/点歌人/同步时间与音量 -->
        <div class="flex items-center gap-2.5 mb-2">
          <div class="relative shrink-0 w-14 h-14">
            <div class="w-full h-full rounded-full overflow-hidden shadow-lg border-2 border-white/80 dark:border-neutral-700/80 relative bg-(--primary)/10 flex items-center justify-center">
              <svg class="w-6 h-6 text-(--primary) opacity-45 absolute" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
              </svg>
              {#if currentPlay?.track.cover && !coverLoadFailed}
                <img
                  src={currentPlay.track.cover}
                  alt={`${currentPlay.track.title} 封面`}
                  class="w-full h-full object-cover chat-spin-slow relative z-10"
                  onerror={() => (coverLoadFailed = true)}
                />
              {/if}
            </div>
          </div>

          <div class="flex-1 min-w-0 flex flex-col">
            <h3 class="font-bold text-base text-[var(--deep-text)] leading-tight truncate m-0">
              {currentPlay ? currentPlay.track.title : "未在播放"}
            </h3>

            <div class="flex items-center gap-1.5 w-full min-w-0 mt-0.5 overflow-hidden">
              <span class="min-w-0 text-xs font-medium text-[var(--chat-meta-color)] truncate">
                {currentPlay ? currentPlay.track.artist : !musicState ? "正在连接电台..." : "暂无点播歌曲"}
              </span>
              {#if currentPlay}
                {@const isSystemFallback =
                  currentPlay.isFallback || currentPlay.requesterKey === "system:fallback"}
                {#if !isSystemFallback && currentPlay.requesterKey && onOpenUserProfile}
                  <button
                    type="button"
                    class="inline-flex items-center justify-center gap-1.5 shrink-0 max-w-[min(10.5rem,62%)] h-[22px] pl-[3px] pr-2 py-0 text-xs leading-none font-medium rounded-full bg-(--primary)/12 text-[var(--chat-accent-text)] hover:bg-(--primary)/20 border-none cursor-pointer transition-colors"
                    onclick={() => openRequesterProfile(currentPlay.requesterKey, currentPlay.requesterName)}
                  >
                    <ChatAvatar
                      src={currentRequesterAvatar}
                      name={currentPlay.requesterName}
                      size="2xs"
                    />
                    <span class="truncate leading-[1.2]">{currentPlay.requesterName}</span>
                  </button>
                {:else}
                  <span class="inline-flex items-center justify-center gap-1.5 shrink-0 max-w-[min(10.5rem,62%)] h-[22px] {isSystemFallback ? 'px-2' : 'pl-[3px] pr-2'} py-0 text-xs leading-none font-medium rounded-full bg-(--primary)/12 text-[var(--chat-accent-text)]">
                    {#if !isSystemFallback}
                      <ChatAvatar
                        src={currentRequesterAvatar}
                        name={currentPlay.requesterName}
                        size="2xs"
                      />
                    {/if}
                    <span class="truncate leading-[1.2]">{currentPlay.requesterName}</span>
                  </span>
                {/if}
              {/if}
            </div>

            <!-- 同步时间与本地音量条 -->
            <div class="flex items-center gap-2 text-[var(--chat-meta-color)] h-5 mt-0.5">
              <div class="text-[10px] font-mono flex items-center gap-1 shrink-0 h-full tabular-nums" aria-live="polite">
                <span>{formatTime(currentPlay ? roomElapsed : 0)}</span>
                <span class="opacity-50" aria-hidden="true">/</span>
                <span>{formatTime(currentPlay ? effectiveDuration : 0)}</span>
              </div>

              <div class="flex items-center gap-1.5 bg-transparent h-full ml-auto">
                <button
                  type="button"
                  disabled={!currentPlay}
                  class="hover:text-(--primary) transition-colors p-0.5 rounded-md flex items-center border-none bg-transparent text-inherit cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed"
                  aria-label={isListening ? "停止收听" : "开始收听"}
                  onclick={toggleListen}
                >
                  {#if !isListening || volume === 0}
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
                    </svg>
                  {:else}
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                    </svg>
                  {/if}
                </button>
                <div class="w-16 flex items-center">
                  <div
                    bind:this={volumeSliderEl}
                    role="slider"
                    tabindex="0"
                    aria-label="音量"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(volumeRatio * 100)}
                    class="chat-slim-slider {isDraggingVolume ? 'chat-slim-slider--dragging' : ''}"
                    style="--pct: {volumeRatio};"
                    onpointerdown={handleVolumePointerDown}
                    onpointermove={handleVolumePointerMove}
                    onpointerup={handleVolumePointerEnd}
                    onpointercancel={handleVolumePointerEnd}
                    onkeydown={handleVolumeKeyDown}
                  >
                    <div class="chat-slim-slider-fill"></div>
                    <div class="chat-slim-slider-thumb"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 只读同步进度条（未播放时也保留显示 0%） -->
        <div class="my-2.5">
          <div class="chat-sync-progress" style="--pct: {currentPlay ? progressRatio : 0};" aria-label="当前歌曲同步进度">
            <div class="chat-sync-progress-fill"></div>
          </div>
        </div>

        <!-- 控制栏：左 切歌/投票切歌 + 中 收听/静音 + 右 队列抽屉开关 -->
        <div class="grid grid-cols-[1fr_auto_1fr] items-center py-1 gap-1.5">
          <div class="flex items-center justify-start min-w-0">
            {#if !currentPlay}
              <button
                type="button"
                disabled
                class="chat-skip-pill opacity-45 cursor-not-allowed!"
              >
                <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                </svg>
                <span>切歌</span>
              </button>
            {:else}
              {@const activeVotes = musicState?.voteCount ?? 0}
              {@const activeThreshold = musicState?.voteThreshold ?? 2}
              {@const mainSkipTooltipText =
                isSkippingTrack
                  ? "正在切歌..."
                  : canDirectSkip
                    ? activeVotes > 0
                      ? `直接切歌（已有 ${activeVotes}/${activeThreshold} 票）`
                      : "直接切歌"
                    : isSoloCoolingDown
                      ? `切歌冷却中（${soloCooldownRemainSec}s）`
                      : hasVotedSkip
                        ? `取消投票（已投 ${activeVotes}/${activeThreshold} 票）`
                        : activeVotes > 0
                          ? `投票切歌（已投 ${activeVotes}/${activeThreshold} 票）`
                          : "投票切歌"}
              <ChatTooltip text={mainSkipTooltipText} align="left">
                {#if canDirectSkip}
                  <button
                    type="button"
                    disabled={isSkippingTrack}
                    class="chat-skip-pill whitespace-nowrap {activeVotes > 0 ? 'voted' : ''} disabled:opacity-75 disabled:cursor-wait!"
                    aria-label={isSkippingTrack ? "正在切歌..." : activeVotes > 0 ? `直接切歌（已有 ${activeVotes}/${activeThreshold} 票）` : "直接切歌"}
                    onclick={onSkipTrack}
                  >
                    {#if isSkippingTrack}
                      <svg class="w-3.5 h-3.5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity="0.25" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
                      </svg>
                    {:else}
                      <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                      </svg>
                    {/if}
                    <span>切歌</span>
                  </button>
                {:else if isSoloCoolingDown}
                  <button
                    type="button"
                    class="chat-skip-pill whitespace-nowrap opacity-75"
                    aria-label={`切歌冷却中 (${soloCooldownRemainSec}s)`}
                    onclick={onSkipTrack}
                  >
                    <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                    </svg>
                    <span class="tabular-nums">{soloCooldownRemainSec}s</span>
                  </button>
                {:else}
                  <button
                    type="button"
                    disabled={isSkippingTrack}
                    class="chat-skip-pill whitespace-nowrap {hasVotedSkip ? 'voted' : ''} disabled:opacity-75 disabled:cursor-wait!"
                    aria-pressed={hasVotedSkip}
                    aria-label={isSkippingTrack ? "正在切歌..." : hasVotedSkip ? `取消投票（已投 ${activeVotes}/${activeThreshold} 票）` : activeVotes > 0 ? `投票切歌（已投 ${activeVotes}/${activeThreshold} 票）` : "投票切歌"}
                    onclick={onVoteSkip}
                  >
                    {#if isSkippingTrack}
                      <svg class="w-3.5 h-3.5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity="0.25" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
                      </svg>
                    {:else}
                      <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                      </svg>
                    {/if}
                    <span>{hasVotedSkip ? "已投" : "切歌"}</span>
                  </button>
                {/if}
              </ChatTooltip>
            {/if}
          </div>

          <button
            type="button"
            disabled={!currentPlay}
            class="chat-play-btn {isListening && currentPlay ? 'playing' : ''} justify-self-center shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label={isListening ? "停止收听" : "开始收听"}
            onclick={toggleListen}
          >
            {#if isListening && currentPlay}
              <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
              </svg>
              <span>停止收听</span>
            {:else}
              <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 1c-4.97 0-9 4.03-9 9v7c0 1.66 1.34 3 3 3h3v-8H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-4v8h3c1.66 0 3-1.34 3-3v-7c0-4.97-4.03-9-9-9z" />
              </svg>
              <span>开始收听</span>
            {/if}
          </button>

          <div class="flex items-center justify-end">
            <button
              type="button"
              class="p-1.5 active:scale-95 transition-colors border-none bg-transparent cursor-pointer {playerPaneMode !== 'split' ? 'text-(--primary)' : 'text-[var(--chat-meta-color)] hover:text-(--primary)'}"
              aria-label={playerPaneMode === "split" ? "当前：歌词与列表并列，点击切换纯歌词" : playerPaneMode === "lyrics" ? "当前：纯歌词，点击切换纯播放列表" : "当前：纯播放列表，点击切换并列显示"}
              onclick={cyclePlayerPaneMode}
            >
              {#if playerPaneMode === "split"}
                <!-- 并列视图：上歌词 + 下列表 -->
                <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2.5" />
                  <line x1="3" y1="13" x2="21" y2="13" />
                  <line x1="7" y1="8.5" x2="17" y2="8.5" />
                  <line x1="7" y1="16.5" x2="15" y2="16.5" />
                </svg>
              {:else if playerPaneMode === "lyrics"}
                <!-- 纯歌词视图 -->
                <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                  <line x1="4" y1="6" x2="20" y2="6" />
                  <line x1="7" y1="10.5" x2="17" y2="10.5" />
                  <line x1="5" y1="15" x2="19" y2="15" />
                  <line x1="8" y1="19.5" x2="16" y2="19.5" />
                </svg>
              {:else}
                <!-- 纯播放列表视图 -->
                <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
                </svg>
              {/if}
            </button>
          </div>
        </div>
      </div>

      <!-- 歌词滚动 + 即将播放容器（支持 并列 / 纯歌词 / 纯列表 三态切换） -->
      <div class="flex-1 min-h-0 flex flex-col mx-4">
        {#if playerPaneMode !== "queue"}
          <div
            class="min-h-0 flex flex-col border-t border-[var(--chat-divider-color)]"
            style={playerPaneMode === "split" ? "flex: 56 1 0%;" : "flex: 1 1 0%;"}
          >
            {#if !currentPlay}
              <div class="flex-1 flex flex-col items-center justify-center gap-3.5 py-4 text-center">
                <p class="text-xs text-[var(--chat-meta-color)] m-0">
                  {!musicState ? "正在连接房间同步电台..." : "暂无播放歌曲，点一首歌和大家一起听吧~"}
                </p>
                {#if musicState}
                  <button
                    type="button"
                    class="chat-send-btn h-9! px-5! rounded-full! text-[13px]! gap-1.5"
                    onclick={() => switchMusicTab("search")}
                  >
                    <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                    </svg>
                    <span>去点歌</span>
                  </button>
                {/if}
              </div>
            {:else}
              <div
                bind:this={lyricsContainer}
                class="chat-lyrics-scroll relative flex-1 min-h-0 overflow-y-auto custom-scrollbar chat-scroll-autohide {lyricsScrolling ? 'is-scrolling' : ''} flex flex-col items-center gap-1 py-12 px-1 text-center"
                role="listbox"
                aria-label="歌词"
                onwheel={() => {
                  lastUserScrollAt = Date.now();
                  programmaticLyricScrollUntil = 0;
                  triggerLyricsScroll();
                }}
                ontouchstart={() => {
                  lastUserScrollAt = Date.now();
                  programmaticLyricScrollUntil = 0;
                  triggerLyricsScroll();
                }}
                onscroll={() => {
                  if (Date.now() > programmaticLyricScrollUntil) {
                    triggerLyricsScroll();
                  }
                }}
              >
                {#if lyricsStatus === "loading"}
                  <div class="text-[var(--chat-meta-color)] text-xs py-8">正在载入歌词...</div>
                {:else if lyrics.length === 0}
                  <div class="text-[var(--chat-meta-color)] text-xs py-8">暂无同步歌词</div>
                {:else}
                  {#each lyrics as line, idx (`${idx}-${line.time}`)}
                    {@const isCurrentLine = idx === activeLyricIndex}
                    <div
                      data-lyric-idx={idx}
                      role="option"
                      aria-selected={isCurrentLine}
                      class="w-full py-1 transition-all duration-300 leading-snug
                        {isCurrentLine ? 'text-[var(--chat-accent-text)] font-bold text-base' : 'text-sm text-[var(--chat-meta-color)]'}"
                    >
                      {line.text}
                    </div>
                  {/each}
                {/if}
              </div>
            {/if}
          </div>
        {/if}

        {#if playerPaneMode !== "lyrics"}
          <div
            class="min-h-0 flex flex-col border-t border-[var(--chat-divider-color)] pt-2 pb-2"
            style={playerPaneMode === "split" ? "flex: 44 1 0%;" : "flex: 1 1 0%;"}
          >
            <div class="flex items-center justify-between mb-1.5 shrink-0">
              <span class="text-xs font-medium text-[var(--chat-meta-color)]">
                即将播放 ({queue.length})
              </span>
            </div>

            {#if queue.length === 0}
              <div class="flex-1 flex flex-col items-center justify-center gap-1 text-center px-3">
                {#if currentPlay?.isFallback}
                  <span class="text-xs font-medium text-[var(--deep-text)]">
                    正在冷场轮播
                  </span>
                  <span class="text-[11px] text-[var(--chat-meta-color)] leading-relaxed">
                    背景音乐轮播中，点歌将立即切播 · 所有人可随时切歌
                  </span>
                {:else}
                  <span class="text-xs text-[var(--chat-meta-color)]">
                    暂无待播歌曲
                  </span>
                {/if}
              </div>
            {:else}
              <div
                class="flex-1 min-h-0 overflow-y-auto custom-scrollbar chat-scroll-autohide {queueScrolling ? 'is-scrolling' : ''} space-y-1"
                onscroll={triggerQueueScroll}
              >
                {#each queue as item (item.uid)}
                  <div class="flex items-center gap-2 py-1.5 px-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                    <div class="w-8 h-8 rounded-md overflow-hidden shrink-0 bg-(--primary)/10 flex items-center justify-center">
                      {#if item.track.cover}
                        <img src={item.track.cover} alt="" loading="lazy" class="w-full h-full object-cover" />
                      {:else}
                        <span class="text-[10px] text-(--primary)">♪</span>
                      {/if}
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="text-xs font-bold text-[var(--deep-text)] truncate">
                        {item.track.title}
                      </div>
                      <div class="text-[10px] text-[var(--chat-meta-color)] truncate">
                        {item.track.artist} ·
                        {#if item.requesterKey && onOpenUserProfile}
                          <button
                            type="button"
                            class="p-0 border-none bg-transparent text-inherit hover:text-[var(--primary)] cursor-pointer text-[10px] inline"
                            onclick={() => openRequesterProfile(item.requesterKey, item.requesterName)}
                          >
                            点歌：{item.requesterName}
                          </button>
                        {:else}
                          点歌：{item.requesterName}
                        {/if}
                      </div>
                    </div>

                    <div class="flex items-center gap-0.5 shrink-0">
                      {#if currentUser?.isAdmin}
                        <button
                          type="button"
                          class="chat-queue-icon-btn"
                          onclick={() => onPlayQueued(item.uid)}
                          aria-label={`切到 ${item.track.title}`}
                        >
                          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <path d="m7.07 18.62 8.43-5.95c.56-.39.56-1.24 0-1.64L7.07 5.08c-.65-.46-1.57 0-1.57.8v11.94c0 .8.92 1.26 1.57.8zM17 6c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1s-1-.45-1-1V7c0-.55.45-1 1-1z" />
                          </svg>
                        </button>
                      {/if}
                      {#if canRemoveEntry(item)}
                        <button
                          type="button"
                          class="chat-queue-icon-btn"
                          onclick={() => onRemoveQueue(item.uid)}
                          aria-label={`移除 ${item.track.title}`}
                        >
                          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {:else if activeTab === "search"}
    <!-- Tab 2：歌曲 / 歌手搜索与待播队列 -->
    <div class="px-3 pt-2.5 pb-2 shrink-0">
      <div class="relative">
        <svg class="w-3.5 h-3.5 text-[var(--chat-meta-color)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          bind:value={searchQuery}
          placeholder="搜索歌曲 / 歌手"
          class="chat-music-search is-focus-reveal"
          onkeydown={(e) => {
            if (e.key === "Enter" && searchQuery.trim()) {
              if (searchTimer !== null) window.clearTimeout(searchTimer);
              isSearching = true;
              void runSearch(searchQuery.trim());
            }
          }}
        />
        {#if searchQuery.trim().length > 0}
          <button
            type="button"
            class="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center border-none bg-transparent text-[var(--chat-meta-color)] hover:text-(--primary) cursor-pointer"
            aria-label="清除搜索"
            onclick={() => (searchQuery = "")}
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        {/if}
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 pb-3 space-y-3">
      <div>
        {#if !searchQuery.trim() && fallbackTracks.length === 0}
          <div class="text-center py-6 px-3 rounded-xl border border-dashed border-[var(--chat-divider-color)] space-y-1">
            <p class="text-xs font-medium text-[var(--deep-text)] m-0">搜索歌曲 / 歌手即可点播</p>
            <p class="text-[11px] text-[var(--chat-meta-color)] m-0">点歌后全房将同步播放与滚动歌词</p>
          </div>
        {:else}
          <div class="flex items-center justify-between mb-1 px-0.5">
            <span class="text-xs font-medium text-[var(--chat-meta-color)]">
              {searchQuery.trim()
                ? isSearching
                  ? "正在搜索..."
                  : `搜索结果 (${displayedBrowseTracks.length})`
                : `房间曲库 (${displayedBrowseTracks.length})`}
            </span>
          </div>

          {#if searchError}
            <div class="text-center py-4 text-xs text-red-500">{searchError}</div>
          {:else if !isSearching && displayedBrowseTracks.length === 0}
            <div class="text-center py-5 rounded-xl border border-dashed border-[var(--chat-divider-color)]">
              <p class="text-xs text-[var(--chat-meta-color)]">未找到相关歌曲，换个关键词试试吧</p>
            </div>
          {:else}
            <div class="space-y-0.5">
              {#each displayedBrowseTracks as song (song.id)}
                {@render trackRequestRow(
                  song,
                  `${song.artist}${song.durationSec ? ` · ${formatTime(song.durationSec)}` : ""}`,
                )}
              {/each}
            </div>
          {/if}
        {/if}
      </div>

      <div class="border-t border-[var(--chat-divider-color)]"></div>

      <div>
        <div class="flex items-center justify-between mb-1 px-0.5">
          <span class="text-xs font-medium text-[var(--chat-meta-color)]">
            房间待播队列 ({queue.length})
          </span>
        </div>

        {#if queue.length === 0}
          <div class="text-center py-4 text-xs text-[var(--chat-meta-color)]">
            待播队列为空，去挑一首歌加入电台吧
          </div>
        {:else}
          <div class="space-y-0.5">
            {#each queue as item (item.uid)}
              <div class="flex items-center gap-2 p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                <div class="w-8 h-8 rounded-md overflow-hidden shrink-0 bg-(--primary)/10 flex items-center justify-center">
                  {#if item.track.cover}
                    <img src={item.track.cover} alt="" loading="lazy" class="w-full h-full object-cover" />
                  {:else}
                    <span class="text-[10px] text-(--primary)">♪</span>
                  {/if}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="text-xs font-bold text-[var(--deep-text)] truncate">
                    {item.track.title}
                  </div>
                  <div class="text-[10px] text-[var(--chat-meta-color)] truncate">
                    {item.track.artist} ·
                    {#if item.requesterKey && onOpenUserProfile}
                      <button
                        type="button"
                        class="p-0 border-none bg-transparent text-inherit hover:text-[var(--primary)] cursor-pointer text-[10px] inline"
                        onclick={() => openRequesterProfile(item.requesterKey, item.requesterName)}
                      >
                        点歌：{item.requesterName}
                      </button>
                    {:else}
                      点歌：{item.requesterName}
                    {/if}
                  </div>
                </div>

                <div class="flex items-center gap-0.5 shrink-0">
                  {#if currentUser?.isAdmin}
                    <button
                      type="button"
                      class="chat-queue-icon-btn"
                      onclick={() => onPlayQueued(item.uid)}
                      aria-label={`切到 ${item.track.title}`}
                    >
                      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="m7.07 18.62 8.43-5.95c.56-.39.56-1.24 0-1.64L7.07 5.08c-.65-.46-1.57 0-1.57.8v11.94c0 .8.92 1.26 1.57.8zM17 6c.55 0 1 .45 1 1v10c0 .55-.45 1-1 1s-1-.45-1-1V7c0-.55.45-1 1-1z" />
                      </svg>
                    </button>
                  {/if}
                  {#if canRemoveEntry(item)}
                    <button
                      type="button"
                      class="chat-queue-icon-btn"
                      onclick={() => onRemoveQueue(item.uid)}
                      aria-label={`移除 ${item.track.title}`}
                    >
                      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {:else if activeTab === "playlist"}
    <!-- Tab 3：歌单（精选歌单 / 我的歌单 / 成员歌单 单列滚动） -->
    {#snippet playlistSummaryCard(pl: PlaylistSummary, showOwner = false)}
      <div class="flex items-center gap-2.5 p-2 rounded-xl border border-[var(--chat-divider-color)] bg-[var(--card-bg)]/45 hover:bg-[var(--card-bg)]/80 hover:border-(--primary)/30 transition-all shadow-xs">
        <button
          type="button"
          class="flex items-center gap-2.5 min-w-0 flex-1 text-left bg-transparent border-none p-0 cursor-pointer"
          onmouseenter={() => schedulePlaylistDetailPrefetch(pl.id)}
          onmouseleave={cancelPlaylistDetailPrefetch}
          onfocus={() => schedulePlaylistDetailPrefetch(pl.id)}
          onblur={cancelPlaylistDetailPrefetch}
          onclick={() => openPlaylistDetail(pl.id)}
        >
          <div class="w-10 h-10 rounded-lg overflow-hidden shrink-0 bg-(--primary)/12 flex items-center justify-center">
            {#if pl.coverUrl}
              <img src={pl.coverUrl} alt="" loading="lazy" class="w-full h-full object-cover" />
            {:else}
              <span class="text-sm text-(--primary)">♪</span>
            {/if}
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="text-xs font-bold text-[var(--deep-text)] truncate">{pl.title}</span>
              {#if pl.isFallback}
                <span class="shrink-0 text-[9px] font-semibold px-1.5 py-px rounded-full bg-(--primary)/15 text-[var(--chat-accent-text)]">
                  冷场轮播
                </span>
              {/if}
              {#if pl.isFeatured}
                <span class="shrink-0 text-[9px] font-semibold px-1.5 py-px rounded-full bg-(--primary)/12 text-[var(--chat-accent-text)]">
                  精选
                </span>
              {/if}
            </div>
            <div class="text-[10px] text-[var(--chat-meta-color)] truncate mt-0.5 flex items-center gap-1">
              <span>{formatPlatformLabel(pl.platform)} · {pl.trackCount} 首</span>
              {#if showOwner && pl.ownerName}
                <span>·</span>
                <span class="inline-flex items-center gap-1 min-w-0">
                  {#if pl.ownerAvatar}
                    <img src={pl.ownerAvatar} alt="" class="w-3 h-3 rounded-full object-cover shrink-0" />
                  {/if}
                  <span class="truncate">{pl.ownerName}</span>
                </span>
              {:else if pl.updatedAt}
                <span>· {formatPlaylistDate(pl.updatedAt)}</span>
              {/if}
            </div>
          </div>
        </button>

        {#if canManagePlaylist(pl)}
          <ChatTooltip text={isRefreshingPlaylistId === pl.id ? "正在同步歌单..." : "从平台重新拉取歌单"} align="right">
            <button
              type="button"
              disabled={isRefreshingPlaylistId === pl.id}
              class="chat-queue-icon-btn w-7! h-7! shrink-0 aspect-square"
              aria-label={`刷新 ${pl.title}`}
              onclick={() => handleRefreshPlaylist(pl)}
            >
              <svg class="w-3.5 h-3.5 {isRefreshingPlaylistId === pl.id ? 'animate-spin' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
          </ChatTooltip>
        {/if}
      </div>
    {/snippet}

    {#snippet importPlaylistCard()}
      <div class="rounded-xl border border-[var(--chat-divider-color)] bg-[var(--card-bg)]/45 p-3 space-y-2">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-bold text-[var(--deep-text)]">导入外部歌单</span>
          <a
            href="https://playlistout.lengxiqwq.com"
            target="_blank"
            rel="noopener noreferrer"
            class="text-[10px] text-[var(--chat-meta-color)] hover:text-(--primary) no-underline transition-colors"
          >
            Powered by Playlist Out
          </a>
        </div>

        <form
          class="flex items-center gap-1.5"
          onsubmit={(e) => {
            e.preventDefault();
            void handleImportSubmit();
          }}
        >
          <input
            type="text"
            class="chat-playlist-input flex-1 min-w-0"
            placeholder="粘贴歌单链接"
            aria-label="外部歌单链接"
            disabled={isImportingPlaylist}
            bind:value={importInput}
          />
          <button
            type="submit"
            disabled={isImportingPlaylist || !importInput.trim()}
            class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-(--primary) text-white border-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {isImportingPlaylist ? "解析中" : "导入"}
          </button>
        </form>

        {#if importError}
          <p class="text-[11px] text-red-500 m-0">{importError}</p>
        {/if}
        {#if importStatusText}
          <p class="text-[11px] text-[var(--chat-meta-color)] m-0">{importStatusText}</p>
        {/if}

        {#if pendingAmbiguousImport}
          <div class="pt-1 space-y-1.5 border-t border-[var(--chat-divider-color)]">
            <div class="text-[11px] font-medium text-[var(--deep-text)]">
              检测到多个可能匹配的平台，请选择：
            </div>
            <div class="space-y-1 max-h-40 overflow-y-auto custom-scrollbar">
              {#each pendingAmbiguousImport.candidates as cand (`${cand.platform}-${cand.kind}-${cand.id}`)}
                <button
                  type="button"
                  disabled={isImportingPlaylist}
                  class="w-full flex items-center justify-between gap-2 p-2 rounded-lg border border-[var(--chat-divider-color)] bg-[var(--card-bg)]/60 hover:bg-(--primary)/10 text-left cursor-pointer"
                  onclick={() =>
                    handleImportSubmit({
                      type: cand.kind,
                      platform: cand.platform,
                    })}
                >
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-semibold text-[var(--deep-text)] truncate">{cand.title}</div>
                    <div class="text-[10px] text-[var(--chat-meta-color)] truncate">
                      {formatPlatformLabel(cand.platform)}{cand.subtitle ? ` · ${cand.subtitle}` : ""}
                    </div>
                  </div>
                  <span class="text-[10px] font-semibold text-[var(--chat-accent-text)] shrink-0">选择</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        {#if pendingUserImport}
          <div class="pt-1 space-y-1.5 border-t border-[var(--chat-divider-color)]">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[11px] font-medium text-[var(--deep-text)] truncate">
                {pendingUserImport.nickname} 的公开歌单（点选导入）
              </span>
              <button
                type="button"
                class="text-[10px] text-[var(--chat-meta-color)] bg-transparent border-none cursor-pointer p-0"
                onclick={() => (pendingUserImport = null)}
              >
                收起
              </button>
            </div>
            <div class="space-y-1 max-h-44 overflow-y-auto custom-scrollbar">
              {#each pendingUserImport.playlists as item (item.id || item.sourceUrl)}
                <button
                  type="button"
                  disabled={isImportingPlaylist}
                  class="w-full flex items-center justify-between gap-2 p-1.5 rounded-lg border border-[var(--chat-divider-color)] bg-[var(--card-bg)]/60 hover:bg-(--primary)/10 text-left cursor-pointer"
                  onclick={() => handleImportUserCandidate(item)}
                >
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-medium text-[var(--deep-text)] truncate">{item.name}</div>
                    <div class="text-[10px] text-[var(--chat-meta-color)]">{item.trackCount} 首</div>
                  </div>
                  <span class="text-[10px] font-semibold text-[var(--chat-accent-text)] shrink-0">+ 导入</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/snippet}

    {#if selectedPlaylist}
      {@const safeSourceUrl = resolveSafeExternalUrl(selectedPlaylist.sourceUrl)}
      <!-- 歌单详情视图 -->
      <div class="flex-1 min-h-0 flex flex-col">
        <div class="px-3 pt-2.5 pb-2 border-b border-[var(--chat-divider-color)] space-y-2 shrink-0">
          <!-- 第 1 行：返回按钮 + 歌单内搜索框 -->
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              class="chat-queue-icon-btn w-7! h-7! shrink-0"
              aria-label="返回歌单列表"
              onclick={() => {
                selectedPlaylist = null;
                playlistTrackFilter = "";
                confirmDeletePlaylistId = "";
              }}
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>

            <div class="relative flex-1 min-w-0">
              <svg class="w-3.5 h-3.5 text-[var(--chat-meta-color)] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                class="chat-music-search is-immersive py-1.5! pl-8! pr-7! text-xs!"
                placeholder="搜歌名或歌手"
                aria-label="歌单内搜索"
                bind:value={playlistTrackFilter}
              />
              {#if playlistTrackFilter.trim().length > 0}
                <button
                  type="button"
                  class="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center border-none bg-transparent text-[var(--chat-meta-color)] hover:text-(--primary) cursor-pointer"
                  aria-label="清除筛选"
                  onclick={() => (playlistTrackFilter = "")}
                >
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              {/if}
            </div>
          </div>

          <!-- 第 2 行：封面图齐整靠左 + 歌单信息 -->
          <div class="flex items-center gap-2.5">
            <div class="w-10 h-10 rounded-lg overflow-hidden shrink-0 bg-(--primary)/12 flex items-center justify-center">
              {#if selectedPlaylist.coverUrl}
                <img src={selectedPlaylist.coverUrl} alt="" class="w-full h-full object-cover" />
              {:else}
                <span class="text-xs text-(--primary)">♪</span>
              {/if}
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="text-xs font-bold text-[var(--deep-text)] truncate">
                  {selectedPlaylist.title}
                </span>
                {#if selectedPlaylist.isFallback}
                  <span class="shrink-0 text-[9px] font-semibold px-1.5 py-px rounded-full bg-(--primary)/15 text-[var(--chat-accent-text)]">
                    冷场轮播
                  </span>
                {/if}
                {#if selectedPlaylist.isFeatured}
                  <span class="shrink-0 text-[9px] font-semibold px-1.5 py-px rounded-full bg-(--primary)/12 text-[var(--chat-accent-text)]">
                    精选
                  </span>
                {/if}
              </div>
              <div class="text-[10px] text-[var(--chat-meta-color)] truncate mt-0.5 flex items-center gap-1">
                <span>{formatPlatformLabel(selectedPlaylist.platform)} · {selectedPlaylist.tracks.length} 首</span>
                {#if selectedPlaylist.ownerName}
                  <span>·</span>
                  {#if onOpenUserProfile && selectedPlaylist.ownerKey}
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 min-w-0 bg-transparent border-none p-0 text-[10px] text-[var(--chat-accent-text)] hover:underline cursor-pointer"
                      onclick={() =>
                        selectedPlaylist &&
                        openRequesterProfile(
                          selectedPlaylist.ownerKey,
                          selectedPlaylist.ownerName,
                        )}
                    >
                      {#if selectedPlaylist.ownerAvatar}
                        <img src={selectedPlaylist.ownerAvatar} alt="" class="w-3 h-3 rounded-full object-cover shrink-0" />
                      {/if}
                      <span class="truncate">{selectedPlaylist.ownerName}</span>
                    </button>
                  {:else}
                    <span class="inline-flex items-center gap-1 min-w-0">
                      {#if selectedPlaylist.ownerAvatar}
                        <img src={selectedPlaylist.ownerAvatar} alt="" class="w-3 h-3 rounded-full object-cover shrink-0" />
                      {/if}
                      <span class="truncate">{selectedPlaylist.ownerName}</span>
                    </span>
                  {/if}
                {/if}
                {#if selectedPlaylist.retrievalMode === "preview"}
                  <span>· 仅预览</span>
                {/if}
              </div>
            </div>
          </div>

          <!-- 第 3 行：纯图标工具栏（左对齐，与上方歌单信息同一起点；同步时间收入刷新按钮悬浮提示，避免窄栏文字拥挤） -->
          <div class="flex items-center justify-start">
            <div class="flex items-center gap-1.5 shrink-0">
              <div class="chat-playlist-action-wrap">
                <button
                  type="button"
                  disabled={selectedPlaylist.tracks.length === 0 || isRandomizing}
                  class="chat-playlist-icon-btn {isRandomizing ? 'opacity-75 cursor-wait!' : ''}"
                  aria-label={isRandomizing ? "正在随机点歌..." : "随机点一首"}
                  onclick={() => selectedPlaylist && handleRandomPlayFromPlaylist(selectedPlaylist)}
                >
                  {#if isRandomizing}
                    <svg class="w-3.5 h-3.5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity="0.25" />
                      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
                    </svg>
                  {:else}
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polyline points="16 3 21 3 21 8" />
                      <line x1="4" y1="20" x2="21" y2="3" />
                      <polyline points="21 16 21 21 16 21" />
                      <line x1="15" y1="15" x2="21" y2="21" />
                      <line x1="4" y1="4" x2="9" y2="9" />
                    </svg>
                  {/if}
                </button>
                <span class="chat-playlist-tooltip align-left" role="tooltip">
                  {isRandomizing ? "正在随机点歌..." : "随机点一首"}
                </span>
              </div>

              {#if safeSourceUrl}
                <div class="chat-playlist-action-wrap">
                  <a
                    href={safeSourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="chat-playlist-icon-btn no-underline"
                    aria-label={`前往${formatPlatformLabel(selectedPlaylist.platform)}原歌单`}
                  >
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </a>
                  <span class="chat-playlist-tooltip {!canManagePlaylist(selectedPlaylist) ? 'align-right' : ''}" role="tooltip">
                    前往{formatPlatformLabel(selectedPlaylist.platform)}原歌单
                  </span>
                </div>
              {/if}

              {#if canManagePlaylist(selectedPlaylist)}
                <div class="chat-playlist-action-wrap">
                  <button
                    type="button"
                    disabled={isRefreshingPlaylistId === selectedPlaylist.id}
                    class="chat-playlist-icon-btn"
                    aria-label={selectedPlaylist.updatedAt ? `刷新同步歌单（上次同步于 ${formatPlaylistDate(selectedPlaylist.updatedAt)}）` : "刷新同步歌单"}
                    onclick={() => selectedPlaylist && handleRefreshPlaylist(selectedPlaylist)}
                  >
                    <svg class="w-3.5 h-3.5 {isRefreshingPlaylistId === selectedPlaylist.id ? 'animate-spin' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polyline points="23 4 23 10 17 10" />
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                  </button>
                  <span class="chat-playlist-tooltip {!currentUser?.isAdmin ? 'align-right' : ''}" role="tooltip">
                    {#if isRefreshingPlaylistId === selectedPlaylist.id}
                      正在同步...
                    {:else if selectedPlaylist.updatedAt}
                      上次同步于 {formatPlaylistDate(selectedPlaylist.updatedAt)}
                    {:else}
                      刷新同步歌单
                    {/if}
                  </span>
                </div>

                {#if currentUser?.isAdmin}
                  <div class="chat-playlist-action-wrap">
                    <button
                      type="button"
                      disabled={isUpdatingFlagsId === selectedPlaylist.id}
                      class="chat-playlist-icon-btn {selectedPlaylist.isFeatured ? 'is-active' : ''}"
                      aria-label={selectedPlaylist.isFeatured ? "取消房间精选" : "设为房间精选"}
                      onclick={() => selectedPlaylist && handleTogglePlaylistFlag(selectedPlaylist, "isFeatured")}
                    >
                      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill={selectedPlaylist.isFeatured ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                    </button>
                    <span class="chat-playlist-tooltip" role="tooltip">
                      {selectedPlaylist.isFeatured ? "取消房间精选" : "设为房间精选"}
                    </span>
                  </div>

                  <div class="chat-playlist-action-wrap">
                    <button
                      type="button"
                      disabled={isUpdatingFlagsId === selectedPlaylist.id}
                      class="chat-playlist-icon-btn {selectedPlaylist.isFallback ? 'is-active' : ''}"
                      aria-label={selectedPlaylist.isFallback ? "取消冷场轮播" : "设为冷场轮播"}
                      onclick={() => selectedPlaylist && handleTogglePlaylistFlag(selectedPlaylist, "isFallback")}
                    >
                      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="2" />
                        <path d="M16.24 7.76a6 6 0 0 1 0 8.49" />
                        <path d="M7.76 16.24a6 6 0 0 1 0-8.49" />
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                        <path d="M4.93 19.07a10 10 0 0 1 0-14.14" />
                      </svg>
                    </button>
                    <span class="chat-playlist-tooltip" role="tooltip">
                      {selectedPlaylist.isFallback ? "取消冷场轮播" : "设为冷场轮播"}
                    </span>
                  </div>
                {/if}

                {#if isOwnPlaylist(selectedPlaylist)}
                  <div class="chat-playlist-action-wrap">
                    <button
                      type="button"
                      disabled={isDeletingPlaylistId === selectedPlaylist.id}
                      class="chat-playlist-icon-btn {confirmDeletePlaylistId === selectedPlaylist.id ? 'is-danger-confirm' : 'is-danger'}"
                      aria-label={confirmDeletePlaylistId === selectedPlaylist.id ? "再次点击确认删除" : "删除歌单"}
                      onclick={() => selectedPlaylist && handleDeletePlaylist(selectedPlaylist)}
                    >
                      {#if confirmDeletePlaylistId === selectedPlaylist.id}
                        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      {:else}
                        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      {/if}
                    </button>
                    <span
                      class="chat-playlist-tooltip align-right {confirmDeletePlaylistId === selectedPlaylist.id ? 'is-armed' : ''}"
                      role="tooltip"
                    >
                      {#if isDeletingPlaylistId === selectedPlaylist.id}
                        正在删除...
                      {:else if confirmDeletePlaylistId === selectedPlaylist.id}
                        再次点击确认删除
                      {:else}
                        删除歌单
                      {/if}
                    </span>
                  </div>
                {/if}
              {/if}
            </div>
          </div>
        </div>

        <div
          class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 py-1.5"
          onscroll={handlePlaylistScroll}
        >
          {#if isLoadingPlaylistDetail}
            <div class="text-center py-6 text-xs text-[var(--chat-meta-color)]">
              正在加载歌单曲目...
            </div>
          {:else if filteredPlaylistTracks.length === 0}
            <div class="text-center py-6 text-xs text-[var(--chat-meta-color)]">
              {playlistTrackFilter.trim() ? "没有匹配的歌曲" : "歌单暂无曲目"}
            </div>
          {:else}
            <div class="space-y-0.5">
              {#each displayedPlaylistTracks as item (`${selectedPlaylist.id}-${item.position}`)}
                {@const track = toEnqueueableTrack(item, selectedPlaylist.id)}
                {@const subtitle = `${item.artist}${item.durationSec ? ` · ${formatTime(item.durationSec)}` : ""}`}
                {@render trackRequestRow(track, subtitle)}
              {/each}
            </div>
            {#if hasMorePlaylistTracks}
              <div class="py-2 flex justify-center">
                <button
                  type="button"
                  class="chat-queue-toggle-btn"
                  onclick={() => (playlistVisibleLimit += 100)}
                >
                  加载更多（剩余 {filteredPlaylistTracks.length - displayedPlaylistTracks.length} 首）
                </button>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {:else}
      <!-- 歌单目录视图：精选歌单 / 我的歌单 / 成员歌单 三段纵向排列 -->
      <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar chat-scrollbar-stable px-3 pb-4 pt-2 space-y-3">
        {#if playlistsError}
          <div class="text-xs text-red-500 px-1">{playlistsError}</div>
        {/if}

        <!-- 段落 1：房间精选（可折叠） -->
        <section class="space-y-1.5">
          <button
            type="button"
            class="w-full flex items-center justify-between gap-2 bg-transparent border-none p-0 cursor-pointer text-left"
            aria-expanded={!featuredCollapsed}
            onclick={() => (featuredCollapsed = !featuredCollapsed)}
          >
            <span class="flex items-center gap-1.5 min-w-0">
              <span class="text-[11px] font-bold text-[var(--deep-text)]">精选歌单</span>
              {#if featuredPlaylists.length > 0}
                <span class="text-[10px] font-semibold text-[var(--chat-meta-color)] tabular-nums">{featuredPlaylists.length}</span>
              {/if}
            </span>
            <svg
              class="w-3.5 h-3.5 shrink-0 text-[var(--chat-meta-color)] transition-transform {featuredCollapsed ? '-rotate-90' : ''}"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {#if !featuredCollapsed}
            {#if isLoadingPlaylists && featuredPlaylists.length === 0}
              <div class="text-center py-4 text-xs text-[var(--chat-meta-color)]">加载中...</div>
            {:else if featuredPlaylists.length === 0}
              <div class="rounded-xl border border-dashed border-[var(--chat-divider-color)] bg-[var(--card-bg)]/30 p-3 text-[11px] text-[var(--chat-meta-color)] text-center">
                这个房间还没有精选歌单
              </div>
            {:else}
              <div class="space-y-1.5">
                {#each featuredPlaylists as pl (pl.id)}
                  {@render playlistSummaryCard(pl, Boolean(pl.ownerName))}
                {/each}
              </div>
            {/if}
          {/if}
        </section>

        <!-- 段落 2：我的歌单（导入入口常驻在列表上方） -->
        <section class="space-y-1.5">
          <button
            type="button"
            class="w-full flex items-center justify-between gap-2 bg-transparent border-none p-0 cursor-pointer text-left"
            aria-expanded={!myCollapsed}
            onclick={() => (myCollapsed = !myCollapsed)}
          >
            <span class="flex items-center gap-1.5 min-w-0">
              <span class="text-[11px] font-bold text-[var(--deep-text)]">我的歌单</span>
              {#if isWalineLoggedIn && myPlaylists.length > 0}
                <span class="text-[10px] font-semibold text-[var(--chat-meta-color)] tabular-nums">{myPlaylists.length}</span>
              {/if}
            </span>
            <svg class="w-3.5 h-3.5 shrink-0 text-[var(--chat-meta-color)] transition-transform {myCollapsed ? '-rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {#if !myCollapsed}
          {#if !isWalineLoggedIn}
            <div class="rounded-xl border border-amber-500/35 bg-amber-500/10 p-3 space-y-2">
              {#if currentUser?.authType === "guest"}
                <div class="flex items-center gap-1.5 text-[11px] font-bold text-amber-600 dark:text-amber-400">
                  <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span>当前为访客身份，无法使用个人歌单</span>
                </div>
                <p class="text-[11px] leading-relaxed text-[var(--deep-text)] m-0">
                  你目前仅填写了访客昵称和邮箱，必须使用 <strong class="font-bold">Waline 账号</strong>登录后，才可导入并管理自己的歌单（访客仍可浏览精选与成员歌单）。
                </p>
              {:else}
                <div class="flex items-center gap-1.5 text-[11px] font-bold text-[var(--deep-text)]">
                  <svg class="w-3.5 h-3.5 text-(--primary) shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <span>需要 Waline 登录</span>
                </div>
                <p class="text-[11px] leading-relaxed text-[var(--chat-meta-color)] m-0">
                  必须使用 <strong class="font-bold text-[var(--deep-text)]">Waline 账号</strong>登录后，才可导入并保存自己的歌单（临时访客身份暂不支持）。
                </p>
              {/if}
              {#if onRequestWalineAuth || onRequestAuth}
                <div class="pt-0.5">
                  <button
                    type="button"
                    disabled={walineLoginWaiting}
                    class="px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-(--primary) text-white border-none cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-not-allowed"
                    onclick={() => (onRequestWalineAuth ?? onRequestAuth)?.()}
                  >
                    {walineLoginWaiting ? "等待 Waline 完成登录..." : "使用 Waline 账号登录"}
                  </button>
                </div>
              {/if}
            </div>
          {:else}
            {@render importPlaylistCard()}
            {#if myPlaylists.length === 0}
              <div class="rounded-xl border border-dashed border-[var(--chat-divider-color)] bg-[var(--card-bg)]/30 p-3 text-[11px] text-[var(--chat-meta-color)] text-center">
                还没有导入个人歌单，在上方粘贴歌单链接试试吧
              </div>
            {:else}
              <div class="space-y-1.5">
                {#each myPlaylists as pl (pl.id)}
                  {@render playlistSummaryCard(pl, false)}
                {/each}
              </div>
            {/if}
          {/if}
          {/if}
        </section>

        <!-- 段落 3：成员歌单（按成员分组，扁平列表） -->
        <section class="space-y-2">
          <button
            type="button"
            class="w-full flex items-center justify-between gap-2 bg-transparent border-none p-0 cursor-pointer text-left"
            aria-expanded={!membersCollapsed}
            onclick={() => (membersCollapsed = !membersCollapsed)}
          >
            <span class="flex items-center gap-1.5 min-w-0">
              <span class="text-[11px] font-bold text-[var(--deep-text)]">成员歌单</span>
              {#if membersPlaylists.length > 0}
                <span class="text-[10px] font-semibold text-[var(--chat-meta-color)] tabular-nums">{membersPlaylists.length}</span>
              {/if}
            </span>
            <svg class="w-3.5 h-3.5 shrink-0 text-[var(--chat-meta-color)] transition-transform {membersCollapsed ? '-rotate-90' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {#if !membersCollapsed}
          {#if isLoadingPlaylists && membersPlaylists.length === 0}
            <div class="text-center py-4 text-xs text-[var(--chat-meta-color)]">加载中...</div>
          {:else if memberPlaylistGroups.length === 0}
            <div class="rounded-xl border border-dashed border-[var(--chat-divider-color)] bg-[var(--card-bg)]/30 p-3 text-[11px] text-[var(--chat-meta-color)] text-center">
              还没有其他成员上传歌单
            </div>
          {:else}
            <div>
              {#each memberPlaylistGroups as group, groupIndex (group.ownerKey)}
                <div class={groupIndex > 0 ? "mt-2.5 pt-2.5 border-t border-[var(--chat-divider-color)]" : ""}>
                  <div class="flex items-center gap-2 px-1 pb-1">
                    <button
                      type="button"
                      class="flex items-center gap-1.5 min-w-0 flex-1 bg-transparent border-none p-0 cursor-pointer text-left transition-opacity hover:opacity-80"
                      aria-label={`查看 ${group.ownerName} 的个人资料`}
                      onclick={() => openRequesterProfile(group.ownerKey, group.ownerName)}
                    >
                      <ChatAvatar src={group.ownerAvatar} name={group.ownerName} size="2xs" />
                      <span class="text-[11px] font-semibold text-[var(--deep-text)] truncate">{group.ownerName}</span>
                    </button>
                    <span class="text-[10px] text-[var(--chat-meta-color)] tabular-nums shrink-0">{group.playlists.length} 张</span>
                  </div>
                  <div class="space-y-1.5 mt-1">
                    {#each group.playlists as pl (pl.id)}
                      {@render playlistSummaryCard(pl, false)}
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
          {/if}
        </section>
      </div>
    {/if}
  {:else}
    <!-- Tab 4：点歌历史记录（支持 按时间 / 按次数 两种排序与按点歌人筛选，紧凑两行展示） -->
    <div class="px-3 pt-2.5 pb-1.5 flex items-center justify-between gap-1.5 shrink-0 relative">
      <div class="inline-flex items-center gap-0.5 rounded-lg bg-[var(--card-bg)]/60 p-0.5 border border-[var(--chat-divider-color)]" role="group" aria-label="历史排序方式">
        <button
          type="button"
          class="px-2 py-0.5 text-[11px] font-medium rounded-md border-none cursor-pointer transition-colors whitespace-nowrap
            {historySort === 'recent'
              ? 'bg-(--primary) text-white'
              : 'bg-transparent text-[var(--chat-meta-color)] hover:text-[var(--deep-text)]'}"
          onclick={() => (historySort = "recent")}
        >
          按时间
        </button>
        <button
          type="button"
          class="px-2 py-0.5 text-[11px] font-medium rounded-md border-none cursor-pointer transition-colors whitespace-nowrap
            {historySort === 'count'
              ? 'bg-(--primary) text-white'
              : 'bg-transparent text-[var(--chat-meta-color)] hover:text-[var(--deep-text)]'}"
          onclick={() => (historySort = "count")}
        >
          按次数
        </button>
      </div>

      <div class="relative shrink-0" data-history-filter-wrap>
        <button
          type="button"
          aria-expanded={showRequesterFilter}
          class="inline-flex items-center gap-1 max-w-32 px-2 py-1 text-[11px] font-medium rounded-lg border cursor-pointer transition-colors
            {selectedRequester
              ? 'bg-(--primary) text-white border-transparent'
              : 'bg-[var(--card-bg)]/60 text-[var(--chat-meta-color)] border-[var(--chat-divider-color)] hover:text-[var(--deep-text)]'}"
          onclick={() => (showRequesterFilter = !showRequesterFilter)}
        >
          <svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
          <span class="truncate">{selectedRequester ? selectedRequester.name : "筛选"}</span>
        </button>

        {#if showRequesterFilter}
          <div class="chat-requester-menu custom-scrollbar" role="menu" aria-label="按点歌人筛选">
            <button
              type="button"
              role="menuitem"
              class="chat-requester-option {!selectedRequesterKey ? 'active' : ''}"
              onclick={() => {
                selectedRequesterKey = "";
                showRequesterFilter = false;
              }}
            >
              <span class="truncate">全部点歌记录</span>
              <span class="text-[10px] opacity-70 tabular-nums shrink-0">{musicState?.history?.length ?? displayedHistoryEntries.length}首</span>
            </button>

            {#if historyRequesters.length > 0}
              <div class="my-1 border-t border-black/5 dark:border-white/10"></div>
              {#each historyRequesters as person (person.key)}
                <button
                  type="button"
                  role="menuitem"
                  class="chat-requester-option {selectedRequesterKey === person.key ? 'active' : ''}"
                  onclick={() => {
                    selectedRequesterKey = person.key;
                    showRequesterFilter = false;
                  }}
                >
                  <span class="flex items-center gap-1.5 min-w-0 flex-1">
                    <ChatAvatar
                      src={person.avatar}
                      name={person.name}
                      size="2xs"
                    />
                    <span class="truncate">{person.name}</span>
                    {#if person.badge}
                      <span class="shrink-0 text-[9px] px-1 py-px rounded bg-black/5 dark:bg-white/10 text-[var(--chat-meta-color)]">{person.badge}</span>
                    {/if}
                    {#if person.isMe}
                      <span class="shrink-0 text-[9px] px-1 py-px rounded bg-(--primary)/15 text-[var(--chat-accent-text)]">我</span>
                    {/if}
                  </span>
                  <span class="text-[10px] opacity-70 tabular-nums shrink-0">{person.trackCount}首</span>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 py-1.5">
      {#if displayedHistoryEntries.length === 0}
        <div class="text-center py-8 px-3 rounded-xl border border-dashed border-[var(--chat-divider-color)] space-y-2">
          <p class="text-xs text-[var(--chat-meta-color)] m-0">
            {selectedRequester ? `${selectedRequester.name} 还没有点歌记录` : "房间里还没有历史点歌记录"}
          </p>
          {#if selectedRequester}
            <button
              type="button"
              class="chat-queue-toggle-btn"
              onclick={() => (selectedRequesterKey = "")}
            >
              查看全部
            </button>
          {:else}
            <button
              type="button"
              class="chat-queue-toggle-btn"
              onclick={() => switchMusicTab("search")}
            >
              去点歌
            </button>
          {/if}
        </div>
      {:else}
        <div class="space-y-0.5">
          {#each displayedHistoryEntries as entry (`${entry.track.id}-${historySort}-${selectedRequesterKey}`)}
            {@const subtitle = [
              entry.track.artist,
              entry.track.durationSec ? formatTime(entry.track.durationSec) : "",
              entry.lastRequesterName || "",
            ].filter(Boolean).join(" · ")}
            {@render trackRequestRow(
              entry.track,
              subtitle,
              `${entry.requestCount}次`,
            )}
          {/each}
        </div>
      {/if}
    </div>
  {/if}

</aside>
