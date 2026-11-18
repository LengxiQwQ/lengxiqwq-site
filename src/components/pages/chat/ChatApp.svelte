<script lang="ts">
import { onMount, tick } from "svelte";
import type { ChatRoomMeta, InterconnectSite } from "@/types/chatConfig";
import ChatAuthModal from "./ChatAuthModal.svelte";
import ChatInterconnectPopover from "./ChatInterconnectPopover.svelte";
import ChatPollCreateModal from "./ChatPollCreateModal.svelte";
import ChatProfileModal from "./ChatProfileModal.svelte";
import ChatUserDetailModal from "./ChatUserDetailModal.svelte";
import ChatWindow from "./ChatWindow.svelte";
import {
	type ChatAppearanceSettings,
	type ChatPanelSlot,
	type ChatWallpaperConfig,
	isChatPanelSlot,
	loadChatAppearanceSettings,
	loadDevPanelWallpaperPreviews,
	resolveSlotWallpaperSrc,
	saveDevPanelWallpaperPreview,
	setRuntimeChatWallpaperCatalog,
	trackBgImgAspectRatio,
} from "./chatAppearance";
import {
	buildWsUrl,
	clearGuestAuth,
	clearWalineAuth,
	consumeUrlWalineToken,
	isMentionedForUser,
	normalizeServerUrl,
	openWalineLoginPopup,
	readStoredWalineToken,
	resolveChatAvatarUrl,
	resolveInitialAuth,
	type ServerPacket,
	saveMemberBadges,
	searchOnlineMusic,
} from "./chatClient";
import type {
	ChatCustomBadge,
	ChatMentionCandidate,
	ChatMessageRecord,
	ChatOnlineMember,
	ChatProfileDraft,
	ChatReadReceipt,
	ChatSessionUser,
	ChatSpectatorRecord,
	ChatUserDetailSeed,
	ConnectionState,
	ImageAttachment,
	RoomMusicState,
} from "./chatTypes";
import MusicPanel from "./MusicPanel.svelte";
import { MusicClock } from "./musicClock";
import type { AudioStatus } from "./roomAudioPlayer";
import type { ChatMusicTrack } from "./musicTypes";
import RoomPanel from "./RoomPanel.svelte";
import {
	buildStickerLookup,
	loadStickerPacks,
	type StickerPack,
} from "./stickerLoader";

interface Props {
	chatServerUrl?: string;
	walineServerUrl?: string;
	playlistOutApiUrl?: string;
	rooms?: ChatRoomMeta[];
	enableImageUpload?: boolean;
	stickerPackUrls?: string[];
	musicTracks?: ChatMusicTrack[];
	initialMusicVolume?: number;
	interconnectSites?: InterconnectSite[];
	siteAvatar?: string;
}

const {
	chatServerUrl = "",
	walineServerUrl = "",
	playlistOutApiUrl = "https://playlistout-api.lengxiqwq.com",
	rooms = [{ id: "chat", name: "闲聊", subtitle: "随便聊聊日常与折腾" }],
	enableImageUpload = true,
	stickerPackUrls = ["/assets/stickers/qq", "/assets/stickers/miku"],
	musicTracks = [],
	initialMusicVolume = 1,
	interconnectSites = [],
	siteAvatar = "",
}: Props = $props();

const LAST_SEEN_PREFIX = "lengxi_chat_last_seen:";
const LAST_ROOM_STORAGE_KEY = "lengxi_chat_last_room";

let mobileDrawer = $state<"none" | "room" | "music">("none");
const roomPanelId = "chat-room-panel";
let isMobileLayout = $state(false);
let splitLayoutBreakpoint = $state(1240);
let stageContentRect = $state<DOMRectReadOnly>();
const isSplitLayout = $derived(
	!isMobileLayout &&
		stageContentRect !== undefined &&
		stageContentRect.width < splitLayoutBreakpoint,
);
let splitRoomOpen = $state(false);
let roomPanelEl: HTMLDivElement;
let splitRoomTrigger: HTMLButtonElement | undefined;
let currentRoom = $state(rooms[0]?.id || "chat");
let connectionState = $state<ConnectionState>("idle");
let isWindowFocused = $state(true);
let isIdleAway = $state(false);
const isEffectiveFocused = $derived(isWindowFocused && !isIdleAway);
let currentUser = $state<ChatSessionUser | null>(null);
let onlineMembers = $state<ChatOnlineMember[]>([]);
let observers = $state<ChatOnlineMember[]>([]);
function uniqueObservers(list: ChatOnlineMember[]): ChatOnlineMember[] {
	return [...new Map(list.map(observer => [observer.userKey, observer])).values()];
}

let spectatorHistory = $state<ChatSpectatorRecord[]>([]);

$effect(() => {
	if (currentUser?.isAdmin) {
		void refreshSpectatorHistory();
	} else {
		spectatorHistory = [];
	}
});
let roomOnlineMembers = $state<ChatOnlineMember[]>([]);
let hasGlobalPresence = false;
let roomMentionMembers = $state<ChatMentionCandidate[]>([]);
let globalMemberDirectory = $state<ChatMentionCandidate[]>([]);
const mentionMembers = $derived.by<ChatMentionCandidate[]>(() => {
	const onlineKeys = new Set(onlineMembers.map((member) => member.userKey));
	const merged = new Map<string, ChatMentionCandidate>();
	for (const member of globalMemberDirectory) {
		merged.set(member.userKey, {
			...member,
			online: onlineKeys.has(member.userKey),
		});
	}
	for (const member of roomMentionMembers) {
		const previous = merged.get(member.userKey);
		merged.set(member.userKey, {
			...previous,
			...member,
			avatar: member.avatar || previous?.avatar || "",
			bio: member.bio || previous?.bio,
			status: member.status || previous?.status,
			customBadges: member.customBadges || previous?.customBadges,
			lastSeenAt: Math.max(member.lastSeenAt || 0, previous?.lastSeenAt || 0),
			online: onlineKeys.has(member.userKey),
		});
	}
	return [...merged.values()].sort((a, b) => {
		if (a.online !== b.online) return a.online ? -1 : 1;
		if (a.online && b.online) {
			if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
			return a.name.localeCompare(b.name, "zh-CN");
		}
		const aTime = a.lastSeenAt || 0;
		const bTime = b.lastSeenAt || 0;
		if (aTime !== bTime) {
			return bTime - aTime;
		}
		if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
		return a.name.localeCompare(b.name, "zh-CN");
	});
});
let totalOnlineCount = $state(0);
let messages = $state<ChatMessageRecord[]>([]);
const roomMessageCache = new Map<string, ChatMessageRecord[]>();

function mergeRoomMessages(
	serverMessages: ChatMessageRecord[],
	cachedMessages: ChatMessageRecord[],
	hasMoreHistory: boolean,
): ChatMessageRecord[] {
	if (!hasMoreHistory || cachedMessages.length === 0) return serverMessages;
	const seen = new Set(serverMessages.map((message) => message.msgUid));
	const oldest = serverMessages[0]?.createdAt ?? Number.MAX_SAFE_INTEGER;
	const older = cachedMessages.filter(
		(message) => !seen.has(message.msgUid) && message.createdAt < oldest,
	);
	if (older.length === 0) return serverMessages;
	return [...older, ...serverMessages].sort(
		(a, b) => a.createdAt - b.createdAt,
	);
}
let hasMoreHistory = $state(false);
let oldestHistoryId = $state(0);
let isLoadingHistory = $state(false);
let historyLoadTimeoutTimer: number | null = null;

function clearHistoryLoadTimer() {
	if (historyLoadTimeoutTimer !== null) {
		window.clearTimeout(historyLoadTimeoutTimer);
		historyLoadTimeoutTimer = null;
	}
}
let sessionUnreadSince = $state(0);
let serverUnreadCount = $state(0);
let serverUnreadUserCount = $state(0);
let unreadJumpSeq = $state(0);
let pinnedUids = $state<string[]>([]);
let roomTopic = $state<string>("");
let roomAvatars = $state<Record<string, string>>({});
let typingUsers = $state<string[]>([]);
let readReceipts = $state<Record<string, ChatReadReceipt[]>>({});
let musicState = $state<RoomMusicState | null>(null);
let musicAudience = $state({ onlineCount: 0, listeningCount: 0 });
const songRequests = new Map<string, {
	room: string;
	finish: (ok: boolean) => void;
}>();
let isSkippingTrack = $state(false);
let skipPendingTimer: number | null = null;
let clockOffsetMs = $state(0);
let hasClockSample = false;
const musicClock = new MusicClock();
const serverNow = () => musicClock.now();
let clockPingSeq = 0;
let clockBurstRemaining = 0;
const pendingClockPings = new WeakMap<WebSocket, { wall: number; monotonic: number; id: number }>();
let chatAudio: HTMLAudioElement | null = $state(null);
let noticeText = $state("");
let noticeVisible = $state(false);
let noticeTone = $state<"default" | "error">("default");
let targetMessageUid = $state("");
let showInterconnect = $state(false);
let totalChatterCount = $state(0);
let walineToken = $state("");
let playlistRefreshSeq = $state(0);
let musicPanelRef: {
	toggleListenControl?: () => void;
	openPlayerTab?: () => void;
} | null = $state(null);
let mobilePlaybackStatus = $state<{
	isListening: boolean;
	audioStatus?: AudioStatus;
	isMuted: boolean;
	elapsedSec: number;
	durationSec: number;
	canDirectSkip: boolean;
	isSoloCoolingDown: boolean;
	soloCooldownRemainSec: number;
	hasVotedSkip: boolean;
	volume?: number;
}>({
	isListening: false,
	isMuted: true,
	elapsedSec: 0,
	durationSec: 0,
	canDirectSkip: false,
	isSoloCoolingDown: false,
	soloCooldownRemainSec: 0,
	hasVotedSkip: false,
	volume: initialMusicVolume,
});

// 全局收听意愿管理（仅在同一次页面会话内跨房间切换时保持，刚进页面默认未收听）
let isListeningIntent = $state(false);
let lastListenPacket = "";
let memoryVolume = $state(initialMusicVolume);
let hasAppMounted = false;

const NOTIFICATION_STORAGE_KEY = "fireflyChatDesktopNotification";
let desktopNotificationEnabled = $state(false);
let desktopNotificationPermission = $state<NotificationPermission>("default");
let roomUnreadCounts = $state<Record<string, number>>({});
const otherRoomsUnreadCount = $derived.by(() =>
	Object.entries(roomUnreadCounts).reduce(
		(acc, [rId, cnt]) => (rId !== currentRoom ? acc + (cnt || 0) : acc),
		0,
	),
);

let stageTouchStart: { x: number; y: number; time: number } | null = null;

$effect(() => {
	if (!isSplitLayout) splitRoomOpen = false;
});

function closeSplitRoom(restoreFocus = false) {
	if (!splitRoomOpen) return;
	splitRoomOpen = false;
	if (restoreFocus) splitRoomTrigger?.focus({ preventScroll: true });
}

async function toggleSplitRoom(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
	if (splitRoomOpen) {
		closeSplitRoom(true);
		return;
	}
	splitRoomTrigger = event.currentTarget;
	splitRoomOpen = true;
	if (event.detail === 0) {
		await tick();
		if (isSplitLayout && splitRoomOpen) {
			roomPanelEl.querySelector<HTMLButtonElement>(".chat-split-room-close")?.focus();
		}
	}
}

$effect(() => {
	if (!isSplitLayout || !splitRoomOpen) return;

	function handleOutsidePointer(event: PointerEvent) {
		if (
			event.target instanceof Element &&
			!roomPanelEl.contains(event.target) &&
			!splitRoomTrigger?.contains(event.target) &&
			!event.target.closest(".chat-modal-backdrop")
		) {
			closeSplitRoom();
		}
	}

	function handleEscape(event: KeyboardEvent) {
		if (
			event.key === "Escape" &&
			!event.defaultPrevented &&
			!event.isComposing &&
			!document.querySelector(".chat-modal-backdrop")
		) {
			closeSplitRoom(true);
		}
	}

	document.addEventListener("pointerdown", handleOutsidePointer, true);
	document.addEventListener("keydown", handleEscape);
	return () => {
		document.removeEventListener("pointerdown", handleOutsidePointer, true);
		document.removeEventListener("keydown", handleEscape);
	};
});

