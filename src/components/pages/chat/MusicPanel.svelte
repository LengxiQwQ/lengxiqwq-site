<script lang="ts">
import { onMount, tick, untrack } from "svelte";
import type {
	ChatSessionUser,
	MusicHistoryEntry,
	QueueEntry,
	RoomMusicState,
} from "./chatTypes";
import type { ChatMusicTrack } from "./musicTypes";

interface Props {
	roomId: string;
	fallbackTracks?: ChatMusicTrack[];
	musicState: RoomMusicState | null;
	currentUser: ChatSessionUser | null;
	onlineMemberCount: number;
	clockOffsetMs: number;
	initialVolume?: number;
	onSearchOnline: (keyword: string) => Promise<ChatMusicTrack[]>;
	onEnqueueTrack: (track: ChatMusicTrack) => void;
	onRemoveQueue: (uid: string) => void;
	onPlayQueued: (uid: string) => void;
	onSkipTrack: () => void;
	onVoteSkip: () => void;
	onReportDuration: (playUid: string, durationSec: number) => void;
	onTrackEnded: (playUid: string) => void;
	onReportError: (playUid: string) => void;
	onRequestAuth?: () => void;
}

interface LyricLine {
	time: number;
	text: string;
}

const {
	roomId,
	fallbackTracks = [],
	musicState = null,
	currentUser = null,
	onlineMemberCount = 0,
	clockOffsetMs = 0,
	initialVolume = 1,
	onSearchOnline,
	onEnqueueTrack,
	onRemoveQueue,
	onPlayQueued,
	onSkipTrack,
	onVoteSkip,
	onReportDuration,
	onTrackEnded,
	onReportError,
	onRequestAuth,
}: Props = $props();

const initVol = untrack(() =>
	Number.isFinite(initialVolume) ? Math.min(1, Math.max(0, initialVolume)) : 1,
);

type MusicTab = "player" | "search" | "playlist" | "history";
type HistorySortMode = "recent" | "count";

interface HistoryRequesterOption {
	key: string;
	name: string;
	avatar: string;
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
let internalAudioAction = false;
let showQueueDrawer = $state(true);
let roomElapsed = $state(0);
let localDuration = $state(0);
let volume = $state(initVol);
let coverLoadFailed = $state(false);

// 搜索相关状态
let searchQuery = $state("");
let searchResults = $state<ChatMusicTrack[]>([]);
let isSearching = $state(false);
let searchError = $state("");
let searchTimer: number | null = null;

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

