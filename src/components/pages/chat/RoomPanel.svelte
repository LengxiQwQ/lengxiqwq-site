<script lang="ts">
import type { ChatRoomMeta } from "@/types/chatConfig";
import ChatAvatar from "./ChatAvatar.svelte";
import type {
	ChatMentionCandidate,
	ChatOnlineMember,
	ChatSessionUser,
	ChatUserDetailSeed,
	ConnectionState,
} from "./chatTypes";

interface Props {
	rooms: ChatRoomMeta[];
	currentRoom: string;
	onlineMembers: ChatOnlineMember[];
	mentionMembers?: ChatMentionCandidate[];
	totalOnlineCount: number;
	totalChatterCount?: number;
	currentUser: ChatSessionUser | null;
	selfMuted?: boolean;
	connectionState: ConnectionState;
	isWindowFocused?: boolean;
	onRoomSelect?: (roomId: string) => void;
	onOpenUserProfile?: (seed: ChatUserDetailSeed) => void;
	onOpenProfile?: () => void;
	onOpenAuth?: () => void;
	onLogout?: () => void;
}

const {
	rooms = [{ id: "chat", name: "闲聊", subtitle: "随便聊聊日常与折腾" }],
	currentRoom = "chat",
	onlineMembers = [],
	mentionMembers = [],
	totalOnlineCount = 0,
	totalChatterCount = 0,
	currentUser = null,
	selfMuted = true,
	connectionState = "idle",
	isWindowFocused = true,
	onRoomSelect,
	onOpenUserProfile,
	onOpenProfile,
	onOpenAuth,
	onLogout,
}: Props = $props();

const observerCount = $derived(
	Math.max(0, totalOnlineCount - onlineMembers.length),
);

/** 未登录旁观者没有真实身份，按人数渲染匿名占位行 */
const observerSlots = $derived(
	Array.from({ length: observerCount }, (_, index) => index),
);

/** 互联房间（跨站联邦聊天）的房间 id */
const INTERCONNECT_ROOM_IDS = new Set(["interconnect"]);

const isCurrentInterconnect = $derived(INTERCONNECT_ROOM_IDS.has(currentRoom));

function isExternalMember(member: { userKey?: string; badge?: string }): boolean {
	if (!member) return false;
	const key = member.userKey || "";
	return key.startsWith("matrix:") || member.badge === "互联茶友";
}

/** 互联茶室模式：本站在线成员 */
const siteOnlineMembers = $derived(
	onlineMembers.filter(
		(m) => !isExternalMember(m) && (!m.roomId || m.roomId === currentRoom),
	),
);

/** 互联茶室模式：其他网站/外部在线成员 */
const externalOnlineMembers = $derived(
	onlineMembers.filter((m) => isExternalMember(m)),
);

/** 本站普通房间模式：纯净本站在线成员（彻底排除外部互联成员） */
const normalOnlineMembers = $derived(
	onlineMembers.filter(
		(m) => !isExternalMember(m) && (!m.roomId || m.roomId === currentRoom),
	),
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
	isAdmin: boolean;
	authType: "waline" | "guest";
}): { label: string; type: "host" | "accent" | "tag" } {
	if (user.isAdmin) return { label: "站长", type: "host" };
	if (user.authType === "waline") return { label: "认证", type: "accent" };
	return { label: "访客", type: "tag" };
}

const roomNameById = $derived(
	new Map(rooms.map((room) => [room.id, room.name] as const)),
);

