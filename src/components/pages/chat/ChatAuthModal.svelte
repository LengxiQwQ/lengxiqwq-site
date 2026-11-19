<script lang="ts">
import { onMount } from "svelte";
import ChatAvatar from "./ChatAvatar.svelte";
import ChatModal from "./ChatModal.svelte";
import {
	buildWalineLoginUrl,
	normalizeServerUrl,
	openWalineLoginPopup,
	previewAvatarFromEmail,
	readStoredGuestMeta,
	registerGuestSession,
} from "./chatClient";
import type { ChatSessionUser } from "./chatTypes";

interface Props {
	open: boolean;
	roomId?: string;
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
	roomId = "chat",
	chatServerUrl,
	walineServerUrl,
	onAuthenticated,
	onClose,
}: Props = $props();

// Waline 新窗口 / 新标签页授权状态
let walinePopupWaiting = $state(false);
let walinePopupBlocked = $state(false);
let walineLoginError = $state("");
let walineLoginUrl = $state("");

// 访客身份表单状态（默认折叠降级，主推 Waline 窗口登录）
let showGuestForm = $state(false);
let guestNick = $state("");
let guestEmail = $state("");
let guestUrl = $state("");
let guestLoading = $state(false);
let guestError = $state("");
let guestBlockedByWaline = $state(false);
let guestBlockedCanSplit = $state(false);
let splitGuestLoading = $state(false);

let cancelPopup: (() => void) | null = null;
let lastOpenState = false;
let authAttemptSeq = 0;

const guestAvatarPreview = $derived(previewAvatarFromEmail(guestEmail));

function hydrateStoredGuestFields() {
	const meta = readStoredGuestMeta();
	if (!guestNick.trim() && meta.nickname) guestNick = meta.nickname;
	if (!guestEmail.trim() && meta.email) guestEmail = meta.email;
	if (!guestUrl.trim() && meta.url) guestUrl = meta.url;
}

function resetInterceptionState() {
	guestBlockedByWaline = false;
	guestBlockedCanSplit = false;
	splitGuestLoading = false;
}

$effect(() => {
	if (open && !lastOpenState) {
		lastOpenState = true;
		showGuestForm = false;
		guestError = "";
		guestLoading = false;
		walinePopupWaiting = false;
		walinePopupBlocked = false;
		walineLoginError = "";
		walineLoginUrl = buildWalineLoginUrl(walineServerUrl);
		resetInterceptionState();
		hydrateStoredGuestFields();
	} else if (!open && lastOpenState) {
		lastOpenState = false;
		authAttemptSeq += 1;
		cancelPopup?.();
		cancelPopup = null;
		walinePopupWaiting = false;
		walinePopupBlocked = false;
		guestLoading = false;
		splitGuestLoading = false;
	}
});

onMount(() => {
	hydrateStoredGuestFields();
	return () => {
		cancelPopup?.();
	};
});

function handleOpenWalinePopup() {
	if (!normalizeServerUrl(walineServerUrl)) {
		walineLoginError = "未配置 Waline 服务端地址";
		return;
	}
	walineLoginUrl = buildWalineLoginUrl(walineServerUrl);
	walinePopupWaiting = true;
	walinePopupBlocked = false;
	guestError = "";
	walineLoginError = "";
	cancelPopup?.();
	cancelPopup = openWalineLoginPopup(
		walineServerUrl,
		(token) => {
			walinePopupWaiting = false;
			walinePopupBlocked = false;
			cancelPopup = null;
			resetInterceptionState();
			onAuthenticated({ kind: "waline", token });
			onClose();
		},
		() => {
			walinePopupWaiting = false;
			cancelPopup = null;
		},
		() => {
			walinePopupWaiting = false;
			walinePopupBlocked = true;
			walineLoginError =
				"登录窗口被浏览器拦截，请允许弹出窗口或点击下方链接在新标签页登录";
		},
	);
}

async function handleGuestSubmit(e: SubmitEvent) {
	e.preventDefault();
	guestError = "";
	resetInterceptionState();
	if (!guestNick.trim()) {
		guestError = "请填写昵称";
		return;
	}
	if (!guestEmail.trim()) {
		guestError = "请填写有效邮箱";
		return;
	}

	const attemptSeq = ++authAttemptSeq;
	guestLoading = true;
	const res = await registerGuestSession(chatServerUrl, {
		nickname: guestNick.trim(),
		email: guestEmail.trim(),
		url: guestUrl.trim(),
		room: roomId,
	});
	if (!open || attemptSeq !== authAttemptSeq) {
		guestLoading = false;
		return;
	}
	guestLoading = false;

	if (!res.ok || !res.token || !res.user) {
		if (res.code === "WALINE_LOGIN_REQUIRED") {
			guestBlockedByWaline = true;
			guestBlockedCanSplit = res.allowSplitGuest !== false;
			walinePopupBlocked = false;
			walineLoginError = "";
			guestError = guestBlockedCanSplit
				? ""
				: res.error || "该邮箱为站长专用邮箱，请通过 Waline 账号登录验证身份";
			return;
		}
		guestError = res.error || "访客验证失败";
		return;
	}

	onAuthenticated({ kind: "guest", token: res.token }, res.user);
	onClose();
}

