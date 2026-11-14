<script lang="ts">
import type { ChatRoomMeta, InterconnectSite } from "@/types/chatConfig";
import Icon from "@/components/common/Icon.svelte";
import ChatAvatar from "./ChatAvatar.svelte";
import ChatTooltip from "./ChatTooltip.svelte";
import { resolveExternalOrigin } from "./chatClient";
import type {
	ChatMentionCandidate,
	ChatOnlineMember,
	ChatSessionUser,
	ChatSpectatorRecord,
	ChatUserDetailSeed,
	ConnectionState,
} from "./chatTypes";

interface Props {
	rooms: ChatRoomMeta[];
	currentRoom: string;
	onlineMembers: ChatOnlineMember[];
	observers?: ChatOnlineMember[];
	spectatorHistory?: ChatSpectatorRecord[];
	mentionMembers?: ChatMentionCandidate[];
	totalOnlineCount: number;
	totalChatterCount?: number;
	currentUser: ChatSessionUser | null;
	selfMuted?: boolean;
	connectionState: ConnectionState;
	isWindowFocused?: boolean;
	interconnectSites?: InterconnectSite[];
	desktopNotificationEnabled?: boolean;
	desktopNotificationPermission?: NotificationPermission;
	roomUnreadCounts?: Record<string, number>;
	onRoomSelect?: (roomId: string) => void;
	onOpenUserProfile?: (seed: ChatUserDetailSeed) => void;
	onOpenProfile?: () => void;
	onOpenAuth?: () => void;
	onLogout?: () => void;
	onToggleDesktopNotification?: () => void;
}

const {
	rooms = [{ id: "chat", name: "闲聊", subtitle: "随便聊聊日常与折腾" }],
	currentRoom = "chat",
	onlineMembers = [],
	observers = [],
	spectatorHistory = [],
	mentionMembers = [],
	totalOnlineCount = 0,
	totalChatterCount = 0,
	currentUser = null,
	selfMuted = true,
	connectionState = "idle",
	isWindowFocused = true,
	interconnectSites = [],
	desktopNotificationEnabled = false,
	desktopNotificationPermission = "default" as NotificationPermission,
	roomUnreadCounts = {},
	onRoomSelect,
	onOpenUserProfile,
	onOpenProfile,
	onOpenAuth,
	onLogout,
	onToggleDesktopNotification,
}: Props = $props();

const observerCount = $derived(observers.length);

/** 互联房间（跨站联邦聊天）的房间 id */
const INTERCONNECT_ROOM_IDS = new Set(["interconnect"]);

const isCurrentInterconnect = $derived(INTERCONNECT_ROOM_IDS.has(currentRoom));

const isNotificationActive = $derived(
	Boolean(desktopNotificationEnabled && desktopNotificationPermission === "granted"),
);

const notificationTooltip = $derived.by(() => {
	if (desktopNotificationPermission === "denied") {
		return "通知已禁用";
	}
	if (isNotificationActive) {
		return "关闭通知";
	}
	return "开启通知";
});

const notificationIcon = $derived(
	isNotificationActive
		? "material-symbols:notifications-outline-rounded"
		: "material-symbols:notifications-off-outline-rounded",
);

function isExternalMember(member: { userKey?: string; badge?: string }): boolean {
	if (!member) return false;
	const key = member.userKey || "";
	return (
		key.startsWith("matrix:") ||
		(key.startsWith("@") && key.includes(":")) ||
		member.badge === "互联茶友" ||
		member.badge === "Detached" ||
		member.badge === "听雨" ||
		member.badge === "GBK"
	);
}

/** 互联茶室模式：本站在线成员（全站通用） */
const siteOnlineMembers = $derived(
	onlineMembers.filter((m) => !isExternalMember(m)),
);

/** 互联茶室模式：其他网站/外部在线成员 */
const externalOnlineMembers = $derived(
	onlineMembers.filter((m) => isExternalMember(m)),
);

/** 本站普通房间模式：纯净本站在线成员（彻底排除外部互联成员，包含全站在线成员） */
const normalOnlineMembers = $derived(
	onlineMembers.filter((m) => !isExternalMember(m)),
);

