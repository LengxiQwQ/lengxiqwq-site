<script lang="ts">
import I18nKey from "@/i18n/i18nKey";
import { i18n } from "@/i18n/translation";
import type {
	SteamLevelInfo,
	SteamPlayerSummary,
	SteamStats,
} from "@/types/steamConfig";

interface Props {
	profile: SteamPlayerSummary;
	stats: SteamStats;
	levelInfo?: SteamLevelInfo;
}

const { profile, stats, levelInfo }: Props = $props();
</script>

<div class="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-6">
	<!-- 用户资料与经验区 -->
	<div class="flex items-center gap-4 flex-1 min-w-0">
		<!-- 头像 (纯净展示，移除角标) -->
		<a
			href={profile.profileurl}
			target="_blank"
			rel="noopener noreferrer"
			class="relative group shrink-0"
			title={i18n(I18nKey.steamViewProfile)}
		>
			<img
				src={profile.avatarfull || profile.avatarmedium || profile.avatar}
				alt={profile.personaname}
				class="w-16 h-16 md:w-20 md:h-20 rounded-xl ring-2 ring-(--primary) transition duration-300 shadow-sm object-cover"
				loading="eager"
				referrerpolicy="no-referrer"
			/>
		</a>

		<!-- 昵称、等级与经验进度 -->
		<div class="min-w-0 flex-1">
			<!-- 头部行：昵称在左（点击直接跳转），状态与等级靠右对齐 (同款圆角矩形风格) -->
			<div class="flex items-center justify-between gap-3">
				<a
					href={profile.profileurl}
					target="_blank"
					rel="noopener noreferrer"
					class="text-xl md:text-2xl font-bold text-neutral-900 dark:text-neutral-100 hover:text-(--primary) transition-colors duration-200 truncate group inline-flex items-center gap-1.5"
					title={i18n(I18nKey.steamViewProfile)}
				>
					<span class="truncate">{profile.personaname}</span>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						class="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-(--primary) shrink-0"
						fill="currentColor"
					>
						<path d="M5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h7v2H5v14h14v-7h2v7q0 .825-.587 1.413T19 21zm4.7-5.3l-1.4-1.4L17.6 5H14V3h7v7h-2V6.4z"/>
					</svg>
				</a>

				<!-- 等级徽章 (统一采用圆角矩形高级中性风) -->
				{#if levelInfo?.player_level !== undefined}
					<div class="flex items-center gap-2 shrink-0">
						<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-neutral-100 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200 border border-neutral-200 dark:border-neutral-700 shadow-2xs">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								class="w-3.5 h-3.5 text-amber-500 dark:text-amber-400"
								fill="currentColor"
							>
								<path d="M7 2h10v7.85q0 .575-.25 1.025t-.7.725l-3.55 2.1l.7 2.3H17l-3.1 2.2l1.2 3.8l-3.1-2.35L8.9 22l1.2-3.8L7 16h3.8l.7-2.3l-3.55-2.1q-.45-.275-.7-.725T7 9.85zm4 2v7.05l1 .6l1-.6V4z"/>
							</svg>
							Lv.{levelInfo.player_level}
						</span>
					</div>
				{/if}
			</div>

			<!-- 经验条与进度 -->
			{#if levelInfo}
				<div class="mt-2.5 max-w-md">
					<div class="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400 mb-1">
						<span>
							{i18n(I18nKey.steamXp)}: <strong class="text-neutral-800 dark:text-neutral-200">{levelInfo.player_xp.toLocaleString()}</strong>
						</span>
						<span>
							{i18n(I18nKey.steamNextLevelXp)} {levelInfo.player_xp_needed_to_level_up.toLocaleString()} XP
						</span>
					</div>
					<div class="w-full bg-neutral-200/70 dark:bg-neutral-800 rounded-full h-2 overflow-hidden">
						<div
							class="bg-gradient-to-r from-(--primary)/80 to-(--primary) h-full rounded-full transition-all duration-500"
							style="width: {levelInfo.progress_percent}%"
							title="升级进度: {levelInfo.progress_percent}%"
						/>
					</div>
				</div>
			{/if}
		</div>
	</div>

	<!-- 统计指标格 (重排顺序：累计总时长 -> 近两周时长 -> 徽章总数 -> 拥有游戏在最右边) -->
	<div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 md:gap-3 w-full lg:w-auto shrink-0">
		<!-- 1. 累计总时长 -->
		<div class="flex flex-col items-center justify-center p-3 rounded-xl bg-(--card-bg) border border-(--line-divider) min-w-[5rem] md:min-w-[5.75rem] shadow-xs hover:border-(--primary)/50 transition-colors">
			<span class="text-xs text-neutral-500 dark:text-neutral-400 font-medium whitespace-nowrap">
				{i18n(I18nKey.steamTotalPlaytime)}
			</span>
			<span class="text-lg md:text-xl font-bold text-(--primary) mt-1 leading-none">
				{stats.totalPlaytimeHours}h
			</span>
		</div>

		<!-- 2. 近两周时长 -->
		<div class="flex flex-col items-center justify-center p-3 rounded-xl bg-(--card-bg) border border-(--line-divider) min-w-[5rem] md:min-w-[5.75rem] shadow-xs hover:border-(--primary)/50 transition-colors">
			<span class="text-xs text-neutral-500 dark:text-neutral-400 font-medium whitespace-nowrap">
				{i18n(I18nKey.steamRecentPlaytime)}
			</span>
			<span class="text-lg md:text-xl font-bold text-(--primary) mt-1 leading-none">
				{stats.recentPlaytimeHours}h
			</span>
		</div>

		<!-- 3. 徽章总数 -->
		<div class="flex flex-col items-center justify-center p-3 rounded-xl bg-(--card-bg) border border-(--line-divider) min-w-[5rem] md:min-w-[5.75rem] shadow-xs hover:border-(--primary)/50 transition-colors">
			<span class="text-xs text-neutral-500 dark:text-neutral-400 font-medium whitespace-nowrap">
				{i18n(I18nKey.steamBadges)}
			</span>
			<span class="text-lg md:text-xl font-bold text-(--primary) mt-1 leading-none">
				{levelInfo?.badges_count ?? 0}
			</span>
		</div>

		<!-- 4. 拥有游戏 (最右侧) -->
		<div class="flex flex-col items-center justify-center p-3 rounded-xl bg-(--card-bg) border border-(--line-divider) min-w-[5rem] md:min-w-[5.75rem] shadow-xs hover:border-(--primary)/50 transition-colors">
			<span class="text-xs text-neutral-500 dark:text-neutral-400 font-medium whitespace-nowrap">
				{i18n(I18nKey.steamTotalGames)}
			</span>
			<span class="text-lg md:text-xl font-bold text-(--primary) mt-1 leading-none">
				{stats.totalGames}
			</span>
		</div>
	</div>
</div>