function handleStageTouchStart(e: TouchEvent) {
	if (typeof window === "undefined" || e.touches.length !== 1) return;
	if (!window.matchMedia("(width < 768px)").matches) return;
	const target = e.target as HTMLElement | null;
	if (
		target?.closest(
			"input, textarea, .chat-slim-slider, .chat-slider-control, .chat-picker-tabs, .chat-md-table-wrap, pre, code",
		)
	) {
		stageTouchStart = null;
		return;
	}
	const t = e.touches[0];
	stageTouchStart = { x: t.clientX, y: t.clientY, time: Date.now() };
}

function handleStageTouchEnd(e: TouchEvent) {
	if (!stageTouchStart || e.changedTouches.length !== 1) return;
	const start = stageTouchStart;
	stageTouchStart = null;
	const t = e.changedTouches[0];
	const dx = t.clientX - start.x;
	const dy = t.clientY - start.y;
	const dt = Date.now() - start.time;
	if (dt > 600 || Math.abs(dx) < 56 || Math.abs(dy) > Math.abs(dx) * 0.65) {
		return;
	}
	const vw = window.innerWidth || 375;
	if (mobileDrawer === "none") {
		if (dx > 0 && start.x < Math.min(96, vw * 0.28)) {
			mobileDrawer = "room";
		} else if (dx < 0 && start.x > vw - Math.min(96, vw * 0.28)) {
			mobileDrawer = "music";
		}
	} else if (mobileDrawer === "room" && dx < -48) {
		mobileDrawer = "none";
	} else if (mobileDrawer === "music" && dx > 48) {
		mobileDrawer = "none";
	}
}

let lastMarkedServerReadAt = 0;
let lastReportedAudioKey = "";
const socketHandshakeAuth = new WeakMap<WebSocket, string>();

$effect(() => {
	const userKey = currentUser?.userKey || "spectator";
	const muted = mobilePlaybackStatus.isMuted;
	if (connectionState !== "connected") {
		lastReportedAudioKey = "";
		return;
	}
	const key = `${currentRoom}:${userKey}:${muted ? 1 : 0}`;
	if (key === lastReportedAudioKey) return;
	if (ws && ws.readyState === WebSocket.OPEN) {
		lastReportedAudioKey = key;
		ws.send(JSON.stringify({ type: "presence:audio", isMuted: muted }));
	}
});

let lastReportedFocusKey = "";
/** 同步上报当前焦点/离开状态至网关，避免切标签页时仅依赖微任务 $effect 而延误发送 */
function reportFocusState(force = false) {
	if (connectionState !== "connected") {
		lastReportedFocusKey = "";
		return;
	}
	if (!ws || ws.readyState !== WebSocket.OPEN) return;
	const focused = isWindowFocused && !isIdleAway;
	const userKey = currentUser?.userKey || "spectator";
	const key = `${currentRoom}:${userKey}:${focused ? 1 : 0}`;
	if (!force && key === lastReportedFocusKey) return;
	lastReportedFocusKey = key;
	ws.send(JSON.stringify({ type: "presence:focus", isFocused: focused }));
}

$effect(() => {
	// 订阅响应式依赖变化（房间、身份、连接状态、有效焦点）作为兜底同步
	void currentRoom;
	void currentUser?.userKey;
	void connectionState;
	void isEffectiveFocused;
	reportFocusState();
});

function mergeRoomPresence(
	roomId: string,
	members: ChatOnlineMember[],
	totalCount?: number,
) {
	const memberMap = new Map(onlineMembers.map((m) => [m.userKey, m]));
	for (const m of members) {
		const existing = memberMap.get(m.userKey);
		memberMap.set(m.userKey, {
			...existing,
			...m,
			roomId: m.roomId || existing?.roomId || roomId,
		});
	}
	onlineMembers = [...memberMap.values()];
	if (typeof totalCount === "number" && totalCount > 0) {
		totalOnlineCount = Math.max(totalCount, onlineMembers.length);
	}
}

function readAnyStoredLastSeen(roomId: string): number {
	if (typeof localStorage === "undefined") return 0;
	let best = 0;
	try {
		const prefix = `${LAST_SEEN_PREFIX}${roomId}:`;
		for (let i = 0; i < localStorage.length; i += 1) {
			const k = localStorage.key(i);
			if (!k?.startsWith(prefix)) continue;
			const val = Number(localStorage.getItem(k) || 0);
			if (Number.isFinite(val) && val > best) {
				best = val;
			}
		}
	} catch {
		// Ignore
	}
	return best;
}

function readUserLastSeen(roomId: string, userKey: string): number {
	if (typeof localStorage === "undefined") return 0;
	try {
		const specific = Number(
			localStorage.getItem(
				`${LAST_SEEN_PREFIX}${roomId}:${userKey || "guest"}`,
			) || 0,
		);
		if (Number.isFinite(specific) && specific > 0) return specific;
		return readAnyStoredLastSeen(roomId);
	} catch {
		return 0;
	}
}

function persistUserLastSeen(roomId: string, userKey: string, ts: number) {
	if (typeof localStorage === "undefined" || !Number.isFinite(ts) || ts <= 0) {
		return;
	}
	try {
		const key = `${LAST_SEEN_PREFIX}${roomId}:${userKey || "guest"}`;
		const prev = Number(localStorage.getItem(key) || 0);
		if (ts > prev) {
			localStorage.setItem(key, String(ts));
		}
	} catch {
		// Ignore
	}
}

function readStoredRoom(): string {
	if (typeof localStorage === "undefined") return "";
	try {
		return localStorage.getItem(LAST_ROOM_STORAGE_KEY)?.trim() || "";
	} catch {
		return "";
	}
}

function persistStoredRoom(roomId: string) {
	if (typeof localStorage === "undefined" || !roomId) return;
	try {
		localStorage.setItem(LAST_ROOM_STORAGE_KEY, roomId);
	} catch {
		// Ignore
	}
}

// 切换房间后同步 URL 上的 room 参数，避免刷新时被旧参数带回上一个房间
function syncRoomUrl(roomId: string) {
	if (typeof window === "undefined" || !roomId) return;
	try {
		const url = new URL(window.location.href);
		if (url.searchParams.get("room") === roomId) return;
		url.searchParams.set("room", roomId);
		window.history.replaceState(
			null,
			"",
			`${url.pathname}${url.search}${url.hash}`,
		);
	} catch {
		// Ignore
	}
}

let showProfileModal = $state(false);
let chatAppearance = $state<ChatAppearanceSettings>(loadChatAppearanceSettings());
let catalogRevision = $state(0);
let devPanelPreviews = $state<Partial<Record<ChatPanelSlot, string>>>({});
let failedPanelBg = $state<Record<ChatPanelSlot, boolean>>({
	left: false,
	center: false,
	right: false,
	input: false,
});
let sideDragActive = $state<{ left: boolean; right: boolean }>({
	left: false,
	right: false,
});
const sideDragCounters = { left: 0, right: 0 };

const effectivePanelBgUrls = $derived.by(() => {
	void catalogRevision;
	return {
		left: resolveSlotWallpaperSrc("left", chatAppearance, devPanelPreviews),
		center: resolveSlotWallpaperSrc("center", chatAppearance, devPanelPreviews),
		right: resolveSlotWallpaperSrc("right", chatAppearance, devPanelPreviews),
		input: resolveSlotWallpaperSrc("input", chatAppearance, devPanelPreviews),
	};
});

const preloadedImageUrls = new Set<string>();

function preloadImageUrl(url: string) {
	if (!url || preloadedImageUrls.has(url) || typeof Image === "undefined") return;
	preloadedImageUrls.add(url);
	const img = new Image();
	img.decoding = "async";
	img.src = url;
}

$effect(() => {
	const urls: string[] = [
		effectivePanelBgUrls.left,
		effectivePanelBgUrls.center,
		effectivePanelBgUrls.right,
		effectivePanelBgUrls.input,
	];
	for (const site of interconnectSites) {
		const resolved = resolveChatAvatarUrl(site.avatar);
		if (resolved) urls.push(resolved);
	}
	const pending = urls.filter((u) => u && !preloadedImageUrls.has(u));
	if (pending.length === 0) return;

	const run = () => {
		for (const url of pending) {
			preloadImageUrl(url);
		}
	};
	if (typeof window !== "undefined" && "requestIdleCallback" in window) {
		const id = window.requestIdleCallback(run, { timeout: 1200 });
		return () => window.cancelIdleCallback(id);
	}
	const timer = setTimeout(run, 100);
	return () => clearTimeout(timer);
});

function handleSidePanelDragEnter(slot: "left" | "right", e: DragEvent) {
	if (!import.meta.env.DEV) return;
	if (!e.dataTransfer?.types?.includes("Files")) return;
	e.preventDefault();
	e.stopPropagation();
	sideDragCounters[slot] += 1;
	sideDragActive = { ...sideDragActive, [slot]: true };
}

function handleSidePanelDragOver(slot: "left" | "right", e: DragEvent) {
	if (!import.meta.env.DEV) return;
	if (!e.dataTransfer?.types?.includes("Files")) return;
	e.preventDefault();
	e.stopPropagation();
	if (e.dataTransfer) {
		e.dataTransfer.dropEffect = "copy";
	}
	if (!sideDragActive[slot]) {
		sideDragActive = { ...sideDragActive, [slot]: true };
	}
}

function handleSidePanelDragLeave(slot: "left" | "right", e: DragEvent) {
	if (!import.meta.env.DEV) return;
	e.preventDefault();
	e.stopPropagation();
	sideDragCounters[slot] = Math.max(0, sideDragCounters[slot] - 1);
	if (sideDragCounters[slot] === 0) {
		sideDragActive = { ...sideDragActive, [slot]: false };
	}
}

async function handleSidePanelDrop(slot: "left" | "right", e: DragEvent) {
	if (!import.meta.env.DEV) return;
	e.preventDefault();
	e.stopPropagation();
	sideDragCounters[slot] = 0;
	sideDragActive = { ...sideDragActive, [slot]: false };
	const files = Array.from(e.dataTransfer?.files || []);
	const imageFile = files.find((f) => f.type.startsWith("image/"));
	if (!imageFile) {
		showNotice("请拖入图片文件以预览面板壁纸");
		return;
	}
	await saveDevPanelWallpaperPreview(slot, imageFile);
	showNotice(
		slot === "left"
			? `已更新左侧面板壁纸预览：${imageFile.name}`
			: `已更新右侧面板壁纸预览：${imageFile.name}`,
	);
}
let showAuthModal = $state(false);
let showUserDetailModal = $state(false);
let showPollCreateModal = $state(false);

function openAuthModal() {
	showUserDetailModal = false;
	showProfileModal = false;
	showAuthModal = true;
}

$effect(() => {
	if (showAuthModal) {
		showUserDetailModal = false;
		showProfileModal = false;
	}
});
let userDetailSeed = $state<ChatUserDetailSeed | null>(null);
let externalPlaylistRequest = $state<
	{ playlistId: string; seq: number } | undefined
>(undefined);
let walineLoginWaiting = $state(false);
let mentionEvent = $state<
	{ name: string; userKey?: string; seq: number } | undefined
>(undefined);
let stickerPacks = $state<StickerPack[]>([]);

let mentionSeq = 0;
let externalPlaylistSeq = 0;
let baseDocumentTitle = "";
let ws: WebSocket | null = null;
let pendingCloseSocket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let noticeTimer: number | null = null;
let cancelWalinePopup: (() => void) | null = null;
let reconnectAttempt = 0;
let isUnmounted = false;
let currentAuth: { kind: "waline" | "guest"; token: string } | null = null;

const stickerMap = $derived(buildStickerLookup(stickerPacks));
const activeMeta = $derived(
	rooms.find((r) => r.id === currentRoom) ??
		rooms[0] ?? { id: "chat", name: "闲聊", subtitle: "随便聊聊日常与折腾" },
);
const normalizedChatServer = $derived(normalizeServerUrl(chatServerUrl));

function clearSkipPending() {
	isSkippingTrack = false;
	if (skipPendingTimer !== null) {
		window.clearTimeout(skipPendingTimer);
		skipPendingTimer = null;
	}
}

