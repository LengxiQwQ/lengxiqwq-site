<script lang="ts">
import Select from "@/components/common/Select.svelte";
import I18nKey from "@/i18n/i18nKey";
import { i18n } from "@/i18n/translation";
import type {
	SteamGameItem,
	SteamLevelInfo,
	SteamPlayerSummary,
	SteamStats,
} from "@/types/steamConfig";
import SteamCard from "./SteamCard.svelte";
import SteamDashboard from "./SteamDashboard.svelte";

interface Props {
	title?: string;
	description?: string;
	games: SteamGameItem[];
	recentGames: SteamGameItem[];
	pageSize?: number;
	profile?: SteamPlayerSummary;
	stats?: SteamStats;
	levelInfo?: SteamLevelInfo;
	showStats?: boolean;
}

const {
	title = "",
	description = "",
	games = [],
	recentGames = [],
	pageSize = 24,
	profile,
	stats,
	levelInfo,
	showStats = true,
}: Props = $props();

type TabType = "all" | "recent" | "hall_of_fame";
type SortType = "playtime_desc" | "recent_desc" | "name_asc";

let currentTab = $state<TabType>("all");
let searchQuery = $state("");
let currentSort = $state<SortType>("playtime_desc");
let displayLimit = $state(pageSize);

const sortOptions = $derived([
	{
		value: "playtime_desc" as const,
		label: i18n(I18nKey.steamSortPlaytimeDesc),
	},
	{
		value: "recent_desc" as const,
		label: i18n(I18nKey.steamSortRecentDesc),
	},
	{
		value: "name_asc" as const,
		label: i18n(I18nKey.steamSortNameAsc),
	},
]);

// 百小时殿堂游戏
const hallOfFameGames = $derived(
	games.filter((g) => (g.playtime_hours || 0) >= 100),
);

// 根据当前 Tab 过滤基础列表
const baseGames = $derived.by(() => {
	switch (currentTab) {
		case "recent":
			return recentGames;
		case "hall_of_fame":
			return hallOfFameGames;
		default:
			return games;
	}
});

// 根据搜索关键词与排序处理最终列表
const filteredGames = $derived.by(() => {
	let list = [...baseGames];

	if (searchQuery.trim()) {
		const q = searchQuery.toLowerCase().trim();
		list = list.filter((g) => g.name.toLowerCase().includes(q));
	}

	switch (currentSort) {
		case "recent_desc":
			list.sort((a, b) => {
				const rA = a.playtime_2weeks || 0;
				const rB = b.playtime_2weeks || 0;
				if (rB !== rA) return rB - rA;
				return (b.rtime_last_played || 0) - (a.rtime_last_played || 0);
			});
			break;
		case "name_asc":
			list.sort((a, b) => a.name.localeCompare(b.name));
			break;
		default:
			list.sort((a, b) => b.playtime_forever - a.playtime_forever);
			break;
	}

	return list;
});

// 分页截断
const paginatedGames = $derived(filteredGames.slice(0, displayLimit));
const hasMore = $derived(displayLimit < filteredGames.length);

function loadMore() {
	displayLimit += pageSize;
}

function handleTabChange(tab: TabType) {
	currentTab = tab;
	displayLimit = pageSize;
}
</script>

