<script lang="ts">
import { onMount } from "svelte";
import type { ChatRoomMeta } from "@/types/chatConfig";
import ChatAuthModal from "./ChatAuthModal.svelte";
import ChatProfileModal from "./ChatProfileModal.svelte";
import ChatSettingsPopover from "./ChatSettingsPopover.svelte";
import ChatWindow from "./ChatWindow.svelte";
import {
	buildWsUrl,
	clearGuestAuth,
	clearWalineAuth,
	normalizeServerUrl,
	resolveInitialAuth,
	type ServerPacket,
	searchOnlineMusic,
} from "./chatClient";
import type {
	ChatMentionCandidate,
	ChatMessageRecord,
	ChatOnlineMember,
	ChatProfileDraft,
	ChatSessionUser,
	ConnectionState,
	ImageAttachment,
	RoomMusicState,
} from "./chatTypes";
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
	rooms?: ChatRoomMeta[];
	enableImageUpload?: boolean;
	stickerPackUrls?: string[];
	musicTracks?: ChatMusicTrack[];
	initialMusicVolume?: number;
}

const {
	chatServerUrl = "",
	walineServerUrl = "",
	rooms = [{ id: "chat", name: "闲聊", subtitle: "随便聊聊日常与折腾" }],
	enableImageUpload = true,
	stickerPackUrls = ["/assets/stickers/qq", "/assets/stickers/miku"],
	musicTracks = [],
	initialMusicVolume = 1,
}: Props = $props();

const PROFILE_OVERRIDE_PREFIX = "fireflyChatProfileV2:";
const LAST_SEEN_PREFIX = "lengxi_chat_last_seen:";

let activeTab = $state<"room" | "chat" | "music">("chat");
let currentRoom = $state(rooms[0]?.id || "chat");
let connectionState = $state<ConnectionState>("idle");
let currentUser = $state<ChatSessionUser | null>(null);
let onlineMembers = $state<ChatOnlineMember[]>([]);
let mentionMembers = $state<ChatMentionCandidate[]>([]);
let totalOnlineCount = $state(0);
let messages = $state<ChatMessageRecord[]>([]);
let hasMoreHistory = $state(false);
let isLoadingHistory = $state(false);
let sessionUnreadSince = $state(0);
let serverUnreadCount = $state(0);
let serverUnreadUserCount = $state(0);
let unreadJumpSeq = $state(0);
let musicState = $state<RoomMusicState | null>(null);
let clockOffsetMs = $state(0);
let noticeText = $state("");
let targetMessageUid = $state("");

let lastMarkedServerReadAt = 0;

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

let showSettings = $state(false);
let showProfileModal = $state(false);
let showAuthModal = $state(false);
let mentionEvent = $state<
	{ name: string; userKey?: string; seq: number } | undefined
>(undefined);
let stickerPacks = $state<StickerPack[]>([]);

let mentionSeq = 0;
let baseDocumentTitle = "";
let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let noticeTimer: number | null = null;
let reconnectAttempt = 0;
let isUnmounted = false;
let currentAuth: { kind: "waline" | "guest"; token: string } | null = null;

const stickerMap = $derived(buildStickerLookup(stickerPacks));
const activeMeta = $derived(
	rooms.find((r) => r.id === currentRoom) ??
		rooms[0] ?? { id: "chat", name: "闲聊", subtitle: "随便聊聊日常与折腾" },
);
const normalizedChatServer = $derived(normalizeServerUrl(chatServerUrl));

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

function applySavedProfileOverrideIfNeeded(user: ChatSessionUser | null) {
	if (!user || typeof localStorage === "undefined") return;
	try {
		const raw = localStorage.getItem(
			`${PROFILE_OVERRIDE_PREFIX}${user.userKey}`,
		);
		if (!raw) return;
		const parsed = JSON.parse(raw) as Partial<ChatProfileDraft>;
		const nextName =
			typeof parsed.nickname === "string" ? parsed.nickname.trim() : "";
		const nextBadge = user.isAdmin
			? "站长"
			: typeof parsed.badge === "string"
				? parsed.badge
				: "";
		const nextStatus =
			typeof parsed.status === "string" ? parsed.status.trim() : "";
		const nextUrl = typeof parsed.url === "string" ? parsed.url.trim() : "";
		const nextAvatar =
			typeof parsed.avatar === "string" ? parsed.avatar.trim() : undefined;

		const changed =
			(nextName && nextName !== user.name) ||
			(!user.isAdmin &&
				typeof parsed.badge === "string" &&
				nextBadge !== user.badge) ||
			(nextStatus && nextStatus !== (user.status || "在线")) ||
			(typeof parsed.url === "string" && nextUrl !== user.url) ||
			(nextAvatar !== undefined &&
				nextAvatar !== "" &&
				nextAvatar !== user.avatar);

		if (changed) {
			const packet: Record<string, unknown> = {
				type: "auth:update_profile",
				nickname: nextName || user.name,
				badge: nextBadge,
				status: nextStatus || user.status || "在线",
				url: typeof parsed.url === "string" ? nextUrl : user.url,
			};
			if (nextAvatar !== undefined && nextAvatar !== "") {
				packet.avatar = nextAvatar;
			}
			sendPacket(packet);
		}
	} catch {
		// Ignore invalid stored override
	}
}

