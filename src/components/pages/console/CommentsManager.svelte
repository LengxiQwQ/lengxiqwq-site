<script lang="ts">
import { onMount } from "svelte";
import { commentConfig } from "@/config/commentConfig";

interface Props {
	onToast?: (msg: string) => void;
}

const { onToast }: Props = $props();

// 读取配置中的 Waline 服务端地址，并标准化其 /ui 路径
const defaultServerUrl =
	commentConfig.waline?.serverURL?.trim().replace(/\/+$/, "") ||
	"https://waline.vercel.app";

let walineAdminUrl = $state(`${defaultServerUrl}/ui`);
let iframeRef: HTMLIFrameElement | null = $state(null);
let isLoading = $state(true);
let isWaitingLogin = $state(false);
let lastToken = $state("");

onMount(() => {
	// 读取此前已持久化的 Waline Token
	try {
		const savedToken =
			localStorage.getItem("WALINE_ADMIN_TOKEN") ||
			localStorage.getItem("TOKEN") ||
			"";
		if (savedToken) {
			lastToken = savedToken;
			walineAdminUrl = `${defaultServerUrl}/ui?token=${encodeURIComponent(savedToken)}`;
		}
	} catch (_) {}
});

function handleRefresh() {
	if (iframeRef) {
		isLoading = true;
		const tokenParam = lastToken
			? `&token=${encodeURIComponent(lastToken)}`
			: "";
		iframeRef.src = `${defaultServerUrl}/ui?t=${Date.now()}${tokenParam}`;
		onToast?.("已刷新 Waline 管理后台视图");
	}
}

function handleIframeLoad() {
	isLoading = false;
}

// 核心功能：打开独立小窗口专门登录，并在登录完成后自动返回并同步回当前内嵌 iframe
function openLoginPopup() {
	const width = 1024;
	const height = 650;
	const left = Math.max(
		0,
		Math.floor((window.innerWidth - width) / 2 + (window.screenX || 0)),
	);
	const top = Math.max(
		0,
		Math.floor((window.innerHeight - height) / 2 + (window.screenY || 0)),
	);

	const loginUrl = `${defaultServerUrl}/ui/login?lng=zh-CN`;
	const popup = window.open(
		loginUrl,
		"waline_admin_login",
		`width=${width},height=${height},left=${left},top=${top},menubar=no,status=no,toolbar=no,scrollbars=yes,resizable=yes`,
	);

	isWaitingLogin = true;
	onToast?.("已打开登录窗口，支持 GitHub、QQ 或邮箱登录");

	let isDone = false;

	function handleSuccess(token: string, nick?: string) {
		if (isDone) return;
		isDone = true;
		isWaitingLogin = false;
		lastToken = token;

		try {
			localStorage.setItem("WALINE_ADMIN_TOKEN", token);
			localStorage.setItem("TOKEN", token);
			localStorage.setItem(
				"WALINE_USER",
				JSON.stringify({
					token,
					display_name: nick || "冷汐OωO",
					email: "me@lengxiqwq.com",
					type: "administrator",
				}),
			);
		} catch (_) {}

		try {
			if (popup && !popup.closed) {
				popup.close();
			}
		} catch (_) {}

		window.removeEventListener("message", onMessage);

		// 刷新内嵌 iframe 并直接注入 Token，秒速进入已登录管理面板
		if (iframeRef) {
			isLoading = true;
			iframeRef.src = `${defaultServerUrl}/ui?token=${encodeURIComponent(token)}&t=${Date.now()}`;
		}

		onToast?.(`登录成功${nick ? `（欢迎，${nick}）` : ""}`);
	}

	// 1. 跨窗口通信监听：Waline 授权完成后回传的 userInfo 消息
	function onMessage(event: MessageEvent) {
		const data = event.data;
		if (data && typeof data === "object") {
			if (data.type === "userInfo" && data.data && data.data.token) {
				handleSuccess(
					data.data.token,
					data.data.display_name || data.data.nick,
				);
			}
		}
	}
	window.addEventListener("message", onMessage);

	// 2. 轮询检测：若用户手动关闭了小窗口，自动触发一次同步检测与刷新
	const pollTimer = setInterval(() => {
		if (!popup || popup.closed) {
			clearInterval(pollTimer);
			window.removeEventListener("message", onMessage);
			if (isWaitingLogin) {
				isWaitingLogin = false;
				handleRefresh();
			}
		}
	}, 800);
}

function openInNewTab() {
	window.open(walineAdminUrl, "_blank", "noopener,noreferrer");
}
</script>

