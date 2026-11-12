<script lang="ts">
import { onMount, tick } from "svelte";
import { KAOMOJI_PRESETS } from "@/constants/kaomoji";
import ChatMessage from "./ChatMessage.svelte";
import { uploadChatImage } from "./chatClient";
import type {
	ChatMentionCandidate,
	ChatMessageRecord,
	ChatOnlineMember,
	ChatSessionUser,
	ImageAttachment,
	RoomMusicState,
} from "./chatTypes";
import type { StickerItem, StickerPack } from "./stickerLoader";

interface Props {
	roomId: string;
	roomName: string;
	roomSubtitle: string;
	onlineCount: number;
	messages: ChatMessageRecord[];
	hasMoreHistory?: boolean;
	isLoadingHistory?: boolean;
	sessionUnreadSince?: number;
	serverUnreadCount?: number;
	serverUnreadUserCount?: number;
	unreadJumpSeq?: number;
	currentUser: ChatSessionUser | null;
	onlineMembers?: ChatOnlineMember[];
	mentionMembers?: ChatMentionCandidate[];
	isChatTabActive?: boolean;
	targetMessageUid?: string;
	musicState?: RoomMusicState | null;
	onSkipTrack?: () => void;
	onVoteSkip?: () => void;
	onClearTargetMessage?: () => void;
	onLoadHistory?: (sinceCreatedAt?: number, jumpTarget?: boolean) => void;
	onMarkRead?: (timestamp: number) => void;
	stickerPacks: StickerPack[];
	stickerMap: Map<string, StickerItem>;
	enableImageUpload: boolean;
	walineServerUrl: string;
	mentionEvent?: { name: string; userKey?: string; seq: number };
	showSettings?: boolean;
	noticeText?: string;
	onToggleSettings?: () => void;
	onSendMessage: (
		content: string,
		attachments: ImageAttachment[],
		mentionKeys: string[],
	) => void;
	onDeleteMessage: (msgUid: string) => void;
	onRequireAuth: () => void;
	onMentionUser: (name: string) => void;
}

const {
	roomId = "chat",
	roomName = "闲聊",
	roomSubtitle = "随便聊聊日常与折腾",
	onlineCount = 0,
	messages = [],
	hasMoreHistory = false,
	isLoadingHistory = false,
	sessionUnreadSince = 0,
	serverUnreadCount = 0,
	serverUnreadUserCount = 0,
	unreadJumpSeq = 0,
	currentUser = null,
	onlineMembers = [],
	mentionMembers = [],
	isChatTabActive = true,
	targetMessageUid = "",
	musicState = null,
	onSkipTrack,
	onVoteSkip,
	onClearTargetMessage,
	onLoadHistory,
	onMarkRead,
	stickerPacks = [],
	stickerMap,
	enableImageUpload = true,
	walineServerUrl = "",
	mentionEvent,
	showSettings = false,
	noticeText = "",
	onToggleSettings,
	onSendMessage,
	onDeleteMessage,
	onRequireAuth,
	onMentionUser,
}: Props = $props();

let inputText = $state("");
let pendingImages = $state<ImageAttachment[]>([]);
let isUploadingImage = $state(false);
let uploadError = $state("");
let activePopover = $state<"none" | "emoji">("none");
let activeEmojiTab = $state<string>("kaomoji");
let showMusicNotices = $state(true);

let mentionMenuOpen = $state(false);
let mentionQuery = $state("");
let mentionTriggerStart = $state(-1);
let mentionActiveIndex = $state(0);
let selectedMentionMap = $state<Record<string, string>>({});

let showMentionHistory = $state(false);
let unreadMentionUids = $state<string[]>([]);
let alertBannerUid = $state<string | null>(null);
let highlightedMsgUid = $state("");

let showAllLoaded = $state(false);
let unreadBarDismissed = $state(false);
let isUnreadDividerInView = $state(false);
let highlightUnreadDivider = $state(false);

const skipVoteBanner = $derived.by(() => {
	const current = musicState?.current ?? null;
	const voteCount = musicState?.voteCount ?? 0;
	const voteThreshold = musicState?.voteThreshold ?? 2;
	if (!current || voteCount <= 0) return null;

	const names = (musicState?.skipVoteNames ?? []).filter(Boolean);
	const voterLabel =
		names.length === 0
			? "房友"
			: names.length <= 2
				? names.join("、")
				: `${names.slice(0, 2).join("、")} 等`;
	const isAdmin = Boolean(currentUser?.isAdmin);
	const isOwnRequest = Boolean(
		currentUser &&
			!current.isFallback &&
			current.requesterKey === currentUser.userKey,
	);
	const hasVotedSkip = Boolean(
		currentUser && current.skipVotes.includes(currentUser.userKey),
	);

	return {
		voterLabel,
		title: current.track.title,
		voteCount,
		voteThreshold,
		canApproveSkip: isAdmin || isOwnRequest,
		hasVotedSkip,
	};
});

const VISIBLE_FOLD_LIMIT = 40;
const SHOW_MUSIC_NOTICES_KEY = "lengxi_chat_show_music_notices";
const LAST_SEEN_PREFIX = "lengxi_chat_last_seen:";

let messageContainer: HTMLDivElement | null = $state(null);
let inputEl: HTMLTextAreaElement | null = $state(null);
let fileInputEl: HTMLInputElement | null = $state(null);
let dockEl: HTMLDivElement | null = $state(null);
let mentionHistoryWrapEl: HTMLDivElement | null = $state(null);
let lastMentionSeq = 0;
let lastUnreadJumpSeq = 0;
let initializedRoom = "";
let hydratedRoomKey = "";
let seenMessageUids = new Set<string>();
let alertAutoHideTimer: number | null = null;
let highlightClearTimer: number | null = null;
let unreadHighlightTimer: number | null = null;
let lastRenderedVisibleLen = 0;
let isStickyAtBottom = true;

function getLastSeenStorageKey(rId: string, uKey: string): string {
	return `${LAST_SEEN_PREFIX}${rId}:${uKey}`;
}

function readLastSeenAt(rId: string, uKey: string): number {
	try {
		const raw = localStorage.getItem(getLastSeenStorageKey(rId, uKey));
		const parsed = raw ? Number(raw) : 0;
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
	} catch {
		return 0;
	}
}

