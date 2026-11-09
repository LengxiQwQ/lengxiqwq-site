<script lang="ts">
import { onMount } from "svelte";
import {
	formatFcircleDate,
	formatFcircleTime,
	getFcircleDatePresentation,
	getFcircleRelativeDays,
} from "@/utils/fcircle-date-utils";

export interface FcirclePost {
	id: string;
	friendName: string;
	friendAvatar: string;
	friendUrl: string;
	title: string;
	link: string;
	pubDate: string;
	excerpt?: string;
	sourceType?: "self" | "friend" | "subscription";
	tags?: string[];
}

export interface FcircleStats {
	friendCount?: number;
	activeCount?: number;
	todayCount?: number;
	updatedAt?: number;
	totalFriends?: number;
	activeFriends?: number;
	todayUpdates?: number;
	lastUpdated?: number;
}

interface Props {
	workerApiUrl: string;
	timeZone: string;
	lang: string;
	title: string;
	description?: string;
	emptyText?: string;
	authorText?: string;
	subscriptionText?: string;
	todayText?: string;
	weekText?: string;
	totalText?: string;
	sitesText?: string;
	postUnitText?: string;
	siteUnitText?: string;
	postsUpdatedText?: string;
	timelineText?: string;
	gridText?: string;
	buildHintText?: string;
}

const {
	workerApiUrl,
	timeZone = "UTC",
	lang = "zh_CN",
	title = "朋友圈",
	description = "",
	emptyText = "还没有抓取到朋友圈文章",
	authorText = "博主",
	subscriptionText = "订阅",
	todayText = "今日更新",
	weekText = "近 7 天",
	totalText = "最新动态",
	sitesText = "订阅博主",
	postUnitText = "篇",
	siteUnitText = "位",
	postsUpdatedText = "篇更新",
	timelineText = "时间线",
	gridText = "平铺",
	buildHintText = "动态内容由 Cloudflare Workers 微服务全自动定时抓取同步",
}: Props = $props();

const STORAGE_KEY = "fcircle_preferred_view";

let currentView = $state<"timeline" | "grid">("timeline");
let loading = $state(true);
let loadingMore = $state(false);
let error = $state<string | null>(null);

let posts = $state<FcirclePost[]>([]);
let stats = $state<FcircleStats | null>(null);
let page = $state(1);
const limit = 20;
let total = $state(0);
let totalPages = $state(1);
let hasMore = $state(false);

// 日期分组衍生状态（时间线使用）
const dateGroups = $derived.by(() => {
	const now = new Date();
	const groupsMap = new Map<
		string,
		{
			dateKey: string;
			displayDate: string;
			subLabel?: string;
			relativeDays: number;
			items: FcirclePost[];
		}
	>();

	for (const post of posts) {
		const info = getFcircleDatePresentation(post.pubDate, now, timeZone, lang);
		if (!groupsMap.has(info.dateKey)) {
			groupsMap.set(info.dateKey, {
				dateKey: info.dateKey,
				displayDate: info.displayDate,
				subLabel: info.subLabel,
				relativeDays: info.relativeDays,
				items: [],
			});
		}
		const group = groupsMap.get(info.dateKey);
		if (group) {
			group.items.push(post);
		}
	}

	return Array.from(groupsMap.values());
});

// 计算统计值（优先使用服务端返回的 stats，辅以客户端派生）
const computedTodayCount = $derived.by(() => {
	if (stats?.todayCount !== undefined) return stats.todayCount;
	if (stats?.todayUpdates !== undefined) return stats.todayUpdates;
	const now = new Date();
	return posts.filter(
		(p) => getFcircleRelativeDays(p.pubDate, now, timeZone) === 0,
	).length;
});

const computedWeekCount = $derived.by(() => {
	const now = new Date();
	return posts.filter((p) => {
		const days = getFcircleRelativeDays(p.pubDate, now, timeZone);
		return days >= 0 && days <= 6;
	}).length;
});

const computedTotalCount = $derived(total || posts.length);