const interconnectRooms = $derived(
	rooms.filter((room) => INTERCONNECT_ROOM_IDS.has(room.id)),
);

const siteRooms = $derived(
	rooms.filter((room) => !INTERCONNECT_ROOM_IDS.has(room.id)),
);

const offlineMembers = $derived.by(() => {
	const currentOnlineList = isCurrentInterconnect
		? [...siteOnlineMembers, ...externalOnlineMembers]
		: normalOnlineMembers;
	const onlineKeys = new Set(currentOnlineList.map((m) => m.userKey));

	return mentionMembers
		.filter((m) => {
			if (m.online || onlineKeys.has(m.userKey)) return false;
			// 严格隔离：处于本站普通房间时，不展示任何外部互联茶友
			if (!isCurrentInterconnect && isExternalMember(m)) return false;
			return true;
		})
		.slice()
		.sort((a, b) => {
			if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
			return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
		});
});

const siteOfflineMembers = $derived(
	offlineMembers.filter((m) => !isExternalMember(m)),
);

const externalOfflineMembers = $derived(
	offlineMembers.filter((m) => isExternalMember(m)),
);

const connLabel = $derived(
	connectionState === "connected"
		? "已连接"
		: connectionState === "reconnecting"
			? "重连中"
			: connectionState === "connecting"
				? "连接中"
				: "离线",
);

function resolveMemberRoleBadge(user: {
	isAdmin?: boolean;
	authType?: "waline" | "guest" | string;
	userKey?: string;
	badge?: string;
	badgeType?: "host" | "accent" | "tag";
}): { label: string; type: "host" | "accent" | "tag" } {
	if (user.isAdmin) return { label: "站长", type: "host" };
	if (
		user.authType === "waline" ||
		user.userKey?.startsWith("waline:")
	) {
		return { label: user.badge || "认证", type: "accent" };
	}
	if (user.badge && user.badgeType) {
		return { label: user.badge, type: user.badgeType };
	}
	return { label: "访客", type: "tag" };
}

const roomNameById = $derived(
	new Map(rooms.map((room) => [room.id, room.name] as const)),
);

/** 在线成员的副标题：状态 · 当前所在房间 */
function formatOnlineLine(member: ChatOnlineMember): string {
	const targetRoomId = member.roomId || "chat";
	const roomName =
		roomNameById.get(targetRoomId) ||
		(targetRoomId === "interconnect"
			? "互联茶室"
			: targetRoomId === "chat"
				? "闲聊"
				: targetRoomId);
	const status =
		member.status && member.status !== "在线" ? member.status.trim() : "在线";
	return `${status} · ${roomName}`;
}

function isMemberMuted(member: ChatOnlineMember): boolean {
	if (currentUser && member.userKey === currentUser.userKey) {
		return selfMuted;
	}
	return member.isMuted !== false;
}

function isMemberFocused(member: ChatOnlineMember): boolean {
	if (currentUser && member.userKey === currentUser.userKey) {
		return isWindowFocused;
	}
	return member.isFocused !== false;
}

let now = $state(Date.now());
$effect(() => {
	const timer = setInterval(() => {
		now = Date.now();
	}, 30000);
	return () => clearInterval(timer);
});

