<script lang="ts">
import type { InterconnectSite } from "@/types/chatConfig";
import ChatAvatar from "./ChatAvatar.svelte";
import ChatModal from "./ChatModal.svelte";
import {
	fetchUserDetailProfile,
	fetchUserDetailTracks,
	readStoredWalineToken,
	resolveExternalOrigin,
	saveMemberBadges,
} from "./chatClient";
import type {
	ChatCustomBadge,
	ChatMessageRecord,
	ChatOnlineMember,
	ChatSessionUser,
	ChatUserDetailProfile,
	ChatUserDetailSeed,
	ChatUserRecentMessage,
	ChatUserRequestedTrackItem,
	ChatUserTopArtistItem,
	ChatUserTopTrackItem,
	MusicHistoryLogEntry,
} from "./chatTypes";
import type { ChatMusicTrack } from "./musicTypes";
import { formatPlatformLabel } from "./playlistClient";

interface Props {
	open: boolean;
	seed: ChatUserDetailSeed | null;
	roomId: string;
	chatServerUrl: string;
	currentUser: ChatSessionUser | null;
	onlineMembers: ChatOnlineMember[];
	messages: ChatMessageRecord[];
	musicHistoryLogs?: MusicHistoryLogEntry[];
	interconnectSites?: InterconnectSite[];
	onClose: () => void;
	onMention: (name: string, userKey?: string) => void;
	onEditSelf: () => void;
	onEnqueueTrack?: (track: ChatMusicTrack) => void;
	onOpenPlaylist?: (playlistId: string) => void;
	onJumpToMessage?: (msgUid: string) => void;
	onUpdateMemberBadges?: (
		targetUserKey: string,
		badges: ChatCustomBadge[],
	) => Promise<boolean> | boolean;
}

const TRACK_PAGE_SIZE = 50;
const USER_DETAIL_CACHE_TTL_MS = 15 * 1000;
const userDetailCache = new Map<
	string,
	{ profile: ChatUserDetailProfile; fetchedAt: number }
>();

const {
	open,
	seed,
	roomId,
	chatServerUrl,
	currentUser = null,
	onlineMembers = [],
	messages = [],
	musicHistoryLogs = [],
	interconnectSites = [],
	onClose,
	onMention,
	onEditSelf,
	onEnqueueTrack,
	onOpenPlaylist,
	onJumpToMessage,
	onUpdateMemberBadges,
}: Props = $props();

let remoteProfile = $state<ChatUserDetailProfile | null>(null);
let remoteTracks = $state<ChatUserRequestedTrackItem[]>([]);
let remoteHasMore = $state(false);
let remoteNextBeforeId = $state(0);
let isLoading = $state(false);
let isLoadingMore = $state(false);
let localVisibleLimit = $state(TRACK_PAGE_SIZE);
let trackTab = $state<"recent" | "top">("recent");
let bodyContainerEl: HTMLDivElement | null = $state(null);
let lockedMinHeight = $state(0);
const matrixUserId = $derived.by(() => {
	if (!seed?.userKey) return "";
	if (seed.userKey.startsWith("matrix:")) {
		return seed.userKey.slice("matrix:".length);
	}
	if (seed.userKey.startsWith("@") && seed.userKey.includes(":")) {
		return seed.userKey;
	}
	return "";
});

const isExternalUser = $derived.by(() => {
	if (matrixUserId) return true;
	if (!seed?.userKey) return false;
	const key = seed.userKey;
	if (key.startsWith("matrix:") || (key.startsWith("@") && key.includes(":"))) return true;
	if (
		seed.badge === "互联茶友" ||
		seed.badge === "Detached" ||
		seed.badge === "听雨" ||
		seed.badge === "GBK"
	) {
		return true;
	}
	return false;
});

const fallbackData = $derived.by<{
	profile: ChatUserDetailProfile;
	allTracks: ChatUserRequestedTrackItem[];
	topTracks: ChatUserTopTrackItem[];
	topArtists: ChatUserTopArtistItem[];
	recentMessages: ChatUserRecentMessage[];
} | null>(() => {
	if (!seed) return null;
	const onlineMatch = onlineMembers.find((m) => m.userKey === seed.userKey);
	const isSelf = Boolean(
		currentUser?.userKey &&
			currentUser.userKey === seed.userKey &&
			!isExternalUser &&
			!matrixUserId &&
			!seed.userKey.startsWith("matrix:") &&
			!seed.userKey.startsWith("@"),
	);
	const selfUser = isSelf ? currentUser : null;
	const userMessages = messages.filter(
		(m) => m.kind === "user" && m.userKey === seed.userKey,
	);
	const latestMsg = userMessages[userMessages.length - 1];

	const authType: "waline" | "guest" =
		onlineMatch?.authType ??
		selfUser?.authType ??
		seed.authType ??
		(seed.userKey.startsWith("waline:") ? "waline" : "guest");
	const isAdmin = Boolean(
		onlineMatch?.isAdmin ??
			selfUser?.isAdmin ??
			seed.isAdmin ??
			latestMsg?.isAdmin,
	);
	const badge = isAdmin
		? "站长"
		: (seed.badge || onlineMatch?.badge || (authType === "waline" ? "认证" : "访客"));
	const badgeType = isAdmin
		? "host"
		: (seed.badgeType || onlineMatch?.badgeType || (authType === "waline" ? "accent" : "tag"));

	const userLogs = musicHistoryLogs.filter(
		(l) => l.requesterKey === seed.userKey,
	);
	const allTracks: ChatUserRequestedTrackItem[] = userLogs.map((log) => ({
		logId: log.id,
		track: log.track,
		requestedAt: log.requestedAt,
		requestCount: log.requestCount,
	}));

	const topMap = new Map<string, ChatUserTopTrackItem>();
	const artistMap = new Map<string, number>();
	for (const log of userLogs) {
		const prev = topMap.get(log.track.id);
		if (prev) {
			prev.requestCount += 1;
			if (log.requestedAt > prev.lastRequestedAt) {
				prev.lastRequestedAt = log.requestedAt;
			}
		} else {
			topMap.set(log.track.id, {
				track: log.track,
				requestCount: 1,
				lastRequestedAt: log.requestedAt,
			});
		}
		const artist = (log.track.artist || "").trim();
		if (artist && artist !== "未知歌手") {
			artistMap.set(artist, (artistMap.get(artist) ?? 0) + 1);
		}
	}

	const topTracks = Array.from(topMap.values())
		.sort(
			(a, b) =>
				b.requestCount - a.requestCount ||
				b.lastRequestedAt - a.lastRequestedAt,
		)
		.slice(0, 50);

	const topArtists = Array.from(artistMap.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([artist, count]) => ({ artist, count }));

	const recentMessages: ChatUserRecentMessage[] = userMessages
		.slice(-10)
		.reverse()
		.map((m) => ({
			msgUid: m.msgUid,
			content: m.content,
			hasImage: Array.isArray(m.attachments) && m.attachments.length > 0,
			createdAt: m.createdAt,
		}));

	return {
		profile: {
			userKey: seed.userKey,
			authType,
			name:
				onlineMatch?.name ||
				selfUser?.name ||
				seed.name ||
				latestMsg?.name ||
				"房友",
			avatar:
				onlineMatch?.avatar ||
				selfUser?.avatar ||
				seed.avatar ||
				latestMsg?.avatar ||
				"",
			url:
				onlineMatch?.url || selfUser?.url || seed.url || latestMsg?.url || "",
			badge,
			badgeType,
			customBadges:
				onlineMatch?.customBadges ??
				selfUser?.customBadges ??
				seed.customBadges ??
				latestMsg?.customBadges ??
				[],
			isAdmin,
			online: Boolean(onlineMatch ?? seed.online),
			status: cleanCustomStatus(
				onlineMatch?.status || selfUser?.status || seed.status,
			),
			bio: onlineMatch?.bio ?? selfUser?.bio ?? seed.bio ?? "",
			location: onlineMatch?.location || selfUser?.location || seed.location || "",
			firstSeenAt: userMessages[0]?.createdAt || 0,
			lastSeenAt: onlineMatch ? Date.now() : latestMsg?.createdAt || 0,
			stats: {
				messageCount: userMessages.length,
				songRequestCount: userLogs.length,
			},
			recentTracks: allTracks.slice(0, TRACK_PAGE_SIZE),
			tracksHasMore: allTracks.length > TRACK_PAGE_SIZE,
			tracksNextBeforeId: 0,
			topTracks,
			topArtists,
			recentMessages,
			playlists: [],
		},
		allTracks,
		topTracks,
		topArtists,
		recentMessages,
	};
});