const computedSiteCount = $derived.by(() => {
	if (stats?.friendCount !== undefined) return stats.friendCount;
	if (stats?.totalFriends !== undefined) return stats.totalFriends;
	const sites = new Set(posts.map((p) => p.friendUrl || p.friendName));
	return sites.size;
});

function isValidLink(link: string): boolean {
	if (!link) return false;
	return (
		link.startsWith("http://") ||
		link.startsWith("https://") ||
		link.startsWith("/")
	);
}

function switchView(mode: "timeline" | "grid") {
	currentView = mode;
	try {
		localStorage.setItem(STORAGE_KEY, mode);
	} catch {}
}

async function fetchStats() {
	try {
		const res = await fetch(`${workerApiUrl}/api/fcircle/stats`, {
			signal: AbortSignal.timeout(6000),
		});
		if (res.ok) {
			const json = await res.json();
			if (json.code === 200 && json.data) {
				stats = json.data;
			}
		}
	} catch (e) {
		console.warn("[Fcircle] Stats fetch failed:", e);
	}
}

async function fetchInitialData() {
	loading = true;
	error = null;

	try {
		// 并行发起统计与首批文章拉取
		fetchStats();

		const res = await fetch(
			`${workerApiUrl}/api/fcircle/posts?page=1&limit=${limit}`,
			{
				signal: AbortSignal.timeout(7000),
			},
		);

		if (!res.ok) {
			throw new Error(`Worker HTTP ${res.status}: ${res.statusText}`);
		}

		const json = await res.json();
		if (json.code !== 200 || !json.data) {
			throw new Error(json.error || "Failed to load posts");
		}

		posts = json.data.items || [];
		total = json.data.total || posts.length;
		page = json.data.page || 1;
		totalPages = json.data.totalPages || 1;
		hasMore = Boolean(json.data.hasMore);
	} catch (err: unknown) {
		console.error("[Fcircle] Initial fetch error:", err);
		error = err instanceof Error ? err.message : "未能连接至朋友圈微服务";
	} finally {
		loading = false;
	}
}

async function loadMore() {
	if (loadingMore || !hasMore) return;
	loadingMore = true;

	try {
		const nextPage = page + 1;
		const res = await fetch(
			`${workerApiUrl}/api/fcircle/posts?page=${nextPage}&limit=${limit}`,
			{
				signal: AbortSignal.timeout(7000),
			},
		);

		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const json = await res.json();

		if (json.code === 200 && json.data?.items) {
			posts = [...posts, ...json.data.items];
			page = json.data.page;
			hasMore = Boolean(json.data.hasMore);
			totalPages = json.data.totalPages;
		}
	} catch (err) {
		console.error("[Fcircle] Load more error:", err);
	} finally {
		loadingMore = false;
	}
}

onMount(() => {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved === "grid" || saved === "timeline") {
			currentView = saved;
		}
	} catch {}

	fetchInitialData();
});
</script>

