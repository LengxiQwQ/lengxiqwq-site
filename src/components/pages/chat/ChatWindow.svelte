<script lang="ts">
import { onMount, tick } from "svelte";
import { KAOMOJI_PRESETS } from "@/constants/kaomoji";
import type { InterconnectSite } from "@/types/chatConfig";
import ChatAvatar from "./ChatAvatar.svelte";
import ChatMessage from "./ChatMessage.svelte";
import ChatTooltip from "./ChatTooltip.svelte";
import { uploadChatImage, uploadChatMedia } from "./chatClient";
import type {
	ChatMentionCandidate,
	ChatMessageRecord,
	ChatOnlineMember,
	ChatSessionUser,
	ChatUserDetailSeed,
	ImageAttachment,
	RoomMusicState,
} from "./chatTypes";
import {
	formatChatReplyPreview,
	type StickerItem,
	type StickerPack,
} from "./stickerLoader";

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
	roomOnlineMembers?: ChatOnlineMember[];
	mentionMembers?: ChatMentionCandidate[];
	isChatTabActive?: boolean;
	targetMessageUid?: string;
	clockOffsetMs?: number;
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
	chatServerUrl?: string;
	mentionEvent?: { name: string; userKey?: string; seq: number };
	showSettings?: boolean;
	showInterconnect?: boolean;
	isInterconnectRoom?: boolean;
	interconnectSites?: InterconnectSite[];
	totalChatterCount?: number;
	noticeText?: string;
	pinnedUids?: string[];
	roomTopic?: string;
	typingUsers?: string[];
	onReaction?: (msgUid: string, key: string) => void;
	onEditMessage?: (msgUid: string, content: string) => void;
	onPinMessage?: (msgUid: string, unpin?: boolean) => void;
	onVotePoll?: (pollUid: string, answerId: string) => void;
	onOpenPollModal?: () => void;
	onCreatePoll?: (
		question: string,
		answers: string[],
		maxSelections: number,
	) => void;
	onTyping?: (typing: boolean) => void;
	onToggleSettings?: () => void;
	onToggleInterconnect?: () => void;
	onSendMessage: (
		content: string,
		attachments: ImageAttachment[],
		mentionKeys: string[],
		replyToUid?: string,
	) => void;
	onRecallMessage?: (msgUid: string) => void;
	onDeleteMessage: (msgUid: string) => void;
	onNotify?: (msg: string) => void;
	onRequireAuth: () => void;
	onOpenUserProfile?: (seed: ChatUserDetailSeed) => void;
	onMentionUser: (name: string, userKey?: string) => void;
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
	roomOnlineMembers = [],
	mentionMembers = [],
	isChatTabActive = true,
	targetMessageUid = "",
	clockOffsetMs = 0,
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
	chatServerUrl = "",
	mentionEvent,
	showSettings = false,
	showInterconnect = false,
	isInterconnectRoom = false,
	interconnectSites = [],
	totalChatterCount = 0,
	noticeText = "",
	pinnedUids = [],
	roomTopic = "",
	typingUsers = [],
	onReaction,
	onEditMessage,
	onPinMessage,
	onVotePoll,
	onOpenPollModal,
	onCreatePoll,
	onTyping,
	onToggleSettings,
	onToggleInterconnect,
	onSendMessage,
	onRecallMessage,
	onDeleteMessage,
	onNotify,
	onRequireAuth,
	onOpenUserProfile,
	onMentionUser,
}: Props = $props();

let inputText = $state("");
let pendingImages = $state<ImageAttachment[]>([]);
let replyingTo = $state<ChatMessageRecord | null>(null);
let editingMessage = $state<ChatMessageRecord | null>(null);
let activePinIndex = $state(0);
let typingTimer: ReturnType<typeof setTimeout> | null = null;
let isUploadingImage = $state(false);
let isUploadingMedia = $state(false);

const effectiveSubtitle = $derived(roomTopic ? roomTopic : roomSubtitle);
const pinnedMessages = $derived.by(() => {
	if (!pinnedUids || pinnedUids.length === 0) return [];
	return pinnedUids.map(uid => messages.find(m => m.msgUid === uid)).filter((m): m is ChatMessageRecord => Boolean(m));
});
const currentPinnedMsg = $derived.by(() => {
	if (pinnedMessages.length === 0) return null;
	const safeIndex = activePinIndex % pinnedMessages.length;
	return pinnedMessages[safeIndex] ?? pinnedMessages[0];
});
let uploadError = $state("");
let isDraggingFiles = $state(false);
let dragCounter = 0;

function handleDragEnter(e: DragEvent) {
	e.preventDefault();
	e.stopPropagation();
	if (e.dataTransfer?.types?.includes("Files")) {
		dragCounter++;
		isDraggingFiles = true;
	}
}

function handleDragOver(e: DragEvent) {
	e.preventDefault();
	e.stopPropagation();
	if (e.dataTransfer) {
		e.dataTransfer.dropEffect = "copy";
	}
}

function handleDragLeave(e: DragEvent) {
	e.preventDefault();
	e.stopPropagation();
	dragCounter--;
	if (dragCounter <= 0) {
		dragCounter = 0;
		isDraggingFiles = false;
	}
}