function connectRoom(roomId: string) {
	if (isUnmounted) return;
	if (reconnectTimer !== null) {
		window.clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (ws) {
		const prev = ws;
		ws = null;
		try {
			prev.close(1000, "switch");
		} catch {
			// Ignore
		}
	}

	if (!normalizedChatServer) {
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
	const socket = new WebSocket(wsUrl);
	ws = socket;

	socket.addEventListener("open", () => {
		if (ws !== socket) return;
		connectionState = "connected";
		reconnectAttempt = 0;

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
				messages = packet.messages;
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

				onlineMembers = packet.members;
				mentionMembers = packet.mentionMembers ?? [];
				totalOnlineCount = packet.totalCount;
				musicState = packet.music;
				clockOffsetMs = packet.music.serverTime - Date.now();
				applySavedProfileOverrideIfNeeded(packet.self);
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
				break;
			}
			case "presence:update": {
				if (packet.roomId === currentRoom) {
					onlineMembers = packet.members;
					if (packet.mentionMembers) {
						mentionMembers = packet.mentionMembers;
					}
					totalOnlineCount = packet.totalCount;
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
							(packet.message.mentionKeys?.includes(currentUser.userKey) ||
								packet.message.mentions.some(
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
			case "chat:deleted": {
				if (packet.roomId === currentRoom) {
					messages = messages.filter((m) => m.msgUid !== packet.msgUid);
				}
				break;
			}
			case "music:state": {
				if (packet.roomId === currentRoom) {
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
				if (packet.code === "AUTH_REQUIRED") {
					showAuthModal = true;
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
		ws = null;
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

function handleRoomSelect(roomId: string) {
	if (roomId === currentRoom) {
		if (activeTab === "room") activeTab = "chat";
		return;
	}
	currentRoom = roomId;
	messages = [];
	hasMoreHistory = false;
	isLoadingHistory = false;
	sessionUnreadSince = 0;
	serverUnreadCount = 0;
	serverUnreadUserCount = 0;
	onlineMembers = [];
	musicState = null;
	reconnectAttempt = 0;
	connectRoom(roomId);
	if (activeTab === "room") {
		activeTab = "chat";
	}
}

function handleMentionUser(name: string) {
	if (!currentUser) {
		showAuthModal = true;
		return;
	}
	mentionSeq += 1;
	mentionEvent = { name, seq: mentionSeq };
	if (activeTab !== "chat") {
		activeTab = "chat";
	}
}

function handleAuthenticated(
	auth: { kind: "waline" | "guest"; token: string },
	user?: ChatSessionUser,
) {
	currentAuth = auth;
	if (user) {
		currentUser = user;
	}
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
	currentUser = null;
	sendPacket({ type: "auth:logout" });
	showNotice("已退出当前聊天身份，进入只读旁观模式");
}

function handleUpdateProfile(draft: ChatProfileDraft) {
	if (!currentUser) return;
	const cleanNick = draft.nickname.trim().slice(0, 16) || currentUser.name;
	const cleanBadge = draft.badge.trim().slice(0, 10);
	const cleanStatus = draft.status.trim().slice(0, 16) || "在线";
	const cleanUrl = draft.url.trim().slice(0, 200);
	const stored: ChatProfileDraft = {
		nickname: cleanNick,
		badge: cleanBadge,
		status: cleanStatus,
		url: cleanUrl,
	};
	if (typeof draft.avatar === "string" && draft.avatar.trim()) {
		stored.avatar = draft.avatar.trim().slice(0, 400);
	}
	try {
		localStorage.setItem(
			`${PROFILE_OVERRIDE_PREFIX}${currentUser.userKey}`,
			JSON.stringify(stored),
		);
	} catch {
		// Ignore
	}
	const packet: Record<string, unknown> = {
		type: "auth:update_profile",
		nickname: cleanNick,
		badge: cleanBadge,
		status: cleanStatus,
		url: cleanUrl,
	};
	if (typeof draft.avatar === "string") {
		packet.avatar = draft.avatar.trim().slice(0, 400);
	}
	if (typeof draft.notifyEmail === "boolean") {
		packet.notifyEmail = draft.notifyEmail;
	}
	sendPacket(packet);
	showNotice("个人资料已更新");
}

function handleSendMessage(
	content: string,
	attachments: ImageAttachment[],
	mentionKeys: string[] = [],
) {
	if (!currentUser) {
		showAuthModal = true;
		return;
	}
	sendPacket({
		type: "chat:send",
		content,
		attachments,
		mentionKeys,
	});
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

function handleDeleteMessage(msgUid: string) {
	sendPacket({ type: "chat:delete", msgUid });
}

async function handleSearchOnline(keyword: string): Promise<ChatMusicTrack[]> {
	return searchOnlineMusic(normalizedChatServer, keyword);
}

function handleEnqueueTrack(track: ChatMusicTrack) {
	if (!currentUser) {
		showAuthModal = true;
		return;
	}
	sendPacket({
		type: "music:enqueue",
		track: {
			id: track.id,
			provider: track.provider || "local",
			sourceId: track.sourceId || track.id,
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

onMount(() => {
	isUnmounted = false;
	baseDocumentTitle = document.title;
	currentAuth = resolveInitialAuth();

	const urlParams = new URLSearchParams(window.location.search);
	const paramRoom = urlParams.get("room")?.trim().toLowerCase() || "";
	if (paramRoom && rooms.some((r) => r.id === paramRoom)) {
		currentRoom = paramRoom;
	}
	const paramMsg = urlParams.get("msg")?.trim() || "";
	if (paramMsg) {
		targetMessageUid = paramMsg;
	}

	void loadStickerPacks(stickerPackUrls).then((packs) => {
		stickerPacks = packs;
	});
	connectRoom(currentRoom);

	const handleVisibility = () => {
		if (document.visibilityState === "visible") {
			if (baseDocumentTitle && document.title !== baseDocumentTitle) {
				document.title = baseDocumentTitle;
			}
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "ping" }));
			} else if (!ws && !isUnmounted) {
				connectRoom(currentRoom);
			}
		}
	};
	document.addEventListener("visibilitychange", handleVisibility);

	return () => {
		isUnmounted = true;
		document.removeEventListener("visibilitychange", handleVisibility);
		if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
		if (noticeTimer !== null) window.clearTimeout(noticeTimer);
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
        totalOnlineCount={totalOnlineCount}
        currentUser={currentUser}
        connectionState={connectionState}
        onRoomSelect={handleRoomSelect}
        onMentionUser={handleMentionUser}
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
          mentionMembers={mentionMembers}
          isChatTabActive={activeTab === "chat"}
          targetMessageUid={targetMessageUid}
          musicState={musicState}
          onSkipTrack={() => {
            if (!currentUser) {
              showAuthModal = true;
              return;
            }
            sendPacket({ type: "music:skip" });
          }}
          onVoteSkip={() => {
            if (!currentUser) {
              showAuthModal = true;
              return;
            }
            sendPacket({ type: "music:vote_skip" });
          }}
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
          noticeText={noticeText}
          onToggleSettings={() => (showSettings = !showSettings)}
          onSendMessage={handleSendMessage}
          onDeleteMessage={handleDeleteMessage}
          onRequireAuth={() => (showAuthModal = true)}
          onMentionUser={handleMentionUser}
        />
      </div>

      <ChatSettingsPopover
        open={showSettings}
        onClose={() => (showSettings = false)}
      />
    </div>

    <div class="chat-panel chat-panel-right {activeTab === 'music' ? 'mobile-active' : ''}">
      <MusicPanel
        roomId={currentRoom}
        fallbackTracks={musicTracks}
        musicState={musicState}
        currentUser={currentUser}
        onlineMemberCount={onlineMembers.length}
        clockOffsetMs={clockOffsetMs}
        initialVolume={initialMusicVolume}
        onSearchOnline={handleSearchOnline}
        onEnqueueTrack={handleEnqueueTrack}
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
        onSkipTrack={() => {
          if (!currentUser) {
            showAuthModal = true;
            return;
          }
          sendPacket({ type: "music:skip" });
        }}
        onVoteSkip={() => {
          if (!currentUser) {
            showAuthModal = true;
            return;
          }
          sendPacket({ type: "music:vote_skip" });
        }}
        onReportDuration={(playUid, durationSec) =>
          sendPacket({ type: "music:report_duration", playUid, durationSec })
        }
        onTrackEnded={(playUid) => sendPacket({ type: "music:ended", playUid })}
        onReportError={(playUid) =>
          sendPacket({ type: "music:report_error", playUid })
        }
        onRequestAuth={() => (showAuthModal = true)}
      />
    </div>
  </div>

  <!-- 身份准入二选一弹窗 -->
  <ChatAuthModal
    open={showAuthModal}
    chatServerUrl={normalizedChatServer}
    walineServerUrl={walineServerUrl}
    onAuthenticated={handleAuthenticated}
    onClose={() => (showAuthModal = false)}
  />

  <!-- 个人资料独立编辑弹窗 -->
  <ChatProfileModal
    open={showProfileModal}
    currentUser={currentUser}
    onSave={handleUpdateProfile}
    onClose={() => (showProfileModal = false)}
  />

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