<div class="comments-manager card-base p-5 md:p-6 space-y-4">
	<!-- 顶部控制栏 -->
	<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-(--line-divider)">
		<div class="flex items-center gap-3">
			<div class="w-9 h-9 rounded-xl bg-(--primary)/15 text-(--primary) flex items-center justify-center font-bold shrink-0">
				<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
				</svg>
			</div>
			<div>
				<h2 class="text-base font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
					评论管理
				</h2>
				<p class="text-xs text-(--content-meta)">
					Waline 评论系统管理后台，支持审核与回复评论
				</p>
			</div>
		</div>

		<!-- 右侧操作按钮组 -->
		<div class="flex items-center gap-2 flex-wrap shrink-0">
			<!-- 小窗口登录按钮 -->
			<button
				type="button"
				onclick={openLoginPopup}
				class="text-xs px-3.5 py-1.5 rounded-xl bg-(--primary) text-white font-medium flex items-center gap-1.5 hover:opacity-90 shadow-sm shadow-(--primary)/20 transition-all cursor-pointer"
				title="打开独立小窗口完成登录，登录后自动同步到本页面"
			>
				<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
				</svg>
				<span>小窗口登录</span>
			</button>

			<!-- 刷新 iframe -->
			<button
				type="button"
				onclick={handleRefresh}
				class="text-xs px-3 py-1.5 rounded-xl border border-(--line-divider) text-neutral-700 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5 flex items-center gap-1.5 transition-colors cursor-pointer"
				title="刷新内嵌管理视图"
			>
				<svg class="w-3.5 h-3.5 {isLoading ? 'animate-spin text-(--primary)' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
				</svg>
				<span>刷新后台</span>
			</button>

			<!-- 独立窗口新标签页打开 -->
			<button
				type="button"
				onclick={openInNewTab}
				class="text-xs px-3 py-1.5 rounded-xl border border-(--line-divider) text-neutral-700 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5 flex items-center gap-1.5 transition-colors cursor-pointer"
				title="在新标签页中打开 Waline 后台"
			>
				<span>新标签打开</span>
			</button>
		</div>
	</div>

	<!-- 等待小窗口登录中的提示横幅 -->
	{#if isWaitingLogin}
		<div class="p-3.5 rounded-xl bg-(--primary)/10 border border-(--primary)/25 text-(--primary) text-xs flex items-center justify-between gap-3 animate-pulse">
			<div class="flex items-center gap-2">
				<svg class="w-4 h-4 animate-spin text-(--primary) shrink-0" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
				</svg>
				<span>已打开登录窗口，请在弹出窗口中完成登录。完成后窗口会自动关闭并同步登录状态。</span>
			</div>
			<button
				type="button"
				onclick={() => { isWaitingLogin = false; handleRefresh(); }}
				class="px-2.5 py-1 rounded-lg bg-(--primary) text-white font-medium hover:opacity-90 shrink-0 cursor-pointer text-[11px]"
			>
				已完成登录，立即同步
			</button>
		</div>
	{/if}

	<!-- 内嵌 Waline 管理后台容器 -->
	<div class="rounded-2xl border border-(--line-divider) overflow-x-auto relative scrollbar-thin bg-white dark:bg-neutral-900">
		<!-- 加载动画状态遮罩 -->
		{#if isLoading}
			<div class="absolute inset-0 z-10 bg-(--card-bg)/80 backdrop-blur-xs flex flex-col items-center justify-center p-8 text-center">
				<div class="w-8 h-8 rounded-full border-2 border-(--primary) border-t-transparent animate-spin mb-3"></div>
				<p class="text-xs font-semibold text-neutral-800 dark:text-neutral-200">
					正在加载评论管理后台...
				</p>
				<p class="text-[11px] text-(--content-meta) mt-1">
					请稍候...
				</p>
			</div>
		{/if}

		<!-- iframe 实体：设置 min-w-[760px] 保证内部导航栏“评论、用户、导出”有足够空间，不折行截断 -->
		<iframe
			bind:this={iframeRef}
			src={walineAdminUrl}
			onload={handleIframeLoad}
			title="Waline 评论管理后台"
			class="min-w-[760px] w-full h-[680px] border-none bg-white dark:bg-neutral-900 block"
			sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
		></iframe>
	</div>

	<!-- 底部提示 -->
	<div class="p-4 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider) text-xs text-(--content-meta) space-y-1.5">
		<div class="font-bold text-neutral-800 dark:text-neutral-200 flex items-center gap-1.5">
			<svg class="w-4 h-4 text-(--primary)" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
			</svg>
			<span>提示:</span>
		</div>
		<p class="text-[11px] text-(--content-meta)">
			第三方登录（GitHub、QQ 等）在内嵌框架中若受浏览器安全策略限制，请点击右上角 <strong>“小窗口登录”</strong>，授权完成后自动同步。
		</p>
	</div>
</div>