function writeLastSeenAt(rId: string, uKey: string, ts: number): void {
	if (!uKey || !Number.isFinite(ts) || ts <= 0) return;
	try {
		const key = getLastSeenStorageKey(rId, uKey);
		const prev = readLastSeenAt(rId, uKey);
		if (ts > prev) {
			localStorage.setItem(key, String(ts));
		}
	} catch {
		// 忽略存储写入异常
	}
}

function isChatPaneFocused(): boolean {
	if (typeof document === "undefined" || typeof window === "undefined") {
		return true;
	}
	if (document.hidden) return false;
	const isMobile = window.matchMedia("(max-width: 767px)").matches;
	return !isMobile || isChatTabActive;
}

function isMusicNoticeMessage(msg: ChatMessageRecord): boolean {
	if (msg.kind !== "system") return false;
	return /(点播了|切到了下一首|投票切歌通过|切播了|音源解析失败|播放失败)/.test(
		msg.content,
	);
}

const visibleMessages = $derived(
	showMusicNotices
		? messages
		: messages.filter((msg) => !isMusicNoticeMessage(msg)),
);

const isLocalFolded = $derived(
	!showAllLoaded && visibleMessages.length > VISIBLE_FOLD_LIMIT,
);

const renderedMessages = $derived(
	isLocalFolded ? visibleMessages.slice(-VISIBLE_FOLD_LIMIT) : visibleMessages,
);

const localFoldedCount = $derived(
	visibleMessages.length - renderedMessages.length,
);

const hasUnloadedUnread = $derived(
	Boolean(
		sessionUnreadSince > 0 &&
			messages.length > 0 &&
			sessionUnreadSince < messages[0].createdAt &&
			hasMoreHistory,
	),
);

const firstUnreadMsgUid = $derived.by(() => {
	if (!sessionUnreadSince) return "";
	const found = visibleMessages.find((m) => m.createdAt > sessionUnreadSince);
	return found?.msgUid || "";
});

const unreadBadgeCount = $derived.by(() => {
	if (!sessionUnreadSince) return 0;
	const loadedCount = visibleMessages.filter(
		(m) => m.createdAt > sessionUnreadSince,
	).length;
	const serverCount = showMusicNotices
		? serverUnreadCount
		: serverUnreadUserCount;
	return hasUnloadedUnread ? Math.max(loadedCount, serverCount) : loadedCount;
});

const showUnreadJumpBar = $derived(
	Boolean(
		sessionUnreadSince > 0 &&
			unreadBadgeCount > 0 &&
			!unreadBarDismissed &&
			(hasUnloadedUnread || !isUnreadDividerInView),
	),
);

