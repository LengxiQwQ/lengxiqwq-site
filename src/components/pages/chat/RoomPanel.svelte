<script lang="ts">
import type { ChatRoomMeta } from "@/types/chatConfig";
import type {
	ChatOnlineMember,
	ChatSessionUser,
	ConnectionState,
} from "./chatTypes";

interface Props {
	rooms: ChatRoomMeta[];
	currentRoom: string;
	onlineMembers: ChatOnlineMember[];
	totalOnlineCount: number;
	currentUser: ChatSessionUser | null;
	connectionState: ConnectionState;
	onRoomSelect?: (roomId: string) => void;
	onMentionUser?: (userName: string) => void;
	onOpenProfile?: () => void;
	onOpenAuth?: () => void;
	onLogout?: () => void;
}

const {
	rooms = [{ id: "chat", name: "闲聊", subtitle: "随便聊聊日常与折腾" }],
	currentRoom = "chat",
	onlineMembers = [],
	totalOnlineCount = 0,
	currentUser = null,
	connectionState = "idle",
	onRoomSelect,
	onMentionUser,
	onOpenProfile,
	onOpenAuth,
	onLogout,
}: Props = $props();

let avatarErrorMap = $state<Record<string, boolean>>({});
let selfAvatarFailed = $state(false);

$effect(() => {
	currentUser?.avatar;
	selfAvatarFailed = false;
});

const observerCount = $derived(
	Math.max(0, totalOnlineCount - onlineMembers.length),
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

  <!-- 房间列表（单房间闲聊聚焦，未来扩展多房间电台互不串台） -->
  <div class="p-2.5 shrink-0">
    <div class="chat-section-title">主题房间</div>
    <div class="flex flex-col gap-1 mt-0.5">
      {#each rooms as room (room.id)}
        <button
          type="button"
          class="chat-room-item {currentRoom === room.id ? 'active' : ''} text-left w-full border-none"
          onclick={() => onRoomSelect?.(room.id)}
        >
          <span class="font-mono text-sm font-bold opacity-60 w-4 text-center ml-1">#</span>
          <span class="flex-1 truncate">{room.name}</span>
          {#if currentRoom === room.id}
            <span class="text-[0.6875rem] text-[var(--chat-meta-color)]">{totalOnlineCount}</span>
          {/if}
        </button>
      {/each}
    </div>
  </div>

  <div class="chat-divider"></div>

  <!-- 在线成员 -->
  <div class="chat-section-title flex items-center justify-between pr-3 shrink-0">
    <span>在线成员</span>
    <span class="text-[0.6875rem] font-normal text-[var(--chat-meta-color)]">
      {onlineMembers.length} 人{observerCount > 0 ? ` (+${observerCount} 旁观)` : ""}
    </span>
  </div>

  <div class="flex-1 overflow-y-auto custom-scrollbar px-2.5 py-1 space-y-1 min-h-0">
    {#if onlineMembers.length === 0}
      <div class="px-2 py-6 text-center text-xs text-[var(--chat-meta-color)]">
        {#if connectionState === "connected"}
          暂无已认证在线成员，发句话或点首歌露个面吧~
        {:else}
          正在同步在线成员列表...
        {/if}
      </div>
    {:else}
      {#each onlineMembers as member (member.userKey)}
        {@const showImg = Boolean(member.avatar) && !avatarErrorMap[member.userKey]}
        <div class="chat-user-item group justify-between">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="relative shrink-0">
              {#if showImg}
                <img
                  src={member.avatar}
                  alt={member.name}
                  class="chat-avatar-sm"
                  onerror={() => {
                    avatarErrorMap = { ...avatarErrorMap, [member.userKey]: true };
                  }}
                />
              {:else}
                <div class="chat-avatar-sm flex items-center justify-center text-xs font-bold text-[var(--chat-accent-text)]">
                  {member.name.slice(0, 1)}
                </div>
              {/if}
              <span class="chat-online-dot absolute -bottom-0.5 -right-0.5 border-[1.5px] border-white/80 dark:border-neutral-900/80"></span>
            </div>

            <div class="min-w-0 flex flex-col">
              <div class="flex items-center gap-1.5 min-w-0">
                {#if member.url}
                  <a
                    href={member.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="truncate font-medium text-[var(--deep-text)] dark:text-white/90 hover:text-[var(--primary)] no-underline"
                    title={`访问 ${member.name} 的主页`}
                  >
                    {member.name}
                  </a>
                {:else}
                  <span class="truncate font-medium text-[var(--deep-text)] dark:text-white/90">
                    {member.name}
                  </span>
                {/if}
                {#if member.badge}
                  <span class="chat-role-badge chat-role-badge--{member.badgeType} py-px! px-1! text-[0.5625rem]!">
                    {member.badge}
                  </span>
                {/if}
              </div>
              <span class="text-[0.6875rem] text-[var(--chat-meta-color)] truncate -mt-0.5">
                {member.authType === "waline" ? "已认证" : "访客"} · {member.status}
              </span>
            </div>
          </div>

          <button
            type="button"
            class="opacity-55 group-hover:opacity-100 text-[var(--chat-meta-color)] hover:text-[var(--chat-accent-text)] text-xs font-semibold px-1.5 py-0.5 rounded-md hover:bg-[var(--card-bg)]/60 transition-all border-none bg-transparent cursor-pointer shrink-0"
            title={`@ ${member.name}`}
            aria-label={`提及 ${member.name}`}
            onclick={() => onMentionUser?.(member.name)}
          >
            @
          </button>
        </div>
      {/each}
    {/if}
  </div>

  <!-- 底部：当前登录 / 访客身份卡片（点击头像或昵称整块区域打开个人资料弹窗） -->
  <div class="chat-self-footer shrink-0">
    {#if currentUser}
      <button
        type="button"
        class="flex items-center gap-2.5 flex-1 min-w-0 text-left bg-transparent border-none p-1 -m-1 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
        aria-label="编辑个人资料"
        onclick={() => onOpenProfile?.()}
      >
        <div class="relative shrink-0">
          {#if currentUser.avatar && !selfAvatarFailed}
            <img
              src={currentUser.avatar}
              alt={currentUser.name}
              class="chat-avatar"
              onerror={() => (selfAvatarFailed = true)}
            />
          {:else}
            <div class="chat-avatar flex items-center justify-center text-sm font-bold text-[var(--chat-accent-text)]">
              {currentUser.name.slice(0, 1)}
            </div>
          {/if}
          <span class="chat-online-dot absolute bottom-0 right-0 border-2 border-white/80 dark:border-neutral-900/80"></span>
        </div>
        <div class="flex flex-col min-w-0 flex-1">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-xs font-bold text-[var(--deep-text)] dark:text-white/90 truncate">
              {currentUser.name}
            </span>
            {#if currentUser.badge}
              <span class="chat-role-badge chat-role-badge--{currentUser.badgeType}">
                {currentUser.badge}
              </span>
            {/if}
          </div>
          <span class="text-[0.6875rem] text-[var(--chat-meta-color)] truncate">
            {currentUser.authType === "waline" ? "已认证" : "访客"} · {currentUser.status || "在线"}
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
