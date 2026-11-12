<script lang="ts">
import { onMount } from "svelte";
import type { ChatProfileDraft, ChatSessionUser } from "./chatTypes";

interface Props {
	open: boolean;
	currentUser: ChatSessionUser | null;
	onSave: (draft: ChatProfileDraft) => void;
	onClose: () => void;
}

const { open, currentUser = null, onSave, onClose }: Props = $props();

const PUBLIC_BADGE_PRESETS: { label: string; value: string }[] = [
	{ label: "点歌达人", value: "点歌达人" },
	{ label: "夜猫子", value: "夜猫子" },
	{ label: "代码宅", value: "代码宅" },
	{ label: "摸鱼中", value: "摸鱼中" },
	{ label: "路过", value: "路过" },
	{ label: "无头衔", value: "" },
];

const STATUS_PRESETS = ["在线", "听歌中", "摸鱼中", "忙碌中", "潜水"];

let draftNickname = $state("");
let draftBadge = $state("");
let draftStatus = $state("在线");
let draftUrl = $state("");
let draftAvatar = $state("");
let draftNotifyEmail = $state(true);
let previewAvatarFailed = $state(false);
let initialAvatar = "";
let avatarEdited = false;

$effect(() => {
	if (open && currentUser) {
		draftNickname = currentUser.name;
		draftBadge = currentUser.isAdmin ? "站长" : currentUser.badge;
		draftStatus = currentUser.status || "在线";
		draftUrl = currentUser.url || "";
		draftAvatar = currentUser.avatar || "";
		draftNotifyEmail = currentUser.notifyEmail !== false;
		initialAvatar = currentUser.avatar || "";
		avatarEdited = false;
		previewAvatarFailed = false;
	}
});

$effect(() => {
	draftAvatar;
	previewAvatarFailed = false;
});

onMount(() => {
	const handleKeydown = (e: KeyboardEvent) => {
		if (open && e.key === "Escape") {
			onClose();
		}
	};
	document.addEventListener("keydown", handleKeydown);
	return () => document.removeEventListener("keydown", handleKeydown);
});

function handleSubmit(e: SubmitEvent) {
	e.preventDefault();
	if (!currentUser) return;
	const payload: ChatProfileDraft = {
		nickname: draftNickname.trim().slice(0, 16) || currentUser.name,
		badge: currentUser.isAdmin ? "站长" : draftBadge.trim().slice(0, 10),
		status: draftStatus.trim().slice(0, 16) || "在线",
		url: draftUrl.trim().slice(0, 200),
		notifyEmail: draftNotifyEmail,
	};
	if (avatarEdited || draftAvatar.trim() !== initialAvatar) {
		payload.avatar = draftAvatar.trim().slice(0, 400);
	}
	onSave(payload);
	onClose();
}
</script>