function formatOfflineTime(ts?: number): string {
	if (!ts || !Number.isFinite(ts) || ts <= 0) return "离线";
	const diff = Math.max(0, now - ts);
	if (diff < 60_000) return "刚刚离线";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前离线`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前离线`;
	const d = new Date(ts);
	return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 离线`;
}
</script>

<div class="flex flex-col h-full w-full select-none min-h-0">
  <!-- 面板顶栏 -->
  <div class="chat-panel-header">
    <div class="font-bold text-sm text-[var(--deep-text)] dark:text-white/90 flex items-center gap-2">
      <svg class="w-4 h-4 text-[var(--primary)] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span>聊天室</span>
    </div>
    <span class="text-[0.6875rem] px-2 py-0.5 rounded-full bg-[var(--card-bg)]/60 border border-[var(--chat-divider-color)] text-[var(--chat-accent-text)] font-medium">
      {connLabel}
    </span>
  </div>

  <!-- 房间列表：按来源分组（互联房间 / 本站房间） -->
  <div class="p-2.5 shrink-0">
    {#if interconnectRooms.length > 0}
      <div class="chat-section-title">互联房间</div>
      <div class="flex flex-col gap-1 mt-0.5">
        {#each interconnectRooms as room (room.id)}
          {@render roomItem(room)}
        {/each}
      </div>
    {/if}
    {#if siteRooms.length > 0}
      <div class="chat-section-title {interconnectRooms.length > 0 ? 'mt-1.5' : ''}">本站</div>
      <div class="flex flex-col gap-1 mt-0.5">
        {#each siteRooms as room (room.id)}
          {@render roomItem(room)}
        {/each}
      </div>
    {/if}
  </div>

  {#snippet roomItem(room: ChatRoomMeta)}
    {@const unread = currentRoom !== room.id ? (roomUnreadCounts?.[room.id] ?? 0) : 0}
    <button
      type="button"
      class="chat-room-item {currentRoom === room.id ? 'active' : ''} text-left w-full border-none"
      onclick={() => onRoomSelect?.(room.id)}
    >
      <span class="font-mono text-sm font-bold opacity-60 w-4 text-center ml-1">#</span>
      <span class="flex-1 truncate">{room.name}</span>
      {#if unread > 0}
        <span class="px-1.5 py-0.2 rounded-full bg-red-500 text-white text-[0.625rem] font-bold shrink-0">
          {unread > 99 ? "99+" : unread}
        </span>
      {:else if currentRoom === room.id}
        <span class="text-[0.6875rem] text-[var(--chat-meta-color)]">
          {INTERCONNECT_ROOM_IDS.has(room.id) && totalChatterCount && totalChatterCount > 0
            ? `${totalOnlineCount}/${totalChatterCount}`
            : totalOnlineCount}
        </span>
      {/if}
    </button>
  {/snippet}

  <div class="chat-divider"></div>

  <!-- 成员名录：在线成员 + 离线成员 -->
  <div class="flex-1 overflow-y-auto custom-scrollbar px-2.5 py-1.5 space-y-3 min-h-0">
    {#if isCurrentInterconnect}
      <!-- 互联茶室模式：直接平铺“本地在线”、“其他站点”、“本站离线”、“其他站点” -->

      <!-- 1. 本地在线 -->
      <section>
        <div class="chat-section-title flex items-center justify-between pr-1">
          <span>本地在线</span>
          <span class="text-[0.6875rem] font-normal text-[var(--chat-meta-color)]">
            {siteOnlineMembers.length + observerCount} 人
          </span>
        </div>

        {#if siteOnlineMembers.length + observerCount === 0}
          <div class="px-2 py-3 text-center text-xs text-[var(--chat-meta-color)]">
            {#if connectionState === "connected"}
              暂无本地已登录在线成员~
            {:else}
              正在同步成员列表...
            {/if}
          </div>
        {:else}
          <div class="space-y-1 mt-0.5">
            {#each siteOnlineMembers as member (member.userKey)}
              {@render memberItem(member, true, false)}
            {/each}
            {#if observers.length > 0}
              {#each observers as obs (obs.userKey)}
                {@render observerItem(obs)}
              {/each}
            {/if}
          </div>
        {/if}
      </section>

      <!-- 2. 互联站点在线 -->
      {#if externalOnlineMembers.length > 0}
        <section class="pt-1 border-t border-[var(--chat-divider-color)]">
          <div class="chat-section-title flex items-center justify-between pr-1">
            <span>互联站点</span>
            <span class="text-[0.6875rem] font-normal text-[var(--chat-meta-color)]">
              {externalOnlineMembers.length} 人
            </span>
          </div>

          <div class="space-y-1 mt-0.5">
            {#each externalOnlineMembers as member (member.userKey)}
              {@render memberItem(member, true, true)}
            {/each}
          </div>
        </section>
      {/if}

      <!-- 3. 本站离线 -->
      {#if siteOfflineMembers.length > 0}
        <section class="pt-1 border-t border-[var(--chat-divider-color)]">
          <div class="chat-section-title flex items-center justify-between pr-1">
            <span>本站离线</span>
            <span class="text-[0.6875rem] font-normal text-[var(--chat-meta-color)]">
              {siteOfflineMembers.length} 人
            </span>
          </div>

          <div class="space-y-1 mt-0.5">
            {#each siteOfflineMembers as member (member.userKey)}
              {@render memberItem(member, false, false)}
            {/each}
          </div>
        </section>
      {/if}

      <!-- 4. 互联站点离线 -->
      {#if externalOfflineMembers.length > 0}
        <section class="pt-1 border-t border-[var(--chat-divider-color)]">
          <div class="chat-section-title flex items-center justify-between pr-1">
            <span>互联站点</span>
            <span class="text-[0.6875rem] font-normal text-[var(--chat-meta-color)]">
              {externalOfflineMembers.length} 人
            </span>
          </div>

          <div class="space-y-1 mt-0.5">
            {#each externalOfflineMembers as member (member.userKey)}
              {@render memberItem(member, false, true)}
            {/each}
          </div>
        </section>
      {/if}

    {:else}
      <!-- 本站普通房间模式（如闲聊）：纯净的“在线成员”和“离线成员” -->
      <section>
        <div class="chat-section-title flex items-center justify-between pr-1">
          <span>在线成员</span>
          <span class="text-[0.6875rem] font-normal text-[var(--chat-meta-color)]">
            {normalOnlineMembers.length + observerCount} 人
          </span>
        </div>

        {#if normalOnlineMembers.length + observerCount === 0}
          <div class="px-2 py-4 text-center text-xs text-[var(--chat-meta-color)]">
            {#if connectionState === "connected"}
              暂无已登录在线成员，发句话或点首歌露个面吧~
            {:else}
              正在同步成员列表...
            {/if}
          </div>
        {:else}
          <div class="space-y-1 mt-0.5">
            {#each normalOnlineMembers as member (member.userKey)}
              {@render memberItem(member, true, false)}
            {/each}
            {#if observers.length > 0}
              {#each observers as obs (obs.userKey)}
                {@render observerItem(obs)}
              {/each}
            {/if}
          </div>
        {/if}
      </section>

      {#if offlineMembers.length > 0}
        <section class="pt-1 border-t border-[var(--chat-divider-color)]">
          <div class="chat-section-title flex items-center justify-between pr-1">
            <span>离线成员</span>
            <span class="text-[0.6875rem] font-normal text-[var(--chat-meta-color)]">
              {offlineMembers.length} 人
            </span>
          </div>

          <div class="space-y-1 mt-0.5">
            {#each offlineMembers as member (member.userKey)}
              {@render memberItem(member, false, false)}
            {/each}
          </div>
        </section>
      {/if}
    {/if}

    <!-- 5. 旁观历史（在所有离线成员的最下面） -->
    {#if spectatorHistory.length > 0}
      <section class="pt-1.5 border-t border-[var(--chat-divider-color)]">
        <div class="chat-section-title flex items-center justify-between pr-1">
          <span>旁观历史</span>
          <span class="text-[0.6875rem] font-normal text-[var(--chat-meta-color)]">
            {spectatorHistory.length} 条
          </span>
        </div>

        <div class="space-y-1 mt-0.5">
          {#each spectatorHistory as item (item.id + '_' + item.connectedAt)}
            {@render spectatorHistoryItem(item)}
          {/each}
        </div>
      </section>
    {/if}
  </div>

  {#snippet memberItem(member: ChatOnlineMember | ChatMentionCandidate, isOnline: boolean, isExternal = false)}
    {@const roleBadge = resolveMemberRoleBadge(member)}
    {@const muted = isOnline ? isMemberMuted(member as ChatOnlineMember) : false}
    {@const isFocused = isOnline ? isMemberFocused(member as ChatOnlineMember) : false}
    {@const origin = isExternal ? resolveExternalOrigin(member, interconnectSites) : null}
    {@const displayName = origin ? origin.cleanName : member.name}
    {@const siteName = origin?.siteName || "外部站点"}
    {@const offlineTime = isOnline ? "" : formatOfflineTime((member as ChatMentionCandidate).lastSeenAt)}
    {@const subtitle = isExternal
      ? (isOnline
          ? (member.status && member.status !== "在线" ? `${member.status.trim()} · 来自：${siteName}` : `来自：${siteName}`)
          : (offlineTime === "离线" ? `来自：${siteName}` : `来自：${siteName} · ${offlineTime}`))
      : (isOnline
          ? formatOnlineLine(member as ChatOnlineMember)
          : offlineTime)}
    <button
      type="button"
      class="chat-user-item group justify-between w-full text-left border-none bg-transparent {isOnline ? '' : 'opacity-75 hover:opacity-100'}"
      aria-label={`查看 ${displayName} 的个人资料`}
      onclick={() =>
        onOpenUserProfile?.({
          userKey: member.userKey,
          authType: member.authType || (member.userKey.startsWith("waline:") ? "waline" : "guest"),
          name: displayName,
          avatar: member.avatar,
          url: member.url,
          badge: isExternal ? "互联茶友" : roleBadge.label,
          badgeType: isExternal ? "tag" : roleBadge.type,
          customBadges: member.customBadges,
          isAdmin: member.isAdmin,
          online: isOnline,
          status: member.status,
          bio: isExternal ? (member.bio || `来自 ${origin?.siteName || "互联茶室"}`) : member.bio,
          location: member.location,
        })}
    >
      <div class="flex items-center gap-2.5 min-w-0 flex-1">
        <div class="relative shrink-0">
          <ChatAvatar
            src={member.avatar}
            name={displayName}
            size="sm"
            grayscale={!isOnline}
            mutedTone={!isOnline}
          />
          {#if isOnline}
            <span
              class="chat-online-dot {isFocused ? '' : 'chat-online-dot--away'} absolute -bottom-0.5 -right-0.5 border-[1.5px] border-white/80 dark:border-neutral-900/80"
            ></span>
          {/if}
        </div>

        <div class="min-w-0 flex flex-col">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="truncate font-medium text-[var(--deep-text)] dark:text-white/90 group-hover:text-[var(--primary)] transition-colors">
              {displayName}
            </span>
            {#if !isExternal}
              <span class="chat-role-badge chat-role-badge--{roleBadge.type} py-px! px-1! text-[0.5625rem]!">
                {roleBadge.label}
              </span>
            {/if}
            {#if member.customBadges && member.customBadges.length > 0}
              {#each member.customBadges as b (b.text)}
                <span class="chat-role-badge chat-role-badge--{b.color} py-px! px-1! text-[0.5625rem]!">
                  {b.text}
                </span>
              {/each}
            {/if}
          </div>
          <span class="text-[0.6875rem] text-[var(--chat-meta-color)] truncate -mt-0.5">
            {subtitle}
          </span>
        </div>
      </div>

      {#if muted}
        <span
          class="text-[var(--chat-meta-color)] opacity-65 shrink-0 inline-flex items-center justify-center pr-0.5"
          aria-label="已静音"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
          </svg>
        </span>
      {/if}
    </button>
  {/snippet}

  {#snippet observerItem(obs: ChatOnlineMember | null)}
    {@const displayName = "旁观者"}
    {@const targetRoom = obs?.roomId || "chat"}
    {@const roomName =
      targetRoom === "interconnect"
        ? "互联茶室"
        : targetRoom === "chat"
          ? "闲聊"
          : targetRoom}
    {@const visitLabel = obs?.visitCount && obs.visitCount > 1 ? `第 ${obs.visitCount} 次来访` : "初次到访"}
    {@const subtitle = `${visitLabel} · ${roomName}`}
    {@const isFocused = obs ? obs.isFocused !== false : true}
    {@const muted = obs ? obs.isMuted !== false : false}
    {#if obs}
      <button
        type="button"
        class="chat-user-item group justify-between w-full text-left border-none bg-transparent cursor-pointer"
        aria-label="查看旁观者信息"
        onclick={() =>
          onOpenUserProfile?.({
            userKey: obs.userKey,
            authType: "guest",
            name: displayName,
            avatar: obs.avatar || "",
            badge: "旁观",
            badgeType: "tag",
            isAdmin: false,
            online: true,
            status: visitLabel,
            bio: obs.bio || "正在只读浏览聊天室",
            location: obs.location,
            roomId: obs.roomId,
            device: obs.device,
            connectedAt: obs.connectedAt,
            isFocused: obs.isFocused,
            isMuted: obs.isMuted,
            visitCount: obs.visitCount || 1,
            totalVisits: obs.visitCount || 1,
            firstSeenAt: obs.firstSeenAt || obs.connectedAt,
            totalDurationSec: obs.totalDurationSec,
            totalDurationFormatted: obs.totalDurationFormatted,
          })}
      >
        <div class="flex items-center gap-2.5 min-w-0 flex-1">
          <div class="relative shrink-0">
            <div class="chat-avatar-sm flex items-center justify-center bg-black/5 dark:bg-white/10 text-[var(--chat-meta-color)] group-hover:text-(--primary) transition-colors rounded-full">
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </div>
            <span
              class="chat-online-dot {isFocused ? '' : 'chat-online-dot--away'} absolute -bottom-0.5 -right-0.5 border-[1.5px] border-white/80 dark:border-neutral-900/80"
            ></span>
          </div>

          <div class="min-w-0 flex flex-col">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="truncate font-medium text-[var(--deep-text)] dark:text-white/90 group-hover:text-[var(--primary)] transition-colors">
                {displayName}
              </span>
            </div>
            <span class="text-[0.6875rem] text-[var(--chat-meta-color)] truncate -mt-0.5">
              {subtitle}
            </span>
          </div>
        </div>

        {#if muted}
          <span
            class="text-[var(--chat-meta-color)] opacity-65 shrink-0 inline-flex items-center justify-center pr-0.5"
            aria-label="已静音"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
            </svg>
          </span>
        {/if}
      </button>
    {/if}
  {/snippet}

  {#snippet spectatorHistoryItem(item: ChatSpectatorRecord)}
    {@const timeLabel = formatOfflineTime(item.connectedAt)}
    {@const targetRoom = item.lastRoom || "chat"}
    {@const roomName =
      targetRoom === "interconnect"
        ? "互联茶室"
        : targetRoom === "chat"
          ? "闲聊"
          : targetRoom}
    {@const visitLabel = item.visitCount && item.visitCount > 1 ? `第 ${item.visitCount} 次来访` : "初次到访"}
    {@const subtitle = `${timeLabel} · ${visitLabel}`}
    <button
      type="button"
      class="chat-user-item group justify-between w-full text-left border-none bg-transparent cursor-pointer opacity-70 hover:opacity-100 transition-opacity"
      aria-label="查看历史旁观者名片"
      onclick={() =>
        onOpenUserProfile?.({
          userKey: `${item.id}:${item.connectedAt}`,
          authType: "guest",
          name: "历史访客",
          avatar: "",
          badge: "历史访客",
          badgeType: "tag",
          isAdmin: false,
          online: false,
          status: `已离线 · ${visitLabel}`,
          bio: `曾游历房间：${item.roomsVisited?.map((r) => (r === "interconnect" ? "互联茶室" : r === "chat" ? "闲聊" : r)).join("、") || roomName}`,
          location: item.location || "未知归属地",
          roomId: targetRoom,
          device: item.os || "未知系统",
          connectedAt: item.connectedAt,
          disconnectedAt: item.disconnectedAt,
          durationFormatted: item.durationFormatted,
          roomsVisited: item.roomsVisited,
          visitCount: item.visitCount || 1,
          totalVisits: item.totalVisits || item.visitCount || 1,
          firstSeenAt: item.firstSeenAt || item.connectedAt,
          totalDurationSec: item.totalDurationSec,
          totalDurationFormatted: item.totalDurationFormatted,
          isFocused: false,
          isMuted: !item.listenedMusic,
        })}
    >
      <div class="flex items-center gap-2.5 min-w-0 flex-1">
        <div class="relative shrink-0">
          <div class="chat-avatar-sm flex items-center justify-center bg-black/5 dark:bg-white/10 text-[var(--chat-meta-color)] opacity-60 rounded-full">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </div>
          <span class="w-2 h-2 rounded-full bg-neutral-400 absolute -bottom-0.5 -right-0.5 border-[1.5px] border-white/80 dark:border-neutral-900/80"></span>
        </div>

        <div class="min-w-0 flex flex-col">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="truncate font-medium text-[var(--deep-text)] dark:text-white/90 group-hover:text-[var(--primary)] transition-colors">
              旁观者
            </span>
            <span class="text-[0.625rem] text-[var(--chat-meta-color)] opacity-60 truncate">
              {item.os || ""}
            </span>
          </div>
          <span class="text-[0.6875rem] text-[var(--chat-meta-color)] truncate -mt-0.5">
            {subtitle}
          </span>
        </div>
      </div>

      {#if item.listenedMusic}
        <span
          class="text-[var(--primary)] opacity-70 shrink-0 inline-flex items-center justify-center pr-0.5"
          aria-label="曾收听广播"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        </span>
      {/if}
    </button>
  {/snippet}

  <!-- 底部：当前登录 / 访客身份卡片（点击头像或昵称整块区域打开个人资料弹窗） -->
  <div class="chat-self-footer shrink-0">
    {#if currentUser}
      {@const selfBadge = resolveMemberRoleBadge(currentUser)}
      <button
        type="button"
        class="flex items-center gap-2.5 flex-1 min-w-0 text-left bg-transparent border-none p-1 -m-1 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
        aria-label="编辑个人资料"
        onclick={() => onOpenProfile?.()}
      >
        <div class="relative shrink-0">
          <ChatAvatar
            src={currentUser.avatar}
            name={currentUser.name}
            size="md"
          />
          <span
            class="chat-online-dot {isWindowFocused ? '' : 'chat-online-dot--away'} absolute bottom-0 right-0 border-2 border-white/80 dark:border-neutral-900/80"
          ></span>
        </div>
        <div class="flex flex-col min-w-0 flex-1">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-xs font-bold text-[var(--deep-text)] dark:text-white/90 truncate">
              {currentUser.name}
            </span>
            <span class="chat-role-badge chat-role-badge--{selfBadge.type}">
              {selfBadge.label}
            </span>
            {#if currentUser.customBadges && currentUser.customBadges.length > 0}
              {#each currentUser.customBadges as b (b.text)}
                <span class="chat-role-badge chat-role-badge--{b.color}">
                  {b.text}
                </span>
              {/each}
            {/if}
          </div>
          <span class="text-[0.6875rem] text-[var(--chat-meta-color)] truncate">
            {currentUser.status && currentUser.status !== "在线" ? currentUser.status : "点击设置状态..."}
          </span>
        </div>
      </button>

      <ChatTooltip text={notificationTooltip} position="top" align="right">
        <button
          type="button"
          class="chat-tool-btn w-7! h-7! shrink-0 {isNotificationActive ? 'text-[var(--chat-accent-text)]' : ''}"
          aria-label={notificationTooltip}
          onclick={() => onToggleDesktopNotification?.()}
        >
          <Icon icon={notificationIcon} class="w-4 h-4" />
        </button>
      </ChatTooltip>

      {#if onLogout}
        <ChatTooltip text="退出登录" position="top" align="right">
          <button
            type="button"
            class="chat-tool-btn w-7! h-7! shrink-0"
            aria-label="退出登录"
            onclick={onLogout}
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </ChatTooltip>
      {/if}
    {:else}
      <div class="chat-avatar flex items-center justify-center text-sm font-bold text-[var(--chat-meta-color)] shrink-0">
        ?
      </div>
      <div class="flex flex-col min-w-0 flex-1">
        <span class="text-xs font-semibold text-[var(--deep-text)] truncate">未登录（旁观）</span>
        <span class="text-[0.6875rem] text-[var(--chat-meta-color)] truncate">登录后即可发言与点歌</span>
      </div>
      <ChatTooltip text={notificationTooltip} position="top" align="right">
        <button
          type="button"
          class="chat-tool-btn w-7! h-7! shrink-0 {isNotificationActive ? 'text-[var(--chat-accent-text)]' : ''}"
          aria-label={notificationTooltip}
          onclick={() => onToggleDesktopNotification?.()}
        >
          <Icon icon={notificationIcon} class="w-4 h-4" />
        </button>
      </ChatTooltip>
      <button
        type="button"
        class="chat-queue-toggle-btn shrink-0"
        onclick={() => onOpenAuth?.()}
      >
        登录
      </button>
    {/if}
  </div>
</div>
