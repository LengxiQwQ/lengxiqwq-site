<script lang="ts">
import I18nKey from "@/i18n/i18nKey";
import { i18n } from "@/i18n/translation";
import type { SteamGameItem } from "@/types/steamConfig";
import SteamCard from "./SteamCard.svelte";

interface Props {
	games: SteamGameItem[];
	recentGames: SteamGameItem[];
	pageSize?: number;
}

const { games = [], recentGames = [], pageSize = 24 }: Props = $props();

type TabType = "all" | "recent" | "hall_of_fame";
type SortType = "playtime_desc" | "recent_desc" | "name_asc";

let currentTab = $state<TabType>("all");
let searchQuery = $state("");
let currentSort = $state<SortType>("playtime_desc");
let displayLimit = $state(pageSize);

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

<!-- 工具栏：Tab 筛选 + 搜索框 + 排序 -->
<div class="card-base p-4 md:p-5 mb-6 rounded-2xl">
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
			<select
				bind:value={currentSort}
				class="px-3 py-1.5 text-xs md:text-sm rounded-xl bg-(--card-bg) border border-(--line-divider) text-neutral-700 dark:text-neutral-300 focus:outline-hidden focus:border-(--primary) cursor-pointer shadow-2xs"
			>
				<option value="playtime_desc">{i18n(I18nKey.steamSortPlaytimeDesc)}</option>
				<option value="recent_desc">{i18n(I18nKey.steamSortRecentDesc)}</option>
				<option value="name_asc">{i18n(I18nKey.steamSortNameAsc)}</option>
			</select>
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
