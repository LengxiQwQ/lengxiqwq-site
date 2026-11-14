<script lang="ts">
import ChatAvatar from "./ChatAvatar.svelte";
import ChatModal from "./ChatModal.svelte";
import { normalizeServerUrl } from "./chatClient";
import {
	CHAT_STATUS_PRESETS,
	type ChatProfileDraft,
	type ChatSessionUser,
	type ChatStatusPreset,
} from "./chatTypes";

interface Props {
	open: boolean;
	currentUser: ChatSessionUser | null;
	walineServerUrl?: string;
	onSave: (draft: ChatProfileDraft) => void;
	onClose: () => void;
}

const {
	open,
	currentUser = null,
	walineServerUrl = "",
	onSave,
	onClose,
}: Props = $props();

const walineProfileUrl = $derived.by(() => {
	const base = normalizeServerUrl(walineServerUrl);
	return base ? `${base}/ui/profile?lng=zh-CN` : "";
});

let draftNickname = $state("");
let draftStatus = $state("");
let draftBio = $state("");
let draftUrl = $state("");
let draftAvatar = $state("");
let draftNotifyEmail = $state(true);
let initialAvatar = "";
let avatarEdited = false;

const roleBadge = $derived.by(() => {
	if (!currentUser) {
		return { label: "访客", type: "tag" as const, hint: "固定访客头衔" };
	}
	if (currentUser.isAdmin) {
		return { label: "站长", type: "host" as const, hint: "固定站长头衔" };
	}
	if (currentUser.authType === "waline") {
		return {
			label: "认证",
			type: "accent" as const,
			hint: "Waline 登录固定头衔",
		};
	}
	return { label: "访客", type: "tag" as const, hint: "访客登录固定头衔" };
});

const isIsolatedGuest = $derived(
	Boolean(
		currentUser?.authType === "guest" &&
			(currentUser?.isolated || currentUser?.userKey.startsWith("guest:iso_")),
	),
);

$effect(() => {
	if (open && currentUser) {
		draftNickname = currentUser.name;
		draftStatus =
			currentUser.status &&
			CHAT_STATUS_PRESETS.includes(currentUser.status as ChatStatusPreset)
				? currentUser.status
				: "";
		draftBio = currentUser.bio || "";
		draftUrl = currentUser.url || "";
		draftAvatar = currentUser.avatar || "";
		draftNotifyEmail = isIsolatedGuest
			? false
			: currentUser.notifyEmail !== false;
		initialAvatar = currentUser.avatar || "";
		avatarEdited = false;
	}
});

function handleSubmit(e: SubmitEvent) {
	e.preventDefault();
	if (!currentUser) return;
	const statusValue = CHAT_STATUS_PRESETS.includes(
		draftStatus as ChatStatusPreset,
	)
		? draftStatus
		: "";
	const payload: ChatProfileDraft = {
		nickname: draftNickname.trim().slice(0, 16) || currentUser.name,
		badge: roleBadge.label,
		status: statusValue,
		bio: draftBio.trim().slice(0, 80),
		url: draftUrl.trim().slice(0, 200),
		notifyEmail: isIsolatedGuest ? false : draftNotifyEmail,
	};
	if (avatarEdited || draftAvatar.trim() !== initialAvatar) {
		payload.avatar = draftAvatar.trim().slice(0, 400);
	}
	onSave(payload);
	onClose();
}
</script>

<ChatModal
  open={open && Boolean(currentUser)}
  title="个人资料"
  subtitle="修改后将实时同步至在线成员列表与后续消息"
  ariaLabel="编辑个人资料"
  size="md"
  {onClose}