const profile = $derived(remoteProfile ?? fallbackData?.profile ?? null);
let managedBadges = $state<ChatCustomBadge[]>([]);
let isSavingBadges = $state(false);
let badgeSaveNotice = $state("");

$effect(() => {
	if (open && profile) {
		managedBadges = (profile.customBadges || []).map((b) => ({ ...b }));
		badgeSaveNotice = "";
	}
});

const effectiveCustomBadges = $derived.by<ChatCustomBadge[]>(() => {
	return profile?.customBadges ?? [];
});

async function handleSaveBadges() {
	if (
		!profile ||
		!currentUser?.isAdmin ||
		isExternalUser ||
		matrixUserId ||
		profile.userKey.startsWith("matrix:") ||
		profile.userKey.startsWith("@")
	) {
		return;
	}
	const sanitized: ChatCustomBadge[] = managedBadges
		.map((b) => ({
			text: (b.text || "").trim().slice(0, 8),
			color: b.color === "gold" ? ("gold" as const) : ("gray" as const),
		}))
		.filter((b) => Boolean(b.text))
		.slice(0, 3);

	isSavingBadges = true;
	badgeSaveNotice = "";
	try {
		let ok = false;
		if (onUpdateMemberBadges) {
			ok = await onUpdateMemberBadges(profile.userKey, sanitized);
		} else {
			const walineToken = readStoredWalineToken();
			ok = await saveMemberBadges(
				chatServerUrl,
				roomId,
				profile.userKey,
				sanitized,
				walineToken,
			);
		}
		if (ok) {
			if (remoteProfile) {
				remoteProfile = {
					...remoteProfile,
					customBadges: sanitized,
				};
			}
			userDetailCache.delete(`${roomId}:${profile.userKey}`);
			managedBadges = sanitized.map((b) => ({ ...b }));
			badgeSaveNotice = "头衔已更新";
			setTimeout(() => {
				if (badgeSaveNotice === "头衔已更新") {
					badgeSaveNotice = "";
				}
			}, 3000);
		} else {
			badgeSaveNotice = "保存失败，请重试";
		}
	} catch {
		badgeSaveNotice = "网络异常，保存失败";
	} finally {
		isSavingBadges = false;
	}
}

function handleAddBadge() {
	if (managedBadges.length >= 3) return;
	managedBadges = [...managedBadges, { text: "", color: "gold" }];
}

function handleRemoveBadge(index: number) {
	managedBadges = managedBadges.filter((_, i) => i !== index);
}

const isSelf = $derived(
	Boolean(
		currentUser &&
			profile &&
			currentUser.userKey === profile.userKey &&
			!isExternalUser &&
			!matrixUserId &&
			!profile.userKey.startsWith("matrix:") &&
			!profile.userKey.startsWith("@"),
	),
);
const displayedTracks = $derived.by<ChatUserRequestedTrackItem[]>(() => {
	if (remoteProfile) return remoteTracks;
	return (fallbackData?.allTracks ?? []).slice(0, localVisibleLimit);
});
const topTracks = $derived.by<ChatUserTopTrackItem[]>(() => {
	if (remoteProfile?.topTracks) return remoteProfile.topTracks;
	return fallbackData?.topTracks ?? [];
});
const topArtists = $derived.by<ChatUserTopArtistItem[]>(() => {
	if (remoteProfile?.topArtists) return remoteProfile.topArtists;
	return fallbackData?.topArtists ?? [];
});
const recentMessages = $derived.by<ChatUserRecentMessage[]>(() => {
	if (
		remoteProfile?.recentMessages &&
		remoteProfile.recentMessages.length > 0
	) {
		return remoteProfile.recentMessages;
	}
	return fallbackData?.recentMessages ?? [];
});
const hasMoreTracks = $derived.by<boolean>(() => {
	if (trackTab !== "recent") return false;
	if (remoteProfile) return remoteHasMore;
	return (fallbackData?.allTracks.length ?? 0) > localVisibleLimit;
});
const totalSongCount = $derived.by<number>(() => {
	if (!profile) return 0;
	return Math.max(profile.stats.songRequestCount, displayedTracks.length);
});