async function handleSplitGuestEnter() {
	if (!guestBlockedCanSplit || splitGuestLoading) return;
	guestError = "";
	const attemptSeq = ++authAttemptSeq;
	splitGuestLoading = true;
	const res = await registerGuestSession(chatServerUrl, {
		nickname: guestNick.trim(),
		email: guestEmail.trim(),
		url: guestUrl.trim(),
		room: roomId,
		allowSplitGuest: true,
	});
	if (!open || attemptSeq !== authAttemptSeq) {
		splitGuestLoading = false;
		return;
	}
	splitGuestLoading = false;

	if (!res.ok || !res.token || !res.user) {
		if (res.code === "WALINE_LOGIN_REQUIRED" && res.allowSplitGuest === false) {
			guestBlockedCanSplit = false;
		}
		guestError = res.error || "创建独立临时身份失败";
		return;
	}

	resetInterceptionState();
	onAuthenticated({ kind: "guest", token: res.token }, res.user);
	onClose();
}
</script>

<ChatModal
  {open}
  title={guestBlockedByWaline ? "验证正式账号" : "登录聊天室"}
  subtitle={guestBlockedByWaline ? "检测到该身份已绑定 Waline 正式账号" : "登录后即可发言、传图与点歌"}
  size="sm"
  topPriority={true}
  {onClose}