<div class="fcircle-container w-full">
	<!-- 顶部标题与视图切换工具栏 -->
	<div class="flex items-center justify-between gap-3 mb-6">
		<div class="page-heading flex-nowrap mb-0 min-w-0 flex-1">
			<div class="page-icon shrink-0" aria-hidden="true">
				<svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
					<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
				</svg>
			</div>
			<div class="min-w-0">
				<h2 class="truncate text-lg sm:text-2xl font-bold">{title}</h2>
				{#if description}
					<p class="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 mt-0.5 truncate">{description}</p>
				{/if}
			</div>
		</div>

		<!-- 视图切换 Segmented Switcher -->
		<div
			class="flex gap-1 p-1 rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 shrink-0 select-none"
			role="tablist"
			aria-label="视图切换"
		>
			<button
				type="button"
				class="fcircle-view-btn px-2.5 sm:px-4 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors cursor-pointer {currentView === 'timeline' ? 'bg-(--primary) text-white font-medium' : 'opacity-60 hover:opacity-100'}"
				onclick={() => switchView("timeline")}
				role="tab"
				aria-selected={currentView === "timeline"}
			>
				{timelineText}
			</button>
			<button
				type="button"
				class="fcircle-view-btn px-2.5 sm:px-4 py-1 sm:py-1.5 text-xs sm:text-sm rounded-lg transition-colors cursor-pointer {currentView === 'grid' ? 'bg-(--primary) text-white font-medium' : 'opacity-60 hover:opacity-100'}"
				onclick={() => switchView("grid")}
				role="tab"
				aria-selected={currentView === "grid"}
			>
				{gridText}
			</button>
		</div>
	</div>

	<!-- 顶部数据概览栏（包含骨架态与真实态） -->
	<div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-0 mb-6 select-none">
		<!-- 1. 今日更新 -->
		<div
			class="p-3 rounded-xl border flex items-center gap-3 transition-all duration-300 relative overflow-hidden group bg-(--card-bg) {computedTodayCount > 0 ? 'border-(--primary)/30 bg-(--primary)/5 hover:border-(--primary)' : 'border-(--line-divider) hover:border-(--primary)/40'}"
		>
			<div
				class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-transform duration-300 group-hover:scale-105 {computedTodayCount > 0 ? 'bg-(--primary) text-white shadow-xs' : 'bg-(--primary)/10 text-(--primary)'}"
				aria-hidden="true"
			>
				<svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
					<path d="M7 2v11h3v9l7-12h-4l4-8z"/>
				</svg>
			</div>
			<div class="flex flex-col min-w-0">
				<span class="text-xs text-neutral-500 dark:text-neutral-400 font-medium">{todayText}</span>
				<div class="flex items-baseline gap-1 mt-0.5">
					{#if loading && posts.length === 0}
						<div class="w-8 h-5 bg-neutral-200 dark:bg-neutral-800 rounded animate-pulse"></div>
					{:else}
						<span class="text-lg font-bold tabular-nums leading-tight {computedTodayCount > 0 ? 'text-(--primary)' : 'text-neutral-800 dark:text-neutral-200'}">
							{computedTodayCount}
						</span>
						<span class="text-xs text-neutral-400">{postUnitText}</span>
					{/if}
				</div>
			</div>
		</div>

		<!-- 2. 近 7 天更新 -->
		<div class="p-3 rounded-xl border border-(--line-divider) flex items-center gap-3 transition-all duration-300 relative overflow-hidden group bg-(--card-bg) hover:border-(--primary)/40">
			<div class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-(--primary)/10 text-(--primary) transition-transform duration-300 group-hover:scale-105" aria-hidden="true">
				<svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
					<path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10z"/>
				</svg>
			</div>
			<div class="flex flex-col min-w-0">
				<span class="text-xs text-neutral-500 dark:text-neutral-400 font-medium">{weekText}</span>
				<div class="flex items-baseline gap-1 mt-0.5">
					{#if loading && posts.length === 0}
						<div class="w-8 h-5 bg-neutral-200 dark:bg-neutral-800 rounded animate-pulse"></div>
					{:else}
						<span class="text-lg font-bold tabular-nums leading-tight text-neutral-800 dark:text-neutral-200">
							{computedWeekCount}
						</span>
						<span class="text-xs text-neutral-400">{postUnitText}</span>
					{/if}
				</div>
			</div>
		</div>

		<!-- 3. 最新动态总数 -->
		<div class="p-3 rounded-xl border border-(--line-divider) flex items-center gap-3 transition-all duration-300 relative overflow-hidden group bg-(--card-bg) hover:border-(--primary)/40">
			<div class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-(--primary)/10 text-(--primary) transition-transform duration-300 group-hover:scale-105" aria-hidden="true">
				<svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
					<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
				</svg>
			</div>
			<div class="flex flex-col min-w-0">
				<span class="text-xs text-neutral-500 dark:text-neutral-400 font-medium">{totalText}</span>
				<div class="flex items-baseline gap-1 mt-0.5">
					{#if loading && posts.length === 0}
						<div class="w-8 h-5 bg-neutral-200 dark:bg-neutral-800 rounded animate-pulse"></div>
					{:else}
						<span class="text-lg font-bold tabular-nums leading-tight text-neutral-800 dark:text-neutral-200">
							{computedTotalCount}
						</span>
						<span class="text-xs text-neutral-400">{postUnitText}</span>
					{/if}
				</div>
			</div>
		</div>

		<!-- 4. 订阅博主数 -->
		<div class="p-3 rounded-xl border border-(--line-divider) flex items-center gap-3 transition-all duration-300 relative overflow-hidden group bg-(--card-bg) hover:border-(--primary)/40">
			<div class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-(--primary)/10 text-(--primary) transition-transform duration-300 group-hover:scale-105" aria-hidden="true">
				<svg xmlns="http://www.w3.org/2000/svg" width="1.2em" height="1.2em" viewBox="0 0 24 24" fill="currentColor">
					<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
				</svg>
			</div>
			<div class="flex flex-col min-w-0">
				<span class="text-xs text-neutral-500 dark:text-neutral-400 font-medium">{sitesText}</span>
				<div class="flex items-baseline gap-1 mt-0.5">
					{#if loading && posts.length === 0}
						<div class="w-8 h-5 bg-neutral-200 dark:bg-neutral-800 rounded animate-pulse"></div>
					{:else}
						<span class="text-lg font-bold tabular-nums leading-tight text-neutral-800 dark:text-neutral-200">
							{computedSiteCount}
						</span>
						<span class="text-xs text-neutral-400">{siteUnitText}</span>
					{/if}
				</div>
			</div>
		</div>
	</div>

	<!-- 异常/离线优雅降级卡片 -->
	{#if error && posts.length === 0}
		<div class="my-8 p-6 sm:p-8 rounded-2xl border border-amber-500/20 bg-amber-500/5 flex flex-col items-center text-center">
			<div class="w-12 h-12 rounded-full bg-amber-500/10 text-amber-500 flex items-center justify-center mb-3 text-2xl">
				<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
					<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
				</svg>
			</div>
			<h3 class="text-base sm:text-lg font-bold text-neutral-800 dark:text-neutral-200 mb-1">
				朋友圈服务暂时离线或同步中
			</h3>
			<p class="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 max-w-md mb-4">
				未能成功获取朋友圈更新（{error}）。您可以稍后再试，或点击下方按钮重新尝试连接。
			</p>
			<button
				type="button"
				class="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-(--primary) text-white text-xs sm:text-sm font-medium hover:opacity-90 transition-opacity cursor-pointer shadow-sm shadow-(--primary)/20"
				onclick={fetchInitialData}
			>
				<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
					<path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
				</svg>
				<span>重新加载</span>
			</button>
		</div>
	{/if}

	<!-- 骨架屏加载态 -->
	{#if loading && posts.length === 0}
		{#if currentView === "timeline"}
			<div class="relative flex flex-col mt-8">
				<div class="fcircle-track" aria-hidden="true"></div>
				{#each [1, 2, 3] as _}
					<div class="fcircle-date-group relative mb-8">
						<div class="flex items-center gap-3 sm:gap-4 mb-4 select-none">
							<div class="w-8 h-8 sm:w-10 sm:h-10 rounded-full border-2 border-(--line-divider) bg-(--card-bg) shrink-0 animate-pulse"></div>
							<div class="h-6 w-36 bg-neutral-200 dark:bg-neutral-800 rounded animate-pulse"></div>
						</div>
						<div class="pl-8 sm:pl-12 flex flex-col gap-3">
							{#each [1, 2] as _}
								<div class="p-4 rounded-xl border border-(--line-divider) bg-(--card-bg) flex items-start gap-4 animate-pulse">
									<div class="w-10 h-10 rounded-full bg-neutral-200 dark:bg-neutral-800 shrink-0"></div>
									<div class="grow flex flex-col gap-2">
										<div class="h-3.5 w-32 bg-neutral-200 dark:bg-neutral-800 rounded"></div>
										<div class="h-5 w-3/4 bg-neutral-200 dark:bg-neutral-800 rounded"></div>
										<div class="h-3 w-5/6 bg-neutral-200 dark:bg-neutral-800 rounded"></div>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
				{#each [1, 2, 3, 4, 5, 6] as _}
					<div class="p-4 sm:p-5 rounded-2xl border border-(--line-divider) bg-(--card-bg) flex flex-col gap-3 animate-pulse">
						<div class="flex items-center gap-2">
							<div class="w-6 h-6 rounded-full bg-neutral-200 dark:bg-neutral-800 shrink-0"></div>
							<div class="h-3 w-20 bg-neutral-200 dark:bg-neutral-800 rounded"></div>
						</div>
						<div class="h-5 w-4/5 bg-neutral-200 dark:bg-neutral-800 rounded"></div>
						<div class="h-3 w-full bg-neutral-200 dark:bg-neutral-800 rounded"></div>
						<div class="h-3 w-2/3 bg-neutral-200 dark:bg-neutral-800 rounded"></div>
					</div>
				{/each}
			</div>
		{/if}
	{/if}

	<!-- 空状态提示 -->
	{#if !loading && !error && posts.length === 0}
		<div class="flex flex-col items-center justify-center py-16 text-neutral-400 dark:text-neutral-500">
			<svg xmlns="http://www.w3.org/2000/svg" width="3em" height="3em" viewBox="0 0 24 24" fill="currentColor" class="opacity-40 mb-3">
				<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
			</svg>
			<div class="text-sm">{emptyText}</div>
		</div>
	{/if}

	<!-- 视图 1：按天聚合的时间线视图（默认视图） -->
	{#if posts.length > 0 && currentView === "timeline"}
		<div id="timeline-view" class="mt-8 transition-opacity duration-300">
			<div class="relative flex flex-col">
				<!-- 纵向贯穿细轨道 -->
				<div class="fcircle-track" aria-hidden="true"></div>

				<!-- 日期分组列表 -->
				{#each dateGroups as group (group.dateKey)}
					{@const isToday = group.relativeDays === 0}
					{@const isYesterday = group.relativeDays === 1}

					<div class="fcircle-date-group relative mb-8 last:mb-2">
						<!-- 日期节点 Header -->
						<div class="flex items-center gap-3 sm:gap-4 mb-4 select-none">
							<!-- 节点圆环 Marker -->
							<div
								class="fcircle-date-marker relative z-10 w-8 h-8 sm:w-10 sm:h-10 rounded-full flex items-center justify-center border-2 shrink-0 {isToday ? 'border-(--primary) bg-(--primary) text-white shadow-md shadow-(--primary)/20 ring-4 ring-(--primary)/15' : isYesterday ? 'border-(--primary) bg-(--card-bg) text-(--primary) shadow-sm ring-2 ring-(--primary)/10' : 'border-(--line-divider) bg-(--card-bg) text-neutral-500 dark:text-neutral-400 hover:border-(--primary)'}"
								aria-hidden="true"
							>
								{#if isToday}
									<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
										<path d="M7 2v11h3v9l7-12h-4l4-8z"/>
									</svg>
								{:else}
									<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
										<path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10z"/>
									</svg>
								{/if}
							</div>

							<!-- 日期文本与条数徽标 -->
							<div class="flex items-center gap-2.5 flex-wrap">
								<span class="fcircle-date-label text-base sm:text-lg font-bold tracking-tight text-neutral-800 dark:text-neutral-100">
									{group.displayDate}
								</span>

								{#if group.subLabel}
									<span class="fcircle-date-sublabel text-xs text-neutral-400 font-medium">
										{group.subLabel}
									</span>
								{/if}

								<span class="text-xs px-2 py-0.5 rounded-full bg-(--btn-regular-bg) text-neutral-600 dark:text-neutral-400 font-medium tabular-nums border border-(--line-divider)">
									{group.items.length} {postsUpdatedText}
								</span>
							</div>
						</div>

						<!-- 当天文章卡片容器 -->
						<div class="pl-8 sm:pl-12 flex flex-col gap-3">
							{#each group.items as item (item.id)}
								{@const safeLink = isValidLink(item.link) ? item.link : "#"}
								{@const timeStr = formatFcircleTime(item.pubDate, timeZone)}

								<a
									href={safeLink}
									target="_blank"
									rel="noopener noreferrer"
									class="fcircle-timeline-card group flex items-start gap-3.5 sm:gap-4 p-3.5 sm:p-4 rounded-xl border border-(--line-divider) bg-(--card-bg) hover:border-(--primary) transition-all duration-300 hover:shadow-md relative overflow-hidden"
								>
									<!-- 高亮悬浮背景层 -->
									<div class="absolute inset-0 bg-(--primary) opacity-0 group-hover:opacity-5 transition-opacity duration-300 pointer-events-none"></div>

									<!-- 右上角小箭头 -->
									<svg
										xmlns="http://www.w3.org/2000/svg"
										width="1.1em"
										height="1.1em"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										class="absolute top-3.5 right-3.5 sm:top-4 sm:right-4 text-(--primary) opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300 shrink-0"
									>
										<path d="M7 17l9.2-9.2M17 17V8H8"/>
									</svg>

									<!-- 作者头像 -->
									<div class="relative w-10 h-10 sm:w-11 sm:h-11 shrink-0 rounded-full overflow-hidden bg-zinc-100 dark:bg-zinc-800 border border-black/5 dark:border-white/5 group-hover:scale-105 transition-transform duration-300 mt-0.5">
										<img
											src={item.friendAvatar}
											alt={item.friendName}
											width="44"
											height="44"
											loading="lazy"
											decoding="async"
											class="w-full h-full object-cover"
										/>
									</div>

									<!-- 核心信息主体 -->
									<div class="grow min-w-0 flex flex-col gap-1 pr-6 sm:pr-8">
										<!-- 头部：作者名 + 订阅角标 + 具体发布时间 -->
										<div class="text-xs text-neutral-500 dark:text-neutral-400 font-medium flex items-center gap-2 flex-wrap">
											<span class="text-neutral-700 dark:text-neutral-300 font-medium group-hover:text-(--primary) transition-colors truncate max-w-40 sm:max-w-64">
												{item.friendName}
											</span>
											{#if item.sourceType === "subscription"}
												<span class="text-[10px] px-1.5 py-0.2 rounded-md bg-(--primary)/10 text-(--primary) font-normal border border-(--primary)/20 shrink-0">
													{item.tags?.[0] || subscriptionText}
												</span>
											{/if}
											{#if item.sourceType === "self"}
												<span class="text-[10px] px-1.5 py-0.2 rounded-md bg-(--primary)/15 text-(--primary) font-medium border border-(--primary)/30 shrink-0">
													{authorText}
												</span>
											{/if}
											{#if timeStr && timeStr !== "00:00"}
												<span class="w-1 h-1 rounded-full bg-neutral-300 dark:bg-neutral-600 shrink-0"></span>
												<span class="tabular-nums text-neutral-400 shrink-0">{timeStr}</span>
											{/if}
										</div>

										<!-- 动态标题 -->
										<h3 class="font-bold text-base sm:text-lg text-neutral-900 dark:text-neutral-100 group-hover:text-(--primary) transition-colors line-clamp-2 leading-snug my-0.5">
											{item.title}
										</h3>

										<!-- 动态摘要 -->
										{#if item.excerpt}
											<p class="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 line-clamp-2 leading-relaxed m-0">
												{item.excerpt}
											</p>
										{/if}
									</div>
								</a>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}

	<!-- 视图 2：经典平铺网格视图 -->
	{#if posts.length > 0 && currentView === "grid"}
		<div id="grid-view" class="fcircle-grid mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 transition-opacity duration-300">
			{#each posts as item (item.id)}
				{@const dateStr = formatFcircleDate(item.pubDate, timeZone, lang)}
				{@const safeLink = isValidLink(item.link) ? item.link : "#"}

				<a
					href={safeLink}
					target="_blank"
					rel="noopener noreferrer"
					class="group flex flex-col justify-start p-4 sm:p-5 rounded-2xl border border-(--line-divider) bg-(--card-bg) hover:border-(--primary) transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 relative overflow-hidden"
				>
					<div class="absolute inset-0 bg-(--primary) opacity-0 group-hover:opacity-[0.03] transition-opacity duration-300 pointer-events-none"></div>

					<!-- 顶部：博主信息与发表日期 -->
					<div class="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400 font-medium mb-2.5 min-w-0">
						<div class="w-6 h-6 rounded-full overflow-hidden shrink-0 border border-black/5 dark:border-white/5 bg-zinc-100 dark:bg-zinc-800">
							<img
								src={item.friendAvatar}
								alt={item.friendName}
								width="24"
								height="24"
								loading="lazy"
								decoding="async"
								class="w-full h-full object-cover"
							/>
						</div>

						<span class="truncate text-neutral-700 dark:text-neutral-300 group-hover:text-(--primary) transition-colors font-medium">
							{item.friendName}
						</span>

						{#if item.sourceType === "subscription"}
							<span class="text-[10px] px-1.5 py-0.5 rounded-md bg-(--primary)/10 text-(--primary) font-normal border border-(--primary)/20 shrink-0">
								{item.tags?.[0] || subscriptionText}
							</span>
						{/if}

						{#if item.sourceType === "self"}
							<span class="text-[10px] px-1.5 py-0.5 rounded-md bg-(--primary)/15 text-(--primary) font-medium border border-(--primary)/30 shrink-0">
								{authorText}
							</span>
						{/if}

						<span class="text-neutral-300 dark:text-neutral-600 shrink-0">·</span>
						<span class="text-neutral-400 dark:text-neutral-500 shrink-0 tabular-nums">
							{dateStr}
						</span>
					</div>

					<!-- 中间：文章标题 -->
					<div class="font-bold text-base text-neutral-900 dark:text-neutral-100 group-hover:text-(--primary) transition-colors line-clamp-2 leading-snug mb-2">
						{item.title}
					</div>

					<!-- 底部：文章摘要 -->
					{#if item.excerpt}
						<div class="text-xs text-neutral-500 dark:text-neutral-400 line-clamp-3 leading-relaxed mt-auto">
							{item.excerpt}
						</div>
					{/if}
				</a>
			{/each}
		</div>
	{/if}

	<!-- 分页与加载更多控制区 -->
	{#if posts.length > 0}
		<div class="mt-8 flex flex-col items-center gap-3">
			{#if hasMore}
				<button
					type="button"
					class="px-6 py-2.5 rounded-xl border border-(--line-divider) bg-(--card-bg) hover:border-(--primary) hover:text-(--primary) text-xs sm:text-sm font-medium transition-all duration-300 hover:shadow-sm cursor-pointer flex items-center gap-2 text-neutral-700 dark:text-neutral-300"
					onclick={loadMore}
					disabled={loadingMore}
				>
					{#if loadingMore}
						<svg class="animate-spin h-4 w-4 text-(--primary)" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						<span>正在加载动态...</span>
					{:else}
						<span>加载更多动态</span>
					{/if}
				</button>
			{:else}
				<div class="text-xs text-neutral-400 dark:text-neutral-500 py-2">
					已经到底啦，共聚合 {total || posts.length} 篇动态
				</div>
			{/if}
		</div>
	{/if}

	<!-- 底部抓取说明提示 -->
	{#if posts.length > 0}
		<div class="mt-8 pt-4 border-t border-(--line-divider) flex items-center justify-center gap-1.5 text-xs text-neutral-400 dark:text-neutral-500 select-none">
			<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" class="text-sm shrink-0">
				<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
			</svg>
			<span>{buildHintText}</span>
		</div>
	{/if}
</div>
