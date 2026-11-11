<script lang="ts">
import { onMount } from "svelte";
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

type TabKey = "dynamic" | "posts" | "friends" | "comments";

interface TabItem {
	key: TabKey;
	label: string;
	disabled?: boolean;
	badge?: string;
}

const tabs: TabItem[] = [
	{ key: "dynamic", label: "说说" },
	{ key: "posts", label: "文章" },
	{ key: "friends", label: "友链" },
	{ key: "comments", label: "评论" },
];

const validTabs: TabKey[] = ["dynamic", "posts", "friends", "comments"];

function getInitialTab(): TabKey {
	if (typeof window !== "undefined") {
		const urlParams = new URLSearchParams(window.location.search);
		const tabParam = urlParams.get("tab") as TabKey | null;
		if (tabParam && validTabs.includes(tabParam)) {
			return tabParam;
		}
		try {
			const savedTab = localStorage.getItem(
				"console_active_tab",
			) as TabKey | null;
			if (savedTab && validTabs.includes(savedTab)) {
				return savedTab;
			}
		} catch {}
	}
	return "dynamic";
}

let isLoggedIn = $state(false);
let token = $state("");
let tokenExpiresAt = $state(0);
let activeTab = $state<TabKey>("dynamic");
let refreshTrigger = $state(0);
let toastMessage = $state("");
let toastVisible = $state(false);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function switchTab(key: TabKey) {
	if (activeTab === key) return;
	// 切换标签时立即重置关闭旧界面的气泡提示，避免残留至新界面
	toastVisible = false;
	if (toastTimer) {
		clearTimeout(toastTimer);
		toastTimer = null;
	}
	activeTab = key;
	if (typeof window !== "undefined") {
		const url = new URL(window.location.href);
		url.searchParams.set("tab", key);
		window.history.replaceState(null, "", url.toString());
		try {
			localStorage.setItem("console_active_tab", key);
		} catch {}
	}
}

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
	showToast("已登录");
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
	showToast("已退出登录");
}

function handlePublished() {
	refreshTrigger += 1;
	showToast("说说已发布");
}

function handleListUpdated() {
	showToast("列表已刷新");
}

function handlePostCommitted(res: Record<string, unknown>) {
	showToast("文章已保存");
}

onMount(() => {
	// 1. 初始化激活标签（URL query ?tab= 优先，localStorage 兜底）
	const initialTab = getInitialTab();
	if (initialTab !== activeTab) {
		activeTab = initialTab;
	}
	if (typeof window !== "undefined") {
		const url = new URL(window.location.href);
		if (url.searchParams.get("tab") !== activeTab) {
			url.searchParams.set("tab", activeTab);
			window.history.replaceState(null, "", url.toString());
		}
	}

	// 2. 监听浏览器前进/后退
	function handlePopState() {
		const urlParams = new URLSearchParams(window.location.search);
		const tabParam = urlParams.get("tab") as TabKey | null;
		if (tabParam && validTabs.includes(tabParam) && tabParam !== activeTab) {
			activeTab = tabParam;
		}
	}
	window.addEventListener("popstate", handlePopState);

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

	return () => {
		window.removeEventListener("popstate", handlePopState);
	};
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
		<!-- 登录界面 -->
		<ConsoleLogin workerApiUrl={apiUrl} onLoginSuccess={handleLoginSuccess} />
	{:else}
		<!-- 已登录管理界面：按重要板块划分清晰主次 -->
		<div class="space-y-6">
			<!-- 板块一：顶部主控面板（标题 + 退出登录 + 4 个整行铺满的主导航按钮） -->
			<div class="card-base p-5 md:p-6 space-y-4">
				<!-- 顶部标题栏：与全站模板一致的标准 .page-heading 与 .page-icon -->
				<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
					<div class="page-heading">
						<div class="page-icon" aria-hidden="true">
							<svg class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
							</svg>
						</div>
						<div>
							<h2>博客管理</h2>
							<p>动态、文章、友链与评论管理</p>
						</div>
					</div>

					<!-- 右侧操作区：仅退出登录按钮 -->
					<div class="flex items-center gap-2.5 shrink-0 self-end sm:self-center">
						<button
							type="button"
							onclick={handleLogout}
							class="text-xs px-3.5 py-2 rounded-xl border border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-1.5 cursor-pointer"
						>
							<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
							</svg>
							<span>退出登录</span>
						</button>
					</div>
				</div>

				<!-- 4 个主导航按钮：填充整行、更大更显眼 -->
				<div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3">
					{#each tabs as tab}
						<button
							type="button"
							onclick={() => !tab.disabled && switchTab(tab.key)}
							disabled={tab.disabled}
							class="py-3 px-4 rounded-xl text-sm font-bold flex items-center justify-center gap-2.5 transition-all cursor-pointer select-none border {activeTab === tab.key ? 'bg-(--primary) text-white border-(--primary) shadow-md shadow-(--primary)/20 scale-[1.01]' : tab.disabled ? 'opacity-40 cursor-not-allowed bg-black/5 dark:bg-white/5 text-(--content-meta) border-transparent' : 'bg-black/5 dark:bg-white/5 border-(--line-divider) text-neutral-700 dark:text-neutral-200 hover:bg-black/10 dark:hover:bg-white/10 hover:border-black/15 dark:hover:border-white/15'}"
						>
							{#if tab.key === "dynamic"}
								<svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
								</svg>
							{:else if tab.key === "posts"}
								<svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
								</svg>
							{:else if tab.key === "friends"}
								<svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
								</svg>
							{:else if tab.key === "comments"}
								<svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
								</svg>
							{/if}
							<span>{tab.label}</span>
							{#if tab.badge}
								<span class="text-[10px] px-1.5 py-0.2 rounded bg-black/10 dark:bg-white/10 opacity-75 font-normal">
									{tab.badge}
								</span>
							{/if}
						</button>
					{/each}
				</div>
			</div>

			<!-- 板块二：当前业务主体工作区 -->
			<div class="tab-panel-container">
				{#if activeTab === "dynamic"}
					<!-- 动态说说发布器与管理列表 -->
					<div class="space-y-6">
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
					</div>
				{:else if activeTab === "posts"}
					<!-- 长文撰写与发布器 -->
					<PostEditor
						workerApiUrl={apiUrl}
						{token}
						onPostCommitted={handlePostCommitted}
						onToast={showToast}
					/>
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
		</div>
	{/if}
</div>
