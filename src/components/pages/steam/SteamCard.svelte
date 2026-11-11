<script lang="ts">
import I18nKey from "@/i18n/i18nKey";
import { i18n } from "@/i18n/translation";
import type { SteamGameItem } from "@/types/steamConfig";

interface Props {
	game: SteamGameItem;
}

const { game }: Props = $props();

let attempt = $state(0);
let loadFailed = $state(false);

const communityIcon = game.img_icon_url
	? `https://media.steampowered.com/steamcommunity/public/images/apps/${game.appid}/${game.img_icon_url}.jpg`
	: null;

// 封面候选链：横版 header -> 竖版 cover -> 社区图标
const candidateUrls = $derived.by(() => {
	const list: string[] = [];
	if (game.header_url) list.push(game.header_url);
	if (game.cover_url && game.cover_url !== game.header_url)
		list.push(game.cover_url);
	if (communityIcon && !list.includes(communityIcon)) list.push(communityIcon);
	return list;
});

let currentCover = $derived(candidateUrls[attempt] || "");

function handleImageError() {
	if (attempt < candidateUrls.length - 1) {
		attempt += 1;
	} else {
		loadFailed = true;
	}
}
</script>

<a
	href={game.store_url}
	target="_blank"
	rel="noopener noreferrer"
	class="group relative flex flex-col rounded-xl overflow-hidden bg-(--card-bg) border border-(--line-divider) hover:border-(--primary) transition-all duration-300 hover:-translate-y-1 hover:shadow-lg"
	title={`${game.name} - ${game.playtime_hours} ${i18n(I18nKey.steamPlaytimeHours)}`}
>
	<!-- 封面区域 (16:9 横版纯净展示，不遮挡画面) -->
	<div class="relative aspect-video w-full overflow-hidden bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center">
		{#if !loadFailed && currentCover}
			<img
				src={currentCover}
				alt={game.name}
				loading="lazy"
				decoding="async"
				referrerpolicy="no-referrer"
				onerror={handleImageError}
				class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
			/>
		{:else}
			<div class="w-full h-full flex flex-col items-center justify-center p-3 text-center bg-gradient-to-br from-neutral-200 to-neutral-300 dark:from-neutral-800 dark:to-neutral-900 text-neutral-400">
				<span class="text-2xl mb-1">🎮</span>
				<span class="text-xs font-medium text-neutral-600 dark:text-neutral-300 line-clamp-1">{game.name}</span>
			</div>
		{/if}

		<!-- 仅当最近两周活跃时，在左上角展示一个小巧的药丸角标 -->
		{#if (game.playtime_2weeks_hours || 0) > 0}
			<div class="absolute top-2 left-2 pointer-events-none">
				<span class="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] md:text-[11px] font-semibold bg-emerald-500/90 text-white shadow-sm backdrop-blur-xs">
					{game.playtime_2weeks_hours}h / 2w
				</span>
			</div>
		{/if}
	</div>

	<!-- 图片下方独立文字区（游戏名称与时长去重，仅展示一次） -->
	<div class="p-3 flex flex-col justify-between flex-1 gap-1.5 bg-(--card-bg)">
		<h4 class="font-bold text-xs md:text-sm text-neutral-800 dark:text-neutral-100 group-hover:text-(--primary) transition-colors line-clamp-1 leading-snug">
			{game.name}
		</h4>

		<div class="flex items-center justify-between text-[11px] text-neutral-500 dark:text-neutral-400">
			<span class="truncate">
				{i18n(I18nKey.steamTotalPlaytime)}: <strong class="text-neutral-700 dark:text-neutral-300 font-semibold">{game.playtime_hours}h</strong>
			</span>
			<span class="shrink-0 text-(--primary) font-medium opacity-0 group-hover:opacity-100 transition-opacity">
				Store ↗
			</span>
		</div>
	</div>
</a>