function startSkipPending() {
	isSkippingTrack = true;
	if (skipPendingTimer !== null) {
		window.clearTimeout(skipPendingTimer);
	}
	skipPendingTimer = window.setTimeout(() => {
		isSkippingTrack = false;
		skipPendingTimer = null;
	}, 4500);
}

function handleSkipTrack() {
	if (!currentUser) {
		showAuthModal = true;
		return;
	}
	if (isSkippingTrack) return;
	if (sendPacket({ type: "music:skip", playUid: musicState?.current?.uid })) {
		startSkipPending();
	}
}

function handleVoteSkip() {
	if (!currentUser) {
		showAuthModal = true;
		return;
	}
	if (isSkippingTrack) return;
	const hasVoted = Boolean(
		musicState?.current?.skipVotes.includes(currentUser.userKey),
	);
	const willPass =
		!hasVoted &&
		(musicState?.voteCount ?? 0) + 1 >= (musicState?.voteThreshold ?? 2);
	if (sendPacket({ type: "music:vote_skip", playUid: musicState?.current?.uid }) && willPass) {
		startSkipPending();
	}
}

function handlePlayQueued(uid: string) {
	if (!currentUser) {
		showAuthModal = true;
		return;
	}
	sendPacket({ type: "music:play_queued", uid, playUid: musicState?.current?.uid });
}

function placeGlobalToast(node: HTMLDivElement) {
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		},
	};
}

function showNotice(msg: string, tone?: "default" | "error") {
	noticeText = msg;
	noticeTone =
		tone ??
		(/(失败|不可用|异常|错误|无法|未找到|超时|拒绝|拦截)/.test(msg)
			? "error"
			: "default");
	noticeVisible = true;
	if (noticeTimer !== null) window.clearTimeout(noticeTimer);
	noticeTimer = window.setTimeout(() => {
		noticeVisible = false;
	}, 3600);
}

async function handleToggleDesktopNotification() {
	if (typeof window === "undefined" || !("Notification" in window)) {
		showNotice("当前浏览器不支持桌面系统通知");
		return;
	}

	desktopNotificationPermission = Notification.permission;

	if (Notification.permission === "denied") {
		showNotice("系统通知权限已被浏览器拒绝，请在浏览器地址栏的网站设置中允许通知权限");
		return;
	}

	if (Notification.permission === "default") {
		try {
			const perm = await Notification.requestPermission();
			desktopNotificationPermission = perm;
			if (perm === "granted") {
				desktopNotificationEnabled = true;
				try {
					localStorage.setItem(NOTIFICATION_STORAGE_KEY, "true");
				} catch {}
				showNotice("已开启聊天室桌面通知");
			} else {
				desktopNotificationEnabled = false;
				showNotice("未授予通知权限，可在浏览器设置中随时开启");
			}
		} catch {
			showNotice("请求通知权限失败");
		}
		return;
	}

	if (desktopNotificationEnabled) {
		desktopNotificationEnabled = false;
		try {
			localStorage.setItem(NOTIFICATION_STORAGE_KEY, "false");
		} catch {}
		showNotice("已关闭系统桌面通知");
	} else {
		desktopNotificationEnabled = true;
		try {
			localStorage.setItem(NOTIFICATION_STORAGE_KEY, "true");
		} catch {}
		showNotice("已开启系统桌面通知");
	}
}

function triggerDesktopNotification(roomId: string, message: ChatMessageRecord) {
	if (!desktopNotificationEnabled) return;
	if (typeof window === "undefined" || !("Notification" in window)) return;
	if (Notification.permission !== "granted") return;

	if (currentUser && message.userKey === currentUser.userKey) return;
	if (message.kind !== "user") return;

	const isCurrent = roomId === currentRoom;
	if (isCurrent && !document.hidden && isWindowFocused) {
		return;
	}

	const roomMeta = rooms.find((r) => r.id === roomId);
	const roomTitle = roomMeta?.name ? `#${roomMeta.name}` : `#${roomId}`;
	const senderName = message.name || "未知用户";
	const title = `${roomTitle} · ${senderName}`;

	let body = (message.content || "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "[图片]")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`#*_~]/g, "")
		.trim();

	if (message.attachments && message.attachments.length > 0) {
		body = body ? `${body} [图片]` : "[图片]";
	}
	if (message.poll) {
		body = `[发起投票] ${message.poll.question || body}`;
	}
	if (!body) {
		body = "[新消息]";
	}
	if (body.length > 100) {
		body = `${body.slice(0, 97)}...`;
	}

	const avatarUrl = resolveChatAvatarUrl(message.avatar);
	const icon = avatarUrl || "/favicon.ico";

	try {
		const notification = new Notification(title, {
			body,
			icon,
			tag: `chat-msg-${roomId}-${message.msgUid}`,
		});

		notification.onclick = () => {
			window.focus();
			if (currentRoom !== roomId) {
				handleRoomSelect(roomId);
			}
			notification.close();
		};
	} catch (e) {
		console.warn("[ChatApp] notification error:", e);
	}
}

function sendPacket(packet: Record<string, unknown>): boolean {
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		showNotice(
			navigator.onLine ? "正在重新连接聊天室，请稍候..." : "网络已断开，请检查网络连接",
		);
		return false;
	}
	ws.send(JSON.stringify(packet));
	return true;
}

function getFixedRoleBadge(user: ChatSessionUser): string {
	if (user.isAdmin) return "站长";
	return user.authType === "waline" ? "认证" : "访客";
}

function sampleRoomClock(socket: WebSocket | null, refresh = false) {
	if (refresh && socket?.readyState === WebSocket.OPEN) {
		musicClock.resetSamples();
		pendingClockPings.delete(socket);
		clockBurstRemaining = 3;
	}
	if (socket?.readyState !== WebSocket.OPEN || pendingClockPings.has(socket)) return;
	const sample = { wall: Date.now(), monotonic: performance.now(), id: ++clockPingSeq };
	pendingClockPings.set(socket, sample);
	socket.send(JSON.stringify({ type: "ping", id: sample.id, musicSyncVersion: 2, musicListening: isListeningIntent && mobilePlaybackStatus.audioStatus !== "blocked" }));
	window.setTimeout(() => {
		if (pendingClockPings.get(socket) === sample) pendingClockPings.delete(socket);
	}, 5000);
}