function handleDrop(e: DragEvent) {
	e.preventDefault();
	e.stopPropagation();
	isDraggingFiles = false;
	dragCounter = 0;

	if (!currentUser) {
		onRequireAuth();
		return;
	}

	const files = e.dataTransfer?.files;
	if (!files || files.length === 0) return;

	const fileList = Array.from(files);
	const imageFiles = fileList.filter((f) => f.type.startsWith("image/"));
	const otherFiles = fileList.filter((f) => !f.type.startsWith("image/"));

	if (imageFiles.length > 0) {
		void processImageFiles(imageFiles);
	}
	if (otherFiles.length > 0) {
		void processMediaFiles(otherFiles);
	}
}
let activePopover = $state<"none" | "emoji">("none");
let activeEmojiTab = $state<string>("kaomoji");
let showMusicNotices = $state(false);

let mentionMenuOpen = $state(false);
let mentionQuery = $state("");
let mentionTriggerStart = $state(-1);
let mentionActiveIndex = $state(0);
let selectedMentionMap = $state<Record<string, string[]>>({});

function addSelectedMentionKey(name: string, userKey?: string) {
	if (!name || !userKey) return;
	const existing = selectedMentionMap[name] ?? [];
	if (existing.includes(userKey)) return;
	selectedMentionMap = {
		...selectedMentionMap,
		[name]: [...existing, userKey],
	};
}

let showMentionHistory = $state(false);
let unreadMentionUids = $state<string[]>([]);
let alertBannerUid = $state<string | null>(null);
let highlightedMsgUid = $state("");

let showAllLoaded = $state(false);
let unreadBarDismissed = $state(false);
let isUnreadDividerInView = $state(false);
let highlightUnreadDivider = $state(false);
let showScrollBottomBtn = $state(false);
let newMessagesWhileScrolled = $state(0);

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
	const otherUnmutedCount = roomOnlineMembers.filter(
		(m) =>
			(!currentUser || m.userKey !== currentUser.userKey) &&
			m.isMuted === false,
	).length;
	const canSkipAloneOrMuted =
		Boolean(currentUser) &&
		roomOnlineMembers.length >= 2 &&
		otherUnmutedCount === 0;

	return {
		voterLabel,
		title: current.track.title,
		voteCount,
		voteThreshold,
		canApproveSkip:
			isAdmin || isOwnRequest || current.isFallback || canSkipAloneOrMuted,
		hasVotedSkip,
	};
});

const VISIBLE_FOLD_LIMIT = 40;
const RECALL_WINDOW_MS = 5 * 60_000;
const SHOW_MUSIC_NOTICES_KEY = "lengxi_chat_show_music_notices";
const LAST_SEEN_PREFIX = "lengxi_chat_last_seen:";

let nowMs = $state(Date.now());

let messageContainer: HTMLDivElement | null = $state(null);
let messageContentEl: HTMLDivElement | null = $state(null);
let inputEl: HTMLTextAreaElement | null = $state(null);
let fileInputEl: HTMLInputElement | null = $state(null);
let mediaFileInputEl: HTMLInputElement | null = $state(null);
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
let lastScrollHeight = 0;
let lastClientHeight = 0;

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
	if (Array.isArray(msg.mentionKeys) && msg.mentionKeys.length > 0) {
		return msg.mentionKeys.includes(currentUser.userKey);
	}
	const myName = currentUser.name.trim().toLowerCase();
	return Boolean(
		myName && msg.mentions.some((m) => m.trim().toLowerCase() === myName),
	);
}

const mentionsToMe = $derived(messages.filter(isMentionedToMe));