>
  {#if currentUser}
    <form class="flex-1 min-h-0 flex flex-col overflow-hidden" onsubmit={handleSubmit}>
      <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3.5 sm:p-4 space-y-3">
        <!-- 顶部通栏实时名片预览 -->
        <div class="rounded-xl bg-(--btn-regular-bg) px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div class="flex items-center gap-3 min-w-0">
            <ChatAvatar
              src={draftAvatar.trim()}
              name={draftNickname.trim() || currentUser.name}
              alt="头像预览"
              size="md"
            />
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
                <span class="text-xs font-bold text-[var(--deep-text)] truncate">
                  {draftNickname.trim() || currentUser.name}
                </span>
                <span class="chat-role-badge chat-role-badge--{roleBadge.type}">
                  {roleBadge.label}
                </span>
                {#if currentUser.customBadges && currentUser.customBadges.length > 0}
                  {#each currentUser.customBadges as b (b.text)}
                    <span class="chat-role-badge chat-role-badge--{b.color}">{b.text}</span>
                  {/each}
                {/if}
              </div>
              <div class="text-[11px] text-[var(--chat-meta-color)] truncate mt-0.5">
                {draftStatus.trim() || "在线"}
              </div>
            </div>
          </div>

          <div class="min-w-0 sm:max-w-[50%] sm:text-right space-y-0.5">
            <div class="text-[11px] text-[var(--deep-text)]/80 truncate">
              {draftBio.trim() || "暂未填写个人简介"}
            </div>
            <div class="flex items-center gap-1.5 flex-wrap sm:justify-end text-[10px] text-[var(--chat-meta-color)]">
              {#if currentUser?.location}
                <span class="inline-flex items-center gap-1 font-medium text-[var(--chat-meta-color)]">
                  <svg class="w-3 h-3 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
                    <circle cx="12" cy="10" r="3" />
                  </svg>
                  <span>{currentUser.location}</span>
                </span>
              {/if}
              {#if draftUrl.trim()}
                {#if currentUser?.location}
                  <span class="opacity-40 select-none">·</span>
                {/if}
                <span class="text-[var(--chat-accent-text)] truncate opacity-85">
                  {draftUrl.trim()}
                </span>
              {/if}
            </div>
          </div>
        </div>

        <!-- 下方左右对称两栏表单 -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3.5 items-start">
          <!-- 左栏：基本资料 + 在线状态 -->
          <div class="space-y-3">
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

                <div>
                  <label for="profile-modal-bio" class="block text-xs font-medium text-(--btn-content) opacity-85 mb-1">
                    个性签名（可选，最多 80 字）
                  </label>
                  <input
                    id="profile-modal-bio"
                    type="text"
                    maxlength={80}
                    bind:value={draftBio}
                    placeholder="写一句简短介绍，别人点击你的头像时可见"
                    class="chat-auth-input"
                  />
                </div>
              </div>
            </div>

            <div>
              <div class="chat-settings-section-title">
                <span>个性状态</span>
              </div>
              <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2.5 space-y-2">
                <div class="flex items-center justify-between text-xs text-[var(--btn-content)] opacity-85 px-0.5">
                  <span class="text-[11px]">点选状态标签：</span>
                  {#if draftStatus}
                    <button
                      type="button"
                      class="text-[11px] text-[var(--primary)] hover:underline bg-transparent border-none cursor-pointer p-0 font-normal"
                      onclick={() => (draftStatus = "")}
                    >
                      清除状态
                    </button>
                  {/if}
                </div>
                <div class="grid grid-cols-4 gap-1.5 max-h-28 overflow-y-auto custom-scrollbar pr-1 pt-0.5">
                  {#each CHAT_STATUS_PRESETS as preset (preset)}
                    <button
                      type="button"
                      class="w-full text-center px-1 py-1 text-xs rounded-lg font-medium active:scale-95 transition-all cursor-pointer border truncate
                        {draftStatus === preset
                          ? 'bg-[var(--primary)] text-white border-[var(--primary)] shadow-xs font-semibold'
                          : 'bg-(--btn-regular-bg) hover:bg-(--btn-regular-bg-hover) text-(--btn-content) opacity-80 hover:opacity-100 border-black/5 dark:border-white/10'}"
                      onclick={() => (draftStatus = draftStatus === preset ? "" : preset)}
                    >
                      {preset}
                    </button>
                  {/each}
                </div>
              </div>
            </div>
          </div>

          <!-- 右栏：主页与头像 + 个人设置 -->
          <div class="space-y-3">
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

            <div>
              <div class="chat-settings-section-title">
                <span>个人设置</span>
              </div>
              <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-3 flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-xs font-medium text-(--btn-content)">离线 @ 与回复邮件提醒</div>
                  <div class="text-[11px] text-(--content-meta) mt-0.5 leading-relaxed">
                    {#if isIsolatedGuest}
                      独立临时身份未经邮箱所有权验证，已禁用离线邮件提醒，防止误发邮件
                    {:else}
                      不在线时有人 @ 或回复你，将发送摘要邮件至账号邮箱
                    {/if}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isIsolatedGuest ? false : draftNotifyEmail}
                  aria-label="切换离线 @ 邮件提醒"
                  disabled={isIsolatedGuest}
                  class="p-0 border-none bg-transparent shrink-0 {isIsolatedGuest ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'}"
                  onclick={() => {
                    if (isIsolatedGuest) return;
                    draftNotifyEmail = !draftNotifyEmail;
                  }}
                >
                  <span class="chat-switch-track {!isIsolatedGuest && draftNotifyEmail ? 'checked' : ''}" aria-hidden="true">
                    <span class="chat-switch-thumb"></span>
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="shrink-0 flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-(--chat-divider-color)">
        {#if walineProfileUrl}
          <a
            href={walineProfileUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="btn-regular h-9 px-3 rounded-xl text-xs font-medium inline-flex items-center gap-1.5 no-underline shrink-0"
          >
            <span>{currentUser.authType === "waline" ? "Waline 个人中心" : "前往 Waline 平台"}</span>
            <span class="text-[11px] opacity-80">↗</span>
          </a>
        {/if}

        <div class="flex items-center gap-2 ml-auto flex-1 sm:flex-initial justify-end">
          <button
            type="button"
            class="btn-regular flex-1 sm:flex-none md:min-w-24 h-9 px-4 rounded-xl text-xs font-medium active:scale-95 transition-all cursor-pointer border-none"
            onclick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            class="chat-send-btn flex-1 sm:flex-none md:min-w-28 h-9! px-5! rounded-xl! text-xs!"
          >
            保存资料
          </button>
        </div>
      </div>
    </form>
  {/if}
</ChatModal>