function clearReconnectTimer() {
	if (reconnectTimer !== null) {
		window.clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
}

function handleNetworkOffline() {
	if (isUnmounted) return;
	connectionState = "offline";
	clearReconnectTimer();
	const socket = ws;
	ws = null;
	closePendingSocket();
	clearSkipPending();
	socket?.close(1000, "offline");
}

function handleNetworkOnline() {
	if (isUnmounted || connectionState !== "offline" || !normalizedChatServer) return;
	reconnectAttempt = 1;
	connectRoom(currentRoom);
}

function connectRoom(roomId: string) {
	if (isUnmounted) return;
	if (!navigator.onLine) {
		handleNetworkOffline();
		return;
	}
	clearReconnectTimer();
	if (ws) {
		// 先保留旧连接，等新房间握手成功后再断开，避免切换瞬间从在线列表里消失。
		closePendingSocket();
		pendingCloseSocket = ws;
		ws = null;
	}

	if (!normalizedChatServer) {
		closePendingSocket();
		connectionState = "offline";
		showNotice("聊天室后端地址尚未配置（请在内容仓配置 chatConfig.serverURL）");
		return;
	}

	connectionState = reconnectAttempt > 0 ? "reconnecting" : "connecting";
	const storedLastRead = readUserLastSeen(roomId, currentUser?.userKey || "");
	const wsUrl = buildWsUrl(
		normalizedChatServer,
		roomId,
		currentAuth,
		storedLastRead,
		isEffectiveFocused,
	);
	const handshakeSig = currentAuth
		? `${currentAuth.kind}:${currentAuth.token}`
		: "none:";
	const socket = new WebSocket(wsUrl);
	socketHandshakeAuth.set(socket, handshakeSig);
	ws = socket;

	socket.addEventListener("open", () => {
		if (ws !== socket) return;
		connectionState = "connected";
		reconnectAttempt = 0;
		closePendingSocket();
		reportFocusState(true);

		const currentSig = currentAuth
			? `${currentAuth.kind}:${currentAuth.token}`
			: "none:";
		if (currentSig !== socketHandshakeAuth.get(socket)) {
			if (currentAuth) {
				sendPacket({
					type: "auth:sync",
					authKind: currentAuth.kind,
					token: currentAuth.token,
				});
			} else {
				sendPacket({ type: "auth:logout" });
			}
		}

		sendPacket({
			type: "room:register_fallback",
			tracks: musicTracks,
		});
	});

	socket.addEventListener("message", (event) => {
		if (ws !== socket || typeof event.data !== "string") return;
		let packet: ServerPacket;
		try {
			packet = JSON.parse(event.data) as ServerPacket;
		} catch {
			return;
		}

		switch (packet.type) {
			case "room:init": {
				currentUser = packet.self;
				messages = mergeRoomMessages(
					packet.messages,
					roomMessageCache.get(packet.roomId) ?? [],
					Boolean(packet.hasMoreHistory),
				);
				hasMoreHistory = Boolean(packet.hasMoreHistory);
				clearHistoryLoadTimer();
				isLoadingHistory = false;
				const userKey = packet.self?.userKey || "guest";
				const localSeen = readUserLastSeen(packet.roomId, userKey);
				const baseline = Math.max(packet.lastReadAt ?? 0, localSeen);
				const hasNewSinceBaseline =
					baseline > 0 &&
					((packet.unreadCount ?? 0) > 0 ||
						packet.messages.some((m) => m.createdAt > baseline));
				sessionUnreadSince = hasNewSinceBaseline ? baseline : 0;
				serverUnreadCount = packet.unreadCount ?? 0;
				serverUnreadUserCount = packet.unreadUserCount ?? 0;
				if (!hasNewSinceBaseline && packet.messages.length > 0) {
					persistUserLastSeen(
						packet.roomId,
						userKey,
						packet.messages[packet.messages.length - 1].createdAt,
					);
				}

				roomOnlineMembers = packet.members.filter(
					(m) => !m.roomId || m.roomId === packet.roomId,
				);
				onlineMembers = packet.members;
				observers = uniqueObservers(packet.observers ?? []);
				if (typeof packet.totalCount === "number" && packet.totalCount > 0) {
					totalOnlineCount = packet.totalCount;
				}
				roomMentionMembers = packet.mentionMembers ?? [];
				if (typeof packet.totalChatters === "number" && packet.totalChatters > 0) {
					totalChatterCount = packet.totalChatters;
				} else if (packet.mentionMembers && packet.mentionMembers.length > 0) {
					totalChatterCount = Math.max(totalChatterCount, packet.mentionMembers.length);
				}
				musicState = packet.music;
				if (packet.musicAudience) musicAudience = packet.musicAudience;
				oldestHistoryId =
					messages[0]?.id ?? packet.oldestHistoryId ?? 0;
				pinnedUids = packet.pinnedUids ?? [];
				roomTopic = packet.topic ?? "";
				if (packet.roomAvatars || typeof packet.roomAvatar === "string") {
					roomAvatars = {
						...roomAvatars,
						...(packet.roomAvatars ?? {}),
						...(typeof packet.roomAvatar === "string"
							? { [packet.roomId]: packet.roomAvatar }
							: {}),
					};
				}
				readReceipts = packet.readReceipts ?? {};
				typingUsers = [];
				clearSkipPending();
				musicClock.seed(packet.music.serverTime);
				if (!hasClockSample) clockOffsetMs = packet.music.serverTime - Date.now();
				sampleRoomClock(socket, true);
				if (packet.mergedGuestHistory) {
					showNotice("已自动合并同邮箱的历史访客记录至当前账号");
				}
				break;
			}
			case "chat:history_batch": {
				if (packet.roomId === currentRoom) {
					clearHistoryLoadTimer();
					isLoadingHistory = false;
					hasMoreHistory = Boolean(packet.hasMoreHistory);
					if (packet.messages.length > 0) {
						const existingIds = new Set(messages.map((m) => m.msgUid));
						const prepended = packet.messages.filter(
							(m) => !existingIds.has(m.msgUid),
						);
						if (prepended.length > 0) {
							messages = [...prepended, ...messages].sort(
								(a, b) => a.createdAt - b.createdAt,
							);
						}
					}
					if (messages.length > 0) {
						oldestHistoryId = messages[0].id;
					} else if (packet.oldestHistoryId) {
						oldestHistoryId = packet.oldestHistoryId;
					}
					if (packet.jumpTarget) {
						unreadJumpSeq += 1;
					}
				}
				break;
			}
			case "pong": {
				const sent = pendingClockPings.get(socket);
				if (!sent || (packet.id !== undefined && packet.id !== sent.id)) break;
				pendingClockPings.delete(socket);
				if (musicClock.sample(packet.serverTime, sent.monotonic)) {
					clockOffsetMs = musicClock.now() - Date.now();
					hasClockSample = true;
				}
				// Collect a small initial burst; prefer low-RTT samples over network outliers.
				if (clockBurstRemaining > 0) {
					clockBurstRemaining--;
					window.setTimeout(() => sampleRoomClock(socket), 150);
				}
				break;
			}
			case "auth:result": {
				currentUser = packet.user;
				if (packet.user?.authType !== "waline") {
					walineToken = "";
				}
				playlistRefreshSeq += 1;
				if (packet.mergedGuestHistory) {
					showNotice("已自动合并同邮箱的历史访客记录至当前账号");
				}
				break;
			}
			case "member:merged": {
				if (packet.roomId === currentRoom && packet.fromUserKeys.length > 0) {
					const fromSet = new Set(packet.fromUserKeys);
					const targetUser = packet.user;
					const remapList = (keys?: string[]) => {
						if (!keys || keys.length === 0) return keys;
						const seen = new Set<string>();
						const out: string[] = [];
						for (const k of keys) {
							const mapped = fromSet.has(k) ? targetUser.userKey : k;
							if (!mapped || seen.has(mapped)) continue;
							seen.add(mapped);
							out.push(mapped);
						}
						return out;
					};
					messages = messages.map((m) => {
						const isSender = fromSet.has(m.userKey);
						const isReplyTarget = m.replyTo && fromSet.has(m.replyTo.userKey);
						const hasMention = m.mentionKeys?.some((k) => fromSet.has(k));
						if (!isSender && !isReplyTarget && !hasMention) return m;
						return {
							...m,
							...(isSender
								? {
										userKey: targetUser.userKey,
										name: targetUser.name,
										avatar: targetUser.avatar,
										url: targetUser.url,
										badge: targetUser.badge,
										badgeType: targetUser.badgeType,
										isAdmin: targetUser.isAdmin,
									}
								: {}),
							...(isReplyTarget && m.replyTo
								? {
										replyTo: {
											...m.replyTo,
											userKey: targetUser.userKey,
											name: targetUser.name,
										},
									}
								: {}),
							...(hasMention ? { mentionKeys: remapList(m.mentionKeys) } : {}),
						};
					});
					if (musicState) {
						musicState = {
							...musicState,
							current: musicState.current
								? {
										...musicState.current,
										...(!musicState.current.isFallback &&
										fromSet.has(musicState.current.requesterKey)
											? {
													requesterKey: targetUser.userKey,
													requesterName: targetUser.name,
												}
											: {}),
										skipVotes: remapList(musicState.current.skipVotes) ?? [],
									}
								: null,
							queue: musicState.queue.map((q) =>
								fromSet.has(q.requesterKey)
									? {
											...q,
											requesterKey: targetUser.userKey,
											requesterName: targetUser.name,
										}
									: q,
							),
							historyLogs: (musicState.historyLogs ?? []).map((h) =>
								fromSet.has(h.requesterKey)
									? {
											...h,
											requesterKey: targetUser.userKey,
											requesterName: targetUser.name,
											requesterAvatar: targetUser.avatar,
										}
									: h,
							),
						};
					}
					if (userDetailSeed && fromSet.has(userDetailSeed.userKey)) {
						userDetailSeed = {
							...userDetailSeed,
							userKey: targetUser.userKey,
							authType: targetUser.authType,
							name: targetUser.name,
							avatar: targetUser.avatar,
							url: targetUser.url,
							badge: targetUser.badge,
							badgeType: targetUser.badgeType,
							isAdmin: targetUser.isAdmin,
						};
					}
				}
				break;
			}
			case "playlist:updated":
			case "playlists:updated": {
				if (!packet.roomId || packet.roomId === currentRoom) {
					playlistRefreshSeq += 1;
				}
				break;
			}
			case "member:badges_updated": {
				const { userKey, customBadges } = packet;
				if (currentUser && currentUser.userKey === userKey) {
					currentUser = {
						...currentUser,
						customBadges,
					};
				}
				roomOnlineMembers = roomOnlineMembers.map((m) =>
					m.userKey === userKey ? { ...m, customBadges } : m,
				);
				roomMentionMembers = roomMentionMembers.map((m) =>
					m.userKey === userKey ? { ...m, customBadges } : m,
				);
				globalMemberDirectory = globalMemberDirectory.map((m) =>
					m.userKey === userKey ? { ...m, customBadges } : m,
				);
				messages = messages.map((m) =>
					m.userKey === userKey ? { ...m, customBadges } : m,
				);
				if (userDetailSeed && userDetailSeed.userKey === userKey) {
					userDetailSeed = {
						...userDetailSeed,
						customBadges,
					};
				}
				break;
			}
			case "presence:update": {
				if (packet.roomId === currentRoom) {
					if (packet.musicAudience) musicAudience = packet.musicAudience;
					roomOnlineMembers = packet.members.filter(
						(m) => !m.roomId || m.roomId === currentRoom,
					);
					onlineMembers = packet.members;
					if (packet.observers) {
						observers = uniqueObservers(packet.observers);
					}
					if (
						typeof packet.totalCount === "number" &&
						packet.totalCount > 0
					) {
						totalOnlineCount = packet.totalCount;
					}
					if (packet.mentionMembers) {
						roomMentionMembers = packet.mentionMembers;
					}
					if (
						typeof packet.totalChatters === "number" &&
						packet.totalChatters > 0
					) {
						totalChatterCount = packet.totalChatters;
					}
				}
				break;
			}
			case "chat:message": {
				const isCurrent = packet.roomId === currentRoom;
				if (isCurrent) {
					if (!messages.some((m) => m.msgUid === packet.message.msgUid)) {
						messages = [...messages, packet.message];
						if (
							document.hidden &&
							isMentionedForUser(packet.message, currentUser)
						) {
							if (!baseDocumentTitle) baseDocumentTitle = document.title;
							document.title = `[有人提到了你] ${baseDocumentTitle}`;
						}
					}
				} else {
					const cached = roomMessageCache.get(packet.roomId);
					if (cached && !cached.some((m) => m.msgUid === packet.message.msgUid)) {
						roomMessageCache.set(packet.roomId, [...cached, packet.message]);
					}
					roomUnreadCounts = {
						...roomUnreadCounts,
						[packet.roomId]: (roomUnreadCounts[packet.roomId] || 0) + 1,
					};
				}
				triggerDesktopNotification(packet.roomId, packet.message);
				break;
			}
			case "chat:updated": {
				if (packet.roomId !== currentRoom) break;
				const updated = packet.message;
				messages = messages.map((message) => {
					if (message.msgUid === updated.msgUid) return updated;
					if (message.replyTo?.msgUid !== updated.msgUid) return message;
					return {
						...message,
						replyTo: {
							...message.replyTo,
							content: updated.content.replace(/\s+/g, " ").trim().slice(0, 120),
							hasImage: updated.attachments.length > 0,
						},
					};
				});
				break;
			}
			case "chat:deleted":
			case "chat:recalled": {
				if (packet.roomId === currentRoom) {
					messages = messages
						.filter((m) => m.msgUid !== packet.msgUid)
						.map((m) =>
							m.replyTo?.msgUid === packet.msgUid
								? {
										...m,
										replyTo: {
											...m.replyTo,
											userKey: m.replyTo.userKey || "",
											content: "",
											hasImage: false,
											isRecalled: true,
										},
									}
								: m,
						);
				}
				break;
			}
			case "chat:reaction_updated": {
				if (packet.roomId === currentRoom) {
					messages = messages.map((m) =>
						m.msgUid === packet.msgUid
							? { ...m, reactions: packet.reactions }
							: m,
					);
				}
				break;
			}
			case "chat:edited": {
				if (packet.roomId === currentRoom) {
					const editedPreview = packet.content.replace(/\s+/g, " ").trim().slice(0, 120);
					messages = messages.map((m) => {
						if (m.msgUid === packet.msgUid) {
							return {
								...m,
								content: packet.content,
								mentions: packet.mentions ?? m.mentions,
								mentionKeys: packet.mentionKeys ?? m.mentionKeys,
								isEdited: true,
								editedAt: packet.editedAt,
							};
						}
						if (m.replyTo && m.replyTo.msgUid === packet.msgUid) {
							return {
								...m,
								replyTo: { ...m.replyTo, content: editedPreview },
							};
						}
						return m;
					});
				}
				break;
			}
			case "chat:pinned_update": {
				if (packet.roomId === currentRoom) {
					pinnedUids = packet.pinnedUids || [];
				}
				break;
			}
			case "chat:topic_update": {
				if (packet.roomId === currentRoom) {
					roomTopic = packet.topic || "";
				}
				break;
			}
			case "chat:room_avatar_update": {
				if (packet.roomId) {
					roomAvatars = {
						...roomAvatars,
						[packet.roomId]: packet.avatar || "",
					};
				}
				break;
			}
			case "chat:typing": {
				if (packet.roomId === currentRoom) {
					const myName = currentUser?.name?.trim();
					if (Array.isArray(packet.users)) {
						typingUsers = packet.users.filter((u: string) => !myName || u.trim() !== myName);
					} else if (packet.userName) {
						if (myName && packet.userName.trim() === myName) {
							break;
						}
						if (packet.typing) {
							if (!typingUsers.includes(packet.userName)) {
								typingUsers = [...typingUsers, packet.userName];
							}
							const targetName = packet.userName;
							setTimeout(() => {
								typingUsers = typingUsers.filter((u) => u !== targetName);
							}, 5000);
						} else {
							typingUsers = typingUsers.filter((u) => u !== packet.userName);
						}
					}
				}
				break;
			}
			case "chat:poll_updated": {
				if (packet.roomId === currentRoom) {
					messages = messages.map((m) =>
						m.msgUid === packet.msgUid && m.poll
							? {
									...m,
									poll: {
										...m.poll,
										votes: packet.votes,
										ended: Boolean(packet.ended),
									},
								}
							: m,
					);
				}
				break;
			}
			case "chat:receipt_update": {
				if (packet.roomId === currentRoom && packet.reader?.msgUid && packet.reader?.userKey) {
					const nextMap: Record<string, ChatReadReceipt[]> = {};
					for (const [uid, list] of Object.entries(readReceipts)) {
						const filtered = list.filter((r) => r.userKey !== packet.reader.userKey);
						if (filtered.length > 0) nextMap[uid] = filtered;
					}
					const targetList = nextMap[packet.reader.msgUid] || [];
					nextMap[packet.reader.msgUid] = [packet.reader, ...targetList];
					readReceipts = nextMap;
				}
				break;
			}
			case "music:request_result": {
				const pending = songRequests.get(packet.requestId);
				if (!pending || pending.room !== packet.roomId) break;
				pending.finish(packet.ok);
				if (packet.roomId === currentRoom) {
					if (packet.code === "AUTH_REQUIRED") openAuthModal();
					else if (!packet.ok) showNotice(packet.error || "点歌失败，请重试", "error");
					else if (!packet.playImmediately && packet.position) showNotice("已加入待播队列，第 " + packet.position + " 首");
				}
				break;
			}
			case "music:state": {
				if (packet.roomId === currentRoom) {
					const prevUid = musicState?.current?.uid ?? "";
					const nextUid = packet.current?.uid ?? "";
					const prevVotes = musicState?.voteCount ?? 0;
					if (
						!nextUid ||
						nextUid !== prevUid ||
						packet.voteCount !== prevVotes
					) {
						clearSkipPending();
					}
					if (nextUid && nextUid !== prevUid) {
						sampleRoomClock(socket);
					}
					musicClock.seed(packet.serverTime);
					if (!hasClockSample) clockOffsetMs = packet.serverTime - Date.now();
					musicState = {
						protocolVersion: packet.protocolVersion,
						stateVersion: packet.stateVersion,
						next: packet.next,
						current: packet.current,
						queue: packet.queue,
						history: packet.history ?? musicState?.history ?? [],
						historyLogs: packet.historyLogs ?? musicState?.historyLogs ?? [],
						requesterOnline: packet.requesterOnline,
						voteCount: packet.voteCount,
						voteThreshold: packet.voteThreshold,
						skipVoteNames: packet.skipVoteNames ?? [],
						soloCooldownUntil: packet.soloCooldownUntil,
						serverTime: packet.serverTime,
					};
				}
				break;
			}
			case "error": {
				clearSkipPending();
				if (packet.code === "AUTH_REQUIRED") {
					showAuthModal = true;
				} else if (packet.code === "WALINE_LOGIN_REQUIRED") {
					clearGuestAuth();
					if (currentAuth?.kind === "guest") {
						currentAuth = null;
					}
					lastMarkedServerReadAt = 0;
					showAuthModal = true;
				} else if (packet.code === "TOKEN_INVALID") {
					const invalidKind = packet.authKind ?? currentAuth?.kind;
					if (invalidKind === "waline") {
						clearWalineAuth();
						walineToken = "";
						if (currentAuth?.kind === "waline") {
							currentAuth = null;
							currentUser = null;
						}
					} else if (invalidKind === "guest") {
						clearGuestAuth();
						if (currentAuth?.kind === "guest") {
							currentAuth = null;
							currentUser = null;
						}
					}
					lastMarkedServerReadAt = 0;
				}
				if (packet.message) {
					showNotice(packet.message, "error");
				}
				break;
			}
		}
	});

	socket.addEventListener("close", () => {
		if (ws !== socket || isUnmounted) return;
		if (!navigator.onLine) {
			handleNetworkOffline();
			return;
		}
		closePendingSocket();
		ws = null;
		clearSkipPending();
		connectionState = "reconnecting";
		const delay = Math.min(10000, 1000 * 2 ** Math.min(4, reconnectAttempt));
		reconnectAttempt += 1;
		reconnectTimer = window.setTimeout(() => {
			connectRoom(currentRoom);
		}, delay);
	});

	socket.addEventListener("error", () => {
		// close handler manages reconnect
	});
}

function closePendingSocket() {
	const stale = pendingCloseSocket;
	pendingCloseSocket = null;
	if (!stale) return;
	try {
		stale.close(1000, "switch");
	} catch {
		// Ignore
	}
}

function handleRoomSelect(roomId: string) {
	showInterconnect = false;
	closeSplitRoom(roomPanelEl?.contains(document.activeElement));
	roomUnreadCounts = {
		...roomUnreadCounts,
		[roomId]: 0,
	};
	if (roomId === currentRoom) {
		mobileDrawer = "none";
		return;
	}
	roomMessageCache.set(currentRoom, messages);
	currentRoom = roomId;
	persistStoredRoom(roomId);
	syncRoomUrl(roomId);
	if (currentUser) {
		const currentKey = currentUser.userKey;
		onlineMembers = onlineMembers.map((m) =>
			m.userKey === currentKey ? { ...m, roomId } : m,
		);
	}
	messages = roomMessageCache.get(roomId) ?? [];
	hasMoreHistory = false;
	oldestHistoryId = 0;
	clearHistoryLoadTimer();
	isLoadingHistory = false;
	pinnedUids = [];
	roomTopic = "";
	readReceipts = {};
	typingUsers = [];
	sessionUnreadSince = 0;
	serverUnreadCount = 0;
	serverUnreadUserCount = 0;
	lastMarkedServerReadAt = 0;
	roomOnlineMembers = [];
	musicState = null;
	musicAudience = { onlineCount: 0, listeningCount: 0 };
	clearSkipPending();
	reconnectAttempt = 0;
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: "room:switch", roomId }));
	} else {
		if (ws) {
			try {
				ws.close(1000, "switch");
			} catch {
				// Ignore
			}
			ws = null;
		}
		connectRoom(roomId);
	}
	mobileDrawer = "none";
}