function formatUnreadTime(ts: number): string {
	if (!ts) return "";
	const d = new Date(ts);
	const now = new Date();
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const timePart = `${hh}:${mm}`;

	const todayStart = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate(),
	).getTime();
	const targetDayStart = new Date(
		d.getFullYear(),
		d.getMonth(),
		d.getDate(),
	).getTime();
	const diffDays = Math.round((todayStart - targetDayStart) / 86_400_000);
	if (diffDays === 0) return `今天 ${timePart}`;
	if (diffDays === 1) return `昨天 ${timePart}`;
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${timePart}`;
}

function toggleMusicNotices() {
	showMusicNotices = !showMusicNotices;
	try {
		localStorage.setItem(SHOW_MUSIC_NOTICES_KEY, showMusicNotices ? "1" : "0");
	} catch {
		// 忽略存储写入异常
	}
}

const orderedStickerPacks = $derived.by(() => {
	return stickerPacks
		.map((pack) => {
			const isMiku = pack.id.includes("/miku") || pack.name === "初音未来";
			return {
				...pack,
				displayName: isMiku ? "贴纸" : pack.name,
				order: pack.id.includes("/qq") ? 1 : isMiku ? 2 : 3,
			};
		})
		.sort((a, b) => a.order - b.order);
});

function isMentionedToMe(msg: ChatMessageRecord): boolean {
	if (
		!currentUser ||
		msg.kind !== "user" ||
		msg.userKey === currentUser.userKey
	) {
		return false;
	}
	if (msg.mentionKeys?.includes(currentUser.userKey)) {
		return true;
	}
	const myName = currentUser.name.trim().toLowerCase();
	return Boolean(
		myName && msg.mentions.some((m) => m.trim().toLowerCase() === myName),
	);
}

const mentionsToMe = $derived(messages.filter(isMentionedToMe));

const mergedMentionCandidates = $derived.by<ChatMentionCandidate[]>(() => {
	const map = new Map<string, ChatMentionCandidate>();
	for (const m of mentionMembers) {
		if (!m.userKey || m.userKey === currentUser?.userKey) continue;
		map.set(m.userKey, m);
	}
	for (const m of onlineMembers) {
		if (!m.userKey || m.userKey === currentUser?.userKey) continue;
		map.set(m.userKey, {
			userKey: m.userKey,
			authType: m.authType,
			name: m.name,
			avatar: m.avatar,
			badge: m.badge,
			badgeType: m.badgeType,
			isAdmin: m.isAdmin,
			online: true,
			lastSeenAt: Date.now(),
		});
	}
	return Array.from(map.values()).sort((a, b) => {
		if (a.online !== b.online) return a.online ? -1 : 1;
		if (a.online && b.online) {
			if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
			return a.name.localeCompare(b.name, "zh-CN");
		}
		if (a.lastSeenAt !== b.lastSeenAt) return b.lastSeenAt - a.lastSeenAt;
		return a.name.localeCompare(b.name, "zh-CN");
	});
});

const filteredMentionCandidates = $derived.by<ChatMentionCandidate[]>(() => {
	const q = mentionQuery.trim().toLowerCase();
	if (!q) return mergedMentionCandidates;
	return mergedMentionCandidates.filter((c) =>
		c.name.toLowerCase().includes(q),
	);
});

const unreadMentionSet = $derived(new Set(unreadMentionUids));

const activeAlertMessage = $derived.by<ChatMessageRecord | null>(() => {
	const targetUid =
		alertBannerUid ??
		(unreadMentionUids.length > 0
			? unreadMentionUids[unreadMentionUids.length - 1]
			: null);
	if (!targetUid) return null;
	return messages.find((m) => m.msgUid === targetUid) ?? null;
});

function checkIsNearBottom(): boolean {
	if (!messageContainer) return true;
	const gap =
		messageContainer.scrollHeight -
		messageContainer.scrollTop -
		messageContainer.clientHeight;
	return gap < 120;
}

function handleMessageScroll() {
	isStickyAtBottom = checkIsNearBottom();
	if (
		isStickyAtBottom &&
		currentUser &&
		messages.length > 0 &&
		isChatPaneFocused()
	) {
		writeLastSeenAt(
			roomId,
			currentUser.userKey,
			messages[messages.length - 1].createdAt,
		);
	}
}

async function scrollToBottom() {
	await tick();
	if (messageContainer) {
		messageContainer.scrollTop = messageContainer.scrollHeight;
		isStickyAtBottom = true;
	}
}

async function jumpToMessage(msgUid: string) {
	showMentionHistory = false;
	showAllLoaded = true;
	const targetMsg = messages.find((m) => m.msgUid === msgUid);
	if (currentUser && targetMsg) {
		writeLastSeenAt(roomId, currentUser.userKey, targetMsg.createdAt);
	}
	unreadMentionUids = unreadMentionUids.filter((id) => id !== msgUid);
	if (alertBannerUid === msgUid) {
		alertBannerUid = null;
	}
	if (alertAutoHideTimer !== null) {
		window.clearTimeout(alertAutoHideTimer);
		alertAutoHideTimer = null;
	}
	await tick();
	const el = messageContainer?.querySelector<HTMLElement>(
		`[data-msg-uid="${CSS.escape(msgUid)}"]`,
	);
	if (!el) return;
	el.scrollIntoView({ behavior: "smooth", block: "center" });
	highlightedMsgUid = msgUid;
	if (highlightClearTimer !== null) {
		window.clearTimeout(highlightClearTimer);
	}
	highlightClearTimer = window.setTimeout(() => {
		highlightedMsgUid = "";
	}, 1800);
}

async function scrollToUnreadDivider() {
	showAllLoaded = true;
	await tick();
	const dividerEl = messageContainer?.querySelector<HTMLElement>(
		"[data-unread-divider]",
	);
	if (dividerEl) {
		dividerEl.scrollIntoView({ behavior: "smooth", block: "center" });
	} else if (messageContainer) {
		messageContainer.scrollTo({ top: 0, behavior: "smooth" });
	}
	highlightUnreadDivider = true;
	unreadBarDismissed = true;
	if (messages.length > 0) {
		onMarkRead?.(messages[messages.length - 1].createdAt);
	}
	if (unreadHighlightTimer !== null) {
		window.clearTimeout(unreadHighlightTimer);
	}
	unreadHighlightTimer = window.setTimeout(() => {
		highlightUnreadDivider = false;
	}, 2200);
}

function handleJumpToUnread() {
	if (hasUnloadedUnread) {
		showAllLoaded = true;
		onLoadHistory?.(sessionUnreadSince, true);
		return;
	}
	void scrollToUnreadDivider();
}

function dismissUnreadBar() {
	unreadBarDismissed = true;
	if (messages.length > 0) {
		onMarkRead?.(messages[messages.length - 1].createdAt);
	}
}

async function handleExpandOlderMessages() {
	const prevHeight = messageContainer?.scrollHeight ?? 0;
	const prevTop = messageContainer?.scrollTop ?? 0;
	if (isLocalFolded) {
		showAllLoaded = true;
		await tick();
		if (messageContainer) {
			messageContainer.scrollTop =
				prevTop + (messageContainer.scrollHeight - prevHeight);
		}
		return;
	}
	if (hasMoreHistory && !isLoadingHistory) {
		onLoadHistory?.();
	}
}

function dismissAlertBanner() {
	if (activeAlertMessage) {
		if (currentUser) {
			writeLastSeenAt(
				roomId,
				currentUser.userKey,
				activeAlertMessage.createdAt,
			);
		}
		unreadMentionUids = unreadMentionUids.filter(
			(id) => id !== activeAlertMessage.msgUid,
		);
	}
	alertBannerUid = null;
	if (alertAutoHideTimer !== null) {
		window.clearTimeout(alertAutoHideTimer);
		alertAutoHideTimer = null;
	}
}

function formatShortTime(ts: number): string {
	if (!ts) return "";
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

onMount(() => {
	try {
		const saved = localStorage.getItem(SHOW_MUSIC_NOTICES_KEY);
		if (saved === "0" || saved === "false") {
			showMusicNotices = false;
		}
	} catch {
		// 忽略存储读取异常
	}

	void scrollToBottom();

	const handlePointerDown = (e: PointerEvent) => {
		const target = e.target as HTMLElement | null;
		if (!target) return;
		if (!dockEl?.contains(target)) {
			activePopover = "none";
			mentionMenuOpen = false;
		}
		if (!mentionHistoryWrapEl?.contains(target)) {
			showMentionHistory = false;
		}
	};

	const handleDocKeydown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			showMentionHistory = false;
		}
	};

	document.addEventListener("pointerdown", handlePointerDown);
	document.addEventListener("keydown", handleDocKeydown);
	return () => {
		document.removeEventListener("pointerdown", handlePointerDown);
		document.removeEventListener("keydown", handleDocKeydown);
		if (alertAutoHideTimer !== null) window.clearTimeout(alertAutoHideTimer);
		if (highlightClearTimer !== null) window.clearTimeout(highlightClearTimer);
		if (unreadHighlightTimer !== null)
			window.clearTimeout(unreadHighlightTimer);
	};
});

$effect(() => {
	const currentRoomId = roomId;
	const msgs = messages;
	const visLen = visibleMessages.length;
	const userKey = currentUser?.userKey || "";

	if (initializedRoom !== currentRoomId) {
		initializedRoom = currentRoomId;
		hydratedRoomKey = "";
		seenMessageUids = new Set();
		unreadMentionUids = [];
		alertBannerUid = null;
		showAllLoaded = false;
		unreadBarDismissed = false;
		isUnreadDividerInView = false;
		highlightUnreadDivider = false;
		lastRenderedVisibleLen = visLen;
		if (!targetMessageUid) {
			void scrollToBottom();
		}
	}

	const roomHydrationTag = `${currentRoomId}:${userKey}`;
	if (msgs.length > 0 && hydratedRoomKey !== roomHydrationTag) {
		hydratedRoomKey = roomHydrationTag;
		seenMessageUids = new Set(msgs.map((m) => m.msgUid));
		const latestCreatedAt = msgs[msgs.length - 1]?.createdAt ?? 0;

		if (userKey) {
			const savedLastSeen = readLastSeenAt(currentRoomId, userKey);
			if (savedLastSeen > 0) {
				// 仅当离开聊天室期间有人 @自己 且未读时弹出横幅提醒
				const missedMentions = msgs.filter(
					(m) =>
						isMentionedToMe(m) &&
						m.createdAt > savedLastSeen &&
						m.msgUid !== targetMessageUid,
				);
				if (missedMentions.length > 0) {
					unreadMentionUids = missedMentions.map((m) => m.msgUid);
					alertBannerUid = missedMentions[missedMentions.length - 1].msgUid;
				}
			} else if (latestCreatedAt > 0) {
				writeLastSeenAt(currentRoomId, userKey, latestCreatedAt);
			}
		}

		lastRenderedVisibleLen = visLen;
		if (!targetMessageUid) {
			void scrollToBottom();
		}
	} else if (hydratedRoomKey === roomHydrationTag) {
		const newlyArrived = msgs.filter((m) => !seenMessageUids.has(m.msgUid));
		for (const m of newlyArrived) {
			seenMessageUids.add(m.msgUid);
			if (isMentionedToMe(m)) {
				// 已经在聊天室里看着底部最新消息时，不弹窗横幅；只有不在当前视图/切出标签页/翻上去读历史时才弹横幅
				const inChatNow = isChatPaneFocused() && isStickyAtBottom;
				if (!inChatNow) {
					unreadMentionUids = [...unreadMentionUids, m.msgUid];
					alertBannerUid = m.msgUid;
				} else if (userKey) {
					writeLastSeenAt(currentRoomId, userKey, m.createdAt);
				}
			} else if (userKey && isChatPaneFocused() && isStickyAtBottom) {
				writeLastSeenAt(currentRoomId, userKey, m.createdAt);
			}
		}

		if (visLen !== lastRenderedVisibleLen) {
			lastRenderedVisibleLen = visLen;
			if (isStickyAtBottom && !targetMessageUid) {
				void scrollToBottom();
			}
		}
	}

	if (visibleMessages.some((m) => m.attachments.length > 0)) {
		void tick().then(() => {
			document.dispatchEvent(new CustomEvent("chat:media-rendered"));
		});
	}
});

$effect(() => {
	if (unreadJumpSeq > 0 && unreadJumpSeq !== lastUnreadJumpSeq) {
		lastUnreadJumpSeq = unreadJumpSeq;
		void scrollToUnreadDivider();
	}
});

$effect(() => {
	const container = messageContainer;
	const markerUid = firstUnreadMsgUid;
	const _foldState = showAllLoaded;
	if (
		!container ||
		!markerUid ||
		hasUnloadedUnread ||
		isLocalFolded ||
		typeof IntersectionObserver === "undefined"
	) {
		isUnreadDividerInView = false;
		return;
	}
	const dividerEl = container.querySelector<HTMLElement>(
		"[data-unread-divider]",
	);
	if (!dividerEl) {
		isUnreadDividerInView = false;
		return;
	}
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					isUnreadDividerInView = true;
					if (messages.length > 0) {
						onMarkRead?.(messages[messages.length - 1].createdAt);
					}
					observer.disconnect();
				}
			}
		},
		{ root: container, threshold: 0.25 },
	);
	observer.observe(dividerEl);
	return () => observer.disconnect();
});

$effect(() => {
	const deepTarget = targetMessageUid;
	if (!deepTarget) return;
	if (messages.some((m) => m.msgUid === deepTarget)) {
		void tick().then(() => {
			void jumpToMessage(deepTarget);
			onClearTargetMessage?.();
		});
	}
});

$effect(() => {
	const container = messageContainer;
	const pending = unreadMentionUids;
	if (
		!container ||
		pending.length === 0 ||
		typeof IntersectionObserver === "undefined"
	) {
		return;
	}
	const observer = new IntersectionObserver(
		(entries) => {
			const viewed: string[] = [];
			for (const entry of entries) {
				if (entry.isIntersecting) {
					const uid = (entry.target as HTMLElement).dataset.msgUid;
					if (uid) viewed.push(uid);
				}
			}
			if (viewed.length > 0) {
				const viewedSet = new Set(viewed);
				unreadMentionUids = unreadMentionUids.filter(
					(id) => !viewedSet.has(id),
				);
				if (alertBannerUid && viewedSet.has(alertBannerUid)) {
					alertBannerUid = null;
				}
			}
		},
		{ root: container, threshold: 0.5 },
	);

	for (const uid of pending) {
		const el = container.querySelector<HTMLElement>(
			`[data-msg-uid="${CSS.escape(uid)}"]`,
		);
		if (el) observer.observe(el);
	}

	return () => observer.disconnect();
});

$effect(() => {
	if (mentionEvent && mentionEvent.seq !== lastMentionSeq) {
		lastMentionSeq = mentionEvent.seq;
		if (mentionEvent.userKey) {
			selectedMentionMap = {
				...selectedMentionMap,
				[mentionEvent.name]: mentionEvent.userKey,
			};
		}
		insertAtCursor(
			`${inputText && !inputText.endsWith(" ") ? " " : ""}@${mentionEvent.name} `,
		);
	}
});

function insertAtCursor(snippet: string) {
	if (!inputEl) {
		inputText += snippet;
		return;
	}
	const start = inputEl.selectionStart ?? inputText.length;
	const end = inputEl.selectionEnd ?? inputText.length;
	inputText = inputText.slice(0, start) + snippet + inputText.slice(end);
	void tick().then(() => {
		if (!inputEl) return;
		inputEl.focus();
		const pos = start + snippet.length;
		inputEl.selectionStart = pos;
		inputEl.selectionEnd = pos;
	});
}

function syncMentionTrigger() {
	if (!inputEl) {
		mentionMenuOpen = false;
		return;
	}
	const caret = inputEl.selectionStart ?? inputText.length;
	const beforeCaret = inputText.slice(0, caret);
	const match = beforeCaret.match(
		/(?:^|[\s,，.。!！?？:：;；()（）[\]【】<>《》"'"“”‘’])@([^\s@]{0,16})$/,
	);
	if (match && mergedMentionCandidates.length > 0) {
		mentionQuery = match[1] ?? "";
		mentionTriggerStart = caret - mentionQuery.length - 1;
		mentionActiveIndex = 0;
		mentionMenuOpen = true;
		activePopover = "none";
	} else {
		mentionMenuOpen = false;
		mentionTriggerStart = -1;
	}
}

function selectMentionCandidate(candidate: ChatMentionCandidate) {
	const caret = inputEl?.selectionStart ?? inputText.length;
	const triggerIdx = mentionTriggerStart;
	const prefix =
		triggerIdx >= 0
			? inputText.slice(0, triggerIdx)
			: inputText.slice(0, caret);
	const suffix = inputText.slice(caret);
	const inserted = `@${candidate.name} `;
	inputText = `${prefix}${inserted}${suffix}`;
	selectedMentionMap = {
		...selectedMentionMap,
		[candidate.name]: candidate.userKey,
	};
	mentionMenuOpen = false;
	mentionTriggerStart = -1;
	mentionQuery = "";

	void tick().then(() => {
		if (!inputEl) return;
		inputEl.focus();
		const pos = prefix.length + inserted.length;
		inputEl.selectionStart = pos;
		inputEl.selectionEnd = pos;
	});
}

function collectMentionKeys(content: string): string[] {
	const lower = content.toLowerCase();
	const keys = new Set<string>();
	for (const [name, key] of Object.entries(selectedMentionMap)) {
		if (lower.includes(`@${name.toLowerCase()}`)) {
			keys.add(key);
		}
	}
	return Array.from(keys);
}

function handleSend() {
	const trimmed = inputText.trim();
	if (!trimmed && pendingImages.length === 0) return;
	if (!currentUser) {
		onRequireAuth();
		return;
	}

	const mentionKeys = collectMentionKeys(trimmed);
	onSendMessage(trimmed, pendingImages, mentionKeys);
	inputText = "";
	pendingImages = [];
	uploadError = "";
	selectedMentionMap = {};
	mentionMenuOpen = false;
	activePopover = "none";
	void scrollToBottom();
}

function handleKeydown(e: KeyboardEvent) {
	if (mentionMenuOpen && filteredMentionCandidates.length > 0) {
		const count = filteredMentionCandidates.length;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			mentionActiveIndex = (mentionActiveIndex + 1) % count;
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			mentionActiveIndex = (mentionActiveIndex - 1 + count) % count;
			return;
		}
		if (e.key === "Enter" || e.key === "Tab") {
			e.preventDefault();
			const picked =
				filteredMentionCandidates[mentionActiveIndex] ??
				filteredMentionCandidates[0];
			if (picked) {
				selectMentionCandidate(picked);
			}
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			mentionMenuOpen = false;
			return;
		}
	}

	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		handleSend();
	}
}

async function processImageFiles(files: FileList | File[]) {
	if (!currentUser) {
		onRequireAuth();
		return;
	}
	if (!enableImageUpload || !walineServerUrl) {
		uploadError = "当前未启用图片上传服务";
		return;
	}
	const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
	if (list.length === 0) return;

	const remaining = Math.max(0, 3 - pendingImages.length);
	if (remaining === 0) {
		uploadError = "单条消息最多附带 3 张图片";
		return;
	}

	uploadError = "";
	isUploadingImage = true;
	try {
		for (const file of list.slice(0, remaining)) {
			const url = await uploadChatImage(file, walineServerUrl);
			pendingImages = [...pendingImages, { type: "image", url }];
		}
	} catch (err) {
		uploadError = err instanceof Error ? err.message : "图片上传失败";
	} finally {
		isUploadingImage = false;
		if (fileInputEl) {
			fileInputEl.value = "";
		}
	}
}

function handlePaste(e: ClipboardEvent) {
	const items = e.clipboardData?.files;
	if (!items || items.length === 0) return;
	const imageFiles = Array.from(items).filter((f) =>
		f.type.startsWith("image/"),
	);
	if (imageFiles.length > 0) {
		e.preventDefault();
		void processImageFiles(imageFiles);
	}
}

function removePendingImage(index: number) {
	pendingImages = pendingImages.filter((_, i) => i !== index);
}
</script>

<div class="flex flex-col h-full w-full min-h-0 relative">
  <!-- 顶栏 -->
  <div class="chat-panel-header">
    <div class="flex items-center gap-2 min-w-0">
      <span class="font-bold text-sm text-[var(--deep-text)] dark:text-white/90 shrink-0">
        # {roomName}
      </span>
      <span class="text-xs text-[var(--chat-meta-color)] truncate hidden sm:inline">
        · {roomSubtitle}
      </span>
    </div>
    <div class="flex items-center gap-1.5 shrink-0">
      {#if currentUser && mentionsToMe.length > 0}
        <div class="relative shrink-0" bind:this={mentionHistoryWrapEl}>
          <button
            type="button"
            class="chat-header-pill-btn {unreadMentionUids.length > 0 ? 'has-unread' : ''}"
            aria-expanded={showMentionHistory}
            aria-label="查看 @我的消息"
            onclick={() => (showMentionHistory = !showMentionHistory)}
          >
            <span class="font-bold text-[var(--primary)]">@我</span>
            {#if unreadMentionUids.length > 0}
              <span class="chat-mention-unread-badge">{unreadMentionUids.length}</span>
            {:else}
              <span class="text-[10px] opacity-75 tabular-nums">{mentionsToMe.length}</span>
            {/if}
          </button>

          {#if showMentionHistory}
            <div class="chat-requester-menu chat-mention-history-menu custom-scrollbar" role="menu" aria-label="@我的消息列表">
              <div class="px-2 py-1 text-[10px] font-semibold text-[var(--chat-meta-color)] flex items-center justify-between">
                <span>近期 @你的消息</span>
                <span>{mentionsToMe.length}条</span>
              </div>
              <div class="my-0.5 border-t border-black/5 dark:border-white/10"></div>
              {#each mentionsToMe.slice().reverse() as item (item.msgUid)}
                {@const isUnread = unreadMentionSet.has(item.msgUid)}
                <button
                  type="button"
                  role="menuitem"
                  class="chat-requester-option items-start! py-1.5! {isUnread ? 'active' : ''}"
                  onclick={() => void jumpToMessage(item.msgUid)}
                >
                  <div class="flex items-start gap-2 min-w-0 flex-1">
                    {#if item.avatar}
                      <img src={item.avatar} alt="" class="w-5 h-5 rounded-full object-cover shrink-0 mt-0.5" />
                    {:else}
                      <span class="w-5 h-5 rounded-full bg-(--primary)/15 text-[var(--chat-accent-text)] text-[10px] font-bold inline-flex items-center justify-center shrink-0 mt-0.5">
                        {item.name.slice(0, 1)}
                      </span>
                    {/if}
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center justify-between gap-1">
                        <span class="font-semibold truncate text-[11px]">{item.name}</span>
                        <span class="text-[10px] opacity-70 tabular-nums shrink-0">{formatShortTime(item.createdAt)}</span>
                      </div>
                      <div class="text-[11px] opacity-80 truncate mt-0.5">
                        {item.content || "[图片消息]"}
                      </div>
                    </div>
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <button
        type="button"
        role="switch"
        aria-checked={showMusicNotices}
        aria-label={showMusicNotices ? "隐藏聊天中的点歌记录" : "在聊天中显示点歌记录"}
        class="chat-header-pill-btn {showMusicNotices ? 'active' : ''}"
        onclick={toggleMusicNotices}
      >
        <span>点歌记录</span>
        <span class="chat-switch-track {showMusicNotices ? 'checked' : ''}" aria-hidden="true">
          <span class="chat-switch-thumb"></span>
        </span>
      </button>
      <div class="text-xs text-[var(--deep-text)] dark:text-white/85 px-2.5 py-1 rounded-full bg-[var(--card-bg)]/60 border border-[var(--chat-divider-color)] flex items-center gap-1.5">
        <span class="chat-online-dot"></span>
        <span>{onlineCount} 人在线</span>
      </div>
      <button
        type="button"
        data-chat-settings-trigger
        class="chat-tool-btn {showSettings ? 'text-[var(--primary)] bg-[var(--btn-plain-bg-hover)]' : ''}"
        aria-label="外观与主题设置"
        aria-expanded={showSettings}
        onclick={() => onToggleSettings?.()}
      >
        <svg class="w-[1.1rem] h-[1.1rem]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
    </div>
  </div>

  <!-- 提示条 -->
  {#if noticeText}
    <div class="mx-4 mt-2 px-3 py-1.5 rounded-xl text-xs bg-(--primary)/14 border border-(--primary)/25 text-[var(--chat-accent-text)] flex items-center justify-between gap-2 shrink-0">
      <span>{noticeText}</span>
    </div>
  {/if}

  <!-- 消息展示流区域（含悬浮 切歌投票 / @你 / 未读定位 横幅） -->
  <div class="relative flex-1 min-h-0 flex flex-col">
    {#if skipVoteBanner || activeAlertMessage || showUnreadJumpBar}
      <div class="chat-floating-alerts-stack">
        {#if skipVoteBanner}
          <div class="chat-mention-floating-bar" role="status" aria-live="polite">
            <div class="flex-1 min-w-0 flex items-center gap-2">
              <svg class="w-3.5 h-3.5 text-[var(--primary)] shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
              </svg>
              <span class="font-bold text-[var(--chat-accent-text)] shrink-0 truncate max-w-32">
                {skipVoteBanner.voterLabel}
              </span>
              <span class="truncate text-[var(--deep-text)] dark:text-white/85">
                申请切歌：《{skipVoteBanner.title}》（{skipVoteBanner.voteCount}/{skipVoteBanner.voteThreshold}）
              </span>
            </div>
            {#if skipVoteBanner.canApproveSkip}
              <button
                type="button"
                class="chat-mention-jump-pill border-none cursor-pointer shrink-0"
                onclick={() => onSkipTrack?.()}
              >
                同意切歌
              </button>
            {:else if skipVoteBanner.hasVotedSkip}
              <button
                type="button"
                class="chat-mention-jump-pill opacity-85 border-none cursor-pointer shrink-0"
                onclick={() => onVoteSkip?.()}
              >
                取消投票
              </button>
            {:else}
              <button
                type="button"
                class="chat-mention-jump-pill border-none cursor-pointer shrink-0"
                onclick={() => onVoteSkip?.()}
              >
                投票切歌
              </button>
            {/if}
          </div>
        {/if}

        {#if activeAlertMessage}
          <div class="chat-mention-floating-bar" role="status" aria-live="polite">
            <button
              type="button"
              class="flex-1 min-w-0 flex items-center gap-2 text-left bg-transparent border-none p-0 cursor-pointer text-inherit"
              onclick={() => void jumpToMessage(activeAlertMessage.msgUid)}
            >
              <span class="w-2 h-2 rounded-full bg-[var(--primary)] shrink-0 animate-pulse"></span>
              <span class="font-bold text-[var(--chat-accent-text)] shrink-0">
                {activeAlertMessage.name} @了你
              </span>
              <span class="truncate text-[var(--deep-text)] dark:text-white/85">
                {activeAlertMessage.content || "[图片消息]"}
              </span>
              <span class="chat-mention-jump-pill shrink-0">
                {unreadMentionUids.length > 1 ? `立即查看 (${unreadMentionUids.length})` : "一键跳转 →"}
              </span>
            </button>
            <button
              type="button"
              class="w-5 h-5 rounded-full flex items-center justify-center border-none bg-transparent text-[var(--chat-meta-color)] hover:text-[var(--deep-text)] cursor-pointer shrink-0 text-xs"
              aria-label="关闭提醒"
              onclick={dismissAlertBanner}
            >
              ×
            </button>
          </div>
        {/if}

        {#if showUnreadJumpBar}
          <div class="chat-mention-floating-bar chat-unread-floating-bar" role="status" aria-live="polite">
            <button
              type="button"
              disabled={isLoadingHistory}
              class="flex-1 min-w-0 flex items-center gap-2 text-left bg-transparent border-none p-0 cursor-pointer text-inherit disabled:opacity-60"
              onclick={handleJumpToUnread}
            >
              <svg class="w-3.5 h-3.5 text-[var(--primary)] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="17 11 12 6 7 11" />
                <polyline points="17 18 12 13 7 18" />
              </svg>
              <span class="font-semibold text-[var(--deep-text)] dark:text-white/90 truncate">
                上次 {formatUnreadTime(sessionUnreadSince)} 后有 {unreadBadgeCount} 条未读消息
              </span>
              <span class="chat-mention-jump-pill shrink-0">
                {#if isLoadingHistory}
                  正在展开...
                {:else if hasUnloadedUnread || isLocalFolded}
                  展开并定位 ↑
                {:else}
                  回到上次阅读 ↑
                {/if}
              </span>
            </button>
            <button
              type="button"
              class="w-5 h-5 rounded-full flex items-center justify-center border-none bg-transparent text-[var(--chat-meta-color)] hover:text-[var(--deep-text)] cursor-pointer shrink-0 text-xs"
              aria-label="忽略未读提示"
              onclick={dismissUnreadBar}
            >
              ×
            </button>
          </div>
        {/if}
      </div>
    {/if}

    <div
      bind:this={messageContainer}
      onscroll={handleMessageScroll}
      class="flex-1 overflow-y-auto custom-scrollbar px-4 md:px-5 py-4 min-h-0 space-y-3"
    >
      {#if isLocalFolded || hasMoreHistory}
        <div class="flex justify-center pb-1">
          <button
            type="button"
            disabled={isLoadingHistory}
            class="chat-history-expand-btn"
            onclick={() => void handleExpandOlderMessages()}
          >
            {#if isLoadingHistory}
              正在加载更早的消息...
            {:else if isLocalFolded}
              还有 {localFoldedCount} 条较早消息已折叠 · 点击展开
            {:else}
              ↑ 加载更早的历史消息
            {/if}
          </button>
        </div>
      {/if}

      {#if renderedMessages.length === 0}
        <div class="h-full flex flex-col items-center justify-center text-center py-8 text-xs text-[var(--chat-meta-color)]">
          {#if messages.length > 0 && !showMusicNotices}
            <p class="m-0">当前已隐藏聊天中的点歌记录，发条消息开启话题吧~</p>
          {:else}
            <p class="m-0">房间暂时很安静，发条消息或点首歌开启话题吧~</p>
          {/if}
        </div>
      {:else}
        {#each renderedMessages as msg (msg.msgUid)}
          {#if firstUnreadMsgUid === msg.msgUid}
            <div
              data-unread-divider
              class="chat-unread-divider {highlightUnreadDivider ? 'highlight' : ''}"
              role="separator"
            >
              <span class="chat-unread-divider-line"></span>
              <span class="chat-unread-divider-label">
                上次 {formatUnreadTime(sessionUnreadSince)} 阅读到这里
              </span>
              <span class="chat-unread-divider-line"></span>
            </div>
          {/if}
          {@const isSelf = Boolean(currentUser && msg.userKey === currentUser.userKey)}
          {@const canDelete = Boolean(
            currentUser && msg.kind === "user" && (currentUser.isAdmin || isSelf),
          )}
          <ChatMessage
            message={msg}
            isSelf={isSelf}
            isMentionedMe={isMentionedToMe(msg)}
            isHighlighted={highlightedMsgUid === msg.msgUid}
            currentUserName={currentUser?.name || ""}
            canDelete={canDelete}
            stickerMap={stickerMap}
            onDelete={onDeleteMessage}
            onMention={onMentionUser}
          />
        {/each}
      {/if}
    </div>
  </div>

  <!-- 统一底部输入停靠区 -->
  <div bind:this={dockEl} class="chat-input-dock">
    <!-- 统一表情面板（纯图标 Tab）：1. 颜文字 -> 2. QQ -> 3. 贴纸 -->
    {#if activePopover === "emoji"}
      <div class="chat-emoji-popover chat-sticker-popover" role="dialog" aria-label="颜文字与表情贴纸">
        <div class="chat-picker-tabs">
          <button
            type="button"
            class="chat-picker-tab {activeEmojiTab === 'kaomoji' ? 'active' : ''}"
            aria-label="颜文字"
            onclick={() => (activeEmojiTab = "kaomoji")}
          >
            <span class="font-bold text-xs leading-none">OωO</span>
          </button>

          {#each orderedStickerPacks as pack (pack.id)}
            <button
              type="button"
              class="chat-picker-tab {activeEmojiTab === pack.id ? 'active' : ''}"
              aria-label={pack.displayName}
              onclick={() => (activeEmojiTab = pack.id)}
            >
              <img src={pack.iconUrl} alt={pack.displayName} class="w-5 h-5 object-contain" />
            </button>
          {/each}
        </div>

        <div class="chat-picker-body custom-scrollbar">
          {#if activeEmojiTab === "kaomoji"}
            <div class="space-y-2.5">
              {#each KAOMOJI_PRESETS as group (group.name)}
                <div>
                  <div class="text-[11px] font-semibold text-[var(--chat-meta-color)] mb-1 px-0.5">
                    {group.name}
                  </div>
                  <div class="flex flex-wrap gap-1">
                    {#each group.items as kaomoji (kaomoji)}
                      <button
                        type="button"
                        class="chat-kaomoji-item"
                        onclick={() => {
                          insertAtCursor(kaomoji);
                          activePopover = "none";
                        }}
                      >
                        {kaomoji}
                      </button>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {:else}
            {@const currentPack = orderedStickerPacks.find((p) => p.id === activeEmojiTab)}
            {#if currentPack}
              <div class="grid grid-cols-5 sm:grid-cols-6 gap-1.5">
                {#each currentPack.items as item (item.code)}
                  <button
                    type="button"
                    class="chat-sticker-btn"
                    title={item.name}
                    onclick={() => {
                      insertAtCursor(item.code);
                      activePopover = "none";
                    }}
                  >
                    <img src={item.url} alt={item.name} loading="lazy" class="w-8 h-8 object-contain" />
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/if}

    <!-- @ 选人弹窗（输入 @ 时触发：在线优先，离线靠后） -->
    {#if mentionMenuOpen}
      <div class="chat-mention-autocomplete custom-scrollbar" role="listbox" aria-label="选择要 @ 的成员">
        {#if filteredMentionCandidates.length === 0}
          <div class="px-2.5 py-2 text-[11px] text-[var(--chat-meta-color)]">
            没有找到匹配的成员
          </div>
        {:else}
          {#each filteredMentionCandidates as person, idx (person.userKey)}
            <button
              type="button"
              role="option"
              aria-selected={idx === mentionActiveIndex}
              class="chat-mention-ac-item {idx === mentionActiveIndex ? 'active' : ''}"
              onmouseenter={() => (mentionActiveIndex = idx)}
              onmousedown={(e) => {
                e.preventDefault();
                selectMentionCandidate(person);
              }}
            >
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <div class="relative shrink-0">
                  {#if person.avatar}
                    <img src={person.avatar} alt={person.name} class="w-5 h-5 rounded-full object-cover" />
                  {:else}
                    <span class="w-5 h-5 rounded-full bg-(--primary)/15 text-[var(--chat-accent-text)] text-[10px] font-bold inline-flex items-center justify-center">
                      {person.name.slice(0, 1)}
                    </span>
                  {/if}
                  <span
                    class="chat-ac-status-dot {person.online ? 'online' : 'offline'}"
                    aria-hidden="true"
                  ></span>
                </div>
                <span class="text-xs font-medium truncate text-[var(--deep-text)] dark:text-white/90">
                  {person.name}
                </span>
                {#if person.badge}
                  <span class="chat-role-badge chat-role-badge--{person.badgeType} scale-90 origin-left">
                    {person.badge}
                  </span>
                {/if}
              </div>
              <span class="text-[10px] shrink-0 {person.online ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-[var(--chat-meta-color)] opacity-75'}">
                {person.online ? "在线" : "离线"}
              </span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- 统一一体化毛玻璃输入卡片 -->
    <div class="chat-composer">
      <!-- 待发送图片预览条 -->
      {#if pendingImages.length > 0 || isUploadingImage || uploadError}
        <div class="px-3 pt-2.5 pb-1 flex flex-wrap items-center gap-2 border-b border-black/5 dark:border-white/10">
          {#each pendingImages as img, idx (img.url)}
            <div class="relative w-14 h-14 rounded-lg overflow-hidden border border-[var(--chat-divider-color)] bg-black/10 shrink-0">
              <img src={img.url} alt="待发送图片" class="w-full h-full object-cover" />
              <button
                type="button"
                aria-label="移除图片"
                class="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/65 text-white border-none text-[10px] leading-none flex items-center justify-center cursor-pointer"
                onclick={() => removePendingImage(idx)}
              >
                ×
              </button>
            </div>
          {/each}
          {#if isUploadingImage}
            <span class="text-xs text-[var(--chat-accent-text)]">图片上传中...</span>
          {/if}
          {#if uploadError}
            <span class="text-xs text-red-500">{uploadError}</span>
          {/if}
        </div>
      {/if}

      <!-- 全宽输入区域 -->
      <textarea
        bind:this={inputEl}
        class="chat-input-box custom-scrollbar"
        rows="2"
        placeholder={currentUser
          ? `以 ${currentUser.name} 的身份在 #${roomName} 说点什么...`
          : `在 #${roomName} 中说点什么（发送前需先登录）...`}
        bind:value={inputText}
        oninput={syncMentionTrigger}
        onclick={syncMentionTrigger}
        onkeyup={(e) => {
          if (
            e.key !== "ArrowUp" &&
            e.key !== "ArrowDown" &&
            e.key !== "Enter" &&
            e.key !== "Tab" &&
            e.key !== "Escape"
          ) {
            syncMentionTrigger();
          }
        }}
        onkeydown={handleKeydown}
        onpaste={handlePaste}
      ></textarea>

      <!-- 单行底栏：左 表情/传图 + 右 快捷提示/发送按钮 -->
      <div class="px-2.5 pb-2 pt-1 flex items-center justify-between gap-2">
        <div class="flex items-center gap-1 shrink-0">
          <!-- 颜文字 / QQ / 贴纸统一选择器按钮 -->
          <button
            type="button"
            class="chat-tool-btn {activePopover === 'emoji' ? 'text-[var(--primary)] bg-[var(--btn-plain-bg-hover)]' : ''}"
            aria-label="颜文字、QQ 表情与贴纸"
            onclick={() => {
              if (!currentUser) {
                onRequireAuth();
                return;
              }
              activePopover = activePopover === "emoji" ? "none" : "emoji";
            }}
          >
            <svg class="w-[1.15rem] h-[1.15rem]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </button>

          <!-- R2 图片上传按钮 -->
          {#if enableImageUpload}
            <input
              bind:this={fileInputEl}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
              multiple
              class="hidden"
              onchange={(e) => {
                if (e.currentTarget.files) {
                  void processImageFiles(e.currentTarget.files);
                }
              }}
            />
            <button
              type="button"
              class="chat-tool-btn"
              aria-label="上传图片"
              disabled={isUploadingImage}
              onclick={() => {
                if (!currentUser) {
                  onRequireAuth();
                  return;
                }
                fileInputEl?.click();
              }}
            >
              <svg class="w-[1.15rem] h-[1.15rem]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
          {/if}
        </div>

        <div class="flex items-center gap-2.5 shrink-0">
          <span class="hidden sm:inline text-[0.6875rem] text-[var(--chat-meta-color)] select-none">
            {#if currentUser}
              Enter 发送 · Shift+Enter 换行 · 支持 Markdown 与粘贴图片
            {:else}
              发送消息前需先登录或填写访客信息
            {/if}
          </span>
          <button
            type="button"
            class="chat-send-btn h-8! px-4! text-xs! shrink-0"
            disabled={isUploadingImage}
            onclick={handleSend}
          >
            <span>发送</span>
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</div>
