<script lang="ts">
import { onMount } from "svelte";
import StatsDashboard from "@/components/pages/stats/StatsDashboard.svelte";
import { getWorkerApiUrl } from "@/utils/api-config";
import CommentsManager from "./CommentsManager.svelte";
import ConsoleLogin from "./ConsoleLogin.svelte";
import DynamicManagerList from "./DynamicManagerList.svelte";
import DynamicPublisher from "./DynamicPublisher.svelte";
import FriendsManager from "./FriendsManager.svelte";
import PostEditor from "./PostEditor.svelte";

interface Props {
	workerApiUrl?: string;
}

const { workerApiUrl }: Props = $props();

const apiUrl = $derived(workerApiUrl || getWorkerApiUrl());

type TabKey = "dynamic" | "posts" | "analytics" | "friends" | "comments";

interface TabItem {
	key: TabKey;
	label: string;
	icon: string;
	disabled?: boolean;
	badge?: string;
}

const tabs: TabItem[] = [
	{ key: "dynamic", label: "动态说说", icon: "💬" },
	{
		key: "posts",
		label: "长文撰写",
		icon: "📝",
	},
	{
		key: "analytics",
		label: "数据大屏",
		icon: "📊",
	},
	{
		key: "friends",
		label: "友链维护",
		icon: "🤝",
	},
	{
		key: "comments",
		label: "评论管理",
		icon: "💬",
	},
];

let isLoggedIn = $state(false);
let token = $state("");
let tokenExpiresAt = $state(0);
let activeTab = $state<TabKey>("dynamic");
let refreshTrigger = $state(0);
let toastMessage = $state("");
let toastVisible = $state(false);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(msg: string, duration = 2200) {
	toastMessage = msg;
	toastVisible = true;
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		toastVisible = false;
	}, duration);
}

function handleLoginSuccess(newToken: string, expiresAt: number) {
	token = newToken;
	tokenExpiresAt = expiresAt;
	isLoggedIn = true;
	try {
		localStorage.setItem("admin_token", newToken);
		localStorage.setItem("admin_token_expires_at", String(expiresAt));
		sessionStorage.setItem("admin_token", newToken);
		sessionStorage.setItem("admin_token_expires_at", String(expiresAt));
	} catch {}
	showToast("✨ 欢迎回到博客管理中枢！已为您保持持久化登录");
}

function handleLogout() {
	try {
		localStorage.removeItem("admin_token");
		localStorage.removeItem("admin_token_expires_at");
		sessionStorage.removeItem("admin_token");
		sessionStorage.removeItem("admin_token_expires_at");
	} catch {}
	token = "";
	tokenExpiresAt = 0;
	isLoggedIn = false;
	showToast("已安全登出控制台");
}

function handlePublished() {
	refreshTrigger += 1;
	showToast("🚀 说说已成功发布并同步！");
}

function handleListUpdated() {
	showToast("说说列表已更新");
}

function handlePostCommitted(res: Record<string, unknown>) {
	showToast(
		`🚀 文章已成功提交至 GitHub 内容仓！(Slug: ${String(res?.slug || "")})`,
	);
}

onMount(() => {
	try {
		const savedToken =
			localStorage.getItem("admin_token") ||
			sessionStorage.getItem("admin_token");
		const savedExpires =
			localStorage.getItem("admin_token_expires_at") ||
			sessionStorage.getItem("admin_token_expires_at");
		if (savedToken && savedExpires) {
			const expTime = Number(savedExpires);
			if (Date.now() < expTime) {
				token = savedToken;
				tokenExpiresAt = expTime;
				isLoggedIn = true;
			} else {
				localStorage.removeItem("admin_token");
				localStorage.removeItem("admin_token_expires_at");
				sessionStorage.removeItem("admin_token");
				sessionStorage.removeItem("admin_token_expires_at");
			}
		}
	} catch (e) {
		console.warn("Storage read failed", e);
	}
});
</script>