function handleMentionUser(name: string, userKey?: string) {
	if (!currentUser) {
		openAuthModal();
		return;
	}
	mentionSeq += 1;
	mentionEvent = { name, ...(userKey ? { userKey } : {}), seq: mentionSeq };
	mobileDrawer = "none";
	closeSplitRoom();
}

function handleDirectWalineLogin() {
	if (!walineServerUrl) {
		showNotice("未配置 Waline 服务地址");
		return;
	}
	walineLoginWaiting = true;
	cancelWalinePopup?.();
	cancelWalinePopup = openWalineLoginPopup(
		walineServerUrl,
		(token) => {
			walineLoginWaiting = false;
			cancelWalinePopup = null;
			handleAuthenticated({ kind: "waline", token });
		},
		() => {
			walineLoginWaiting = false;
			cancelWalinePopup = null;
		},
		() => {
			showNotice("登录窗口被浏览器拦截，请允许本站弹出窗口后重试");
		},
	);
}

function handleAuthenticated(
	auth: { kind: "waline" | "guest"; token: string },
	user?: ChatSessionUser,
) {
	if (auth.kind === "waline") {
		clearGuestAuth();
	} else {
		// 切换或确认为访客登录时清理可能失效的旧 Waline 凭证，防止刷新被拉回旁观态
		clearWalineAuth();
	}
	currentAuth = auth;
	walineToken = auth.kind === "waline" ? auth.token : "";
	lastMarkedServerReadAt = 0;
	if (user) {
		currentUser = user;
	}
	playlistRefreshSeq += 1;
	sendPacket({
		type: "auth:sync",
		authKind: auth.kind,
		token: auth.token,
	});
}

function handleLogout() {
	if (currentAuth?.kind === "waline") {
		clearWalineAuth();
	} else if (currentAuth?.kind === "guest") {
		clearGuestAuth();
	}
	currentAuth = null;
	walineToken = "";
	currentUser = null;
	lastMarkedServerReadAt = 0;
	playlistRefreshSeq += 1;
	sendPacket({ type: "auth:logout" });
	showNotice("已退出当前聊天身份，进入只读旁观模式");
}

function handleOpenUserProfile(seed: ChatUserDetailSeed) {
	if (!seed.userKey && !seed.name) return;
	const isSpectatorSeed =
		seed.userKey?.startsWith("spectator") ||
		seed.userKey?.startsWith("observer") ||
		seed.userKey?.startsWith("spec_") ||
		seed.badge === "旁观" ||
		seed.badge === "历史访客";
	if (isSpectatorSeed && !currentUser?.isAdmin) {
		return;
	}
	let enriched: ChatUserDetailSeed = { ...seed };
	const needsKey =
		!enriched.userKey ||
		enriched.userKey.startsWith("name:") ||
		enriched.userKey === "system:fallback";
	if (needsKey && enriched.name) {
		const onlineMatch = onlineMembers.find((m) => m.name === enriched.name);
		const mentionMatch = mentionMembers.find((m) => m.name === enriched.name);
		const selfMatch =
			currentUser && currentUser.name === enriched.name ? currentUser : null;
		const msgMatch = [...messages]
			.reverse()
			.find((m) => m.kind === "user" && m.name === enriched.name && m.userKey);
		const match = onlineMatch || mentionMatch || selfMatch || msgMatch;
		if (match) {
			enriched = {
				...enriched,
				userKey: match.userKey,
				authType:
					enriched.authType ||
					("authType" in match ? match.authType : undefined) ||
					(match.userKey.startsWith("waline:") ? "waline" : "guest"),
				avatar: enriched.avatar || match.avatar,
				url: enriched.url || match.url,
				badge: enriched.badge || match.badge,
				badgeType: enriched.badgeType || match.badgeType,
				isAdmin: enriched.isAdmin ?? match.isAdmin,
				location:
					enriched.location ||
					("location" in match ? match.location : undefined),
			};
		}
	}
	userDetailSeed = enriched;
	showUserDetailModal = true;
}

function handleOpenPlaylistFromProfile(playlistId: string) {
	if (!currentUser) {
		openAuthModal();
		return;
	}
	showUserDetailModal = false;
	externalPlaylistSeq += 1;
	externalPlaylistRequest = { playlistId, seq: externalPlaylistSeq };
	mobileDrawer = "music";
	closeSplitRoom();
}

function handleUpdateProfile(draft: ChatProfileDraft) {
	if (!currentUser) return;
	const cleanNick = draft.nickname.trim().slice(0, 16) || currentUser.name;
	const cleanBadge = getFixedRoleBadge(currentUser);
	const rawStatus = draft.status.trim().slice(0, 16);
	const cleanStatus = rawStatus === "在线" ? "" : rawStatus;
	const cleanUrl = draft.url.trim().slice(0, 200);
	const cleanBio = (draft.bio ?? "").trim().slice(0, 80);
	const packet: Record<string, unknown> = {
		type: "auth:update_profile",
		nickname: cleanNick,
		badge: cleanBadge,
		status: cleanStatus,
		url: cleanUrl,
		bio: cleanBio,
	};
	if (typeof draft.avatar === "string") {
		packet.avatar = draft.avatar.trim().slice(0, 400);
	}
	if (typeof draft.notifyEmail === "boolean") {
		packet.notifyEmail = draft.notifyEmail;
	}
	if (sendPacket(packet)) {
		showNotice("个人资料已更新");
	}
}

async function handleUpdateMemberBadges(
	targetUserKey: string,
	badges: ChatCustomBadge[],
): Promise<boolean> {
	if (!currentUser?.isAdmin) return false;
	const token = readStoredWalineToken();
	const httpOk = await saveMemberBadges(
		normalizedChatServer,
		currentRoom,
		targetUserKey,
		badges,
		token,
	);
	if (httpOk) {
		if (currentUser.userKey === targetUserKey) {
			currentUser = { ...currentUser, customBadges: badges };
		}
		roomOnlineMembers = roomOnlineMembers.map((m) =>
			m.userKey === targetUserKey ? { ...m, customBadges: badges } : m,
		);
		roomMentionMembers = roomMentionMembers.map((m) =>
			m.userKey === targetUserKey ? { ...m, customBadges: badges } : m,
		);
		globalMemberDirectory = globalMemberDirectory.map((m) =>
			m.userKey === targetUserKey ? { ...m, customBadges: badges } : m,
		);
		messages = messages.map((m) =>
			m.userKey === targetUserKey ? { ...m, customBadges: badges } : m,
		);
		if (userDetailSeed && userDetailSeed.userKey === targetUserKey) {
			userDetailSeed = { ...userDetailSeed, customBadges: badges };
		}
		showNotice("头衔已更新");
		return true;
	}
	return false;
}

function handleSendMessage(
	content: string,
	attachments: ImageAttachment[],
	mentionKeys: string[] = [],
	replyToUid = "",
) {
	if (!currentUser) {
		showAuthModal = true;
		return;
	}
	const packet: Record<string, unknown> = {
		type: "chat:send",
		content,
		attachments,
		mentionKeys,
	};
	if (replyToUid) {
		packet.replyToUid = replyToUid;
	}
	sendPacket(packet);
}

function handleLoadHistory(sinceCreatedAt = 0, jumpTarget = false) {
	if (isLoadingHistory) return;
	const oldestMsg = messages[0];
	const oldestId = oldestMsg?.id || oldestHistoryId || 0;
	const beforeUid = oldestMsg?.msgUid || "";
	const beforeCreatedAt = oldestMsg?.createdAt || 0;
	if (!beforeUid && !oldestId) return;
	isLoadingHistory = true;
	clearHistoryLoadTimer();
	historyLoadTimeoutTimer = window.setTimeout(() => {
		isLoadingHistory = false;
		historyLoadTimeoutTimer = null;
	}, 10000);
	const ok = sendPacket({
		type: "chat:load_history",
		beforeId: oldestId,
		beforeUid: beforeUid || undefined,
		beforeCreatedAt: beforeCreatedAt > 0 ? beforeCreatedAt : undefined,
		sinceCreatedAt: sinceCreatedAt > 0 ? sinceCreatedAt : undefined,
		jumpTarget,
	});
	if (!ok) {
		clearHistoryLoadTimer();
		isLoadingHistory = false;
	}
}

