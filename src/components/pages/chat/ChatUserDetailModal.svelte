<script lang="ts">
import ChatAvatar from "./ChatAvatar.svelte";
import ChatModal from "./ChatModal.svelte";
import {
	fetchUserDetailProfile,
	fetchUserDetailTracks,
	readStoredWalineToken,
} from "./chatClient";
import type {
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
	onClose: () => void;
	onMention: (name: string, userKey?: string) => void;
	onEditSelf: () => void;
	onEnqueueTrack?: (track: ChatMusicTrack) => void;
	onOpenPlaylist?: (playlistId: string) => void;
	onJumpToMessage?: (msgUid: string) => void;
}

const TRACK_PAGE_SIZE = 50;
const USER_DETAIL_CACHE_TTL_MS = 5 * 60 * 1000;
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
	onClose,
	onMention,
	onEditSelf,
	onEnqueueTrack,
	onOpenPlaylist,
	onJumpToMessage,
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
const matrixUserId = $derived(
	seed?.userKey.startsWith("matrix:") ? seed.userKey.slice("matrix:".length) : "",
);

const fallbackData = $derived.by<{
	profile: ChatUserDetailProfile;
	allTracks: ChatUserRequestedTrackItem[];
	topTracks: ChatUserTopTrackItem[];
	topArtists: ChatUserTopArtistItem[];
	recentMessages: ChatUserRecentMessage[];
} | null>(() => {
	if (!seed) return null;
	const onlineMatch = onlineMembers.find((m) => m.userKey === seed.userKey);
	const isSelf = currentUser?.userKey === seed.userKey;
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
	const badge = isAdmin ? "站长" : authType === "waline" ? "已认证" : "访客";
	const badgeType = isAdmin ? "host" : authType === "waline" ? "accent" : "tag";

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
			isAdmin,
			online: Boolean(onlineMatch ?? seed.online),
			status: onlineMatch?.status || selfUser?.status || seed.status || "在线",
			bio: onlineMatch?.bio ?? selfUser?.bio ?? seed.bio ?? "",
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
const isSelf = $derived(
	Boolean(currentUser && profile && currentUser.userKey === profile.userKey),
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
		currentSeed.userKey.startsWith("name:") ||
		currentSeed.userKey === "system:fallback"
	) {
		isLoading = false;
		return;
	}

	const detailCacheKey = `${roomId}:${currentSeed.userKey}`;
	const cachedEntry = userDetailCache.get(detailCacheKey);
	if (
		cachedEntry &&
		Date.now() - cachedEntry.fetchedAt < USER_DETAIL_CACHE_TTL_MS
	) {
		const liveOnline = onlineMembers.find(
			(m) => m.userKey === currentSeed.userKey,
		);
		const mergedProfile: ChatUserDetailProfile = liveOnline
			? {
					...cachedEntry.profile,
					name: liveOnline.name || cachedEntry.profile.name,
					avatar: liveOnline.avatar || cachedEntry.profile.avatar,
					url: liveOnline.url ?? cachedEntry.profile.url,
					status: liveOnline.status || cachedEntry.profile.status,
					bio: liveOnline.bio ?? cachedEntry.profile.bio,
					online: true,
				}
			: {
					...cachedEntry.profile,
					online: Boolean(liveOnline ?? currentSeed.online),
				};
		remoteProfile = mergedProfile;
		remoteTracks = mergedProfile.recentTracks ?? [];
		remoteHasMore = Boolean(mergedProfile.tracksHasMore);
		remoteNextBeforeId = Number(mergedProfile.tracksNextBeforeId || 0);
		isLoading = false;
		return;
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
  open={open && Boolean(profile || matrixUserId)}
  title="成员名片"
  ariaLabel={seed ? `${seed.name} 的个人资料` : "成员名片"}
  size={matrixUserId ? "sm" : "lg"}
  fillHeightOnDesktop={!matrixUserId}
  {lockedMinHeight}
  {onClose}
>
  {#snippet headerExtra()}
    {#if isLoading}
      <span class="text-[11px] text-[var(--chat-meta-color)] shrink-0">同步中...</span>
    {/if}
  {/snippet}

  {#if matrixUserId && seed}
    <div class="p-4 space-y-3">
      <div class="flex items-center gap-3">
        <ChatAvatar src={seed.avatar} name={seed.name} size="lg" />
        <div class="min-w-0">
          <div class="text-sm font-bold text-[var(--deep-text)] break-words">{seed.name}</div>
          <span class="chat-role-badge chat-role-badge--tag">互联茶友</span>
        </div>
      </div>
      <div class="text-xs text-[var(--chat-meta-color)] break-all">
        Matrix 发件账号
        <a
          href={`https://matrix.to/#/${encodeURIComponent(matrixUserId)}`}
          target="_blank"
          rel="noopener noreferrer"
          class="block text-[var(--chat-accent-text)]"
        >{matrixUserId}</a>
      </div>
      {#if seed.url}
        <a
          href={seed.url}
          target="_blank"
          rel="noopener noreferrer"
          class="block text-xs text-[var(--chat-accent-text)] break-all"
        >访问个人网站 ↗</a>
      {/if}
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
                title={profile.online ? "当前在线" : "当前离线"}
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
              </div>
              <div class="text-[11px] text-[var(--chat-meta-color)] mt-0.5 truncate">
                {#if profile.online}
                  在线 · {profile.status || "在线"}
                {:else}
                  {formatLastSeen(profile.lastSeenAt)}
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
            <button
              type="button"
              class="chat-send-btn flex-1 h-9! rounded-xl! text-xs! truncate px-3!"
              onclick={() => {
                onClose();
                onMention(profile.name, profile.userKey);
              }}
            >
              @ {profile.name}
            </button>
          {/if}
        </div>

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