<!-- 整合主面板：Steam 游戏标题 + 玩家个人资料与数据看板 + 筛选/搜索/排序工具栏 -->
<div class="card-base card-toolbar-panel !overflow-visible p-5 md:p-6 mb-6 rounded-2xl flex flex-col gap-5 md:gap-6 relative z-30">
	<!-- 顶部：Steam 游戏标题区 -->
	{#if title}
		<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
			<div class="page-heading">
				<div class="page-icon shrink-0" aria-hidden="true">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 640 640"
						class="w-7 h-7 md:w-8 md:h-8 fill-current"
					>
						<path d="M568 320c0 137-111.2 248-248.4 248c-113.8 0-209.6-76.3-239-180.4l95.2 39.3c6.4 32.1 34.9 56.4 68.9 56.4c39.2 0 71.9-32.4 70.2-73.5l84.5-60.2c52.1 1.3 95.8-40.9 95.8-93.5c0-51.6-42-93.5-93.7-93.5s-93.7 42-93.7 93.5v1.2L248.6 343c-15.5-.9-30.7 3.4-43.5 12.1L72 300.1C82.2 172.4 189.1 72 319.6 72C456.8 72 568 183 568 320M227.7 448.3l-30.5-12.6c5.6 11.6 15.3 20.8 27.2 25.8c26.9 11.2 57.8-1.6 69-28.4c5.4-13 5.5-27.3.1-40.3S278 369.6 265 364.2c-12.9-5.4-26.7-5.2-38.9-.6l31.5 13c19.8 8.2 29.2 30.9 20.9 50.7c-8.3 19.9-31 29.2-50.8 21m173.8-254.5c34.4 0 62.3 27.9 62.3 62.3s-27.9 62.3-62.3 62.3s-62.3-27.9-62.3-62.3s27.9-62.3 62.3-62.3m.1 109c25.8 0 46.8-21 46.8-46.8s-21-46.8-46.8-46.8s-46.8 21-46.8 46.8s21 46.8 46.8 46.8"/>
					</svg>
				</div>
				<div>
					<h2>{title}</h2>
					{#if description}
						<p>{description}</p>
					{/if}
				</div>
			</div>

			{#if stats?.lastUpdated}
				<div class="text-xs text-neutral-400 dark:text-neutral-500 self-start sm:self-center shrink-0">
					<span>{i18n(I18nKey.animeLastUpdated)}</span>
					<span class="font-medium text-neutral-600 dark:text-neutral-300 ml-1">
						{new Date(stats.lastUpdated).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}
					</span>
				</div>
			{/if}
		</div>
	{/if}

	<!-- 中部：玩家数据看板 -->
	{#if showStats && profile && stats}
		<SteamDashboard {profile} {stats} {levelInfo} />
	{/if}

	<!-- 底部：Tab 筛选/搜索/排序工具栏 -->
	<div class="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4">
		<!-- 分类 Tab 胶囊 (带按压弹性与平滑过渡动效) -->
		<div class="flex items-center gap-1.5 p-1 bg-(--btn-regular-bg) rounded-xl overflow-x-auto">
			<button
				type="button"
				class={`px-3 py-1.5 rounded-lg text-xs md:text-sm font-medium transition-all duration-200 ease-out active:scale-95 cursor-pointer whitespace-nowrap ${
					currentTab === "all"
						? "bg-white dark:bg-neutral-800 text-(--primary) shadow-xs font-bold scale-[1.02]"
						: "text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-black/5 dark:hover:bg-white/5"
				}`}
				onclick={() => handleTabChange("all")}
			>
				{i18n(I18nKey.steamTabAll)}
				<span class="ml-1 text-xs opacity-70">({games.length})</span>
			</button>

			<button
				type="button"
				class={`px-3 py-1.5 rounded-lg text-xs md:text-sm font-medium transition-all duration-200 ease-out active:scale-95 cursor-pointer whitespace-nowrap ${
					currentTab === "recent"
						? "bg-white dark:bg-neutral-800 text-(--primary) shadow-xs font-bold scale-[1.02]"
						: "text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-black/5 dark:hover:bg-white/5"
				}`}
				onclick={() => handleTabChange("recent")}
			>
				{i18n(I18nKey.steamTabRecent)}
				<span class="ml-1 text-xs opacity-70">({recentGames.length})</span>
			</button>

			<button
				type="button"
				class={`px-3 py-1.5 rounded-lg text-xs md:text-sm font-medium transition-all duration-200 ease-out active:scale-95 cursor-pointer whitespace-nowrap ${
					currentTab === "hall_of_fame"
						? "bg-white dark:bg-neutral-800 text-(--primary) shadow-xs font-bold scale-[1.02]"
						: "text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 hover:bg-black/5 dark:hover:bg-white/5"
				}`}
				onclick={() => handleTabChange("hall_of_fame")}
			>
				{i18n(I18nKey.steamTabHallOfFame)}
				<span class="ml-1 text-xs opacity-70">({hallOfFameGames.length})</span>
			</button>
		</div>

		<!-- 搜索与排序区 -->
		<div class="flex items-center gap-3 w-full lg:w-auto">
			<!-- 搜索栏 -->
			<div class="relative flex-1 lg:w-64">
				<input
					type="text"
					bind:value={searchQuery}
					placeholder={i18n(I18nKey.steamSearchPlaceholder)}
					class="w-full px-3.5 py-1.5 pl-8 text-xs md:text-sm rounded-xl bg-(--card-bg) border border-(--line-divider) focus:outline-hidden focus:border-(--primary) transition shadow-2xs"
				/>
				<svg
					class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400 pointer-events-none"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
					/>
				</svg>
			</div>

			<!-- 排序下拉 -->
			<Select
				bind:value={currentSort}
				options={sortOptions}
				onChange={() => {
					displayLimit = pageSize;
				}}
			/>
		</div>
	</div>
</div>

<!-- 游戏网格列表 (一排 4~5 列响应式网格，带 Tab 切换平滑淡入动效) -->
{#if paginatedGames.length > 0}
	{#key currentTab}
		<div class="steam-grid-wrapper grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-5 gap-3 md:gap-4">
			{#each paginatedGames as game (game.appid)}
				<SteamCard {game} />
			{/each}
		</div>
	{/key}

	<!-- 加载更多按钮 (支持单次展开 60 款) -->
	{#if hasMore}
		<div class="flex justify-center mt-8">
			<button
				type="button"
				class="px-8 py-2.5 rounded-full bg-(--card-bg) border border-(--line-divider) text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:border-(--primary) hover:text-(--primary) hover:shadow-md active:scale-95 transition-all duration-200 cursor-pointer"
				onclick={loadMore}
			>
				{i18n(I18nKey.steamLoadMore)} ({filteredGames.length - displayLimit} {i18n(I18nKey.steamRemaining)})
			</button>
		</div>
	{/if}
{:else}
	<!-- 空数据状态 -->
	<div class="card-base p-12 text-center rounded-2xl">
		<div class="text-4xl mb-3">🎮</div>
		<p class="text-neutral-500 dark:text-neutral-400 text-sm">
			{i18n(I18nKey.steamNoResults)}
		</p>
	</div>
{/if}

<style>
	.card-toolbar-panel {
		overflow: visible !important;
	}

	.steam-grid-wrapper {
		animation: steamGridFade 0.28s cubic-bezier(0.16, 1, 0.3, 1) forwards;
	}

	@keyframes steamGridFade {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
</style>