function handleMarkRead(timestamp: number, msgUid?: string) {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return;
	const userKey = currentUser?.userKey || "guest";
	persistUserLastSeen(currentRoom, userKey, timestamp);
	if (
		currentUser &&
		timestamp > lastMarkedServerReadAt &&
		ws?.readyState === WebSocket.OPEN
	) {
		lastMarkedServerReadAt = timestamp;
		ws.send(
			JSON.stringify({
				type: "chat:mark_read",
				timestamp,
				...(msgUid ? { msgUid } : {}),
			}),
		);
	}
}

function handleRecallMessage(msgUid: string) {
	sendPacket({ type: "chat:recall", msgUid });
}

function handleDeleteMessage(msgUid: string) {
	sendPacket({ type: "chat:delete", msgUid });
}

function handleReaction(msgUid: string, key: string) {
	if (!currentUser) {
		openAuthModal();
		return;
	}
	sendPacket({ type: "chat:reaction", msgUid, key });
}

function handleEditMessage(msgUid: string, content: string) {
	sendPacket({ type: "chat:edit", msgUid, content });
}

function handlePinMessage(msgUid: string, unpin?: boolean) {
	sendPacket({ type: "chat:pin", msgUid, unpin });
}

function handleVotePoll(pollUid: string, answerId: string) {
	if (!currentUser) {
		openAuthModal();
		return;
	}
	sendPacket({ type: "chat:poll_vote", pollUid, answerId });
}

function handleEndPoll(pollUid: string) {
	if (!currentUser) {
		openAuthModal();
		return;
	}
	sendPacket({ type: "chat:poll_end", pollUid });
}

function handleSetTopic(topic: string) {
	if (!currentUser?.isAdmin) return;
	const clean = topic.trim();
	if (!clean) return;
	sendPacket({ type: "chat:set_topic", topic: clean });
}

function handleCreatePoll(
	question: string,
	answers: string[],
	maxSelections: number,
) {
	if (!currentUser) {
		openAuthModal();
		return;
	}
	sendPacket({
		type: "chat:poll_create",
		question,
		answers,
		maxSelections,
	});
}

function handleTyping(typing: boolean) {
	if (!currentUser || ws?.readyState !== WebSocket.OPEN) return;
	sendPacket({ type: "chat:typing", typing });
}

async function handleSearchOnline(
	keyword: string,
	options?: { signal?: AbortSignal; page?: number },
) {
	return searchOnlineMusic(normalizedChatServer, keyword, options);
}

async function handleEnqueueTrack(track: ChatMusicTrack): Promise<boolean> {
	if (!currentUser) {
		openAuthModal();
		return false;
	}
	const room = currentRoom;
	const requestId = crypto.randomUUID();
	return new Promise<boolean>((resolve) => {
		const timer = window.setTimeout(() => {
			finish(false);
			if (room === currentRoom) showNotice("点歌未收到回应，请先查看待播队列");
		}, 30_000);
		const finish = (ok: boolean) => {
			window.clearTimeout(timer);
			songRequests.delete(requestId);
			resolve(ok);
		};
		songRequests.set(requestId, { room, finish });
		if (!sendPacket({
			type: "music:enqueue",
			requestId,
			track: {
				id: track.id,
				provider: track.provider,
				sourceId: track.sourceId,
				playlistId: track.playlistId,
				position: track.position,
				title: track.title,
				artist: track.artist,
				album: track.album,
				cover: track.cover,
				durationSec: track.durationSec ?? 0,
			},
		})) finish(false);
	});
}

async function refreshGlobalPresence() {
	if (!normalizedChatServer || isUnmounted) return;
	const reqRoom = currentRoom;
	try {
		const separator = normalizedChatServer.includes("?") ? "&" : "?";
		const response = await fetch(
			`${normalizedChatServer}/api/presence${separator}room=${encodeURIComponent(reqRoom)}&_t=${Date.now()}`,
			{ cache: "no-store" },
		);
		if (!response.ok) return;
		const data = (await response.json()) as {
			members: ChatOnlineMember[];
			observers?: ChatObserverItem[];
			totalCount: number;
		};
		if (!isUnmounted && currentRoom === reqRoom && Array.isArray(data.members)) {
			hasGlobalPresence = true;
			const currentKey = currentUser?.userKey;
			onlineMembers = data.members.map((m) => {
				if (currentKey && m.userKey === currentKey) {
					return { ...m, roomId: currentRoom };
				}
				return m;
			});
			if (Array.isArray(data.observers)) {
				observers = uniqueObservers(data.observers);
			}
			totalOnlineCount = data.totalCount;
		}
	} catch {
		// Keep the most recent snapshot until the next refresh.
	}
}

async function refreshMemberDirectory() {
	if (!normalizedChatServer || isUnmounted) return;
	try {
		const separator = normalizedChatServer.includes("?") ? "&" : "?";
		const response = await fetch(`${normalizedChatServer}/api/members${separator}_t=${Date.now()}`, { cache: "no-store" });
		if (!response.ok) return;
		const data = (await response.json()) as {
			members: Array<{
				userKey: string;
				authType: "waline" | "guest";
				name: string;
				avatar: string;
				url: string;
				badge: string;
				badgeType: ChatMentionCandidate["badgeType"];
				isAdmin: boolean;
				bio: string;
				status: string;
				location?: string;
				lastSeenAt: number;
			}>;
		};
		if (isUnmounted || !Array.isArray(data.members)) return;
		globalMemberDirectory = data.members.map((member) => ({
			userKey: member.userKey,
			authType: member.authType,
			name: member.name,
			avatar: member.avatar || "",
			url: member.url || "",
			badge: member.badge || "",
			badgeType: member.badgeType,
			isAdmin: Boolean(member.isAdmin),
			online: false,
			status: member.status || "",
			bio: member.bio || "",
			location: member.location || "",
			lastSeenAt: member.lastSeenAt || 0,
		}));
	} catch {
		// 名录拉取失败时保留上一份数据
	}
}

async function refreshSpectatorHistory() {
	if (!normalizedChatServer || isUnmounted || !currentUser?.isAdmin) {
		spectatorHistory = [];
		return;
	}
	try {
		const separator = normalizedChatServer.includes("?") ? "&" : "?";
		const response = await fetch(
			`${normalizedChatServer}/api/spectators/history${separator}limit=30&_t=${Date.now()}`,
			{ cache: "no-store" },
		);
		if (!response.ok) return;
		const data = (await response.json()) as {
			ok: boolean;
			records: ChatSpectatorRecord[];
		};
		if (!isUnmounted && Array.isArray(data.records)) {
			spectatorHistory = data.records;
		}
	} catch {
		// 历史旁观记录拉取失败保留上一份数据
	}
}

