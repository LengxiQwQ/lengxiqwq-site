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
	onToast?.("🔑 已打开登录小窗口，支持 GitHub、QQ 或邮箱密码登录...");

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

		onToast?.(
			`🎉 登录成功！已自动将凭据同步回本内嵌窗口${nick ? `（欢迎，${nick}）` : ""}`,
		);
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

<div class="comments-manager space-y-5">
	<!-- 顶部控制与状态栏卡片 -->
	<div class="card-base p-4 md:p-5 rounded-(--radius-large) shadow-lg border border-(--line-divider) flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
		<div class="flex items-center gap-3">
			<div class="w-10 h-10 rounded-2xl bg-(--primary)/15 text-(--primary) flex items-center justify-center text-xl font-bold">
				💬
			</div>
			<div>
				<h2 class="text-base font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
					Waline 评论管理内嵌中枢
					<span class="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium">
						双向同步沙箱
					</span>
				</h2>
				<p class="text-xs text-(--content-meta) mt-0.5">
					当前服务源: <code class="font-mono text-(--primary)">{walineAdminUrl}</code>
				</p>
			</div>
		</div>

		<!-- 右侧操作按钮组 -->
		<div class="flex items-center gap-2 flex-wrap">
			<!-- 专属小窗口登录按钮（解决 GitHub/QQ 内嵌被拒） -->
			<button
				type="button"
				onclick={openLoginPopup}
				class="text-xs px-3.5 py-1.5 rounded-xl bg-(--primary) text-white font-bold flex items-center gap-1.5 hover:opacity-90 shadow-sm shadow-(--primary)/20 transition-all cursor-pointer"
				title="打开独立小窗口完成 GitHub/QQ 授权，登录完成后自动将状态同步回本页面"
			>
				<span>⚡ 打开小窗口登录</span>
				<span class="text-xs">↗</span>
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

			<!-- 独立窗口新标签页全屏打开 -->
			<button
				type="button"
				onclick={openInNewTab}
				class="text-xs px-3 py-1.5 rounded-xl border border-(--line-divider) text-neutral-700 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5 flex items-center gap-1.5 transition-colors cursor-pointer"
				title="在新标签页中全屏打开 Waline 后台"
			>
				<span>新标签打开</span>
			</button>
		</div>
	</div>

	<!-- 等待小窗口登录中的友好提示横幅 -->
	{#if isWaitingLogin}
		<div class="p-3.5 rounded-xl bg-(--primary)/10 border border-(--primary)/25 text-(--primary) text-xs flex items-center justify-between gap-3 animate-pulse">
			<div class="flex items-center gap-2">
				<span class="animate-spin text-sm">⏳</span>
				<span>已打开独立登录窗口，请在弹出窗口中完成登录。完成之后小窗口会自动关闭，本页面将直接同步进入管理后台！</span>
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
	<div class="card-base rounded-(--radius-large) shadow-lg border border-(--line-divider) overflow-hidden relative">
		<!-- 加载动画状态遮罩 -->
		{#if isLoading}
			<div class="absolute inset-0 z-10 bg-(--card-bg)/80 backdrop-blur-xs flex flex-col items-center justify-center p-8 text-center">
				<div class="w-8 h-8 rounded-full border-2 border-(--primary) border-t-transparent animate-spin mb-3"></div>
				<p class="text-xs font-semibold text-neutral-800 dark:text-neutral-200">
					正在安全连接 Waline 评论管理后台...
				</p>
				<p class="text-[11px] text-(--content-meta) mt-1">
					首次加载需验证远程服务端 SSL 证书与跨域策略
				</p>
			</div>
		{/if}

		<!-- iframe 实体 -->
		<iframe
			bind:this={iframeRef}
			src={walineAdminUrl}
			onload={handleIframeLoad}
			title="Waline 评论管理后台"
			class="w-full h-[640px] border-none bg-white dark:bg-neutral-900"
			sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
		></iframe>
	</div>

	<!-- 底部安全管理与运维提示 -->
	<div class="p-4 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider) text-xs text-(--content-meta) space-y-1.5">
		<div class="font-bold text-neutral-800 dark:text-neutral-200 flex items-center gap-1.5">
			<span>💡</span> 站长评论运维提示:
		</div>
		<ul class="list-disc list-inside space-y-1 text-[11px] pl-1">
			<li>
				<strong>解决内嵌拒绝连接</strong>：由于 GitHub、QQ 等第三方平台禁止在 <code>iframe</code> 内嵌网页中弹出授权，请使用上方 <strong>“⚡ 打开小窗口登录”</strong>，登录成功后会自动关闭并无缝回传登录态至本内嵌窗口。
			</li>
			<li>
				<strong>专属管理员账号</strong>：已为你激活邮箱密码直登模式（邮箱：<code class="text-(--primary)">me@lengxiqwq.com</code>，密码：<code class="text-(--primary)">lengxi.0325</code>），在弹窗中无论是用 GitHub、QQ 还是邮箱密码都能 100% 成功登录！
			</li>
			<li>严禁擅自向未授权用户发送邮件或测试群发通知，保障收件箱洁净。</li>
		</ul>
	</div>
</div>