$effect(() => {
	const currentSeed = seed;
	localVisibleLimit = TRACK_PAGE_SIZE;
	remoteTracks = [];
	remoteHasMore = false;
	remoteNextBeforeId = 0;
	isLoadingMore = false;
	trackTab = "recent";
	lockedMinHeight = 0;

	if (!open || !currentSeed?.userKey) {
		remoteProfile = null;
		isLoading = false;
		return;
	}

	remoteProfile = null;
	if (
		matrixUserId ||
		isExternalUser ||
		currentSeed.userKey.startsWith("matrix:") ||
		currentSeed.userKey.startsWith("@") ||
		currentSeed.userKey.startsWith("name:") ||
		currentSeed.userKey === "system:fallback"
	) {
		isLoading = false;
		return;
	}

	const detailCacheKey = `${roomId}:${currentSeed.userKey}`;
	const cachedEntry = userDetailCache.get(detailCacheKey);
	const hasFreshCache =
		cachedEntry &&
		Date.now() - cachedEntry.fetchedAt < USER_DETAIL_CACHE_TTL_MS;

	if (cachedEntry) {
		const liveOnline = onlineMembers.find(
			(m) => m.userKey === currentSeed.userKey,
		);
		const isWaline = currentSeed.userKey.startsWith("waline:");
		const mergedProfile: ChatUserDetailProfile = {
			...cachedEntry.profile,
			authType: isWaline ? "waline" : cachedEntry.profile.authType,
			badge:
				isWaline && cachedEntry.profile.badge === "访客"
					? "认证"
					: cachedEntry.profile.badge || (isWaline ? "认证" : "访客"),
			badgeType:
				isWaline && cachedEntry.profile.badgeType === "tag"
					? "accent"
					: cachedEntry.profile.badgeType || (isWaline ? "accent" : "tag"),
			name: liveOnline?.name || cachedEntry.profile.name,
			avatar: liveOnline?.avatar || cachedEntry.profile.avatar,
			url: liveOnline?.url ?? cachedEntry.profile.url,
			status: cleanCustomStatus(
				liveOnline?.status || cachedEntry.profile.status,
			),
			bio: liveOnline?.bio ?? cachedEntry.profile.bio,
			location: liveOnline?.location || cachedEntry.profile.location,
			online: Boolean(liveOnline ?? currentSeed.online),
		};
		remoteProfile = mergedProfile;
		remoteTracks = mergedProfile.recentTracks ?? [];
		remoteHasMore = Boolean(mergedProfile.tracksHasMore);
		remoteNextBeforeId = Number(mergedProfile.tracksNextBeforeId || 0);

		// 若缓存仍在极短保鲜期（< 3秒），作为最终展示；否则作为 SWR 瞬时骨架并在后台刷新
		if (hasFreshCache && Date.now() - cachedEntry.fetchedAt < 3000) {
			isLoading = false;
			return;
		}
	}

	let cancelled = false;
	isLoading = true;
	void fetchUserDetailProfile(
		chatServerUrl,
		roomId,
		currentSeed.userKey,
		TRACK_PAGE_SIZE,
		readStoredWalineToken(),
	).then((res) => {
		if (cancelled) return;
		isLoading = false;
		if (res) {
			userDetailCache.set(detailCacheKey, {
				profile: res,
				fetchedAt: Date.now(),
			});
			remoteProfile = res;
			remoteTracks = res.recentTracks ?? [];
			remoteHasMore = Boolean(res.tracksHasMore);
			remoteNextBeforeId = Number(res.tracksNextBeforeId || 0);
		}
	});
	return () => {
		cancelled = true;
	};
});

async function loadMoreTracks() {
	if (
		trackTab !== "recent" ||
		isLoadingMore ||
		!hasMoreTracks ||
		!seed?.userKey
	) {
		return;
	}
	if (!remoteProfile) {
		localVisibleLimit += TRACK_PAGE_SIZE;
		return;
	}
	if (remoteNextBeforeId <= 0) {
		remoteHasMore = false;
		return;
	}
	const targetKey = seed.userKey;
	isLoadingMore = true;
	try {
		const page = await fetchUserDetailTracks(
			chatServerUrl,
			roomId,
			targetKey,
			remoteNextBeforeId,
			TRACK_PAGE_SIZE,
		);
		if (!open || seed?.userKey !== targetKey) return;
		if (!page) return;
		const seenLogIds = new Set(
			remoteTracks
				.map((item) => item.logId)
				.filter((id): id is number => typeof id === "number" && id > 0),
		);
		const appended = page.items.filter(
			(item) => !item.logId || !seenLogIds.has(item.logId),
		);
		remoteTracks = [...remoteTracks, ...appended];
		remoteHasMore = page.hasMore && page.nextBeforeId > 0;
		remoteNextBeforeId = page.nextBeforeId;
	} finally {
		if (seed?.userKey === targetKey) {
			isLoadingMore = false;
		}
	}
}

function handleSwitchTrackTab(nextTab: "recent" | "top") {
	if (nextTab === trackTab) return;
	const cardEl = bodyContainerEl?.closest(
		".chat-dialog-card",
	) as HTMLElement | null;
	if (cardEl) {
		const currentHeight = Math.round(cardEl.getBoundingClientRect().height);
		if (currentHeight > lockedMinHeight) {
			lockedMinHeight = currentHeight;
		}
	}
	trackTab = nextTab;
}

function handleScrollNearBottom(el: HTMLElement) {
	if (trackTab !== "recent" || !hasMoreTracks || isLoadingMore) return;
	if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
		void loadMoreTracks();
	}
}