onMount(() => {
	isUnmounted = false;
	const mobileLayoutQuery = window.matchMedia("(width < 768px)");
	isMobileLayout = mobileLayoutQuery.matches;
	const handleMobileLayoutChange = () => {
		isMobileLayout = mobileLayoutQuery.matches;
		mobileDrawer = "none";
		stageTouchStart = null;
	};
	mobileLayoutQuery.addEventListener("change", handleMobileLayoutChange);
	const touchLayoutQuery = window.matchMedia("(pointer: coarse)");
	const updateSplitLayoutBreakpoint = () => {
		if (!touchLayoutQuery.matches) {
			splitLayoutBreakpoint = 1240;
			return;
		}
		const { width, height, orientation } = window.screen;
		const isPortrait = orientation?.type.startsWith("portrait") ?? width < height;
		const portraitWidth = Math.min(width, height);
		// A full-width portrait iPad can be narrower than the tablet split breakpoint.
		splitLayoutBreakpoint =
			isPortrait && portraitWidth >= 768 ? Math.min(1024, portraitWidth - 2) : 1024;
	};
	updateSplitLayoutBreakpoint();
	touchLayoutQuery.addEventListener("change", updateSplitLayoutBreakpoint);
	window.addEventListener("resize", updateSplitLayoutBreakpoint);
	window.screen.orientation?.addEventListener("change", updateSplitLayoutBreakpoint);
	// 切入聊天室时立即停止全站侧栏/顶栏音乐播放器，避免与点歌台同时发声
	window.__fireflyMusic?.stop?.();
	baseDocumentTitle = document.title;
	currentAuth = resolveInitialAuth();
	walineToken = currentAuth?.kind === "waline" ? currentAuth.token : "";

	void consumeUrlWalineToken(walineServerUrl).then((res) => {
		if (res?.token) {
			if (!isUnmounted && (currentAuth?.kind !== "waline" || currentAuth.token !== res.token)) {
				handleAuthenticated({ kind: "waline", token: res.token });
			}
			return;
		}
		if (!isUnmounted && currentAuth?.kind === "waline" && !readStoredWalineToken()) {
			clearWalineAuth();
			currentAuth = resolveInitialAuth();
			walineToken = currentAuth?.kind === "waline" ? currentAuth.token : "";
			connectRoom(currentRoom);
		}
	});

	hasAppMounted = true;

	if (typeof window !== "undefined" && "Notification" in window) {
		desktopNotificationPermission = Notification.permission;
		const storedPref = localStorage.getItem(NOTIFICATION_STORAGE_KEY);
		if (storedPref === "true" && Notification.permission === "granted") {
			desktopNotificationEnabled = true;
		} else if (storedPref === "false") {
			desktopNotificationEnabled = false;
		} else if (Notification.permission === "granted") {
			desktopNotificationEnabled = true;
		}
	}

	const urlParams = new URLSearchParams(window.location.search);
	const paramRoom = urlParams.get("room")?.trim().toLowerCase() || "";
	const storedRoom = readStoredRoom();
	if (paramRoom && rooms.some((r) => r.id === paramRoom)) {
		currentRoom = paramRoom;
	} else if (storedRoom && rooms.some((r) => r.id === storedRoom)) {
		currentRoom = storedRoom;
	}
	persistStoredRoom(currentRoom);
	const paramMsg = urlParams.get("msg")?.trim() || "";
	if (paramMsg) {
		targetMessageUid = paramMsg;
	}

	void loadStickerPacks(stickerPackUrls).then((packs) => {
		stickerPacks = packs;
	});
	connectRoom(currentRoom);
	void refreshGlobalPresence();
	void refreshMemberDirectory();
	void refreshSpectatorHistory();

	const presenceTimer = window.setInterval(() => {
		if (!document.hidden) {
			void refreshGlobalPresence();
			sampleRoomClock(ws);
		}
	}, 15000);
	const memberTimer = window.setInterval(() => {
		if (!document.hidden) {
			void refreshMemberDirectory();
			void refreshSpectatorHistory();
		}
	}, 15000);

	// 低频自增歌单刷新序列（仅在页面前台活跃时触发，避免后台休眠时无意义刷新）
	const playlistTimer = window.setInterval(() => {
		if (!document.hidden) {
			playlistRefreshSeq += 1;
		}
	}, 30000);

	const IDLE_AWAY_MS = 2 * 60 * 1000;
	let idleAwayTimer: number | null = null;
	let lastActivityResetAt = 0;
	let lastMouseX = -1;
	let lastMouseY = -1;

	const resetIdleTimer = (event?: Event) => {
		if (event instanceof MouseEvent && event.type === "mousemove") {
			if (
				lastMouseX >= 0 &&
				Math.abs(event.clientX - lastMouseX) + Math.abs(event.clientY - lastMouseY) < 4
			) {
				return;
			}
			lastMouseX = event.clientX;
			lastMouseY = event.clientY;
		}

		const now = Date.now();
		if (isIdleAway) {
			isIdleAway = false;
			reportFocusState();
		} else if (now - lastActivityResetAt < 1000) {
			return;
		}
		lastActivityResetAt = now;
		if (idleAwayTimer !== null) window.clearTimeout(idleAwayTimer);
		idleAwayTimer = window.setTimeout(() => {
			isIdleAway = true;
			reportFocusState();
		}, IDLE_AWAY_MS);
	};

	const isDocumentHidden = () =>
		document.hidden || document.visibilityState === "hidden";

	const computeFocusedState = () =>
		!isDocumentHidden() &&
		(typeof document.hasFocus !== "function" || document.hasFocus());

	const syncFocusState = () => {
		const focused = computeFocusedState();
		isWindowFocused = focused;
		reportFocusState();
		if (focused) {
			resetIdleTimer();
		}
	};

	const handleWindowFocus = () => {
		const focused = !isDocumentHidden();
		isWindowFocused = focused;
		reportFocusState();
		if (focused) {
			resetIdleTimer();
		}
	};

	const handleWindowBlur = () => {
		isWindowFocused = false;
		reportFocusState();
	};

	const handlePageHide = () => {
		isWindowFocused = false;
		reportFocusState();
	};

	const handlePageFreeze = () => {
		isWindowFocused = false;
		reportFocusState();
	};

	const handlePageShowOrResume = () => {
		syncFocusState();
	};

	const handleVisibility = () => {
		if (isDocumentHidden()) {
			isWindowFocused = false;
			reportFocusState();
		} else {
			isWindowFocused =
				typeof document.hasFocus === "function" ? document.hasFocus() : true;
			reportFocusState();
			if (isWindowFocused) {
				resetIdleTimer();
			}
			if (baseDocumentTitle && document.title !== baseDocumentTitle) {
				document.title = baseDocumentTitle;
			}
			void refreshGlobalPresence();
			void refreshMemberDirectory();
			void refreshSpectatorHistory();
			if (ws && ws.readyState === WebSocket.OPEN) {
				sampleRoomClock(ws, true);
			} else if (!ws && !isUnmounted) {
				connectRoom(currentRoom);
			}
		}
	};
	syncFocusState();
	const focusSyncTimer = window.setInterval(() => {
		if (isDocumentHidden()) {
			if (isWindowFocused) {
				isWindowFocused = false;
				reportFocusState();
			}
			return;
		}
		if (typeof document.hasFocus === "function") {
			const focused = document.hasFocus();
			if (focused !== isWindowFocused) {
				isWindowFocused = focused;
				reportFocusState();
				if (focused) resetIdleTimer();
			}
		}
	}, 800);
	const handleWalineStorageSync = (e: StorageEvent) => {
		if (isUnmounted) return;
		if (
			e.key !== "WALINE_USER" &&
			e.key !== "TOKEN" &&
			e.key !== "WALINE_ADMIN_TOKEN"
		) {
			return;
		}
		if (!e.newValue) return;
		const nextToken = readStoredWalineToken();
		if (!nextToken) return;
		if (currentAuth?.kind !== "waline" || currentAuth.token !== nextToken) {
			walineLoginWaiting = false;
			cancelWalinePopup?.();
			cancelWalinePopup = null;
			showAuthModal = false;
			handleAuthenticated({ kind: "waline", token: nextToken });
		}
	};

	document.addEventListener("visibilitychange", handleVisibility);
	document.addEventListener("freeze", handlePageFreeze);
	document.addEventListener("resume", handlePageShowOrResume);
	window.addEventListener("focus", handleWindowFocus);
	window.addEventListener("blur", handleWindowBlur);
	window.addEventListener("pagehide", handlePageHide);
	window.addEventListener("pageshow", handlePageShowOrResume);
	window.addEventListener("offline", handleNetworkOffline);
	window.addEventListener("online", handleNetworkOnline);
	window.addEventListener("storage", handleWalineStorageSync);
	window.addEventListener("mousemove", resetIdleTimer, { passive: true });
	window.addEventListener("pointerdown", resetIdleTimer, { passive: true });
	window.addEventListener("keydown", resetIdleTimer, { passive: true });
	window.addEventListener("wheel", resetIdleTimer, { passive: true });
	window.addEventListener("touchstart", resetIdleTimer, { passive: true });

	const handleDevBgPreviewChange = (e: Event) => {
		if (!import.meta.env.DEV) return;
		const ce = e as CustomEvent<{
			slot?: ChatPanelSlot | "all";
			url?: string;
			cleared?: boolean;
		}>;
		const slot = ce.detail?.slot;
		if (ce.detail?.cleared) {
			if (slot === "all" || !slot) {
				for (const oldUrl of Object.values(devPanelPreviews)) {
					if (oldUrl?.startsWith("blob:")) URL.revokeObjectURL(oldUrl);
				}
				devPanelPreviews = {};
				failedPanelBg = { left: false, center: false, right: false, input: false };
			} else {
				const oldUrl = devPanelPreviews[slot];
				if (oldUrl?.startsWith("blob:")) URL.revokeObjectURL(oldUrl);
				const next = { ...devPanelPreviews };
				delete next[slot];
				devPanelPreviews = next;
				failedPanelBg = { ...failedPanelBg, [slot]: false };
			}
			return;
		}
		if (isChatPanelSlot(slot) && ce.detail?.url) {
			const oldUrl = devPanelPreviews[slot];
			if (oldUrl?.startsWith("blob:") && oldUrl !== ce.detail.url) {
				URL.revokeObjectURL(oldUrl);
			}
			devPanelPreviews = { ...devPanelPreviews, [slot]: ce.detail.url };
			failedPanelBg = { ...failedPanelBg, [slot]: false };
		}
	};

	const handleChatAppearanceSync = (e: Event) => {
		const ce = e as CustomEvent<ChatAppearanceSettings | undefined>;
		chatAppearance = ce.detail
			? { ...ce.detail }
			: loadChatAppearanceSettings();
		failedPanelBg = { left: false, center: false, right: false, input: false };
	};

	const handleCatalogChange = (e: Event) => {
		const ce = e as CustomEvent<ChatWallpaperConfig | undefined>;
		if (ce.detail) {
			setRuntimeChatWallpaperCatalog(ce.detail);
		}
		catalogRevision += 1;
		chatAppearance = loadChatAppearanceSettings();
		failedPanelBg = { left: false, center: false, right: false, input: false };
	};

	window.addEventListener("chatAppearanceChange", handleChatAppearanceSync);
	window.addEventListener("chat-wallpapers-catalog-change", handleCatalogChange);

	if (import.meta.env.DEV) {
		void loadDevPanelWallpaperPreviews().then((loaded) => {
			if (!isUnmounted && Object.keys(loaded).length > 0) {
				devPanelPreviews = loaded;
				failedPanelBg = { left: false, center: false, right: false, input: false };
			}
		});
		window.addEventListener("chat-bg-preview-change", handleDevBgPreviewChange);
	}

	return () => {
		window.removeEventListener("chatAppearanceChange", handleChatAppearanceSync);
		window.removeEventListener(
			"chat-wallpapers-catalog-change",
			handleCatalogChange,
		);
		if (import.meta.env.DEV) {
			window.removeEventListener(
				"chat-bg-preview-change",
				handleDevBgPreviewChange,
			);
			for (const oldUrl of Object.values(devPanelPreviews)) {
				if (oldUrl?.startsWith("blob:")) URL.revokeObjectURL(oldUrl);
			}
		}
		isUnmounted = true;
		clearHistoryLoadTimer();
		for (const pending of songRequests.values()) pending.finish(false);
		window.clearInterval(presenceTimer);
		window.clearInterval(memberTimer);
		window.clearInterval(playlistTimer);
		window.clearInterval(focusSyncTimer);
		if (idleAwayTimer !== null) window.clearTimeout(idleAwayTimer);
		document.removeEventListener("visibilitychange", handleVisibility);
		document.removeEventListener("freeze", handlePageFreeze);
		document.removeEventListener("resume", handlePageShowOrResume);
		window.removeEventListener("focus", handleWindowFocus);
		window.removeEventListener("blur", handleWindowBlur);
		window.removeEventListener("pagehide", handlePageHide);
		window.removeEventListener("pageshow", handlePageShowOrResume);
		window.removeEventListener("offline", handleNetworkOffline);
		window.removeEventListener("online", handleNetworkOnline);
		window.removeEventListener("storage", handleWalineStorageSync);
		window.removeEventListener("mousemove", resetIdleTimer);
		window.removeEventListener("pointerdown", resetIdleTimer);
		window.removeEventListener("keydown", resetIdleTimer);
		window.removeEventListener("wheel", resetIdleTimer);
		window.removeEventListener("touchstart", resetIdleTimer);
		mobileLayoutQuery.removeEventListener("change", handleMobileLayoutChange);
		touchLayoutQuery.removeEventListener("change", updateSplitLayoutBreakpoint);
		window.removeEventListener("resize", updateSplitLayoutBreakpoint);
		window.screen.orientation?.removeEventListener("change", updateSplitLayoutBreakpoint);
		cancelWalinePopup?.();
		clearReconnectTimer();
		if (noticeTimer !== null) window.clearTimeout(noticeTimer);
		if (skipPendingTimer !== null) window.clearTimeout(skipPendingTimer);
		closePendingSocket();
		if (ws) {
			try {
				ws.close(1000, "unmount");
			} catch {
				// Ignore
			}
			ws = null;
		}
	};
});
</script>