{#if open && currentUser}
  <div
    class="chat-modal-backdrop"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
  >
    <div
      class="chat-auth-modal"
      role="dialog"
      aria-modal="true"
      aria-label="编辑个人资料"
    >
      <div class="flex items-center justify-between px-4 pt-3.5 pb-2 border-b border-black/5 dark:border-white/10">
        <div>
          <h3 class="text-sm font-bold text-[var(--deep-text)] m-0">个人资料</h3>
          <p class="text-[11px] text-[var(--chat-meta-color)] mt-0.5 mb-0">
            修改后将实时同步至在线成员列表与后续消息
          </p>
        </div>
        <button
          type="button"
          class="chat-tool-btn w-7! h-7!"
          aria-label="关闭弹窗"
          onclick={onClose}
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <form class="px-3.5 pb-3.5 pt-1 space-y-2.5 max-h-[75dvh] overflow-y-auto custom-scrollbar" onsubmit={handleSubmit}>
        <!-- 名片预览 -->
        <div>
          <div class="chat-settings-section-title">
            <span>名片预览</span>
          </div>
          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2.5 flex items-center gap-3">
            {#if draftAvatar.trim() && !previewAvatarFailed}
              <img
                src={draftAvatar.trim()}
                alt="头像预览"
                class="chat-avatar"
                onerror={() => (previewAvatarFailed = true)}
              />
            {:else}
              <div class="chat-avatar flex items-center justify-center font-bold text-sm text-[var(--chat-accent-text)]">
                {(draftNickname.trim() || currentUser.name).slice(0, 1)}
              </div>
            {/if}
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="text-xs font-bold text-[var(--deep-text)] truncate">
                  {draftNickname.trim() || currentUser.name}
                </span>
                {#if draftBadge.trim()}
                  <span class="chat-role-badge chat-role-badge--{currentUser.badgeType}">
                    {draftBadge.trim()}
                  </span>
                {/if}
              </div>
              <div class="text-[11px] text-[var(--chat-meta-color)] truncate mt-0.5">
                {currentUser.authType === "waline" ? "已认证" : "访客"} · {draftStatus.trim() || "在线"}
              </div>
            </div>
          </div>
        </div>

        <!-- 基本资料 -->
        <div>
          <div class="chat-settings-section-title">
            <span>基本资料</span>
          </div>
          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2.5 space-y-2.5">
            <div>
              <label for="profile-modal-nick" class="block text-xs font-medium text-(--btn-content) opacity-85 mb-1">
                展示昵称
              </label>
              <input
                id="profile-modal-nick"
                type="text"
                maxlength={16}
                bind:value={draftNickname}
                placeholder="输入展示昵称"
                class="chat-auth-input"
              />
            </div>

            {#if currentUser.isAdmin}
              <div class="flex items-center justify-between pt-0.5">
                <span class="text-xs font-medium text-(--btn-content) opacity-85">头衔标签</span>
                <div class="flex items-center gap-2">
                  <span class="chat-role-badge chat-role-badge--host">站长</span>
                  <span class="text-[11px] text-(--content-meta)">固定站长头衔</span>
                </div>
              </div>
            {:else}
              <div>
                <label for="profile-modal-badge" class="block text-xs font-medium text-(--btn-content) opacity-85 mb-1">
                  头衔标签（保留头衔除外）
                </label>
                <input
                  id="profile-modal-badge"
                  type="text"
                  maxlength={10}
                  bind:value={draftBadge}
                  placeholder="自定义头衔（留空隐藏）"
                  class="chat-auth-input mb-1.5"
                />
                <div class="grid grid-cols-3 gap-1.5">
                  {#each PUBLIC_BADGE_PRESETS as preset (preset.label)}
                    <button
                      type="button"
                      class="btn-regular rounded-md py-1.5 px-2 text-xs font-medium active:scale-95 transition-all cursor-pointer border-none
                        {draftBadge === preset.value ? 'bg-(--btn-regular-bg-hover) text-(--primary) font-semibold' : 'opacity-75'}"
                      onclick={() => (draftBadge = preset.value)}
                    >
                      {preset.label}
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        </div>

        <!-- 在线状态 -->
        <div>
          <div class="chat-settings-section-title">
            <span>在线状态</span>
          </div>
          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2.5 space-y-2">
            <input
              id="profile-modal-status"
              type="text"
              maxlength={16}
              bind:value={draftStatus}
              placeholder="例如：听歌中 / 摸鱼中"
              class="chat-auth-input"
            />
            <div class="grid grid-cols-5 gap-1">
              {#each STATUS_PRESETS as preset (preset)}
                <button
                  type="button"
                  class="btn-regular rounded-md py-1.5 px-1 text-[11px] font-medium active:scale-95 transition-all cursor-pointer border-none truncate
                    {draftStatus === preset ? 'bg-(--btn-regular-bg-hover) text-(--primary) font-semibold' : 'opacity-75'}"
                  onclick={() => (draftStatus = preset)}
                >
                  {preset}
                </button>
              {/each}
            </div>
          </div>
        </div>

        <!-- 主页与头像 -->
        <div>
          <div class="chat-settings-section-title">
            <span>主页与头像</span>
          </div>
          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2.5 space-y-2.5">
            <div>
              <label for="profile-modal-url" class="block text-xs font-medium text-(--btn-content) opacity-85 mb-1">
                个人主页（可选）
              </label>
              <input
                id="profile-modal-url"
                type="text"
                maxlength={200}
                bind:value={draftUrl}
                placeholder="https://your-site.com"
                class="chat-auth-input"
              />
            </div>

            <div>
              <div class="flex items-center justify-between mb-1">
                <label for="profile-modal-avatar" class="block text-xs font-medium text-(--btn-content) opacity-85">
                  自定义头像链接（可选）
                </label>
                <button
                  type="button"
                  class="text-[11px] font-medium text-(--primary) bg-transparent border-none cursor-pointer p-0 hover:underline"
                  onclick={() => {
                    draftAvatar = "";
                    avatarEdited = true;
                  }}
                >
                  恢复默认
                </button>
              </div>
              <input
                id="profile-modal-avatar"
                type="url"
                maxlength={400}
                bind:value={draftAvatar}
                oninput={() => (avatarEdited = true)}
                placeholder="留空或点恢复默认即使用账号默认头像"
                class="chat-auth-input"
              />
            </div>
          </div>
        </div>

        <!-- 离线提醒 -->
        <div>
          <div class="chat-settings-section-title">
            <span>消息提醒</span>
          </div>
          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2.5 flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="text-xs font-medium text-(--btn-content)">离线 @ 邮件提醒</div>
              <div class="text-[11px] text-(--content-meta) mt-0.5">
                不在线时有人 @你，将发送聊天摘要邮件至账号邮箱
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={draftNotifyEmail}
              aria-label="切换离线 @ 邮件提醒"
              class="p-0 border-none bg-transparent cursor-pointer shrink-0"
              onclick={() => (draftNotifyEmail = !draftNotifyEmail)}
            >
              <span class="chat-switch-track {draftNotifyEmail ? 'checked' : ''}" aria-hidden="true">
                <span class="chat-switch-thumb"></span>
              </span>
            </button>
          </div>
        </div>

        <div class="flex items-center gap-2 pt-1">
          <button
            type="button"
            class="btn-regular flex-1 h-9 rounded-xl text-xs font-medium active:scale-95 transition-all cursor-pointer border-none"
            onclick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            class="chat-send-btn flex-1 h-9! rounded-xl! text-xs!"
          >
            保存资料
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}
