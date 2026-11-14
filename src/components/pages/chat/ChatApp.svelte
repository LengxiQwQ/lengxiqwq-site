<script lang="ts">
import { onMount } from "svelte";
import type { ChatRoomMeta, InterconnectSite } from "@/types/chatConfig";
import ChatAuthModal from "./ChatAuthModal.svelte";
import ChatInterconnectPopover from "./ChatInterconnectPopover.svelte";
import ChatProfileModal from "./ChatProfileModal.svelte";
import ChatSettingsPopover from "./ChatSettingsPopover.svelte";
import ChatUserDetailModal from "./ChatUserDetailModal.svelte";
import ChatWindow from "./ChatWindow.svelte";
import {
	buildWsUrl,
	clearGuestAuth,
	clearWalineAuth,
	normalizeServerUrl,
	openWalineLoginPopup,
	readStoredWalineToken,
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
	ChatSessionUser,
	ChatUserDetailSeed,
	ConnectionState,
	ImageAttachment,
	RoomMusicState,
} from "./chatTypes";
import MiniPlayerBar from "./MiniPlayerBar.svelte";
import MusicPanel from "./MusicPanel.svelte";
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
}: Props = $props();

const LAST_SEEN_PREFIX = "lengxi_chat_last_seen:";
const LAST_ROOM_STORAGE_KEY = "lengxi_chat_last_room";

let activeTab = $state<"room" | "chat" | "music">("chat");
let currentRoom = $state(rooms[0]?.id || "chat");
let connectionState = $state<ConnectionState>("idle");
let isWindowFocused = $state(true);
let currentUser = $state<ChatSessionUser | null>(null);
let onlineMembers = $state<ChatOnlineMember[]>([]);
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
			online: member.online || onlineKeys.has(member.userKey),
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
let isLoadingHistory = $state(false);
let sessionUnreadSince = $state(0);
let serverUnreadCount = $state(0);
let serverUnreadUserCount = $state(0);
let unreadJumpSeq = $state(0);
let pinnedUids = $state<string[]>([]);
let roomTopic = $state<string>("");
let typingUsers = $state<string[]>([]);
let musicState = $state<RoomMusicState | null>(null);
let isSkippingTrack = $state(false);
let skipPendingTimer: number | null = null;
let clockOffsetMs = $state(0);
let noticeText = $state("");
let targetMessageUid = $state("");
let showInterconnect = $state(false);
let totalChatterCount = $state(0);
let walineToken = $state("");
let playlistRefreshSeq = $state(0);
let musicPanelRef: {
	toggleListenControl?: () => void;
	openPlayerTab?: () => void;
} | null = $state(null);
let mobilePlaybackStatus = $state({
	isListening: false,
	isMuted: true,
	elapsedSec: 0,
	durationSec: 0,
	canDirectSkip: false,
	isSoloCoolingDown: false,
	soloCooldownRemainSec: 0,
	hasVotedSkip: false,
});

let lastMarkedServerReadAt = 0;
let lastReportedAudioKey = "";
const socketHandshakeAuth = new WeakMap<WebSocket, string>();