<div class="flex flex-col h-full w-full min-h-0">
  <div
    class="chat-mobile-stage flex flex-1 min-h-0 gap-0"
    bind:contentRect={stageContentRect}
    data-chat-split-layout={isSplitLayout ? "" : undefined}
    ontouchstart={handleStageTouchStart}
    ontouchend={handleStageTouchEnd}
  >
    {#if mobileDrawer !== "none"}
      <button
        type="button"
        class="chat-mobile-drawer-backdrop md:hidden"
        aria-label="关闭侧边抽屉"
        onclick={() => (mobileDrawer = "none")}
      ></button>
    {/if}

    <div
      class="chat-panel chat-panel-left {mobileDrawer === 'room' ? 'mobile-drawer-open' : ''}"
      class:chat-split-room-open={isSplitLayout && splitRoomOpen}
      id={roomPanelId}
      bind:this={roomPanelEl}
      inert={isSplitLayout && !splitRoomOpen}
      ondragenter={(e) => handleSidePanelDragEnter("left", e)}
      ondragover={(e) => handleSidePanelDragOver("left", e)}
      ondragleave={(e) => handleSidePanelDragLeave("left", e)}
      ondrop={(e) => void handleSidePanelDrop("left", e)}
    >
      <div class="chat-panel-bg-layer" aria-hidden="true">
        {#if effectivePanelBgUrls.left}
          <img
            src={effectivePanelBgUrls.left}
            alt=""
            loading="eager"
            fetchpriority="low"
            decoding="async"
            class="chat-panel-bg-img"
            use:trackBgImgAspectRatio={effectivePanelBgUrls.left}
            style:display={failedPanelBg.left ? "none" : undefined}
            onerror={() => { failedPanelBg = { ...failedPanelBg, left: true }; }}
          />
        {/if}
        <div class="chat-panel-bg-scrim"></div>
      </div>
      {#if import.meta.env.DEV && sideDragActive.left}
        <div class="chat-panel-dev-drop-overlay" role="presentation">
          <div class="chat-panel-dev-drop-box">
            <span class="text-xs font-bold text-[var(--skin-accent)]">松开替换为左侧面板壁纸</span>
            <span class="text-[11px] text-[var(--chat-meta-color)]">仅本地开发预览</span>
          </div>
        </div>
      {/if}
      <RoomPanel
        rooms={rooms}
        currentRoom={currentRoom}
        onlineMembers={onlineMembers}
        observers={observers}
        spectatorHistory={spectatorHistory}
        mentionMembers={mentionMembers}
        totalOnlineCount={totalOnlineCount}
        totalChatterCount={totalChatterCount}
        currentUser={currentUser}
        selfMuted={mobilePlaybackStatus.isMuted}
        connectionState={connectionState}
        isWindowFocused={isEffectiveFocused}
        interconnectSites={interconnectSites}
        desktopNotificationEnabled={desktopNotificationEnabled}
        desktopNotificationPermission={desktopNotificationPermission}
        roomUnreadCounts={roomUnreadCounts}
        roomAvatars={roomAvatars}
        siteAvatar={siteAvatar}
        onRoomSelect={handleRoomSelect}
        onCloseSplitRoom={isSplitLayout && splitRoomOpen ? () => closeSplitRoom(true) : undefined}
        onOpenUserProfile={handleOpenUserProfile}
        onOpenProfile={() => (showProfileModal = true)}
        onOpenAuth={() => (showAuthModal = true)}
        onToggleDesktopNotification={handleToggleDesktopNotification}
      />
    </div>

    <div class="chat-panel-center relative flex flex-col min-w-0 min-h-0 mobile-active">
      <div class="chat-panel chat-panel-center-inner flex-1 min-h-0 w-full">
        <div class="chat-panel-bg-layer" aria-hidden="true">
          {#if effectivePanelBgUrls.center}
            <img
              src={effectivePanelBgUrls.center}
              alt=""
              loading="eager"
              fetchpriority="low"
              decoding="async"
              class="chat-panel-bg-img"
              use:trackBgImgAspectRatio={effectivePanelBgUrls.center}
              style:display={failedPanelBg.center ? "none" : undefined}
              onerror={() => { failedPanelBg = { ...failedPanelBg, center: true }; }}
            />
          {/if}
          <div class="chat-panel-bg-scrim"></div>
        </div>
        <ChatWindow
          roomId={currentRoom}
          roomName={activeMeta.name}
          roomSubtitle={activeMeta.subtitle}
          roomAvatar={roomAvatars[currentRoom] || activeMeta.avatar || (currentRoom !== "interconnect" ? siteAvatar : "")}
          inputBgUrl={effectivePanelBgUrls.input}
          failedInputBg={failedPanelBg.input}
          onInputBgError={() => { failedPanelBg = { ...failedPanelBg, input: true }; }}
          onlineCount={totalOnlineCount}
          messages={messages}
          hasMoreHistory={hasMoreHistory}
          isLoadingHistory={isLoadingHistory}
          sessionUnreadSince={sessionUnreadSince}
          serverUnreadCount={serverUnreadCount}
          serverUnreadUserCount={serverUnreadUserCount}
          unreadJumpSeq={unreadJumpSeq}
          currentUser={currentUser}
          onlineMembers={onlineMembers}
          roomOnlineMembers={roomOnlineMembers}
          observers={observers}
          mentionMembers={mentionMembers}
          isChatTabActive={mobileDrawer === "none"}
          isWindowFocused={isEffectiveFocused}
          targetMessageUid={targetMessageUid}
          clockOffsetMs={clockOffsetMs}
          musicState={musicState}
          isSkippingTrack={isSkippingTrack}
          onSkipTrack={handleSkipTrack}
          onVoteSkip={handleVoteSkip}
          onPlayQueued={handlePlayQueued}
          onLoadHistory={handleLoadHistory}
          onMarkRead={handleMarkRead}
          onClearTargetMessage={() => {
            targetMessageUid = "";
            if (typeof window !== "undefined") {
              const url = new URL(window.location.href);
              if (url.searchParams.has("msg")) {
                url.searchParams.delete("msg");
                window.history.replaceState({}, "", url.toString());
              }
            }
          }}
          stickerPacks={stickerPacks}
          stickerMap={stickerMap}
          enableImageUpload={enableImageUpload}
          walineServerUrl={walineServerUrl}
          chatServerUrl={normalizedChatServer}
          mentionEvent={mentionEvent}
          showInterconnect={showInterconnect}
          isInterconnectRoom={currentRoom === "interconnect"}
          interconnectSites={interconnectSites}
          totalChatterCount={totalChatterCount}
          pinnedUids={pinnedUids}
          roomTopic={roomTopic}
          typingUsers={typingUsers}
          readReceipts={readReceipts}
          onReaction={handleReaction}
          onEditMessage={handleEditMessage}
          onPinMessage={handlePinMessage}
          onVotePoll={handleVotePoll}
          onEndPoll={handleEndPoll}
          onSetTopic={handleSetTopic}
          onOpenPollModal={() => (showPollCreateModal = true)}
          onCreatePoll={handleCreatePoll}
          onTyping={handleTyping}
          onToggleInterconnect={() => {
            showInterconnect = !showInterconnect;
          }}
          onSendMessage={handleSendMessage}
          onRecallMessage={handleRecallMessage}
          onDeleteMessage={handleDeleteMessage}
          onNotify={showNotice}
          onRequireAuth={() => (showAuthModal = true)}
          onMentionUser={handleMentionUser}
          onOpenUserProfile={handleOpenUserProfile}
          otherRoomsUnreadCount={otherRoomsUnreadCount}
          mobilePlaybackStatus={mobilePlaybackStatus}
          onOpenRoomDrawer={() => (mobileDrawer = "room")}
          splitRoomPanelId={roomPanelId}
          splitRoomOpen={isSplitLayout && splitRoomOpen}
          onToggleSplitRoom={toggleSplitRoom}
          onOpenMusicDrawer={() => (mobileDrawer = "music")}
          onOpenLyricsDrawer={() => {
            mobileDrawer = "music";
            musicPanelRef?.openPlayerTab?.();
          }}
          onToggleListen={() => musicPanelRef?.toggleListenControl?.()}
        />
      </div>

      <ChatInterconnectPopover
        open={showInterconnect}
        sites={interconnectSites}
        onClose={() => (showInterconnect = false)}
      />
    </div>

    <div
      class="chat-panel chat-panel-right {mobileDrawer === 'music' ? 'mobile-drawer-open' : ''}"
      ondragenter={(e) => handleSidePanelDragEnter("right", e)}
      ondragover={(e) => handleSidePanelDragOver("right", e)}
      ondragleave={(e) => handleSidePanelDragLeave("right", e)}
      ondrop={(e) => void handleSidePanelDrop("right", e)}
    >
      <div class="chat-panel-bg-layer" aria-hidden="true">
        {#if effectivePanelBgUrls.right}
          <img
            src={effectivePanelBgUrls.right}
            alt=""
            loading="eager"
            fetchpriority="low"
            decoding="async"
            class="chat-panel-bg-img"
            use:trackBgImgAspectRatio={effectivePanelBgUrls.right}
            style:display={failedPanelBg.right ? "none" : undefined}
            onerror={() => { failedPanelBg = { ...failedPanelBg, right: true }; }}
          />
        {/if}
        <div class="chat-panel-bg-scrim"></div>
      </div>
      {#if import.meta.env.DEV && sideDragActive.right}
        <div class="chat-panel-dev-drop-overlay" role="presentation">
          <div class="chat-panel-dev-drop-box">
            <span class="text-xs font-bold text-[var(--skin-accent)]">松开替换为右侧面板壁纸</span>
            <span class="text-[11px] text-[var(--chat-meta-color)]">仅本地开发预览</span>
          </div>
        </div>
      {/if}
      <audio bind:this={chatAudio} preload="auto" playsinline muted></audio>
      {#key currentRoom}
      <MusicPanel
        bind:this={musicPanelRef}
        audioEl={chatAudio}
        serverNow={serverNow}
        roomId={currentRoom}
        chatServerUrl={normalizedChatServer}
        playlistOutApiUrl={playlistOutApiUrl}
        walineToken={walineToken}
        playlistRefreshSeq={playlistRefreshSeq}
        externalPlaylistRequest={externalPlaylistRequest}
        fallbackTracks={musicTracks}
        musicState={musicState}
        currentUser={currentUser}
        onlineMemberCount={musicAudience.onlineCount || roomOnlineMembers.length}
        listeningMemberCount={musicAudience.listeningCount}
        onlineMembers={roomOnlineMembers}
        mentionMembers={mentionMembers}
        clockOffsetMs={clockOffsetMs}
        initialVolume={memoryVolume}
        initialListening={isListeningIntent}
        onSearchOnline={handleSearchOnline}
        onEnqueueTrack={handleEnqueueTrack}
        onNotify={showNotice}
        onOpenUserProfile={handleOpenUserProfile}
        onPlaybackStatusChange={(status) => {
          mobilePlaybackStatus = status;
          const listening = Boolean(status.listenIntent && status.audioStatus !== "blocked");
          const listenKey = currentRoom + ":" + listening;
          if (ws?.readyState === WebSocket.OPEN && listenKey !== lastListenPacket) {
            ws.send(JSON.stringify({ type: "music:listen", listening }));
            lastListenPacket = listenKey;
          }
          if (!hasAppMounted) return;
          if (typeof status.listenIntent === "boolean") {
            isListeningIntent = status.listenIntent;
          }
          if (typeof status.volume === "number") {
            memoryVolume = status.volume;
          }
        }}
        onRemoveQueue={(uid) => {
          if (!currentUser) {
            showAuthModal = true;
            return;
          }
          sendPacket({ type: "music:remove", uid });
        }}
        onPlayQueued={handlePlayQueued}
        isSkippingTrack={isSkippingTrack}
        onSkipTrack={handleSkipTrack}
        onVoteSkip={handleVoteSkip}
        onReady={(playUid, sourceRevision) =>
          sendPacket({ type: "music:ready", playUid, sourceRevision })
        }
        onReportDuration={(playUid, durationSec) =>
          sendPacket({ type: "music:report_duration", playUid, durationSec })
        }
        onTrackEnded={(playUid) => sendPacket({ type: "music:ended", playUid })}
        onReportError={(playUid, sourceRevision) =>
          sendPacket({ type: "music:report_error", playUid, sourceRevision })
        }
        onRequestAuth={() => (showAuthModal = true)}
        onRequestWalineAuth={handleDirectWalineLogin}
        walineLoginWaiting={walineLoginWaiting}
      />
      {/key}
    </div>
  </div>

  <!-- 个人资料独立编辑弹窗 -->
  <ChatProfileModal
    open={showProfileModal}
    currentUser={currentUser}
    walineServerUrl={walineServerUrl}
    onSave={handleUpdateProfile}
    onClose={() => (showProfileModal = false)}
    onLogout={handleLogout}
  />

  <!-- 用户详细资料卡弹窗 -->
  <ChatUserDetailModal
    open={showUserDetailModal}
    seed={userDetailSeed}
    roomId={currentRoom}
    chatServerUrl={normalizedChatServer}
    currentUser={currentUser}
    onlineMembers={onlineMembers}
    messages={messages}
    musicHistoryLogs={musicState?.historyLogs ?? []}
    interconnectSites={interconnectSites}
    onClose={() => (showUserDetailModal = false)}
    onMention={handleMentionUser}
    onEditSelf={() => {
      showUserDetailModal = false;
      showProfileModal = true;
    }}
    onEnqueueTrack={handleEnqueueTrack}
    onOpenPlaylist={handleOpenPlaylistFromProfile}
    onUpdateMemberBadges={handleUpdateMemberBadges}
    onJumpToMessage={(msgUid) => {
      showUserDetailModal = false;
      targetMessageUid = msgUid;
      mobileDrawer = "none";
      closeSplitRoom();
    }}
  />

  <!-- 身份准入二选一弹窗（最高层级，唤起时自动收起其他底层弹窗） -->
  <ChatAuthModal
    open={showAuthModal}
    roomId={currentRoom}
    chatServerUrl={normalizedChatServer}
    walineServerUrl={walineServerUrl}
    onAuthenticated={handleAuthenticated}
    onClose={() => (showAuthModal = false)}
  />

  <!-- 发起投票弹窗（顶级外层，免受 .chat-mobile-stage 高斯模糊影响） -->
  <ChatPollCreateModal
    open={showPollCreateModal}
    onClose={() => (showPollCreateModal = false)}
    onSubmit={handleCreatePoll}
  />

  <!-- 全局底部悬浮提示气泡（挂载至 body 顶层，避免被弹窗/抽屉/壁纸遮挡） -->
  <div
    use:placeGlobalToast
    class="fixed bottom-8 left-1/2 -translate-x-1/2 z-[2147483647] px-4 py-2.5 rounded-xl text-white text-xs sm:text-sm font-medium shadow-2xl backdrop-blur-md transition-all duration-300 max-w-[90vw] text-center border pointer-events-none select-none inline-flex items-center gap-2 {noticeTone === 'error' ? 'bg-red-600/95 dark:bg-red-600/90 border-red-400/50 shadow-red-950/35' : 'bg-black/85 dark:bg-neutral-800/90 border-white/10'} {noticeVisible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-2 scale-95'}"
    role="status"
    aria-live="polite"
    aria-hidden={!noticeVisible}
  >
    {#if noticeTone === "error"}
      <svg class="w-4 h-4 shrink-0 text-red-100" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    {/if}
    <span>{noticeText}</span>
  </div>
</div>