/** 在线成员的副标题：状态 · 当前所在房间 */
function formatOnlineLine(member: ChatOnlineMember): string {
	const roomName = member.roomId ? roomNameById.get(member.roomId) : "";
	const status =
		member.status && member.status !== "在线" ? member.status.trim() : "";
	if (status && roomName) return `${status} · ${roomName}`;
	if (status) return status;
	if (roomName) return roomName;
	return "在线";
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

function formatOfflineTime(ts: number): string {
	if (!ts) return "离线";
	const diff = Date.now() - ts;
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
    <button
      type="button"
      class="chat-room-item {currentRoom === room.id ? 'active' : ''} text-left w-full border-none"
      onclick={() => onRoomSelect?.(room.id)}
    >
      <span class="font-mono text-sm font-bold opacity-60 w-4 text-center ml-1">#</span>
      <span class="flex-1 truncate">{room.name}</span>
      {#if currentRoom === room.id}
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
    <!-- 在线成员 -->
    <section>
      <div class="chat-section-title flex items-center justify-between pr-1">
        <span>在线成员</span>
        <span class="text-[0.6875rem] font-normal text-[var(--chat-meta-color)]">
          {isCurrentInterconnect
            ? `${siteOnlineMembers.length + externalOnlineMembers.length + observerCount} 人`
            : `${normalOnlineMembers.length + observerCount} 人`}
        </span>
      </div>

      {#if isCurrentInterconnect}
        <!-- 互联茶室模式：分为“本站”和“其他网站” -->
        {#if siteOnlineMembers.length + externalOnlineMembers.length + observerCount === 0}
          <div class="px-2 py-4 text-center text-xs text-[var(--chat-meta-color)]">
            {#if connectionState === "connected"}
              暂无已登录在线成员，发句话或点首歌露个面吧~
            {:else}
              正在同步成员列表...
            {/if}
          </div>
        {:else}
          <div class="space-y-2 mt-1">
            <!-- 本站在线 -->
            <div>
              <div class="text-[0.625rem] font-semibold text-[var(--chat-meta-color)] px-1 mb-1">
                本站在线 ({siteOnlineMembers.length + observerCount})
              </div>
              <div class="space-y-1">
                {#each siteOnlineMembers as member (member.userKey)}
                  {@render memberItem(member, true, false)}
                {/each}
                {#each observerSlots as slotIndex (slotIndex)}
                  {@render observerItem()}
                {/each}
              </div>
            </div>

            <!-- 其他网站在线 -->
            {#if externalOnlineMembers.length > 0}
              <div class="pt-1.5 border-t border-[var(--chat-divider-color)]/60">
                <div class="text-[0.625rem] font-semibold text-[var(--chat-meta-color)] px-1 mb-1 flex items-center justify-between">
                  <span>其他网站 ({externalOnlineMembers.length})</span>
                  <span class="text-[0.5625rem] font-normal opacity-70">互联节点活跃</span>
                </div>
                <div class="space-y-1">
                  {#each externalOnlineMembers as member (member.userKey)}
                    {@render memberItem(member, true, true)}
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/if}
      {:else}
        <!-- 本站普通房间模式：纯净显示当前房间本站在线成员 -->
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
            {#each observerSlots as slotIndex (slotIndex)}
              {@render observerItem()}
            {/each}
          </div>
        {/if}
      {/if}
    </section>

    <!-- 离线成员 -->
    {#if isCurrentInterconnect}
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

      {#if externalOfflineMembers.length > 0}
        <section class="pt-1 border-t border-[var(--chat-divider-color)]">
          <div class="chat-section-title flex items-center justify-between pr-1">
            <span>其他网站</span>
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
  </div>

  {#snippet memberItem(member: ChatOnlineMember | ChatMentionCandidate, isOnline: boolean, isExternal = false)}
    {@const roleBadge = resolveMemberRoleBadge(member)}
    {@const muted = isOnline ? isMemberMuted(member as ChatOnlineMember) : false}
    {@const isFocused = isOnline ? isMemberFocused(member as ChatOnlineMember) : false}
    <button
      type="button"
      class="chat-user-item group justify-between w-full text-left border-none bg-transparent {isOnline ? '' : 'opacity-75 hover:opacity-100'}"
      title={`查看 ${member.name} 的个人资料`}
      onclick={() =>
        onOpenUserProfile?.({
          userKey: member.userKey,
          authType: member.authType,
          name: member.name,
          avatar: member.avatar,
          url: member.url,
          badge: isExternal ? "互联茶友" : roleBadge.label,
          badgeType: isExternal ? "tag" : roleBadge.type,
          customBadges: member.customBadges,
          isAdmin: member.isAdmin,
          online: isOnline,
          status: member.status,
          bio: member.bio,
          location: member.location,
        })}
    >
      <div class="flex items-center gap-2.5 min-w-0 flex-1">
        <div class="relative shrink-0">
          <ChatAvatar
            src={member.avatar}
            name={member.name}
            size="sm"
            grayscale={!isOnline}
            mutedTone={!isOnline}
          />
          {#if isOnline}
            <span
              class="chat-online-dot {isFocused ? '' : 'chat-online-dot--away'} absolute -bottom-0.5 -right-0.5 border-[1.5px] border-white/80 dark:border-neutral-900/80"
              title={isFocused ? "在线（活跃中）" : "在线（离开焦点）"}
            ></span>
          {/if}
        </div>

        <div class="min-w-0 flex flex-col">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="truncate font-medium text-[var(--deep-text)] dark:text-white/90 group-hover:text-[var(--primary)] transition-colors">
              {member.name}
            </span>
            <span class="chat-role-badge chat-role-badge--{isExternal ? 'tag' : roleBadge.type} py-px! px-1! text-[0.5625rem]!">
              {isExternal ? "互联" : roleBadge.label}
            </span>
            {#if member.customBadges && member.customBadges.length > 0}
              {#each member.customBadges as b (b.text)}
                <span class="chat-role-badge chat-role-badge--{b.color} py-px! px-1! text-[0.5625rem]!">
                  {b.text}
                </span>
              {/each}
            {/if}
          </div>
          <span class="text-[0.6875rem] text-[var(--chat-meta-color)] truncate -mt-0.5">
            {isOnline ? formatOnlineLine(member as ChatOnlineMember) : formatOfflineTime((member as ChatMentionCandidate).lastSeenAt)}
          </span>
        </div>
      </div>

      {#if muted}
        <span
          class="text-[var(--chat-meta-color)] opacity-65 shrink-0 inline-flex items-center justify-center pr-0.5"
          title="已静音同步"
          aria-label="已静音"
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
          </svg>
        </span>
      {/if}
    </button>
  {/snippet}

  {#snippet observerItem()}
    <div class="chat-user-item justify-between w-full" title="未登录的旁观者">
      <div class="flex items-center gap-2.5 min-w-0 flex-1">
        <div class="relative shrink-0">
          <div class="chat-avatar-sm flex items-center justify-center bg-black/5 dark:bg-white/10 text-[var(--chat-meta-color)]">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5Z" />
            </svg>
          </div>
          <span class="chat-online-dot absolute -bottom-0.5 -right-0.5 border-[1.5px] border-white/80 dark:border-neutral-900/80"></span>
        </div>

        <div class="min-w-0 flex flex-col">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="truncate font-medium text-[var(--chat-meta-color)]">旁观</span>
          </div>
          <span class="text-[0.6875rem] text-[var(--chat-meta-color)] truncate -mt-0.5">
            只读旁观中
          </span>
        </div>
      </div>
    </div>
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

      {#if onLogout}
        <button
          type="button"
          class="chat-tool-btn w-7! h-7! shrink-0"
          aria-label="切换或退出当前身份"
          onclick={onLogout}
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      {/if}
    {:else}
      <div class="chat-avatar flex items-center justify-center text-sm font-bold text-[var(--chat-meta-color)] shrink-0">
        ?
      </div>
      <div class="flex flex-col min-w-0 flex-1">
        <span class="text-xs font-semibold text-[var(--deep-text)] truncate">未登录（旁观）</span>
        <span class="text-[0.6875rem] text-[var(--chat-meta-color)] truncate">登录后即可发言与点歌</span>
      </div>
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