>
  <div class="px-4 pb-4 pt-3 space-y-3 flex-1 min-h-0 overflow-y-auto custom-scrollbar">
    {#if guestBlockedByWaline}
      <!-- 已绑定正式账号：独立紧凑引导视图（无需在底部长列表滚动） -->
      <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2 flex items-center justify-between gap-2.5">
        <div class="flex items-center gap-2.5 min-w-0">
          <ChatAvatar
            src={guestAvatarPreview}
            name={guestNick.trim()}
            fallback="?"
            alt="账号头像预览"
            size="sm"
          />
          <div class="min-w-0">
            <div class="text-xs font-bold text-(--deep-text) truncate">
              {guestNick.trim() || "已绑定账号"}
            </div>
            <div class="text-[13px] md:text-[11px] text-(--chat-meta-color) truncate">
              {guestEmail.trim()}
            </div>
          </div>
        </div>
        <button
          type="button"
          onclick={() => {
            resetInterceptionState();
            guestError = "";
            showGuestForm = true;
          }}
          class="btn-regular h-7 px-2.5 rounded-lg text-[13px] md:text-[11px] font-medium shrink-0 cursor-pointer border-none"
        >
          修改信息
        </button>
      </div>

      <div
        class="rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2.5 space-y-2.5"
        role="alert"
      >
        <div class="flex items-center gap-1.5 text-xs font-bold text-amber-700 dark:text-amber-300">
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"></span>
          <span>检测到已绑定的正式账号</span>
        </div>
        <p class="text-[13px] md:text-[11px] text-(--deep-text) opacity-90 leading-relaxed m-0">
          {#if guestBlockedCanSplit}
            该邮箱已绑定 Waline 正式账号。请通过 Waline 账号登录以同步认证头衔与历史记录；若暂不登录，也可以直接进入（将创建独立临时身份，不会与原账号合并）。
          {:else}
            {guestError || "该邮箱为站长专用邮箱，请通过 Waline 账号登录验证身份。"}
          {/if}
        </p>
        {#if guestBlockedCanSplit && guestError}
          <p class="text-[13px] md:text-[11px] text-red-500 leading-relaxed m-0">
            {guestError}
          </p>
        {/if}

        {#if walineLoginError}
          <p class="text-[13px] md:text-[11px] text-red-500 leading-relaxed m-0">
            {walineLoginError}
          </p>
        {/if}

        <div class="flex items-center gap-2 pt-0.5">
          <button
            type="button"
            disabled={walinePopupWaiting || splitGuestLoading}
            onclick={handleOpenWalinePopup}
            class="chat-send-btn flex-1 h-9! rounded-xl! text-xs! font-semibold disabled:opacity-60"
          >
            <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            <span>{walinePopupWaiting ? "等待 Waline 登录完成..." : "打开 Waline 窗口登录"}</span>
          </button>
          {#if guestBlockedCanSplit}
            <button
              type="button"
              disabled={splitGuestLoading || walinePopupWaiting}
              onclick={handleSplitGuestEnter}
              class="btn-regular h-9 px-3 rounded-xl text-[13px] md:text-[11px] font-semibold shrink-0 cursor-pointer border-none disabled:opacity-60"
            >
              {splitGuestLoading ? "创建中..." : "直接进入"}
            </button>
          {/if}
        </div>

        {#if (walinePopupBlocked || walinePopupWaiting) && walineLoginUrl}
          <div class="text-center">
            <a
              href={walineLoginUrl}
              target="_blank"
              rel="noopener noreferrer"
              onclick={() => {
                walineLoginError = "";
              }}
              class="inline-flex items-center gap-1 text-[13px] md:text-[11px] font-medium text-(--chat-accent-text) hover:underline"
            >
              <span>在新标签页中打开 Waline 登录</span>
              <span aria-hidden="true">↗</span>
            </a>
          </div>
        {/if}
      </div>
    {:else}
      <!-- 主推方式：统一通过新窗口 / 新标签页打开 Waline 登录（严禁站内直输账号密码） -->
      <div class="rounded-2xl border border-(--primary)/35 bg-(--primary)/8 px-3.5 py-3.5 space-y-3">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-sm font-bold text-(--deep-text) truncate">
              Waline 账号登录
            </span>
            <span class="shrink-0 px-2 py-0.5 rounded-full text-[11px] md:text-[10px] font-bold bg-(--primary) text-white leading-none">
              推荐
            </span>
          </div>
          <span class="shrink-0 text-[11px] md:text-[10px] font-medium text-(--chat-accent-text)">
            评论区互通
          </span>
        </div>

        <p class="text-[13px] md:text-[11px] text-(--deep-text)/80 leading-relaxed m-0">
          点击下方按钮将打开独立 Waline 窗口完成登录或注册（支持账号密码、GitHub 等方式），即可拥有 <strong class="font-semibold text-(--chat-accent-text)">认证</strong> 标识并解锁个人歌单。
        </p>

        {#if walineLoginError}
          <p class="text-xs text-red-500 m-0 leading-relaxed">{walineLoginError}</p>
        {/if}

        <button
          type="button"
          disabled={walinePopupWaiting}
          onclick={handleOpenWalinePopup}
          class="chat-send-btn w-full h-10! rounded-xl! text-[13px]! font-semibold disabled:opacity-60"
        >
          <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          <span>{walinePopupWaiting ? "等待 Waline 登录完成..." : "使用 Waline 账号登录"}</span>
        </button>

        {#if walineLoginUrl}
          <div class="flex items-center justify-between gap-2 text-[13px] md:text-[11px] text-(--chat-meta-color) pt-0.5">
            <span>{walinePopupBlocked ? "弹窗被拦截？" : "未弹出窗口或偏好标签页？"}</span>
            <a
              href={walineLoginUrl}
              target="_blank"
              rel="noopener noreferrer"
              onclick={() => {
                walineLoginError = "";
              }}
              class="inline-flex items-center gap-0.5 font-medium text-(--chat-accent-text) hover:underline shrink-0"
            >
              <span>在新标签页打开</span>
              <span aria-hidden="true">↗</span>
            </a>
          </div>
        {/if}
      </div>

      <!-- 降级次选：临时访客入口（默认收起） -->
      <div class="pt-0.5">
        <button
          type="button"
          aria-expanded={showGuestForm}
          onclick={() => (showGuestForm = !showGuestForm)}
          class="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-(--chat-divider-color) bg-transparent hover:bg-(--btn-regular-bg) text-left cursor-pointer transition-colors"
        >
          <div class="min-w-0">
            <div class="text-[13px] md:text-xs font-medium text-(--chat-meta-color)">
              临时访客进入（无需账号）
            </div>
            <div class="text-[12px] md:text-[10px] text-(--chat-meta-color)/80 truncate mt-0.5">
              仅填昵称与邮箱快速发言，不支持导入与管理个人歌单
            </div>
          </div>
          <svg
            class="w-4 h-4 shrink-0 text-(--chat-meta-color) transition-transform duration-200 {showGuestForm ? 'rotate-180' : ''}"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {#if showGuestForm}
        <!-- 次选表单：填写临时访客信息进入 -->
        <form
          class="space-y-2 pt-0.5"
          method="post"
          action="/chat/"
          autocomplete="on"
          onsubmit={handleGuestSubmit}
        >
          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-1.5 flex items-center gap-2.5">
            <ChatAvatar
              src={guestAvatarPreview}
              name={guestNick.trim()}
              fallback="?"
              alt="头像预览"
              size="sm"
            />
            <div class="min-w-0 flex-1">
              <div class="text-xs font-bold text-[var(--deep-text)] truncate">
                {guestNick.trim() || "访客名片"}
              </div>
              <div class="text-[11px] md:text-[10px] text-[var(--chat-meta-color)] truncate">
                根据邮箱匹配头像 · 与评论区名片同步
              </div>
            </div>
          </div>

          <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2.5 space-y-2">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
                  placeholder="最多 16 字"
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
            class="btn-regular w-full h-9 rounded-xl text-xs font-medium active:scale-95 transition-all cursor-pointer border-none disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {guestLoading ? "正在进入..." : "以访客身份进入"}
          </button>
        </form>
      {/if}
    {/if}
  </div>
</ChatModal>
