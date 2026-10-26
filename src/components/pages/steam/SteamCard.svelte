<script lang="ts">
import I18nKey from "@/i18n/i18nKey";
import { i18n } from "@/i18n/translation";
import type { SteamGameItem } from "@/types/steamConfig";

interface Props {
	game: SteamGameItem;
}

const { game }: Props = $props();

let imgError = $state(false);
// 16:9 比例优先使用横版 header 封面
let currentCover = $state(game.header_url || game.cover_url);

function handleImageError() {
	if (!imgError && currentCover !== game.cover_url) {
		// 若横版 header 不存在，回退到竖版 cover
		currentCover = game.cover_url;
		imgError = true;
	}
}
</script>

<a
	href={game.store_url}
	target="_blank"
	rel="noopener noreferrer"
	class="card-base group relative flex flex-col overflow-hidden rounded-xl transition-all duration-300 hover:-translate-y-1 hover:shadow-lg border border-(--line-divider) hover:border-(--primary)"
	title={`${game.name} - ${game.playtime_hours} ${i18n(I18nKey.steamPlaytimeHours)}`}
>
	<!-- 封面区域 (16:9 横版纯净展示，不遮挡画面) -->
	<div class="relative aspect-video w-full overflow-hidden bg-neutral-100 dark:bg-neutral-800">
		<img
			src={currentCover}
			alt={game.name}
			loading="lazy"
			decoding="async"
			referrerpolicy="no-referrer"
			onerror={handleImageError}
			class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
		/>

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