$effect(() => {
	const userKey = currentUser?.userKey || "";
	const muted = mobilePlaybackStatus.isMuted;
	if (connectionState !== "connected" || !userKey) {
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
$effect(() => {
	const userKey = currentUser?.userKey || "";
	if (connectionState !== "connected" || !userKey) {
		lastReportedFocusKey = "";
		return;
	}
	const key = `${currentRoom}:${userKey}:${isWindowFocused ? 1 : 0}`;
	if (key === lastReportedFocusKey) return;
	if (ws && ws.readyState === WebSocket.OPEN) {
		lastReportedFocusKey = key;
		ws.send(JSON.stringify({ type: "presence:focus", isFocused: isWindowFocused }));
	}
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
			roomId,
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

let showSettings = $state(false);
let showProfileModal = $state(false);
let showAuthModal = $state(false);
let showUserDetailModal = $state(false);

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
	}, 12000);
}

function handleSkipTrack() {
	if (!currentUser) {
		showAuthModal = true;
		return;
	}
	if (isSkippingTrack) return;
	if (sendPacket({ type: "music:skip" })) {
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
	if (sendPacket({ type: "music:vote_skip" }) && willPass) {
		startSkipPending();
	}
}

function showNotice(msg: string) {
	noticeText = msg;
	if (noticeTimer !== null) window.clearTimeout(noticeTimer);
	noticeTimer = window.setTimeout(() => {
		noticeText = "";
	}, 3600);
}

function sendPacket(packet: Record<string, unknown>): boolean {
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		showNotice("正在重新连接聊天室，请稍候...");
		return false;
	}
	ws.send(JSON.stringify(packet));
	return true;
}

function getFixedRoleBadge(user: ChatSessionUser): string {
	if (user.isAdmin) return "站长";
	return user.authType === "waline" ? "认证" : "访客";
}

function connectRoom(roomId: string) {
	if (isUnmounted) return;
	if (reconnectTimer !== null) {
		window.clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
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

				roomOnlineMembers = packet.members;
				mergeRoomPresence(packet.roomId, packet.members, packet.totalCount);
				void refreshGlobalPresence();
				roomMentionMembers = packet.mentionMembers ?? [];
				if (typeof packet.totalChatters === "number" && packet.totalChatters > 0) {
					totalChatterCount = packet.totalChatters;
				} else if (packet.mentionMembers && packet.mentionMembers.length > 0) {
					totalChatterCount = Math.max(totalChatterCount, packet.mentionMembers.length);
				}
				musicState = packet.music;
				pinnedUids = packet.pinnedUids ?? [];
				roomTopic = packet.topic ?? "";
				typingUsers = [];
				clearSkipPending();
				clockOffsetMs = packet.music.serverTime - Date.now();
				if (packet.mergedGuestHistory) {
					showNotice("已自动合并同邮箱的历史访客记录至当前账号");
				}
				break;
			}
			case "chat:history_batch": {
				if (packet.roomId === currentRoom) {
					isLoadingHistory = false;
					hasMoreHistory = Boolean(packet.hasMoreHistory);
					if (packet.messages.length > 0) {
						const existingIds = new Set(messages.map((m) => m.msgUid));
						const prepended = packet.messages.filter(
							(m) => !existingIds.has(m.msgUid),
						);
						if (prepended.length > 0) {
							messages = [...prepended, ...messages];
						}
					}
					if (packet.jumpTarget) {
						unreadJumpSeq += 1;
					}
				}
				break;
			}
			case "pong": {
				clockOffsetMs = packet.serverTime - Date.now();
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
										errorReports:
											remapList(musicState.current.errorReports) ?? [],
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
							historyLogs: musicState.historyLogs.map((h) =>
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
			case "playlist:updated": {
				if (packet.roomId === currentRoom) {
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
					roomOnlineMembers = packet.members;
					mergeRoomPresence(packet.roomId, packet.members, packet.totalCount);
					void refreshGlobalPresence();
					void refreshMemberDirectory();
					if (packet.mentionMembers) {
						roomMentionMembers = packet.mentionMembers;
					}
					if (typeof packet.totalChatters === "number" && packet.totalChatters > 0) {
						totalChatterCount = packet.totalChatters;
					}
				}
				break;
			}
			case "chat:message": {
				if (packet.roomId === currentRoom) {
					if (!messages.some((m) => m.msgUid === packet.message.msgUid)) {
						messages = [...messages, packet.message];
						if (
							document.hidden &&
							currentUser &&
							packet.message.kind === "user" &&
							packet.message.userKey !== currentUser.userKey &&
							(packet.message.mentionKeys &&
							packet.message.mentionKeys.length > 0
								? packet.message.mentionKeys.includes(currentUser.userKey)
								: packet.message.mentions.some(
										(n) => n.toLowerCase() === currentUser?.name.toLowerCase(),
									))
						) {
							if (!baseDocumentTitle) baseDocumentTitle = document.title;
							document.title = `[有人@你] ${baseDocumentTitle}`;
						}
					}
				}
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
					messages = messages.map((m) =>
						m.msgUid === packet.msgUid
							? { ...m, content: packet.content, isEdited: true, editedAt: packet.editedAt }
							: m,
					);
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
			case "chat:typing": {
				if (packet.roomId === currentRoom) {
					if (Array.isArray(packet.users)) {
						typingUsers = packet.users;
					} else if (packet.userName) {
						if (packet.typing) {
							if (!typingUsers.includes(packet.userName)) {
								typingUsers = [...typingUsers, packet.userName];
							}
							const targetName = packet.userName;
							setTimeout(() => {
								typingUsers = typingUsers.filter((u) => u !== targetName);
							}, 6000);
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
			case "music:state": {
				if (packet.roomId === currentRoom) {
					const prevUid = musicState?.current?.uid ?? "";
					const nextUid = packet.current?.uid ?? "";
					if (!nextUid || nextUid !== prevUid) {
						clearSkipPending();
					}
					clockOffsetMs = packet.serverTime - Date.now();
					musicState = {
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
					showNotice(packet.message);
				}
				break;
			}
		}
	});

	socket.addEventListener("close", () => {
		if (ws !== socket || isUnmounted) return;
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
	showSettings = false;
	if (roomId === currentRoom) {
		if (activeTab === "room") activeTab = "chat";
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
	isLoadingHistory = false;
	sessionUnreadSince = 0;
	serverUnreadCount = 0;
	serverUnreadUserCount = 0;
	lastMarkedServerReadAt = 0;
	roomOnlineMembers = [];
	musicState = null;
	clearSkipPending();
	reconnectAttempt = 0;
	if (ws) {
		try {
			ws.close(1000, "switch");
		} catch {
			// Ignore
		}
		ws = null;
	}
	connectRoom(roomId);
	if (activeTab === "room") {
		activeTab = "chat";
	}
}

function handleMentionUser(name: string, userKey?: string) {
	if (!currentUser) {
		openAuthModal();
		return;
	}
	mentionSeq += 1;
	mentionEvent = { name, ...(userKey ? { userKey } : {}), seq: mentionSeq };
	if (activeTab !== "chat") {
		activeTab = "chat";
	}
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
	if (activeTab !== "music") {
		activeTab = "music";
	}
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
	const packet: Record<string, unknown> = {
		type: "admin:update_member_badges",
		targetUserKey,
		customBadges: badges,
	};
	const sent = sendPacket(packet);
	if (sent) {
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
	const oldestId = messages[0]?.id ?? 0;
	if (!oldestId || isLoadingHistory) return;
	isLoadingHistory = true;
	const ok = sendPacket({
		type: "chat:load_history",
		beforeId: oldestId,
		sinceCreatedAt: sinceCreatedAt > 0 ? sinceCreatedAt : undefined,
		jumpTarget,
	});
	if (!ok) {
		isLoadingHistory = false;
	}
}

function handleMarkRead(timestamp: number) {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return;
	const userKey = currentUser?.userKey || "guest";
	persistUserLastSeen(currentRoom, userKey, timestamp);
	if (
		currentUser &&
		timestamp > lastMarkedServerReadAt &&
		ws?.readyState === WebSocket.OPEN
	) {
		lastMarkedServerReadAt = timestamp;
		ws.send(JSON.stringify({ type: "chat:mark_read", timestamp }));
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

function handleTyping(typing: boolean) {
	if (!currentUser || ws?.readyState !== WebSocket.OPEN) return;
	sendPacket({ type: "chat:typing", typing });
}

async function handleSearchOnline(keyword: string): Promise<ChatMusicTrack[]> {
	return searchOnlineMusic(normalizedChatServer, keyword);
}

function handleEnqueueTrack(track: ChatMusicTrack) {
	if (!currentUser) {
		openAuthModal();
		return;
	}
	sendPacket({
		type: "music:enqueue",
		track: {
			id: track.id,
			provider: track.provider || "local",
			sourceId: track.sourceId || track.id,
			sourcePlatform: track.sourcePlatform,
			playlistId: track.playlistId,
			position: track.position,
			title: track.title,
			artist: track.artist,
			album: track.album,
			cover: track.cover,
			url: track.url,
			lrc: track.lrc,
			durationSec: track.durationSec ?? 0,
		},
	});
}

async function refreshGlobalPresence() {
	if (!normalizedChatServer || isUnmounted) return;
	try {
		const separator = normalizedChatServer.includes("?") ? "&" : "?";
		const response = await fetch(
			`${normalizedChatServer}/api/presence${separator}_t=${Date.now()}`,
			{ cache: "no-store" },
		);
		if (!response.ok) return;
		const data = (await response.json()) as {
			members: ChatOnlineMember[];
			totalCount: number;
		};
		if (!isUnmounted && Array.isArray(data.members)) {
			hasGlobalPresence = true;
			const currentKey = currentUser?.userKey;
			onlineMembers = data.members.map((m) => {
				if (currentKey && m.userKey === currentKey) {
					return { ...m, roomId: currentRoom };
				}
				return m;
			});
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

onMount(() => {
	isUnmounted = false;
	baseDocumentTitle = document.title;
	currentAuth = resolveInitialAuth();
	walineToken = currentAuth?.kind === "waline" ? currentAuth.token : "";

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

	const presenceTimer = window.setInterval(() => {
		if (!document.hidden) {
			void refreshGlobalPresence();
		}
	}, 15000);
	const memberTimer = window.setInterval(() => {
		if (!document.hidden) {
			void refreshMemberDirectory();
		}
	}, 15000);

	// 低频自增歌单刷新序列（仅在页面前台活跃时触发，避免后台休眠时无意义刷新）
	const playlistTimer = window.setInterval(() => {
		if (!document.hidden) {
			playlistRefreshSeq += 1;
		}
	}, 30000);

	const updateFocusState = () => {
		if (document.hidden) {
			isWindowFocused = false;
			return;
		}
		isWindowFocused =
			typeof document.hasFocus === "function" ? document.hasFocus() : true;
	};

	const handleVisibility = () => {
		updateFocusState();
		if (document.visibilityState === "visible") {
			if (baseDocumentTitle && document.title !== baseDocumentTitle) {
				document.title = baseDocumentTitle;
			}
			void refreshGlobalPresence();
			void refreshMemberDirectory();
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "ping" }));
			} else if (!ws && !isUnmounted) {
				connectRoom(currentRoom);
			}
		}
	};
	document.addEventListener("visibilitychange", handleVisibility);
	window.addEventListener("focus", updateFocusState);
	window.addEventListener("blur", updateFocusState);

	return () => {
		isUnmounted = true;
		window.clearInterval(presenceTimer);
		window.clearInterval(memberTimer);
		window.clearInterval(playlistTimer);
		document.removeEventListener("visibilitychange", handleVisibility);
		window.removeEventListener("focus", updateFocusState);
		window.removeEventListener("blur", updateFocusState);
		cancelWalinePopup?.();
		if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
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
  <div class="chat-mobile-stage flex flex-1 min-h-0 gap-3 md:gap-4">
    <div class="chat-panel chat-panel-left {activeTab === 'room' ? 'mobile-active' : ''}">
      <RoomPanel
        rooms={rooms}
        currentRoom={currentRoom}
        onlineMembers={onlineMembers}
        mentionMembers={mentionMembers}
        totalOnlineCount={totalOnlineCount}
        totalChatterCount={totalChatterCount}
        currentUser={currentUser}
        selfMuted={mobilePlaybackStatus.isMuted}
        connectionState={connectionState}
        isWindowFocused={isWindowFocused}
        interconnectSites={interconnectSites}
        onRoomSelect={handleRoomSelect}
        onOpenUserProfile={handleOpenUserProfile}
        onOpenProfile={() => (showProfileModal = true)}
        onOpenAuth={() => (showAuthModal = true)}
        onLogout={handleLogout}
      />
    </div>

    <div class="chat-panel-center relative flex flex-col min-w-0 min-h-0 {activeTab === 'chat' ? 'mobile-active' : ''}">
      <div class="chat-panel flex-1 min-h-0 w-full">
        <ChatWindow
          roomId={currentRoom}
          roomName={activeMeta.name}
          roomSubtitle={activeMeta.subtitle}
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
          mentionMembers={mentionMembers}
          isChatTabActive={activeTab === "chat"}
          targetMessageUid={targetMessageUid}
          clockOffsetMs={clockOffsetMs}
          musicState={musicState}
          onSkipTrack={handleSkipTrack}
          onVoteSkip={handleVoteSkip}
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
          mentionEvent={mentionEvent}
          showSettings={showSettings}
          showInterconnect={showInterconnect}
          isInterconnectRoom={currentRoom === "interconnect"}
          interconnectSites={interconnectSites}
          totalChatterCount={totalChatterCount}
          noticeText={noticeText}
          pinnedUids={pinnedUids}
          roomTopic={roomTopic}
          typingUsers={typingUsers}
          onReaction={handleReaction}
          onEditMessage={handleEditMessage}
          onPinMessage={handlePinMessage}
          onVotePoll={handleVotePoll}
          onTyping={handleTyping}
          onToggleSettings={() => {
            showSettings = !showSettings;
            if (showSettings) showInterconnect = false;
          }}
          onToggleInterconnect={() => {
            showInterconnect = !showInterconnect;
            if (showInterconnect) showSettings = false;
          }}
          onSendMessage={handleSendMessage}
          onRecallMessage={handleRecallMessage}
          onDeleteMessage={handleDeleteMessage}
          onNotify={showNotice}
          onRequireAuth={() => (showAuthModal = true)}
          onMentionUser={handleMentionUser}
          onOpenUserProfile={handleOpenUserProfile}
        />
      </div>

      <ChatSettingsPopover
        open={showSettings}
        onClose={() => (showSettings = false)}
      />

      <ChatInterconnectPopover
        open={showInterconnect}
        sites={interconnectSites}
        onClose={() => (showInterconnect = false)}
      />
    </div>

    <div class="chat-panel chat-panel-right {activeTab === 'music' ? 'mobile-active' : ''}">
      {#key currentRoom}
      <MusicPanel
        bind:this={musicPanelRef}
        roomId={currentRoom}
        chatServerUrl={normalizedChatServer}
        playlistOutApiUrl={playlistOutApiUrl}
        walineToken={walineToken}
        playlistRefreshSeq={playlistRefreshSeq}
        externalPlaylistRequest={externalPlaylistRequest}
        fallbackTracks={musicTracks}
        musicState={musicState}
        currentUser={currentUser}
        onlineMemberCount={roomOnlineMembers.length}
        onlineMembers={roomOnlineMembers}
        mentionMembers={mentionMembers}
        clockOffsetMs={clockOffsetMs}
        initialVolume={initialMusicVolume}
        onSearchOnline={handleSearchOnline}
        onEnqueueTrack={handleEnqueueTrack}
        onNotify={showNotice}
        onOpenUserProfile={handleOpenUserProfile}
        onPlaybackStatusChange={(status) => (mobilePlaybackStatus = status)}
        onRemoveQueue={(uid) => {
          if (!currentUser) {
            showAuthModal = true;
            return;
          }
          sendPacket({ type: "music:remove", uid });
        }}
        onPlayQueued={(uid) => {
          if (!currentUser) {
            showAuthModal = true;
            return;
          }
          sendPacket({ type: "music:play_queued", uid });
        }}
        isSkippingTrack={isSkippingTrack}
        onSkipTrack={handleSkipTrack}
        onVoteSkip={handleVoteSkip}
        onReportDuration={(playUid, durationSec) =>
          sendPacket({ type: "music:report_duration", playUid, durationSec })
        }
        onTrackEnded={(playUid) => sendPacket({ type: "music:ended", playUid })}
        onReportError={(playUid) =>
          sendPacket({ type: "music:report_error", playUid })
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
      if (activeTab !== "chat") {
        activeTab = "chat";
      }
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

  <!-- 移动端跨面板全局迷你播放条（仅非点歌面板且有曲目播放时展示） -->
  {#if musicState?.current && activeTab !== "music"}
    <MiniPlayerBar
      currentPlay={musicState.current}
      isListening={mobilePlaybackStatus.isListening}
      elapsedSec={mobilePlaybackStatus.elapsedSec}
      durationSec={mobilePlaybackStatus.durationSec}
      canDirectSkip={mobilePlaybackStatus.canDirectSkip}
      isSoloCoolingDown={mobilePlaybackStatus.isSoloCoolingDown}
      soloCooldownRemainSec={mobilePlaybackStatus.soloCooldownRemainSec}
      hasVotedSkip={mobilePlaybackStatus.hasVotedSkip}
      voteCount={musicState.voteCount}
      voteThreshold={musicState.voteThreshold}
      isSkippingTrack={isSkippingTrack}
      variant="mobile"
      onOpenLyrics={() => {
        activeTab = "music";
        musicPanelRef?.openPlayerTab?.();
      }}
      onToggleListen={() => musicPanelRef?.toggleListenControl?.()}
      onSkipTrack={handleSkipTrack}
      onVoteSkip={handleVoteSkip}
    />
  {/if}

  <!-- 移动端底部 Tab 切换 -->
  <nav class="chat-mobile-tabs" aria-label="聊天室面板切换">
    <button
      type="button"
      class="chat-mobile-tab {activeTab === 'room' ? 'active' : ''}"
      onclick={() => (activeTab = 'room')}
    >
      <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      <span>房间/成员</span>
    </button>
    <button
      type="button"
      class="chat-mobile-tab {activeTab === 'chat' ? 'active' : ''}"
      onclick={() => (activeTab = 'chat')}
    >
      <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span>聊天视窗</span>
    </button>
    <button
      type="button"
      class="chat-mobile-tab {activeTab === 'music' ? 'active' : ''}"
      onclick={() => (activeTab = 'music')}
    >
      <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 18V5l12-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="16" r="3" />
      </svg>
      <span>点歌/歌词</span>
    </button>
  </nav>
</div>
