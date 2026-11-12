<script lang="ts">
import { onMount } from "svelte";
import {
	loginWalineWithPassword,
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

// 账号登录优先，访客身份作为右侧备选
let mode = $state<"waline" | "guest">("waline");

// 账号登录状态
let walineEmail = $state("");
let walinePassword = $state("");
let waline2fa = $state("");
let need2fa = $state(false);
let walineLoading = $state(false);
let walinePopupWaiting = $state(false);
let walineError = $state("");

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
		walineError = "";
		guestError = "";
		hydrateStoredGuestFields();
	} else if (!open) {
		lastOpenState = false;
	}
});

onMount(() => {
	hydrateStoredGuestFields();

	const handleKeydown = (e: KeyboardEvent) => {
		if (open && e.key === "Escape") {
			onClose();
		}
	};
	document.addEventListener("keydown", handleKeydown);
	return () => {
		document.removeEventListener("keydown", handleKeydown);
		cancelPopup?.();
	};
});

async function handleWalinePasswordLogin(e: SubmitEvent) {
	e.preventDefault();
	walineError = "";
	if (!walineEmail.trim() || !walinePassword) {
		walineError = "请输入邮箱和密码";
		return;
	}

	walineLoading = true;
	const res = await loginWalineWithPassword(
		walineServerUrl,
		walineEmail,
		walinePassword,
		need2fa ? waline2fa : undefined,
	);
	walineLoading = false;

	if (!res.ok || !res.token) {
		if (res.need2fa) need2fa = true;
		walineError = res.error || "登录失败";
		return;
	}

	onAuthenticated({ kind: "waline", token: res.token });
	onClose();
}

function handleOpenWalinePopup() {
	walineError = "";
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

{#if open}
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
      aria-label="登录聊天室"
    >
      <div class="flex items-center justify-between px-4 pt-3.5 pb-2.5 border-b border-black/5 dark:border-white/10">
        <div>
          <h3 class="text-sm font-bold text-[var(--deep-text)] m-0">登录聊天室</h3>
          <p class="text-[11px] text-[var(--chat-meta-color)] mt-0.5 mb-0">
            登录后即可发言、传图与点歌
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

      <!-- 方式切换：账号登录优先，访客身份在右侧 -->
      <div class="px-4 pt-3">
        <div class="chat-auth-tabs" role="tablist" aria-label="登录方式切换">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "waline"}
            class="chat-auth-tab {mode === 'waline' ? 'active' : ''}"
            onclick={() => (mode = "waline")}
          >
            账号登录
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "guest"}
            class="chat-auth-tab {mode === 'guest' ? 'active' : ''}"
            onclick={() => (mode = "guest")}
          >
            访客身份
          </button>
        </div>
      </div>

      {#if mode === "waline"}
        <div class="px-4 pb-4 pt-3 space-y-3">
          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-3 space-y-2.5">
            <div class="text-[11px] text-(--content-meta) leading-relaxed">
              与博客评论区共用账号，推荐直接通过授权窗口一键登录。
            </div>
            <button
              type="button"
              disabled={walinePopupWaiting}
              onclick={handleOpenWalinePopup}
              class="chat-send-btn w-full h-9! text-xs! disabled:opacity-60"
            >
              {walinePopupWaiting ? "等待授权窗口完成登录..." : "打开授权窗口登录（GitHub / QQ 等）"}
            </button>
          </div>

          <div class="flex items-center gap-2 text-[11px] text-[var(--chat-meta-color)]">
            <span class="flex-1 h-px bg-black/8 dark:bg-white/10"></span>
            <span>其他方式</span>
            <span class="flex-1 h-px bg-black/8 dark:bg-white/10"></span>
          </div>

          <form
            class="rounded-xl bg-(--btn-regular-bg) px-3 py-3 space-y-2.5"
            method="post"
            action="/chat/"
            autocomplete="on"
            onsubmit={handleWalinePasswordLogin}
          >
            <div>
              <label for="chat-waline-email" class="block text-xs font-medium text-(--btn-content) opacity-85 mb-1">
                账号邮箱
              </label>
              <input
                id="chat-waline-email"
                name="email"
                type="email"
                autocomplete="username"
                required
                bind:value={walineEmail}
                placeholder="name@example.com"
                class="chat-auth-input"
              />
            </div>

            <div>
              <label for="chat-waline-pass" class="block text-xs font-medium text-(--btn-content) opacity-85 mb-1">
                密码
              </label>
              <input
                id="chat-waline-pass"
                name="password"
                type="password"
                autocomplete="current-password"
                required
                bind:value={walinePassword}
                placeholder="输入登录密码"
                class="chat-auth-input"
              />
            </div>

            {#if need2fa}
              <div>
                <label for="chat-waline-2fa" class="block text-xs font-medium text-(--btn-content) opacity-85 mb-1">
                  两步验证码
                </label>
                <input
                  id="chat-waline-2fa"
                  name="otp"
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  maxlength={6}
                  required
                  bind:value={waline2fa}
                  placeholder="6 位动态验证码"
                  class="chat-auth-input"
                />
              </div>
            {/if}

            {#if walineError}
              <p class="text-xs text-red-500 m-0">{walineError}</p>
            {/if}

            <button
              type="submit"
              disabled={walineLoading}
              class="btn-regular w-full h-9 rounded-xl text-xs font-medium active:scale-95 transition-all cursor-pointer border-none disabled:opacity-60"
            >
              {walineLoading ? "验证中..." : "账号密码登录"}
            </button>
          </form>
        </div>
      {:else}
        <form
          class="px-4 pb-4 pt-3 space-y-3"
          method="post"
          action="/chat/"
          autocomplete="on"
          onsubmit={handleGuestSubmit}
        >
          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2.5 flex items-center gap-3">
            {#if guestAvatarPreview}
              <img src={guestAvatarPreview} alt="头像预览" class="chat-avatar" />
            {:else}
              <div class="chat-avatar flex items-center justify-center font-bold text-sm text-[var(--chat-accent-text)]">
                {guestNick.trim() ? guestNick.trim().slice(0, 1) : "?"}
              </div>
            {/if}
            <div class="min-w-0 flex-1">
              <div class="text-xs font-bold text-[var(--deep-text)] truncate">
                {guestNick.trim() || "访客名片"}
              </div>
              <div class="text-[11px] text-[var(--chat-meta-color)] truncate mt-0.5">
                根据邮箱自动匹配头像 · 与评论区名片同步
              </div>
            </div>
          </div>

          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-3 space-y-2.5">
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
            class="chat-send-btn w-full h-9! text-xs!"
          >
            {guestLoading ? "正在进入..." : "确认进入"}
          </button>
        </form>
      {/if}
    </div>
  </div>
{/if}
