<script lang="ts">
import { onMount } from "svelte";
import ChatAvatar from "./ChatAvatar.svelte";
import ChatModal from "./ChatModal.svelte";
import {
	openWalineLoginPopup,
	previewAvatarFromEmail,
	readStoredGuestMeta,
	registerGuestSession,
} from "./chatClient";
import type { ChatSessionUser } from "./chatTypes";

interface Props {
	open: boolean;
	chatServerUrl: string;
	walineServerUrl: string;
	onAuthenticated: (
		auth: { kind: "waline" | "guest"; token: string },
		user?: ChatSessionUser,
	) => void;
	onClose: () => void;
}

const {
	open,
	chatServerUrl,
	walineServerUrl,
	onAuthenticated,
	onClose,
}: Props = $props();

// 账号授权窗口状态
let walinePopupWaiting = $state(false);

// 访客身份表单状态
let guestNick = $state("");
let guestEmail = $state("");
let guestUrl = $state("");
let guestLoading = $state(false);
let guestError = $state("");

let cancelPopup: (() => void) | null = null;
let lastOpenState = false;

const guestAvatarPreview = $derived(previewAvatarFromEmail(guestEmail));

function hydrateStoredGuestFields() {
	const meta = readStoredGuestMeta();
	if (!guestNick.trim() && meta.nickname) guestNick = meta.nickname;
	if (!guestEmail.trim() && meta.email) guestEmail = meta.email;
	if (!guestUrl.trim() && meta.url) guestUrl = meta.url;
}

$effect(() => {
	if (open && !lastOpenState) {
		lastOpenState = true;
		guestError = "";
		hydrateStoredGuestFields();
	} else if (!open) {
		lastOpenState = false;
	}
});

onMount(() => {
	hydrateStoredGuestFields();
	return () => {
		cancelPopup?.();
	};
});

function handleOpenWalinePopup() {
	walinePopupWaiting = true;
	cancelPopup?.();
	cancelPopup = openWalineLoginPopup(
		walineServerUrl,
		(token) => {
			walinePopupWaiting = false;
			onAuthenticated({ kind: "waline", token });
			onClose();
		},
		() => {
			walinePopupWaiting = false;
		},
	);
}

async function handleGuestSubmit(e: SubmitEvent) {
	e.preventDefault();
	guestError = "";
	if (!guestNick.trim()) {
		guestError = "请填写昵称";
		return;
	}
	if (!guestEmail.trim()) {
		guestError = "请填写有效邮箱";
		return;
	}

	guestLoading = true;
	const res = await registerGuestSession(chatServerUrl, {
		nickname: guestNick.trim(),
		email: guestEmail.trim(),
		url: guestUrl.trim(),
	});
	guestLoading = false;

	if (!res.ok || !res.token || !res.user) {
		guestError = res.error || "访客验证失败";
		return;
	}

	onAuthenticated({ kind: "guest", token: res.token }, res.user);
	onClose();
}
</script>

<ChatModal
  {open}
  title="登录聊天室"
  subtitle="登录后即可发言、传图与点歌"
  size="sm"
  {onClose}
>
  <div class="px-4 pb-4 pt-3 space-y-3 flex-1 min-h-0 overflow-y-auto custom-scrollbar">
    <!-- 主推方式：直接打开 Waline 授权窗口 -->
    <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-3 space-y-2.5">
      <div class="text-[11px] text-(--content-meta) leading-relaxed">
        与博客评论区共用账号，点击直接打开 Waline 授权登录。
      </div>
      <button
        type="button"
        disabled={walinePopupWaiting}
        onclick={handleOpenWalinePopup}
        class="chat-send-btn w-full h-9! text-xs! disabled:opacity-60"
      >
        {walinePopupWaiting ? "等待 Waline 完成登录..." : "打开 Waline 授权窗口"}
      </button>
    </div>

    <div class="flex items-center gap-2 text-[11px] text-[var(--chat-meta-color)]">
      <span class="flex-1 h-px bg-black/8 dark:bg-white/10"></span>
      <span>其他方式</span>
      <span class="flex-1 h-px bg-black/8 dark:bg-white/10"></span>
    </div>

    <!-- 其他方式：直接填写访客信息进入 -->
    <form
      class="space-y-2.5"
      method="post"
      action="/chat/"
      autocomplete="on"
      onsubmit={handleGuestSubmit}
    >
      <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2 flex items-center gap-2.5">
        <ChatAvatar
          src={guestAvatarPreview}
          name={guestNick.trim()}
          fallback="?"
          alt="头像预览"
          size="md"
        />
        <div class="min-w-0 flex-1">
          <div class="text-xs font-bold text-[var(--deep-text)] truncate">
            {guestNick.trim() || "访客名片"}
          </div>
          <div class="text-[11px] text-[var(--chat-meta-color)] truncate mt-0.5">
            根据邮箱匹配头像 · 与评论区名片同步
          </div>
        </div>
      </div>

      <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2.5 space-y-2">
        <div>
          <label for="chat-guest-nick" class="block text-xs font-medium text-(--btn-content) opacity-85 mb-1">
            昵称 <span class="text-red-500">*</span>
          </label>
          <input
            id="chat-guest-nick"
            name="nickname"
            type="text"
            autocomplete="nickname"
            maxlength={16}
            required
            bind:value={guestNick}
            placeholder="输入昵称（最多 16 字）"
            class="chat-auth-input"
          />
        </div>

        <div>
          <label for="chat-guest-email" class="block text-xs font-medium text-(--btn-content) opacity-85 mb-1">
            邮箱 <span class="text-red-500">*</span>
          </label>
          <input
            id="chat-guest-email"
            name="email"
            type="email"
            autocomplete="email"
            maxlength={128}
            required
            bind:value={guestEmail}
            placeholder="name@example.com"
            class="chat-auth-input"
          />
        </div>

        <div>
          <label for="chat-guest-url" class="block text-xs font-medium text-(--btn-content) opacity-85 mb-1">
            个人主页（可选）
          </label>
          <input
            id="chat-guest-url"
            name="url"
            type="text"
            inputmode="url"
            autocomplete="url"
            maxlength={200}
            bind:value={guestUrl}
            placeholder="https://your-site.com"
            class="chat-auth-input"
          />
        </div>
      </div>

      {#if guestError}
        <p class="text-xs text-red-500 m-0">{guestError}</p>
      {/if}

      <button
        type="submit"
        disabled={guestLoading}
        class="btn-regular w-full h-9 rounded-xl text-xs font-medium active:scale-95 transition-all cursor-pointer border-none disabled:opacity-60"
      >
        {guestLoading ? "正在进入..." : "确认进入"}
      </button>
    </form>
  </div>
</ChatModal>