function formatOfflineTime(ts?: number): string {
	if (!ts || !Number.isFinite(ts) || ts <= 0) return "离线";
	const diff = Date.now() - ts;
	if (diff < 60_000) return "刚刚离线";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前离线`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前离线`;
	const d = new Date(ts);
	const now = new Date();
	if (d.getFullYear() === now.getFullYear()) {
		return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 离线`;
	}
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 离线`;
}

const mergedMentionCandidates = $derived.by<ChatMentionCandidate[]>(() => {
	const map = new Map<string, ChatMentionCandidate>();
	for (const m of mentionMembers) {
		if (!m.userKey || m.userKey === currentUser?.userKey) continue;
		// 站外跨 Matrix 成员暂不支持提及，排除出 @ 自动补全
		if (
			m.userKey.startsWith("matrix:") ||
			(m.userKey.startsWith("@") && m.userKey.includes(":")) ||
			m.badge === "互联茶友" ||
			m.badge === "Detached" ||
			m.badge === "听雨" ||
			m.badge === "GBK"
		) {
			continue;
		}
		map.set(m.userKey, m);
	}
	for (const m of onlineMembers) {
		if (!m.userKey || m.userKey === currentUser?.userKey) continue;
		if (
			m.userKey.startsWith("matrix:") ||
			(m.userKey.startsWith("@") && m.userKey.includes(":")) ||
			m.badge === "互联茶友" ||
			m.badge === "Detached" ||
			m.badge === "听雨" ||
			m.badge === "GBK"
		) {
			continue;
		}
		const prev = map.get(m.userKey);
		map.set(m.userKey, {
			userKey: m.userKey,
			authType: m.authType,
			name: m.name,
			avatar: m.avatar,
			badge: m.badge,
			badgeType: m.badgeType,
			isAdmin: m.isAdmin,
			online: true,
			lastSeenAt: prev?.lastSeenAt ?? Date.now(),
		});
	}
	return Array.from(map.values()).sort((a, b) => {
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

const filteredMentionCandidates = $derived.by<ChatMentionCandidate[]>(() => {
	const q = mentionQuery.trim().toLowerCase();
	if (!q) return mergedMentionCandidates;
	return mergedMentionCandidates.filter((c) =>
		c.name.toLowerCase().includes(q),
	);
});

const unreadMentionSet = $derived(new Set(unreadMentionUids));

const userNameMap = $derived.by<Map<string, string>>(() => {
	const map = new Map<string, string>();
	if (currentUser?.userKey && currentUser?.name) {
		map.set(currentUser.userKey, currentUser.name);
	}
	for (const m of messages) {
		if (m.userKey && m.name) {
			map.set(m.userKey, m.name);
		}
	}
	for (const m of mentionMembers) {
		if (m.userKey && m.name) {
			map.set(m.userKey, m.name);
		}
	}
	for (const m of onlineMembers) {
		if (m.userKey && m.name) {
			map.set(m.userKey, m.name);
		}
	}
	for (const m of roomOnlineMembers) {
		if (m.userKey && m.name) {
			map.set(m.userKey, m.name);
		}
	}
	return map;
});

const displayTypingUsers = $derived.by<string[]>(() => {
	const myName = currentUser?.name?.trim();
	return (typingUsers || []).filter((name) => name && name.trim() !== myName);
});

const activeAlertMessage = $derived.by<ChatMessageRecord | null>(() => {
	const targetUid =
		alertBannerUid ??
		(unreadMentionUids.length > 0
			? unreadMentionUids[unreadMentionUids.length - 1]
			: null);
	if (!targetUid) return null;
	return messages.find((m) => m.msgUid === targetUid) ?? null;
});

function getScrollGap(): number {
	if (!messageContainer) return 0;
	return Math.max(
		0,
		messageContainer.scrollHeight -
			messageContainer.scrollTop -
			messageContainer.clientHeight,
	);
}

function snapScrollToBottom() {
	if (!messageContainer) return;
	messageContainer.scrollTop = messageContainer.scrollHeight;
	lastScrollHeight = messageContainer.scrollHeight;
	lastClientHeight = messageContainer.clientHeight;
	isStickyAtBottom = true;
	showScrollBottomBtn = false;
	newMessagesWhileScrolled = 0;
}

function handleMessageScroll() {
	if (!messageContainer) return;
	const sh = messageContainer.scrollHeight;
	const ch = messageContainer.clientHeight;
	const layoutChanged =
		(lastScrollHeight > 0 && sh !== lastScrollHeight) ||
		(lastClientHeight > 0 && ch !== lastClientHeight);
	lastScrollHeight = sh;
	lastClientHeight = ch;

	// 如果原本处于贴底状态，且本次 scroll 事件伴随容器/内容高度变化（例如平板 100dvh 稳定、软键盘弹起、图片撑开），
	// 立即重新贴底，防止被浏览器当成用户手动上滑而脱离贴底锁定
	if (
		isStickyAtBottom &&
		layoutChanged &&
		!targetMessageUid &&
		!highlightedMsgUid &&
		!highlightUnreadDivider
	) {
		snapScrollToBottom();
		return;
	}

	const gap = getScrollGap();
	isStickyAtBottom = gap < 120;
	showScrollBottomBtn = gap > 180;
	if (isStickyAtBottom) {
		newMessagesWhileScrolled = 0;
	}
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

async function scrollToBottom(smooth = false) {
	await tick();
	if (!messageContainer) return;
	if (smooth) {
		messageContainer.scrollTo({
			top: messageContainer.scrollHeight,
			behavior: "smooth",
		});
		lastScrollHeight = messageContainer.scrollHeight;
		lastClientHeight = messageContainer.clientHeight;
		isStickyAtBottom = true;
		showScrollBottomBtn = false;
		newMessagesWhileScrolled = 0;
		return;
	}
	snapScrollToBottom();
	// 在平板及移动端上，视口高度（100dvh）与文本/弹性盒排版常在下一帧才完全收敛，
	// 补一次 rAF 贴底确保初始进入和发图后精确停靠在最底部
	requestAnimationFrame(() => {
		if (
			isStickyAtBottom &&
			!targetMessageUid &&
			!highlightedMsgUid &&
			!highlightUnreadDivider
		) {
			snapScrollToBottom();
		}
	});
}

async function jumpToMessage(msgUid: string) {
	showMentionHistory = false;
	isStickyAtBottom = false;
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
	}, 3800);
}

async function scrollToUnreadDivider() {
	isStickyAtBottom = false;
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
	isStickyAtBottom = false;
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
	isStickyAtBottom = false;
	const prevHeight = messageContainer?.scrollHeight ?? 0;
	const prevTop = messageContainer?.scrollTop ?? 0;
	if (isLocalFolded) {
		showAllLoaded = true;
		await tick();
		if (messageContainer) {
			messageContainer.scrollTop =
				prevTop + (messageContainer.scrollHeight - prevHeight);
			lastScrollHeight = messageContainer.scrollHeight;
			lastClientHeight = messageContainer.clientHeight;
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
		if (saved === "1" || saved === "true") {
			showMusicNotices = true;
		} else if (saved === "0" || saved === "false") {
			showMusicNotices = false;
		}
	} catch {
		// 忽略存储读取异常
	}

	void scrollToBottom();

	let rafSyncId: number | null = null;
	const scheduleSnapIfSticky = () => {
		if (
			!isStickyAtBottom ||
			targetMessageUid ||
			highlightedMsgUid ||
			highlightUnreadDivider
		) {
			return;
		}
		snapScrollToBottom();
		if (rafSyncId !== null) window.cancelAnimationFrame(rafSyncId);
		rafSyncId = window.requestAnimationFrame(() => {
			rafSyncId = null;
			if (
				isStickyAtBottom &&
				!targetMessageUid &&
				!highlightedMsgUid &&
				!highlightUnreadDivider
			) {
				snapScrollToBottom();
			}
		});
	};

	const resizeObserver =
		typeof ResizeObserver !== "undefined"
			? new ResizeObserver(() => {
					scheduleSnapIfSticky();
				})
			: null;
	if (messageContainer) {
		resizeObserver?.observe(messageContainer);
	}
	if (messageContentEl) {
		resizeObserver?.observe(messageContentEl);
	}

	const handleMediaLoad = (e: Event) => {
		const target = e.target as HTMLElement | null;
		if (target && (target.tagName === "IMG" || target.tagName === "VIDEO")) {
			scheduleSnapIfSticky();
		}
	};
	messageContainer?.addEventListener("load", handleMediaLoad, true);

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

	const preventWindowDrag = (e: DragEvent) => {
		if (e.dataTransfer?.types?.includes("Files")) {
			e.preventDefault();
		}
	};

	window.addEventListener("dragover", preventWindowDrag);
	window.addEventListener("drop", preventWindowDrag);
	document.addEventListener("pointerdown", handlePointerDown);
	document.addEventListener("keydown", handleDocKeydown);
	return () => {
		window.removeEventListener("dragover", preventWindowDrag);
		window.removeEventListener("drop", preventWindowDrag);
		resizeObserver?.disconnect();
		messageContainer?.removeEventListener("load", handleMediaLoad, true);
		if (rafSyncId !== null) window.cancelAnimationFrame(rafSyncId);
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
		replyingTo = null;
		showAllLoaded = false;
		unreadBarDismissed = false;
		isUnreadDividerInView = false;
		highlightUnreadDivider = false;
		showScrollBottomBtn = false;
		newMessagesWhileScrolled = 0;
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
			const addedCount = Math.max(0, visLen - lastRenderedVisibleLen);
			lastRenderedVisibleLen = visLen;
			if (isStickyAtBottom && !targetMessageUid) {
				void scrollToBottom();
			} else if (!isStickyAtBottom && addedCount > 0) {
				newMessagesWhileScrolled += addedCount;
				showScrollBottomBtn = getScrollGap() > 180;
			}
		}
	}

	if (replyingTo && !msgs.some((m) => m.msgUid === replyingTo?.msgUid)) {
		replyingTo = null;
	}
});

$effect(() => {
	const userKey = currentUser?.userKey || "";
	const isAdmin = Boolean(currentUser?.isAdmin);
	const offset = clockOffsetMs;
	const serverNow = nowMs + offset;
	if (!userKey || isAdmin) return;

	let earliestExpireLocal = Number.POSITIVE_INFINITY;
	for (const m of renderedMessages) {
		if (m.kind !== "user" || m.userKey !== userKey) continue;
		const expireServer = m.createdAt + RECALL_WINDOW_MS;
		if (expireServer > serverNow) {
			const expireLocal = expireServer - offset;
			if (expireLocal < earliestExpireLocal) {
				earliestExpireLocal = expireLocal;
			}
		}
	}

	if (!Number.isFinite(earliestExpireLocal)) return;
	const waitMs = Math.min(
		60_000,
		Math.max(50, earliestExpireLocal - Date.now() + 30),
	);
	const timer = window.setTimeout(() => {
		nowMs = Date.now();
	}, waitMs);
	return () => window.clearTimeout(timer);
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

function syncInputHeight() {
	if (!inputEl) return;
	if (
		typeof CSS !== "undefined" &&
		typeof CSS.supports === "function" &&
		CSS.supports("field-sizing", "content")
	) {
		if (inputEl.style.height) {
			inputEl.style.height = "";
		}
		return;
	}
	inputEl.style.height = "auto";
	inputEl.style.height = `${inputEl.scrollHeight}px`;
}

$effect(() => {
	const _text = inputText;
	const _el = inputEl;
	if (!_el) return;
	void tick().then(() => {
		syncInputHeight();
	});
});

$effect(() => {
	const container = messageContainer;
	if (!container || typeof ResizeObserver === "undefined") return;
	const observer = new ResizeObserver(() => {
		if (isStickyAtBottom && !targetMessageUid) {
			container.scrollTop = container.scrollHeight;
		}
	});
	observer.observe(container);
	return () => observer.disconnect();
});

$effect(() => {
	if (mentionEvent && mentionEvent.seq !== lastMentionSeq) {
		lastMentionSeq = mentionEvent.seq;
		if (mentionEvent.userKey) {
			addSelectedMentionKey(mentionEvent.name, mentionEvent.userKey);
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
	addSelectedMentionKey(candidate.name, candidate.userKey);
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
	for (const [name, keyList] of Object.entries(selectedMentionMap)) {
		if (lower.includes(`@${name.toLowerCase()}`)) {
			for (const key of keyList) {
				keys.add(key);
			}
		}
	}
	return Array.from(keys);
}

function handleStartReply(msg: ChatMessageRecord) {
	if (!currentUser) {
		onRequireAuth();
		return;
	}
	replyingTo = msg;
	void tick().then(() => {
		inputEl?.focus();
	});
}

function handleJumpToReply(msgUid: string) {
	if (messages.some((m) => m.msgUid === msgUid)) {
		void jumpToMessage(msgUid);
		return;
	}
	onNotify?.("原消息较早或已撤回");
}

let lastTypingSentAt = 0;
function triggerTyping() {
	if (onTyping) {
		const now = Date.now();
		if (now - lastTypingSentAt > 2500) {
			lastTypingSentAt = now;
			onTyping(true);
		}
		if (typingTimer) clearTimeout(typingTimer);
		typingTimer = setTimeout(() => {
			onTyping?.(false);
			lastTypingSentAt = 0;
		}, 4500);
	}
}

function handleSend() {
	const trimmed = inputText.trim();
	if (!trimmed && pendingImages.length === 0) return;
	if (!currentUser) {
		onRequireAuth();
		return;
	}

	if (typingTimer) clearTimeout(typingTimer);
	onTyping?.(false);
	lastTypingSentAt = 0;

	if (editingMessage) {
		onEditMessage?.(editingMessage.msgUid, trimmed);
		editingMessage = null;
		inputText = "";
		pendingImages = [];
		replyingTo = null;
		return;
	}

	const mentionKeys = collectMentionKeys(trimmed);
	const replyToUid = replyingTo?.msgUid || "";
	onSendMessage(trimmed, pendingImages, mentionKeys, replyToUid || undefined);
	inputText = "";
	pendingImages = [];
	replyingTo = null;
	selectedMentionMap = {};
	uploadError = "";
	mentionMenuOpen = false;
	activePopover = "none";
	void scrollToBottom();
}

function handleKeydown(e: KeyboardEvent) {
	if (mentionMenuOpen && filteredMentionCandidates.length > 0) {
		const count = filteredMentionCandidates.length;
		// 弹窗用 column-reverse 渲染：数组第 0 项在最下面（贴输入框），所以“向上”= 索引 +1
		if (e.key === "ArrowUp") {
			e.preventDefault();
			mentionActiveIndex = (mentionActiveIndex + 1) % count;
			return;
		}
		if (e.key === "ArrowDown") {
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

	if (e.key === "Escape") {
		if (editingMessage) {
			e.preventDefault();
			editingMessage = null;
			inputText = "";
			return;
		}
		if (replyingTo) {
			e.preventDefault();
			replyingTo = null;
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

async function processMediaFiles(files: FileList | File[]) {
	if (!currentUser) {
		onRequireAuth();
		return;
	}
	const list = Array.from(files);
	if (list.length === 0) return;

	const remaining = Math.max(0, 3 - pendingImages.length);
	if (remaining === 0) {
		uploadError = "单条消息最多附带 3 个附件";
		return;
	}

	uploadError = "";
	isUploadingMedia = true;
	try {
		for (const file of list.slice(0, remaining)) {
			const res = await uploadChatMedia(
				file,
				chatServerUrl || "https://chat-server.lengxiqwq.com",
			);
			pendingImages = [
				...pendingImages,
				{
					type: res.type,
					url: res.url,
					name: res.name,
					size: res.size,
				},
			];
		}
	} catch (err) {
		uploadError = err instanceof Error ? err.message : "附件上传失败";
	} finally {
		isUploadingMedia = false;
		if (mediaFileInputEl) {
			mediaFileInputEl.value = "";
		}
	}
}

function handlePaste(e: ClipboardEvent) {
	const items = e.clipboardData?.files;
	if (!items || items.length === 0) return;
	const files = Array.from(items);
	const imageFiles = files.filter((f) => f.type.startsWith("image/"));
	const otherFiles = files.filter((f) => !f.type.startsWith("image/"));
	if (imageFiles.length > 0) {
		e.preventDefault();
		void processImageFiles(imageFiles);
	}
	if (otherFiles.length > 0) {
		e.preventDefault();
		void processMediaFiles(otherFiles);
	}
}

function removePendingImage(index: number) {
	pendingImages = pendingImages.filter((_, i) => i !== index);
}
</script>

<div
  class="flex flex-col h-full w-full min-h-0 relative"
  ondragenter={handleDragEnter}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  ondrop={handleDrop}
>
  <!-- 视窗全屏拖拽放置提示层 -->
  {#if isDraggingFiles}
    <div class="chat-drag-overlay" role="presentation">
      <div class="chat-drag-box">
        <div class="w-12 h-12 rounded-2xl bg-[var(--skin-accent)]/15 text-[var(--skin-accent)] flex items-center justify-center mb-2 animate-bounce">
          <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <span class="text-sm font-bold text-[var(--deep-text)]">拖拽文件到此处添加为附件</span>
        <span class="text-xs text-[var(--chat-meta-color)] mt-1">支持照片、音视频、文档或压缩包</span>
      </div>
    </div>
  {/if}
  <!-- 顶栏 -->
  <div class="chat-panel-header">
    <div class="flex items-center gap-2 min-w-0">
      <span class="font-bold text-sm text-[var(--deep-text)] dark:text-white/90 shrink-0">
        # {roomName}
      </span>
      <span class="text-xs text-[var(--chat-meta-color)] truncate hidden sm:inline">
        · {effectiveSubtitle}
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
                    <ChatAvatar
                      src={item.avatar}
                      name={item.name}
                      size="xs"
                      class="mt-0.5"
                    />
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
      <ChatTooltip text={isInterconnectRoom && totalChatterCount && totalChatterCount > 0 ? `${onlineCount} 人在线 · 累计 ${totalChatterCount} 人聊过天` : `${onlineCount} 人在线`}>
        <div
          class="text-xs text-[var(--deep-text)] dark:text-white/85 px-2.5 py-1 rounded-full bg-[var(--card-bg)]/60 border border-[var(--chat-divider-color)] flex items-center gap-1.5"
        >
          <span class="chat-online-dot"></span>
          <span>{isInterconnectRoom && totalChatterCount && totalChatterCount > 0 ? `${onlineCount}/${totalChatterCount}` : `${onlineCount} 人在线`}</span>
        </div>
      </ChatTooltip>
      {#if isInterconnectRoom}
        <button
          type="button"
          data-chat-interconnect-trigger
          class="chat-header-pill-btn {showInterconnect ? 'active text-[var(--primary)]' : ''} flex items-center gap-1"
          aria-label="查看互联茶室友站列表"
          aria-expanded={showInterconnect}
          onclick={() => onToggleInterconnect?.()}
        >
          <span class="text-xs">🍵</span>
          <span class="hidden sm:inline">互联茶室</span>
          <svg class="w-3 h-3 opacity-70 transition-transform {showInterconnect ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      {/if}
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

  <!-- 置顶消息横幅 (Pinned Messages) -->
  {#if currentPinnedMsg}
    <div class="chat-pinned-banner">
      <button
        type="button"
        class="flex items-center gap-2 truncate flex-1 chat-pinned-btn text-left bg-transparent border-none p-0 text-[var(--skin-text)] cursor-pointer"
        onclick={() => void jumpToMessage(currentPinnedMsg.msgUid)}
      >
        <span class="text-xs">📌</span>
        <span class="font-semibold text-xs shrink-0">{currentPinnedMsg.name}:</span>
        <span class="truncate text-xs text-[var(--chat-meta-color)]">
          {currentPinnedMsg.content || (currentPinnedMsg.attachments?.length > 0 ? "[多媒体附件]" : "消息")}
        </span>
      </button>
      <div class="flex items-center gap-1.5 shrink-0 ml-2">
        {#if pinnedMessages.length > 1}
          <span class="text-[0.625rem] text-[var(--chat-meta-color)] tabular-nums">
            {activePinIndex + 1}/{pinnedMessages.length}
          </span>
          <ChatTooltip text="查看下一条置顶">
            <button
              type="button"
              class="p-1 text-[var(--chat-meta-color)] hover:text-[var(--skin-accent)] hover:bg-black/5 dark:hover:bg-white/5 rounded transition-colors border-none bg-transparent cursor-pointer flex items-center justify-center"
              aria-label="查看下一条置顶"
              onclick={() => (activePinIndex = (activePinIndex + 1) % pinnedMessages.length)}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </ChatTooltip>
        {/if}
        {#if currentUser?.isAdmin}
          <ChatTooltip text="取消置顶">
            <button
              type="button"
              class="p-1 text-[var(--chat-meta-color)] hover:text-red-400 text-xs border-none bg-transparent cursor-pointer"
              aria-label="取消置顶"
              onclick={() => onPinMessage?.(currentPinnedMsg.msgUid, true)}
            >
              ✕
            </button>
          </ChatTooltip>
        {/if}
      </div>
    </div>
  {/if}

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
      class="flex-1 overflow-y-auto custom-scrollbar px-4 md:px-5 py-4 min-h-0"
    >
      <div bind:this={messageContentEl} class="min-h-full flex flex-col gap-3">
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
          <div class="flex-1 flex flex-col items-center justify-center text-center py-8 text-xs text-[var(--chat-meta-color)]">
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
            {@const isSelf = Boolean(
              currentUser && (
                msg.userKey === currentUser.userKey ||
                (currentUser.isAdmin && (
                  msg.isAdmin ||
                  msg.userKey === "waline:1" ||
                  msg.userKey === "@lengxiqwq:matrix.lengxiqwq.com" ||
                  msg.userKey === "matrix:@lengxiqwq:matrix.lengxiqwq.com"
                ))
              )
            )}
            {@const isAdmin = Boolean(currentUser?.isAdmin)}
            {@const serverNow = nowMs + clockOffsetMs}
            {@const canRecall = Boolean(
              currentUser &&
                msg.kind === "user" &&
                (isAdmin ||
                  (isSelf && serverNow - msg.createdAt <= RECALL_WINDOW_MS)),
            )}
            {@const canEdit = Boolean(
              currentUser &&
                msg.kind === "user" &&
                (isAdmin ||
                  (isSelf && serverNow - msg.createdAt <= 15 * 60 * 1000)),
            )}
            {@const canDelete = Boolean(
              currentUser && msg.kind === "user" && isAdmin && roomId !== "interconnect",
            )}
            <ChatMessage
              message={msg}
              isSelf={isSelf}
              isMentionedMe={isMentionedToMe(msg)}
              isHighlighted={highlightedMsgUid === msg.msgUid}
              currentUserName={currentUser?.name || ""}
              currentUserKey={currentUser?.userKey}
              isAdmin={isAdmin}
              isPinned={pinnedUids.includes(msg.msgUid)}
              canRecall={canRecall}
              canEdit={canEdit}
              canDelete={canDelete}
              stickerMap={stickerMap}
              interconnectSites={interconnectSites}
              userNameMap={userNameMap}
              onRecall={onRecallMessage}
              onDelete={onDeleteMessage}
              onReply={msg.kind === "user" ? handleStartReply : undefined}
              onEdit={(m) => {
                editingMessage = m;
                inputText = m.content;
                inputEl?.focus();
              }}
              onPin={onPinMessage}
              onReaction={onReaction}
              onVotePoll={onVotePoll}
              onJumpToMessage={handleJumpToReply}
              onOpenUserProfile={onOpenUserProfile}
              onMention={onMentionUser}
            />
          {/each}
        {/if}
      </div>
    </div>

    {#if showScrollBottomBtn}
      <div class="chat-scroll-bottom-wrap">
        <button
          type="button"
          class="chat-scroll-bottom-btn"
          aria-label="滚动到底部最新消息"
          onclick={() => {
            void scrollToBottom(true);
            if (currentUser && messages.length > 0) {
              writeLastSeenAt(
                roomId,
                currentUser.userKey,
                messages[messages.length - 1].createdAt,
              );
              onMarkRead?.(messages[messages.length - 1].createdAt);
            }
          }}
        >
          <svg class="w-3.5 h-3.5 text-[var(--primary)] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
          <span>
            {newMessagesWhileScrolled > 0
              ? `回到底部 (${newMessagesWhileScrolled} 条新消息)`
              : "回到底部"}
          </span>
        </button>
      </div>
    {/if}
  </div>

  <!-- 统一底部输入停靠区 -->
  <div bind:this={dockEl} class="chat-input-dock">
    <!-- 统一表情面板（纯图标 Tab）：1. 颜文字 -> 2. QQ -> 3. 贴纸 -->
    {#if activePopover === "emoji"}
      <div class="chat-emoji-popover chat-sticker-popover" role="dialog" aria-label="颜文字与表情贴纸">
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
              {@const isStickerPack = currentPack.category === "sticker"}
              {@const isQQPack = currentPack.category === "qq"}
              <div class={isStickerPack ? "grid grid-cols-4 sm:grid-cols-6 gap-2" : "grid grid-cols-8 sm:grid-cols-11 gap-1"}>
                {#each currentPack.items as item (item.code)}
                  <button
                    type="button"
                    class="chat-sticker-btn {isStickerPack ? 'chat-sticker-btn--sticker' : 'chat-sticker-btn--emoji'}"
                    aria-label={item.name}
                    onclick={() => {
                      insertAtCursor(item.code);
                      activePopover = "none";
                    }}
                  >
                    <img
                      src={item.url}
                      alt={item.name}
                      loading="lazy"
                      class={isStickerPack
                        ? "w-14 h-14 sm:w-16 sm:h-16 max-w-full object-contain"
                        : isQQPack
                          ? "w-6 h-6 object-contain"
                          : "w-[26px] h-[26px] object-contain"}
                    />
                  </button>
                {/each}
              </div>
            {/if}
          {/if}
        </div>

        <div class="chat-picker-tabs" role="tablist" aria-label="表情分类">
          <button
            type="button"
            role="tab"
            aria-selected={activeEmojiTab === "kaomoji"}
            class="chat-picker-tab {activeEmojiTab === 'kaomoji' ? 'active' : ''}"
            aria-label="颜文字"
            onclick={() => (activeEmojiTab = "kaomoji")}
          >
            <span class="font-bold text-xs leading-none">OωO</span>
          </button>

          {#each orderedStickerPacks as pack (pack.id)}
            <button
              type="button"
              role="tab"
              aria-selected={activeEmojiTab === pack.id}
              class="chat-picker-tab {activeEmojiTab === pack.id ? 'active' : ''}"
              aria-label={pack.displayName}
              onclick={() => (activeEmojiTab = pack.id)}
            >
              <img src={pack.iconUrl} alt={pack.displayName} class="w-5 h-5 object-contain" />
            </button>
          {/each}
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
            {@const personBadgeLabel = person.isAdmin
              ? "站长"
              : person.authType === "waline"
                ? "认证"
                : "访客"}
            {@const personBadgeType = person.isAdmin
              ? "host"
              : person.authType === "waline"
                ? "accent"
                : "tag"}
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
                  <ChatAvatar
                    src={person.avatar}
                    name={person.name}
                    size="xs"
                    grayscale={!person.online}
                    mutedTone={!person.online}
                  />
                  {#if person.online}
                    <span
                      class="chat-ac-status-dot online"
                      aria-hidden="true"
                    ></span>
                  {/if}
                </div>
                <span class="text-xs font-medium truncate text-[var(--deep-text)] dark:text-white/90">
                  {person.name}
                </span>
                <span class="chat-role-badge chat-role-badge--{personBadgeType} scale-90 origin-left">
                  {personBadgeLabel}
                </span>
                {#if person.customBadges && person.customBadges.length > 0}
                  {#each person.customBadges as b (b.text)}
                    <span class="chat-role-badge chat-role-badge--{b.color} scale-90 origin-left">
                      {b.text}
                    </span>
                  {/each}
                {/if}
              </div>
              <span class="text-[10px] shrink-0 {person.online ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-[var(--chat-meta-color)] opacity-75'}">
                {person.online ? "在线" : formatOfflineTime(person.lastSeenAt)}
              </span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- 正在输入浮动提示条（独立绝对定位，杜绝输入框跳动） -->
    {#if displayTypingUsers.length > 0}
      <div class="chat-typing-dock-indicator">
        <span class="chat-typing-dots">
          <span class="chat-typing-dot"></span>
          <span class="chat-typing-dot"></span>
          <span class="chat-typing-dot"></span>
        </span>
        <span>{displayTypingUsers.join("、")} 正在输入...</span>
      </div>
    {/if}

    <!-- 统一一体化毛玻璃输入卡片 -->
    <div class="chat-composer">
      <!-- 正在编辑提示条 -->
      {#if editingMessage}
        <div class="chat-reply-bar">
          <div class="chat-reply-bar-main">
            <span class="chat-reply-bar-label font-bold text-[var(--skin-accent)]">编辑消息</span>
            <span class="chat-reply-bar-text">
              {editingMessage.content}
            </span>
          </div>
          <button
            type="button"
            class="chat-reply-bar-close"
            aria-label="取消编辑"
            onclick={() => {
              editingMessage = null;
              inputText = "";
            }}
          >
            ×
          </button>
        </div>
      {/if}

      <!-- 正在回复提示条 -->
      {#if replyingTo}
        <div class="chat-reply-bar">
          <div class="chat-reply-bar-main">
            <span class="chat-reply-bar-label">回复 {replyingTo.name || "用户"}</span>
            <span class="chat-reply-bar-text">
              {formatChatReplyPreview(
                replyingTo.content,
                stickerMap,
                replyingTo.attachments.length > 0,
              )}
            </span>
          </div>
          <button
            type="button"
            class="chat-reply-bar-close"
            aria-label="取消回复"
            onclick={() => (replyingTo = null)}
          >
            ×
          </button>
        </div>
      {/if}


      <!-- 待发送附件预览条 -->
      {#if pendingImages.length > 0 || isUploadingImage || isUploadingMedia || uploadError}
        <div class="px-3 pt-2.5 pb-1 flex flex-wrap items-center gap-2 border-b border-black/5 dark:border-white/10">
          {#each pendingImages as att, idx (att.url)}
            {#if att.type === "image"}
              <div class="relative w-14 h-14 rounded-lg overflow-hidden border border-[var(--chat-divider-color)] bg-black/10 shrink-0">
                <img src={att.url} alt="待发送图片" class="w-full h-full object-cover" />
                <button
                  type="button"
                  aria-label="移除图片"
                  class="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/65 text-white border-none text-[10px] leading-none flex items-center justify-center cursor-pointer"
                  onclick={() => removePendingImage(idx)}
                >
                  ×
                </button>
              </div>
            {:else}
              <div class="relative flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--skin-line)] bg-[var(--btn-regular-bg)] max-w-[14rem] shrink-0">
                <span class="text-base shrink-0">
                  {att.type === "audio" ? "🎵" : att.type === "video" ? "🎬" : "📎"}
                </span>
                <div class="min-w-0 flex-1">
                  <div class="text-xs font-medium truncate text-[var(--skin-text)]">{att.name || "附件"}</div>
                  {#if att.size}
                    <div class="text-[10px] text-[var(--chat-meta-color)]">
                      {att.size > 1024 * 1024 ? `${(att.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(att.size / 1024)} KB`}
                    </div>
                  {/if}
                </div>
                <button
                  type="button"
                  aria-label="移除附件"
                  class="w-4 h-4 rounded-full bg-black/40 hover:bg-black/70 text-white border-none text-[10px] leading-none flex items-center justify-center cursor-pointer ml-1"
                  onclick={() => removePendingImage(idx)}
                >
                  ×
                </button>
              </div>
            {/if}
          {/each}
          {#if isUploadingImage || isUploadingMedia}
            <span class="text-xs text-[var(--chat-accent-text)] animate-pulse">附件上传中...</span>
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
        oninput={() => {
          syncMentionTrigger();
          triggerTyping();
        }}
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
          <ChatTooltip text="表情与贴纸">
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
          </ChatTooltip>

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
            <ChatTooltip text="上传图片">
              <button
                type="button"
                class="chat-tool-btn"
                aria-label="上传图片"
                disabled={isUploadingImage || isUploadingMedia}
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
            </ChatTooltip>
          {/if}

          <!-- 多媒体与文件附件上传按钮 -->
          <input
            bind:this={mediaFileInputEl}
            type="file"
            accept="audio/*,video/*,.pdf,.zip,.tar,.gz,.7z,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md"
            multiple
            class="hidden"
            onchange={(e) => {
              if (e.currentTarget.files) {
                void processMediaFiles(e.currentTarget.files);
              }
            }}
          />
          <ChatTooltip text="发送文件或音视频">
            <button
              type="button"
              class="chat-tool-btn"
              aria-label="发送文件或音视频"
              disabled={isUploadingImage || isUploadingMedia}
              onclick={() => {
                if (!currentUser) {
                  onRequireAuth();
                  return;
                }
                mediaFileInputEl?.click();
              }}
            >
              <svg class="w-[1.15rem] h-[1.15rem]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
          </ChatTooltip>

          <!-- 发起投票按钮 -->
          <ChatTooltip text="发起投票">
            <button
              type="button"
              class="chat-tool-btn"
              aria-label="发起投票"
              onclick={() => {
                if (!currentUser) {
                  onRequireAuth();
                  return;
                }
                onOpenPollModal?.();
              }}
            >
              <svg class="w-[1.15rem] h-[1.15rem]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 3v18h18" />
                <rect x="7" y="10" width="3" height="8" rx="1" />
                <rect x="13" y="5" width="3" height="13" rx="1" />
                <rect x="19" y="13" width="3" height="5" rx="1" />
              </svg>
            </button>
          </ChatTooltip>
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
            disabled={isUploadingImage || isUploadingMedia}
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