	return Array.from(peopleMap.values())
		.map((p) => ({
			key: p.key,
			name:
				currentUser && p.key === currentUser.userKey
					? currentUser.name
					: p.name,
			avatar: p.avatar,
			trackCount: p.tracks.size,
			totalRequests: p.totalRequests,
			isMe: Boolean(currentUser && p.key === currentUser.userKey),
		}))
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
const canDirectSkip = $derived(
	Boolean(currentUser && currentPlay) &&
		(isAdmin || isOwnRequest || (isSoloMode && soloCooldownRemainSec === 0)),
);
const isSoloCoolingDown = $derived(
	Boolean(currentUser && currentPlay) &&
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

function canToggleCatalogTrack(songId: string): boolean {
	if (!currentUser) return true; // Clicking prompts auth modal via parent
	if (currentUser.isAdmin) return true;
	const existing = queue.find((item) => item.track.id === songId);
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

function formatTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
	const mins = Math.floor(seconds / 60);
	const secs = Math.floor(seconds % 60);
	return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

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

async function seekAndPlayCurrent(el: HTMLAudioElement) {
	isSyncingAudio = true;
	try {
		if (el.readyState < 1) {
			await new Promise<void>((resolve) => {
				el.addEventListener("loadedmetadata", () => resolve(), { once: true });
				window.setTimeout(resolve, 1800);
			});
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
		await el.play();
		roomElapsed = computeExpectedElapsed();
	} catch {
		isListening = false;
		el.muted = true;
	} finally {
		isSyncingAudio = false;
	}
}

async function startOrResumeAudio() {
	if (!audioEl || !currentPlay) return;
	if (volume === 0) volume = 0.5;
	hasJoinedAudio = true;
	isListening = true;

	registerMediaSessionHandlers();
	updateMediaSessionMetadata();

	internalAudioAction = true;
	audioEl.muted = false;
	audioEl.volume = volume;
	window.setTimeout(() => {
		internalAudioAction = false;
	}, 50);

	await seekAndPlayCurrent(audioEl);
	updateMediaSessionMetadata();
}

async function toggleListen() {
	if (isListening) {
		muteLocally();
		return;
	}
	await startOrResumeAudio();
}

function handleVolumeInput(value: number) {
	const clamped = Math.min(1, Math.max(0, value));
	volume = clamped;
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
			pendingAutoUnmuteTrackId === active.track.id &&
			Date.now() - pendingAutoUnmuteAt < 12_000 &&
			currentUser &&
			active.requesterKey === currentUser.userKey,
	);
	if (shouldAutoUnmute) {
		pendingAutoUnmuteTrackId = "";
	}

	void loadLyricsForUrl(active.track.lrcUrl || active.track.lrc);
	updateMediaSessionMetadata();

	void tick().then(async () => {
		if (!audioEl) return;
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
			await seekAndPlayCurrent(audioEl);
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

	isSearching = true;
	searchError = "";
	searchTimer = window.setTimeout(() => {
		void runSearch(q);
	}, 420);
});

async function runSearch(q: string) {
	try {
		const tracks = await onSearchOnline(q);
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

function handleToggleQueueTrack(song: ChatMusicTrack) {
	if (currentPlay?.track.id === song.id) return;
	const existing = queue.find((item) => item.track.id === song.id);
	if (existing) {
		if (!canRemoveEntry(existing)) return;
		onRemoveQueue(existing.uid);
	} else {
		// 当前没有歌在播放时，自己点的第一首歌自动取消静音开播；已有歌在播则保持静音
		if (!currentPlay && currentUser) {
			pendingAutoUnmuteTrackId = song.id;
			pendingAutoUnmuteAt = Date.now();
		}
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
		if (audioEl) {
			internalAudioAction = true;
			audioEl.pause();
		}
		if (typeof navigator !== "undefined" && "mediaSession" in navigator) {
			navigator.mediaSession.playbackState = "none";
		}
	};
});

const displayedBrowseTracks = $derived(
	searchQuery.trim() ? searchResults : fallbackTracks,
);
</script>

<aside class="flex flex-col h-full w-full min-h-0 overflow-hidden select-none" aria-label="点歌台">
  <audio
    bind:this={audioEl}
    src={currentPlay?.track.streamUrl || ""}
    preload="metadata"
    muted={!isListening}
    onloadedmetadata={syncDurationFromAudio}
    ondurationchange={syncDurationFromAudio}
    oncanplay={syncDurationFromAudio}
    onpause={() => {
      // 响应硬件耳机/系统后台暂停：自动转入“本地静音”态，不停止房间时钟
      if (!internalAudioAction && isListening) {
        isListening = false;
        if (audioEl) audioEl.muted = true;
        if (typeof navigator !== "undefined" && "mediaSession" in navigator && hasJoinedAudio) {
          navigator.mediaSession.playbackState = "paused";
        }
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

  <!-- 4-Tab 切换栏：正在播放 / 搜索 / 歌单 / 历史 -->
  <div class="grid grid-cols-4 gap-1 border-b border-[var(--chat-divider-color)] px-2.5 py-1.5 shrink-0" role="tablist" aria-label="点歌台视图切换">
    <button
      type="button"
      role="tab"
      aria-selected={activeTab === "player"}
      class="flex items-center justify-center gap-1 py-1.5 px-1 text-[11px] font-medium whitespace-nowrap transition-colors rounded-lg cursor-pointer border-none
        {activeTab === 'player'
          ? 'bg-(--btn-plain-bg-hover) text-(--primary)'
          : 'bg-transparent text-[var(--chat-meta-color)] hover:bg-(--btn-plain-bg-hover) hover:text-[var(--deep-text)]'}"
      onclick={() => switchMusicTab("player")}
    >
      <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
        <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
      </svg>
      <span>播放</span>
    </button>

    <button
      type="button"
      role="tab"
      aria-selected={activeTab === "search"}
      class="flex items-center justify-center gap-1 py-1.5 px-1 text-[11px] font-medium whitespace-nowrap transition-colors rounded-lg cursor-pointer border-none
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
      class="flex items-center justify-center gap-1 py-1.5 px-1 text-[11px] font-medium whitespace-nowrap transition-colors rounded-lg cursor-pointer border-none
        {activeTab === 'playlist'
          ? 'bg-(--btn-plain-bg-hover) text-(--primary)'
          : 'bg-transparent text-[var(--chat-meta-color)] hover:bg-(--btn-plain-bg-hover) hover:text-[var(--deep-text)]'}"
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
      class="flex items-center justify-center gap-1 py-1.5 px-1 text-[11px] font-medium whitespace-nowrap transition-colors rounded-lg cursor-pointer border-none
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
    {@const isCurrent = currentPlay?.track.id === song.id}
    {@const isQueued = queuedTrackIds.has(song.id)}
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
      {:else if isQueued && !canToggleCatalogTrack(song.id)}
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

            <div class="flex items-center gap-1.5 min-w-0 mt-0.5">
              <span class="text-xs font-medium text-[var(--chat-meta-color)] truncate">
                {currentPlay ? currentPlay.track.artist : !musicState ? "正在连接电台..." : "暂无点播歌曲"}
              </span>
              {#if currentPlay}
                <span class="shrink-0 text-[10px] font-medium px-1.5 py-px rounded-full bg-(--primary)/12 text-[var(--chat-accent-text)]">
                  点歌：{currentPlay.requesterName}
                </span>
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
                <div class="w-14 flex items-center">
                  <div class="chat-slim-slider" style="--pct: {volumeRatio};">
                    <div class="chat-slim-slider-fill"></div>
                    <div class="chat-slim-slider-thumb"></div>
                    <input
                      type="range"
                      aria-label="音量"
                      min="0"
                      max="1"
                      step="0.02"
                      value={volumeRatio}
                      class="chat-slim-slider-input"
                      oninput={(e) => handleVolumeInput(Number(e.currentTarget.value))}
                    />
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

        <!-- 控制栏：左 切歌/切歌倒计时/投票切歌 + 中 收听/静音 + 右 队列抽屉开关 -->
        <div class="flex items-center justify-between py-1 gap-1.5">
          <div class="min-w-8 flex items-center justify-start shrink-0">
            {#if !currentPlay}
              <button
                type="button"
                disabled
                class="chat-skip-pill opacity-45 cursor-not-allowed!"
              >
                <span>{isAdmin || isSoloMode ? "切歌" : "投票切歌"}</span>
              </button>
            {:else if canDirectSkip}
              {@const activeVotes = musicState?.voteCount ?? 0}
              {@const activeThreshold = musicState?.voteThreshold ?? 2}
              <button
                type="button"
                class="chat-skip-pill whitespace-nowrap {activeVotes > 0 ? 'voted' : ''}"
                aria-label={activeVotes > 0 ? `已有 ${activeVotes}/${activeThreshold} 人投票切歌，点击立即切歌` : "切歌"}
                onclick={onSkipTrack}
              >
                <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                </svg>
                <span>切歌</span>
                {#if activeVotes > 0}
                  <span class="tabular-nums">{activeVotes}/{activeThreshold}</span>
                {/if}
              </button>
            {:else if isSoloCoolingDown}
              {@const activeVotes = musicState?.voteCount ?? 0}
              {@const activeThreshold = musicState?.voteThreshold ?? 2}
              <button
                type="button"
                class="chat-skip-pill whitespace-nowrap {activeVotes > 0 ? 'voted' : 'opacity-75'}"
                onclick={onSkipTrack}
              >
                <span>切歌 {soloCooldownRemainSec}s</span>
                {#if activeVotes > 0}
                  <span class="tabular-nums">{activeVotes}/{activeThreshold}</span>
                {/if}
              </button>
            {:else}
              <button
                type="button"
                class="chat-skip-pill {hasVotedSkip ? 'voted' : ''}"
                aria-label={hasVotedSkip ? "取消投票" : "投票切歌"}
                onclick={onVoteSkip}
              >
                <span>{hasVotedSkip ? "已投切歌" : "投票切歌"}</span>
                <span>{musicState?.voteCount ?? 0}/{musicState?.voteThreshold ?? 2}</span>
              </button>
            {/if}
          </div>

          <button
            type="button"
            disabled={!currentPlay}
            class="chat-play-btn {isListening && currentPlay ? 'playing' : ''} shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
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

          <div class="w-8 flex items-center justify-end shrink-0">
            <button
              type="button"
              class="p-1.5 active:scale-95 transition-colors border-none bg-transparent cursor-pointer {showQueueDrawer ? 'text-(--primary)' : 'text-[var(--chat-meta-color)] hover:text-(--primary)'}"
              aria-label={showQueueDrawer ? "收起即将播放" : "展开即将播放"}
              onclick={() => (showQueueDrawer = !showQueueDrawer)}
            >
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- 歌词滚动 (60%) + 即将播放 (40%) 容器 -->
      <div class="flex-1 min-h-0 flex flex-col mx-4">
        <div
          class="min-h-0 flex flex-col border-t border-[var(--chat-divider-color)]"
          style={showQueueDrawer ? "flex: 3 1 0%;" : "flex: 1 1 0%;"}
        >
          {#if !currentPlay}
            <div class="flex-1 flex flex-col items-center justify-center gap-2.5 py-4 text-center">
              <p class="text-xs text-[var(--chat-meta-color)] m-0">
                {!musicState ? "正在连接房间同步电台..." : "暂无播放歌曲，点一首歌和大家一起听吧~"}
              </p>
              {#if musicState}
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
            <div
              bind:this={lyricsContainer}
              class="chat-lyrics-scroll relative flex-1 min-h-0 overflow-y-auto custom-scrollbar flex flex-col items-center gap-1 py-12 px-1 text-center"
              role="listbox"
              aria-label="歌词"
              onwheel={() => {
                lastUserScrollAt = Date.now();
              }}
              ontouchstart={() => {
                lastUserScrollAt = Date.now();
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

        {#if showQueueDrawer}
          <div
            class="min-h-0 flex flex-col border-t border-[var(--chat-divider-color)] pt-2 pb-2"
            style="flex: 2 1 0%;"
          >
            <div class="flex items-center justify-between mb-1.5 shrink-0">
              <span class="text-xs font-medium text-[var(--chat-meta-color)]">
                即将播放 ({queue.length})
              </span>
            </div>

            {#if queue.length === 0}
              <div class="flex-1 flex items-center justify-center text-xs text-[var(--chat-meta-color)]">
                暂无待播歌曲
              </div>
            {:else}
              <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-1">
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
                        {item.track.artist} · 点歌：{item.requesterName}
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
          class="chat-music-search"
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
                    {item.track.artist} · 点歌：{item.requesterName}
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
    <!-- Tab 3：歌单（预留接入公共导出歌单与个人歌单） -->
    <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 space-y-3">
      <div class="rounded-xl border border-dashed border-[var(--chat-divider-color)] bg-[var(--card-bg)]/35 p-3.5 space-y-2">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 text-xs font-bold text-[var(--deep-text)]">
            <svg class="w-3.5 h-3.5 text-(--primary) shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
            <span>房间精选歌单</span>
          </div>
          <span class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-(--primary)/12 text-[var(--chat-accent-text)]">
            即将接入
          </span>
        </div>
        <p class="text-[11px] leading-relaxed text-[var(--chat-meta-color)] m-0">
          此处已预留接入 <code class="text-[10px]">playlistout</code> 导出的歌单目录，后续将支持一键浏览站点歌单并将曲目快速加入点播队列。
        </p>
      </div>

      <div class="rounded-xl border border-dashed border-[var(--chat-divider-color)] bg-[var(--card-bg)]/35 p-3.5 space-y-2">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 text-xs font-bold text-[var(--deep-text)]">
            <svg class="w-3.5 h-3.5 text-(--primary) shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span>我的个人歌单</span>
          </div>
          <span class="text-[10px] font-medium px-2 py-0.5 rounded-full bg-[var(--card-bg)]/70 border border-[var(--chat-divider-color)] text-[var(--chat-meta-color)]">
            预留功能
          </span>
        </div>
        <p class="text-[11px] leading-relaxed text-[var(--chat-meta-color)] m-0">
          {#if currentUser?.authType === "waline"}
            当前已登录「{currentUser.name}」，后续可在此配置并管理属于你自己的个人点歌歌单。
          {:else}
            后续每位登录用户均可建立并同步自己的个人歌单，随时在聊天室里快速点播。
          {/if}
        </p>
        {#if (!currentUser || currentUser.authType === "guest") && onRequestAuth}
          <div class="pt-1">
            <button
              type="button"
              class="chat-queue-toggle-btn"
              onclick={onRequestAuth}
            >
              登录账号
            </button>
          </div>
        {/if}
      </div>

      <div class="pt-1 flex justify-center">
        <button
          type="button"
          class="chat-queue-toggle-btn"
          onclick={() => switchMusicTab("search")}
        >
          去点歌
        </button>
      </div>
    </div>
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
                    {#if person.avatar}
                      <img src={person.avatar} alt="" class="w-4 h-4 rounded-full object-cover shrink-0" />
                    {:else}
                      <span class="w-4 h-4 rounded-full bg-(--primary)/15 text-[var(--chat-accent-text)] text-[9px] font-bold inline-flex items-center justify-center shrink-0">
                        {person.name.slice(0, 1)}
                      </span>
                    {/if}
                    <span class="truncate">{person.name}</span>
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
              entry.lastRequesterName ? `点歌：${entry.lastRequesterName}` : "",
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