function formatJoinTime(ts: number): string {
	if (!ts) return "近期来访";
	const d = new Date(ts);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function cleanCustomStatus(status?: string | null): string {
	const trimmed = (status ?? "").trim();
	return trimmed === "在线" ? "" : trimmed;
}

function formatLastSeen(ts: number): string {
	if (!ts) return "离线";
	const diff = Date.now() - ts;
	if (diff < 60_000) return "刚刚活跃";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前活跃`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前活跃`;
	const d = new Date(ts);
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 活跃`;
}

function formatActiveStat(online: boolean, ts: number): string {
	if (online) return "在线中";
	if (!ts) return "离线";
	const diff = Date.now() - ts;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	const d = new Date(ts);
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTrackTime(ts: number): string {
	if (!ts) return "";
	const d = new Date(ts);
	const now = new Date();
	const hh = String(d.getHours()).padStart(2, "0");
	const min = String(d.getMinutes()).padStart(2, "0");
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	if (d.toDateString() === now.toDateString()) {
		return `今天 ${hh}:${min}`;
	}
	if (d.getFullYear() === now.getFullYear()) {
		return `${mm}-${dd} ${hh}:${min}`;
	}
	return `${d.getFullYear()}-${mm}-${dd}`;
}

function formatMessageSummary(msg: ChatUserRecentMessage): string {
	const text = (msg.content || "").replace(/\s+/g, " ").trim();
	if (text) return text;
	return msg.hasImage ? "[发送了图片]" : "[消息]";
}
</script>

<ChatModal
  open={open && Boolean(profile || matrixUserId || isExternalUser)}
  title="成员名片"
  ariaLabel={seed ? `${seed.name} 的个人资料` : "成员名片"}
  size={matrixUserId || isExternalUser ? "md" : "lg"}
  fillHeightOnDesktop={!(matrixUserId || isExternalUser)}
  {lockedMinHeight}
  {onClose}
>
  {#snippet headerExtra()}
    {#if isLoading}
      <span class="text-[11px] text-[var(--chat-meta-color)] shrink-0">同步中...</span>
    {/if}
  {/snippet}

  {#if (matrixUserId || isExternalUser) && seed}
    {@const origin = resolveExternalOrigin({ name: seed.name, userKey: seed.userKey }, interconnectSites)}
    {@const cleanName = origin.cleanName || seed.name}
    {@const matchedSite = origin.site}
    {@const userMessages = messages.filter((m) => m.kind === "user" && m.userKey === seed.userKey)}
    {@const onlineMatch = onlineMembers.find((m) => m.userKey === seed.userKey)}
    {@const isOnline = Boolean(onlineMatch ?? seed.online)}
    {@const firstSeenAt = userMessages[0]?.createdAt || 0}
    {@const latestMsg = userMessages[userMessages.length - 1]}
    {@const lastSeenAt = onlineMatch ? Date.now() : (latestMsg?.createdAt || 0)}
    {@const recentMsgs = userMessages.slice(-5).reverse()}

    <div class="flex-1 overflow-y-auto custom-scrollbar p-3.5 sm:p-4 space-y-3 min-h-0">
      <!-- 1. 顶部身份卡片 -->
      <div class="rounded-xl bg-(--btn-regular-bg) p-3 border border-black/5 dark:border-white/10 space-y-2.5">
        <div class="flex items-center gap-3">
          <div class="relative shrink-0">
            <ChatAvatar src={seed.avatar} name={cleanName} size="lg" />
            {#if isOnline}
              <span
                class="chat-online-dot absolute -bottom-0.5 -right-0.5 border-[1.5px] border-white/80 dark:border-neutral-900/80"
                title="在线中"
              ></span>
            {/if}
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-base font-bold text-[var(--deep-text)] dark:text-white/90 break-words">
                {cleanName}
              </span>
              <span class="chat-role-badge chat-role-badge--tag">🍵 互联茶友</span>
              {#if seed.customBadges && seed.customBadges.length > 0}
                {#each seed.customBadges as b (b.text)}
                  <span class="chat-role-badge chat-role-badge--{b.color}">{b.text}</span>
                {/each}
              {/if}
            </div>
            <div class="flex items-center gap-1.5 text-xs text-[var(--chat-meta-color)] mt-0.5 flex-wrap">
              {#if !isOnline}
                <span>{formatLastSeen(lastSeenAt)}</span>
                <span>·</span>
              {/if}
              <span>Matrix 联邦中继</span>
            </div>
          </div>

          <!-- @该茶友 快捷按钮（站外暂不支持提及，置灰禁用） -->
          <button
            type="button"
            disabled
            class="px-2.5 py-1.5 text-xs text-[var(--chat-meta-color)] bg-black/5 dark:bg-white/5 rounded-lg shrink-0 flex items-center gap-1 cursor-not-allowed opacity-50 border-none select-none"
            title="暂不支持跨站提及站外茶友"
          >
            <span class="font-bold opacity-60">@</span>
            <span>暂不支持提及</span>
          </button>
        </div>
      </div>

      <!-- 2. 🍵 归属互联茶室 / 博客卡片 -->
      <div class="rounded-xl bg-(--btn-regular-bg) p-3 border border-black/5 dark:border-white/10 space-y-2">
        <div class="flex items-center justify-between text-xs font-semibold text-[var(--chat-meta-color)]">
          <span class="flex items-center gap-1.5">
            <span>🍵</span>
            <span>归属互联茶室</span>
          </span>
          {#if matchedSite?.owner}
            <span class="text-[0.6875rem] font-normal opacity-75">
              站长: {matchedSite.owner}
            </span>
          {/if}
        </div>

        <div class="flex items-center justify-between gap-3 bg-black/3 dark:bg-white/5 p-2.5 rounded-lg border border-black/5 dark:border-white/5">
          <div class="flex items-center gap-2.5 min-w-0">
            {#if matchedSite?.avatar}
              <img
                src={matchedSite.avatar}
                alt={matchedSite.name}
                class="w-8 h-8 rounded-full object-cover shrink-0"
              />
            {:else}
              <div class="w-8 h-8 rounded-full bg-(--primary)/15 text-[var(--chat-accent-text)] flex items-center justify-center font-bold text-xs shrink-0">
                🍵
              </div>
            {/if}
            <div class="min-w-0">
              <div class="font-bold text-xs text-[var(--deep-text)] dark:text-white/90 truncate">
                {matchedSite?.name || origin.siteName}
              </div>
              <div class="text-[0.6875rem] text-[var(--chat-meta-color)] truncate">
                {matchedSite?.desc || `来自 ${origin.siteName} 互联聊天节点`}
              </div>
            </div>
          </div>

          {#if matchedSite?.url}
            <a
              href={matchedSite.url}
              target="_blank"
              rel="noopener noreferrer"
              class="chat-btn-ghost px-2.5 py-1 text-xs shrink-0 text-[var(--chat-accent-text)] bg-(--primary)/10 hover:bg-(--primary)/20 rounded-lg no-underline font-medium transition-colors"
            >
              前往串门 ↗
            </a>
          {:else if seed.url}
            <a
              href={seed.url}
              target="_blank"
              rel="noopener noreferrer"
              class="chat-btn-ghost px-2.5 py-1 text-xs shrink-0 text-[var(--chat-accent-text)] bg-(--primary)/10 hover:bg-(--primary)/20 rounded-lg no-underline font-medium transition-colors"
            >
              访问主页 ↗
            </a>
          {/if}
        </div>
      </div>

      <!-- 3. 足迹统计与联邦网络信息 -->
      <div class="rounded-xl bg-(--btn-regular-bg) p-3 border border-black/5 dark:border-white/10">
        <div class="grid grid-cols-2 gap-2 text-center">
          <div class="bg-black/3 dark:bg-white/5 p-2 rounded-lg">
            <div class="text-[0.6875rem] text-[var(--chat-meta-color)]">茶室发言</div>
            <div class="font-bold text-sm text-[var(--deep-text)] dark:text-white/90 mt-0.5">
              {userMessages.length} 条
            </div>
          </div>
          <div class="bg-black/3 dark:bg-white/5 p-2 rounded-lg">
            <div class="text-[0.6875rem] text-[var(--chat-meta-color)]">初次相识</div>
            <div class="font-bold text-sm text-[var(--deep-text)] dark:text-white/90 mt-0.5 truncate" title={firstSeenAt ? new Date(firstSeenAt).toLocaleString() : "未知"}>
              {firstSeenAt ? formatJoinTime(firstSeenAt) : "本次会话"}
            </div>
          </div>
        </div>

        <div class="mt-2.5 pt-2 border-t border-[var(--chat-divider-color)]/60 text-[0.6875rem] text-[var(--chat-meta-color)] space-y-1">
          <div class="flex items-center justify-between gap-2">
            <span class="shrink-0">Matrix 账号:</span>
            <a
              href={`https://matrix.to/#/${encodeURIComponent(matrixUserId || seed.userKey)}`}
              target="_blank"
              rel="noopener noreferrer"
              class="text-[var(--chat-accent-text)] hover:underline truncate"
              title={matrixUserId || seed.userKey}
            >
              {matrixUserId || seed.userKey}
            </a>
          </div>
          {#if origin.host}
            <div class="flex items-center justify-between gap-2">
              <span class="shrink-0">中继节点:</span>
              <span class="truncate">{origin.host}</span>
            </div>
          {/if}
        </div>
      </div>

      <!-- 4. 最近茶室发言 -->
      <div class="rounded-xl bg-(--btn-regular-bg) p-3.5 border border-black/5 dark:border-white/10 space-y-2">
        <div class="text-xs font-semibold text-[var(--chat-meta-color)] flex items-center justify-between">
          <span>最近在茶室说了什么</span>
          <span class="text-[0.6875rem] font-normal opacity-75">
            共 {userMessages.length} 条
          </span>
        </div>

        {#if recentMsgs.length === 0}
          <div class="py-4 text-center text-xs text-[var(--chat-meta-color)]">
            该茶友在当前加载记录中暂无发言~
          </div>
        {:else}
          <div class="space-y-1.5">
            {#each recentMsgs as m (m.msgUid)}
              <div class="flex items-center justify-between gap-2 p-2 rounded-lg bg-black/3 dark:bg-white/5 hover:bg-black/5 dark:hover:bg-white/8 transition-colors">
                <div class="min-w-0 flex-1">
                  <div class="text-xs text-[var(--deep-text)] dark:text-white/90 truncate">
                    {m.content || (Array.isArray(m.attachments) && m.attachments.length > 0 ? "[发送了图片]" : "...")}
                  </div>
                  <div class="text-[0.625rem] text-[var(--chat-meta-color)] mt-0.5">
                    {formatTrackTime(m.createdAt)}
                  </div>
                </div>
                {#if onJumpToMessage}
                  <button
                    type="button"
                    class="text-[0.6875rem] text-[var(--chat-accent-text)] hover:underline shrink-0 px-1 py-0.5 border-none bg-transparent cursor-pointer"
                    onclick={() => {
                      onJumpToMessage(m.msgUid);
                      onClose();
                    }}
                  >
                    定位 ↑
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {:else if profile}
    <!-- 主体：手机端单流平滑滚动，平板/桌面端 42%:58% 左右双栏独立滚动且高度随内容自适应 -->
    <div
      bind:this={bodyContainerEl}
      class="flex-1 min-h-0 flex flex-col md:grid md:grid-cols-[minmax(18.5rem,42%)_minmax(0,58%)] md:grid-rows-[minmax(0,1fr)] overflow-y-auto md:overflow-hidden custom-scrollbar"
      onscroll={(e) => handleScrollNearBottom(e.currentTarget)}
    >
      <!-- 左栏：名片核心、互动四格统计、常点歌手、歌单与最近发言 -->
      <div class="w-full md:min-h-0 md:overflow-y-auto custom-scrollbar p-3.5 sm:p-4 space-y-3 border-b md:border-b-0 md:border-r border-(--chat-divider-color)">
        <!-- 头部名片与签名 -->
        <div class="rounded-xl bg-(--btn-regular-bg) p-3 space-y-2.5">
          <div class="flex items-center gap-3">
            <div class="relative shrink-0">
              <ChatAvatar
                src={profile.avatar}
                name={profile.name}
                size="lg"
              />
              <span
                class="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-white dark:border-neutral-900 {profile.online ? 'bg-emerald-500' : 'bg-neutral-400'}"
              ></span>
            </div>

            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
                <span class="text-sm font-bold text-[var(--deep-text)] truncate">
                  {profile.name}
                </span>
                <span class="chat-role-badge chat-role-badge--{profile.badgeType}">
                  {profile.badge}
                </span>
                {#if effectiveCustomBadges.length > 0}
                  {#each effectiveCustomBadges as b (b.text)}
                    <span class="chat-role-badge chat-role-badge--{b.color}">
                      {b.text}
                    </span>
                  {/each}
                {/if}
              </div>
              <div class="text-[11px] text-[var(--chat-meta-color)] mt-0.5 truncate flex items-center gap-1.5 flex-wrap">
                <span>{profile.online ? "在线" : formatLastSeen(profile.lastSeenAt)}</span>

                {#if cleanCustomStatus(profile.status)}
                  <span class="opacity-40 select-none">·</span>
                  <span>{cleanCustomStatus(profile.status)}</span>
                {/if}

                {#if profile.location}
                  <span class="opacity-40 select-none">·</span>
                  <span
                    class="inline-flex items-center gap-1 font-medium text-[var(--chat-meta-color)]"
                  >
                    <svg
                      class="w-3 h-3 shrink-0 opacity-70"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
                      <circle cx="12" cy="10" r="3" />
                    </svg>
                    <span>{profile.location}</span>
                  </span>
                {/if}
              </div>
            </div>
          </div>

          <div class="chat-user-detail-subcard text-xs leading-relaxed text-[var(--deep-text)]/90 px-2.5 py-2 rounded-lg break-words">
            {#if profile.bio.trim()}
              {profile.bio}
            {:else}
              <span class="text-[var(--chat-meta-color)] opacity-80">这个人很懒，还没有填写个人简介~</span>
            {/if}
          </div>

          {#if profile.url}
            <a
              href={profile.url}
              target="_blank"
              rel="noopener noreferrer"
              class="chat-user-detail-subcard flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs text-[var(--chat-accent-text)] hover:border-(--primary)/50 transition-colors no-underline"
            >
              <span class="truncate">{profile.url}</span>
              <span class="text-[10px] shrink-0 opacity-85">访问主页 ↗</span>
            </a>
          {/if}
        </div>

        <!-- 快捷操作 -->
        <div class="flex items-center">
          {#if isSelf}
            <button
              type="button"
              class="chat-send-btn flex-1 h-9! rounded-xl! text-xs!"
              onclick={() => {
                onClose();
                onEditSelf();
              }}
            >
              编辑我的资料
            </button>
          {:else}
            {@const isExternalProfile = Boolean(isExternalUser || matrixUserId || profile.userKey?.startsWith("matrix:") || profile.userKey?.startsWith("@") || profile.badge === "互联茶友")}
            <button
              type="button"
              disabled={isExternalProfile}
              class="{isExternalProfile ? 'bg-black/5 dark:bg-white/5 text-[var(--chat-meta-color)] opacity-50 cursor-not-allowed select-none' : 'chat-send-btn'} flex-1 h-9! rounded-xl! text-xs! truncate px-3!"
              title={isExternalProfile ? "暂不支持跨站提及站外茶友" : `在聊天中 @${profile.name}`}
              onclick={() => {
                if (isExternalProfile) return;
                onClose();
                onMention(profile.name, profile.userKey);
              }}
            >
              {#if isExternalProfile}
                @ 暂不支持提及
              {:else}
                @ {profile.name}
              {/if}
            </button>
          {/if}
        </div>

        <!-- 站长专属：身份头衔管理（严格隔离：绝不允许设置站外/互联用户） -->
        {#if currentUser?.isAdmin && profile && !isExternalUser && !matrixUserId && !profile.userKey.startsWith("matrix:") && !profile.userKey.startsWith("@")}
          <div class="rounded-xl bg-(--btn-regular-bg) p-3 space-y-2.5 border border-amber-500/25 dark:border-amber-400/25">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-1.5 min-w-0">
                <svg class="w-3.5 h-3.5 text-amber-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
                <span class="text-xs font-bold text-[var(--deep-text)] truncate">身份头衔管理</span>
                <span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-semibold shrink-0">站长视角</span>
              </div>
              <span class="text-[11px] text-[var(--chat-meta-color)] shrink-0 font-medium">
                {managedBadges.length}/3
              </span>
            </div>

            <!-- 系统固定头衔只读 -->
            <div class="flex items-center justify-between text-xs py-1.5 px-2.5 rounded-lg bg-black/5 dark:bg-white/5 gap-2">
              <span class="text-[11px] text-[var(--chat-meta-color)]">系统固定头衔：</span>
              <div class="flex items-center gap-1.5">
                <span class="chat-role-badge chat-role-badge--{profile.badgeType}">
                  {profile.badge}
                </span>
                <span class="text-[10px] text-[var(--chat-meta-color)] opacity-70">（固定头衔，不可修改）</span>
              </div>
            </div>

            <!-- 自定义头衔列表编辑 -->
            <div class="space-y-2">
              <div class="text-[11px] font-medium text-[var(--chat-meta-color)] flex items-center justify-between">
                <span>自定义头衔（最多 3 个）：</span>
                {#if managedBadges.length < 3}
                  <button
                    type="button"
                    class="text-[11px] text-[var(--primary)] hover:underline bg-transparent border-none cursor-pointer p-0 font-medium inline-flex items-center gap-0.5"
                    onclick={handleAddBadge}
                  >
                    <span>+ 添加头衔</span>
                  </button>
                {/if}
              </div>

              {#if managedBadges.length === 0}
                <div class="text-[11px] text-[var(--chat-meta-color)] opacity-70 py-1 px-1">
                  暂未添加自定义头衔，点击右上角“+ 添加头衔”即可为该成员添加头衔。
                </div>
              {:else}
                <div class="space-y-2">
                  {#each managedBadges as badge, idx}
                    <div class="p-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 space-y-1.5">
                      <div class="flex items-center gap-2">
                        <input
                          type="text"
                          maxlength={8}
                          bind:value={badge.text}
                          placeholder="输入头衔（最多 8 字）"
                          class="chat-auth-input text-xs py-1 px-2 h-7.5 flex-1 min-w-0"
                        />
                        <button
                          type="button"
                          class="text-neutral-400 hover:text-red-500 p-1 rounded transition-colors bg-transparent border-none cursor-pointer shrink-0"
                          onclick={() => handleRemoveBadge(idx)}
                          aria-label="删除此头衔"
                        >
                          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                          </svg>
                        </button>
                      </div>

                      <div class="flex items-center justify-between text-[11px] pt-0.5">
                        <span class="text-[var(--chat-meta-color)]">头衔颜色：</span>
                        <div class="flex items-center gap-1.5">
                          <button
                            type="button"
                            class="px-2 py-0.5 rounded text-[11px] font-medium border cursor-pointer transition-all flex items-center gap-1
                              {badge.color === 'gold'
                                ? 'chat-role-badge--gold border-amber-500/50 shadow-xs font-semibold'
                                : 'bg-transparent text-[var(--chat-meta-color)] border-transparent opacity-60 hover:opacity-100'}"
                            onclick={() => (badge.color = 'gold')}
                          >
                            <span class="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block"></span>
                            <span>金色</span>
                          </button>
                          <button
                            type="button"
                            class="px-2 py-0.5 rounded text-[11px] font-medium border cursor-pointer transition-all flex items-center gap-1
                              {badge.color === 'gray'
                                ? 'chat-role-badge--gray border-neutral-400/50 shadow-xs font-semibold'
                                : 'bg-transparent text-[var(--chat-meta-color)] border-transparent opacity-60 hover:opacity-100'}"
                            onclick={() => (badge.color = 'gray')}
                          >
                            <span class="w-1.5 h-1.5 rounded-full bg-neutral-400 inline-block"></span>
                            <span>灰色</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            <!-- 保存按钮与提示 -->
            <div class="flex items-center justify-between pt-1 gap-2">
              {#if badgeSaveNotice}
                <span class="text-[11px] {badgeSaveNotice === '头衔已更新' ? 'text-emerald-500' : 'text-red-400'} font-medium truncate">
                  {badgeSaveNotice}
                </span>
              {:else}
                <span></span>
              {/if}
              <button
                type="button"
                class="chat-send-btn h-7.5! px-3! rounded-lg! text-xs! font-medium cursor-pointer shrink-0 disabled:opacity-50"
                disabled={isSavingBadges}
                onclick={handleSaveBadges}
              >
                {isSavingBadges ? "保存中..." : "保存头衔修改"}
              </button>
            </div>
          </div>
        {/if}

        <!-- 2x2 互动与活跃统计 -->
        <div class="grid grid-cols-2 gap-2">
          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2 flex items-center justify-between gap-2">
            <span class="text-[11px] text-[var(--chat-meta-color)]">聊天发言</span>
            <span class="text-xs font-bold text-[var(--deep-text)] tabular-nums">
              {profile.stats.messageCount}
            </span>
          </div>
          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2 flex items-center justify-between gap-2">
            <span class="text-[11px] text-[var(--chat-meta-color)]">累计点歌</span>
            <span class="text-xs font-bold text-[var(--deep-text)] tabular-nums">
              {profile.stats.songRequestCount}
            </span>
          </div>
          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2 flex items-center justify-between gap-2">
            <span class="text-[11px] text-[var(--chat-meta-color)]">初次来访</span>
            <span class="text-[11px] font-bold text-[var(--deep-text)] tabular-nums truncate">
              {formatJoinTime(profile.firstSeenAt)}
            </span>
          </div>
          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2 flex items-center justify-between gap-2">
            <span class="text-[11px] text-[var(--chat-meta-color)]">最近活跃</span>
            <span class="text-[11px] font-bold tabular-nums truncate {profile.online ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--deep-text)]'}">
              {formatActiveStat(profile.online, profile.lastSeenAt)}
            </span>
          </div>
        </div>

        <!-- 常点歌手偏好 -->
        {#if topArtists.length > 0}
          <div class="space-y-1.5">
            <div class="text-[11px] font-semibold text-[var(--chat-meta-color)] px-0.5">
              常点歌手
            </div>
            <div class="flex flex-wrap gap-1.5">
              {#each topArtists as item (item.artist)}
                <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-(--btn-regular-bg) text-[11px] font-medium text-[var(--deep-text)]">
                  <span class="truncate max-w-[9rem]">{item.artist}</span>
                  <span class="text-[10px] text-[var(--chat-accent-text)] font-semibold tabular-nums">
                    {item.count} 次
                  </span>
                </span>
              {/each}
            </div>
          </div>
        {/if}

        <!-- TA 导入的歌单（Waline 已认证用户） -->
        {#if profile.playlists.length > 0}
          <div class="space-y-1.5">
            <div class="text-[11px] font-semibold text-[var(--chat-meta-color)] px-0.5">
              导入的歌单
            </div>
            <div class="rounded-xl bg-(--btn-regular-bg) p-1.5 space-y-1">
              {#each profile.playlists as pl (pl.id)}
                <button
                  type="button"
                  class="w-full flex items-center gap-2 p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left bg-transparent border-none cursor-pointer"
                  onclick={() => {
                    onClose();
                    onOpenPlaylist?.(pl.id);
                  }}
                >
                  <div class="w-8 h-8 rounded-md overflow-hidden shrink-0 bg-(--primary)/12 flex items-center justify-center">
                    {#if pl.coverUrl}
                      <img src={pl.coverUrl} alt="" loading="lazy" class="w-full h-full object-cover" />
                    {:else}
                      <span class="text-xs text-(--primary)">♪</span>
                    {/if}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-semibold text-[var(--deep-text)] truncate">{pl.title}</div>
                    <div class="text-[10px] text-[var(--chat-meta-color)] truncate">
                      {formatPlatformLabel(pl.platform)} · {pl.trackCount} 首
                    </div>
                  </div>
                  <span class="text-[10px] font-semibold text-[var(--chat-accent-text)] shrink-0">查看 →</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <!-- 最近发言动态（点击跳转定位至原消息） -->
        {#if recentMessages.length > 0}
          <div class="space-y-1.5">
            <div class="text-[11px] font-semibold text-[var(--chat-meta-color)] px-0.5">
              最近发言
            </div>
            <div class="rounded-xl bg-(--btn-regular-bg) p-1.5 space-y-1">
              {#each recentMessages as msg (msg.msgUid)}
                <button
                  type="button"
                  class="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors bg-transparent border-none cursor-pointer flex items-center justify-between gap-2"
                  onclick={() => {
                    onClose();
                    onJumpToMessage?.(msg.msgUid);
                  }}
                >
                  <span class="text-xs text-[var(--deep-text)]/90 truncate min-w-0 flex-1">
                    {formatMessageSummary(msg)}
                  </span>
                  <span class="text-[10px] text-[var(--chat-meta-color)] tabular-nums shrink-0">
                    {formatTrackTime(msg.createdAt)}
                  </span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <!-- 右栏：TA 点过的歌（按时间 50 首起无限滚 / 按次数排行） -->
      <div class="w-full md:min-w-0 md:min-h-0 flex flex-col">
        <div class="shrink-0 flex items-center justify-between gap-2 px-3.5 sm:px-4 py-2.5 border-b border-(--chat-divider-color) md:overflow-y-auto custom-scrollbar chat-scrollbar-stable">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-xs font-bold text-[var(--deep-text)]">点过的歌</span>
            <span class="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-(--primary)/12 text-[var(--chat-accent-text)] tabular-nums">
              共 {totalSongCount} 首
            </span>
          </div>

          <div class="inline-flex items-center gap-0.5 rounded-lg bg-(--btn-regular-bg) p-0.5 shrink-0" role="tablist" aria-label="点歌视图切换">
            <button
              type="button"
              role="tab"
              aria-selected={trackTab === "recent"}
              class="px-2 py-0.5 rounded-md text-[11px] font-medium border-none cursor-pointer transition-colors {trackTab === 'recent' ? 'bg-(--primary) text-white' : 'bg-transparent text-[var(--chat-meta-color)] hover:text-[var(--deep-text)]'}"
              onclick={() => handleSwitchTrackTab("recent")}
            >
              按时间
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={trackTab === "top"}
              class="px-2 py-0.5 rounded-md text-[11px] font-medium border-none cursor-pointer transition-colors {trackTab === 'top' ? 'bg-(--primary) text-white' : 'bg-transparent text-[var(--chat-meta-color)] hover:text-[var(--deep-text)]'}"
              onclick={() => handleSwitchTrackTab("top")}
            >
              按次数
            </button>
          </div>
        </div>

        <div
          class="md:flex-1 md:min-h-0 md:overflow-y-auto custom-scrollbar chat-scrollbar-stable px-3.5 sm:px-4 py-3 space-y-1.5"
          onscroll={(e) => handleScrollNearBottom(e.currentTarget)}
        >
          {#if trackTab === "recent"}
            {#if displayedTracks.length === 0}
              <div class="flex flex-col items-center justify-center py-8 px-4 text-center rounded-xl bg-(--btn-regular-bg)/60">
                <div class="w-9 h-9 rounded-full bg-(--primary)/12 flex items-center justify-center text-sm text-(--primary) mb-2">
                  ♪
                </div>
                <div class="text-xs font-medium text-[var(--deep-text)]/80">
                  暂无点歌记录
                </div>
                <div class="text-[11px] text-[var(--chat-meta-color)] mt-0.5">
                  TA 还没有在本房间点过歌~
                </div>
              </div>
            {:else}
              {#each displayedTracks as item, idx (item.logId ? `log-${item.logId}` : `local-${idx}-${item.track.id}-${item.requestedAt}`)}
                <div class="flex items-center gap-2.5 p-2 rounded-xl bg-(--btn-regular-bg)/70 hover:bg-(--btn-regular-bg) transition-colors">
                  <span class="w-5 text-center text-[10px] font-semibold text-[var(--chat-meta-color)] tabular-nums shrink-0">
                    {idx + 1}
                  </span>
                  <div class="w-9 h-9 rounded-lg overflow-hidden shrink-0 bg-(--primary)/12 flex items-center justify-center">
                    {#if item.track.cover}
                      <img src={item.track.cover} alt="" loading="lazy" class="w-full h-full object-cover" />
                    {:else}
                      <span class="text-xs text-(--primary)">♪</span>
                    {/if}
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-semibold text-[var(--deep-text)] truncate">
                      {item.track.title}
                    </div>
                    <div class="text-[11px] text-[var(--chat-meta-color)] truncate mt-0.5">
                      {item.track.artist}
                      {#if item.requestedAt}
                        · {formatTrackTime(item.requestedAt)}
                      {/if}
                      {#if item.requestCount > 1}
                        · 全站 {item.requestCount} 次
                      {/if}
                    </div>
                  </div>
                  {#if onEnqueueTrack}
                    <button
                      type="button"
                      class="chat-queue-toggle-btn text-[11px]! px-2.5! py-1! shrink-0"
                      onclick={() => {
                        onEnqueueTrack(item.track);
                      }}
                    >
                      + 点歌
                    </button>
                  {/if}
                </div>
              {/each}

              <div class="pt-2 pb-1 flex items-center justify-center">
                {#if isLoadingMore}
                  <span class="text-[11px] text-[var(--chat-meta-color)]">
                    正在加载更多点歌记录...
                  </span>
                {:else if hasMoreTracks}
                  <button
                    type="button"
                    class="btn-regular h-8 px-3.5 rounded-lg text-[11px] font-medium cursor-pointer border-none"
                    onclick={() => void loadMoreTracks()}
                  >
                    向下滚动或点击加载更多
                  </button>
                {:else}
                  <span class="text-[11px] text-[var(--chat-meta-color)] opacity-80">
                    已展示全部 {displayedTracks.length} 首点歌记录
                  </span>
                {/if}
              </div>
            {/if}
          {:else if topTracks.length === 0}
            <div class="flex flex-col items-center justify-center py-8 px-4 text-center rounded-xl bg-(--btn-regular-bg)/60">
              <div class="w-9 h-9 rounded-full bg-(--primary)/12 flex items-center justify-center text-sm text-(--primary) mb-2">
                ♪
              </div>
              <div class="text-xs font-medium text-[var(--deep-text)]/80">
                暂无点歌排行
              </div>
              <div class="text-[11px] text-[var(--chat-meta-color)] mt-0.5">
                点过的歌曲会在这里自动统计次数~
              </div>
            </div>
          {:else}
            {#each topTracks as item, idx (item.track.id)}
              <div class="flex items-center gap-2.5 p-2 rounded-xl bg-(--btn-regular-bg)/70 hover:bg-(--btn-regular-bg) transition-colors">
                <span class="w-5 text-center text-[10px] font-bold tabular-nums shrink-0 {idx < 3 ? 'text-[var(--chat-accent-text)]' : 'text-[var(--chat-meta-color)]'}">
                  #{idx + 1}
                </span>
                <div class="w-9 h-9 rounded-lg overflow-hidden shrink-0 bg-(--primary)/12 flex items-center justify-center">
                  {#if item.track.cover}
                    <img src={item.track.cover} alt="" loading="lazy" class="w-full h-full object-cover" />
                  {:else}
                    <span class="text-xs text-(--primary)">♪</span>
                  {/if}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="text-xs font-semibold text-[var(--deep-text)] truncate">
                    {item.track.title}
                  </div>
                  <div class="text-[11px] text-[var(--chat-meta-color)] truncate mt-0.5">
                    {item.track.artist} · TA 点过 {item.requestCount} 次
                  </div>
                </div>
                {#if onEnqueueTrack}
                  <button
                    type="button"
                    class="chat-queue-toggle-btn text-[11px]! px-2.5! py-1! shrink-0"
                    onclick={() => {
                      onEnqueueTrack(item.track);
                    }}
                  >
                    + 点歌
                  </button>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
      </div>
    </div>
  {/if}
</ChatModal>