<div class="console-dashboard w-full pb-10">
	<!-- 全局提示气泡：复用全站原生底栏 Toast 样式与动效 (同友链与资料卡复制提示) -->
	<div
		id="console-toast"
		class="fixed bottom-8 left-1/2 -translate-x-1/2 z-[1080] px-4 py-2.5 rounded-xl bg-black/85 dark:bg-neutral-800/90 text-white text-xs sm:text-sm font-medium shadow-2xl backdrop-blur-md transition-all duration-300 max-w-[90vw] text-center border border-white/10 pointer-events-none {toastVisible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-2 scale-95'}"
		role="status"
		aria-live="polite"
	>
		{toastMessage}
	</div>

	{#if !isLoggedIn}
		<!-- 未登录暗号核验界面 -->
		<ConsoleLogin workerApiUrl={apiUrl} onLoginSuccess={handleLoginSuccess} />
	{:else}
		<!-- 已登录管理中枢大屏 -->
		<div class="space-y-6">
			<!-- 顶部导航栏卡片 -->
			<div class="card-base p-4 md:p-5 rounded-(--radius-large) shadow-lg border border-(--line-divider) backdrop-blur-md flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
				<!-- 左侧中枢标识 -->
				<div class="flex items-center gap-3">
					<div class="w-10 h-10 rounded-xl bg-(--primary)/15 text-(--primary) flex items-center justify-center text-lg font-bold">
						⚡
					</div>
					<div>
						<h1 class="text-base font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
							博客管理中枢
							<span class="text-[11px] font-normal px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
								<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
								暗号已激活
							</span>
						</h1>
						<p class="text-xs text-(--content-meta)">
							Cloudflare Worker 边缘节点驱动 · {apiUrl}
						</p>
					</div>
				</div>

				<!-- 中间与右侧操作区 -->
				<div class="flex items-center justify-between md:justify-end gap-3 flex-wrap">
					<!-- 返回博客按钮 -->
					<a
						href="/"
						class="text-xs px-3.5 py-1.5 rounded-lg border border-(--line-divider) text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-1.5"
					>
						<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
						</svg>
						<span>返回博客</span>
					</a>

					<!-- 安全登出按钮 -->
					<button
						type="button"
						onclick={handleLogout}
						class="text-xs px-3.5 py-1.5 rounded-lg border border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-1.5 cursor-pointer ml-auto"
					>
						<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
						</svg>
						<span>安全登出</span>
					</button>
				</div>
			</div>

			<!-- 功能选项卡切换栏 -->
			<div class="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
				{#each tabs as tab}
					<button
						type="button"
						onclick={() => !tab.disabled && (activeTab = tab.key)}
						disabled={tab.disabled}
						class="px-4 py-2 rounded-xl text-xs font-medium flex items-center gap-2 whitespace-nowrap transition-all cursor-pointer select-none {activeTab === tab.key ? 'bg-(--primary) text-white shadow-md shadow-(--primary)/20 scale-[1.02]' : tab.disabled ? 'opacity-40 cursor-not-allowed bg-black/5 dark:bg-white/5 text-(--content-meta)' : 'bg-black/5 dark:bg-white/5 text-neutral-700 dark:text-neutral-300 hover:bg-black/10 dark:hover:bg-white/10'}"
					>
						<span>{tab.icon}</span>
						<span>{tab.label}</span>
						{#if tab.badge}
							<span class="text-[10px] px-1.5 py-0.2 rounded bg-black/10 dark:bg-white/10 opacity-70">
								{tab.badge}
							</span>
						{/if}
					</button>
				{/each}
			</div>

			<!-- 选项卡对应的主面板内容 -->
			{#if activeTab === "dynamic"}
				<!-- 动态说说发布器与管理列表 -->
				<DynamicPublisher
					workerApiUrl={apiUrl}
					{token}
					onPublished={handlePublished}
				/>
				<DynamicManagerList
					workerApiUrl={apiUrl}
					{token}
					{refreshTrigger}
					onListUpdated={handleListUpdated}
				/>
			{:else if activeTab === "posts"}
				<!-- 长文撰写与发布器 -->
				<PostEditor
					workerApiUrl={apiUrl}
					{token}
					onPostCommitted={handlePostCommitted}
					onToast={showToast}
				/>
			{:else if activeTab === "analytics"}
				<!-- 数据大屏面板 -->
				<div class="card-base p-5 md:p-7 rounded-(--radius-large) shadow-lg border border-(--line-divider)">
					<StatsDashboard workerApiUrl={apiUrl} />
				</div>
			{:else if activeTab === "friends"}
				<!-- 友链维护面板 -->
				<FriendsManager
					workerApiUrl={apiUrl}
					{token}
					onToast={showToast}
				/>
			{:else if activeTab === "comments"}
				<!-- Waline 评论内嵌管理 -->
				<CommentsManager onToast={showToast} />
			{/if}
		</div>
	{/if}
</div>
