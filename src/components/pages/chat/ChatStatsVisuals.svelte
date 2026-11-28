<script lang="ts">
import type {
	ChatStatsHourlySlot,
	ChatStatsSiteItem,
	ChatStatsTrackItem,
} from "./chatStatsTypes";

interface Props {
	hourlyProfile: ChatStatsHourlySlot[];
	siteDistribution: ChatStatsSiteItem[];
	topTracks: ChatStatsTrackItem[];
	showSites?: boolean;
}

const {
	hourlyProfile = [],
	siteDistribution = [],
	topTracks = [],
	showSites = true,
}: Props = $props();

const SITE_FALLBACK_COLORS = [
	"var(--skin-accent)",
	"#f472b6",
	"#38bdf8",
	"#fbbf24",
	"#34d399",
	"#a78bfa",
	"#fb7185",
	"#60a5fa",
];

let hoveredHour = $state<ChatStatsHourlySlot | null>(null);
let hoveredSiteIdx = $state<number | null>(null);

const maxHourMsg = $derived(
	Math.max(1, ...hourlyProfile.map((h) => h.messages)),
);

const peakHour = $derived.by(() => {
	let best: ChatStatsHourlySlot | null = null;
	for (const h of hourlyProfile) {
		if (h.messages > 0 && (!best || h.messages > best.messages)) best = h;
	}
	return best;
});

const donutSegments = $derived.by(() => {
	const positiveSites = siteDistribution.filter((s) => s.messages > 0);
	if (positiveSites.length === 0) return [];
	const head = positiveSites.slice(0, 7);
	const tail = positiveSites.slice(7);
	const grouped: ChatStatsSiteItem[] =
		tail.length > 0
			? [
					...head,
					{
						siteKey: "__others__",
						siteName: `其他 ${tail.length} 站`,
						color: "#94a3b8",
						messages: tail.reduce((acc, s) => acc + s.messages, 0),
						activeUsers: tail.reduce((acc, s) => acc + s.activeUsers, 0),
						sharePct:
							Math.round(tail.reduce((acc, s) => acc + s.sharePct, 0) * 10) /
							10,
					},
				]
			: head;

	const total = grouped.reduce((acc, s) => acc + s.messages, 0);
	if (total <= 0) return [];
	const r = 42;
	const c = 2 * Math.PI * r;
	let offset = 0;
	const hasMultiple = grouped.length > 1;
	return grouped.map((site, idx) => {
		const ratio = site.messages / total;
		const len = ratio * c;
		const gap = hasMultiple && len > 2.5 ? 1.2 : 0;
		const dashLen = Math.max(0.8, len - gap);
		const color =
			site.color || SITE_FALLBACK_COLORS[idx % SITE_FALLBACK_COLORS.length];
		const seg = {
			...site,
			color,
			dashArray: `${dashLen.toFixed(2)} ${Math.max(0, c - dashLen).toFixed(2)}`,
			dashOffset: (-offset).toFixed(2),
		};
		offset += len;
		return seg;
	});
});
</script>

<div class="grid grid-cols-1 lg:grid-cols-12 lg:items-stretch gap-3">
  <!-- 1. 24 小时活跃分布 -->
  <section class="chat-stats-bento-card h-full flex flex-col {showSites && siteDistribution.length > 0 ? 'lg:col-span-7' : 'lg:col-span-12'}" style="--stagger: 5;">
    <div class="flex items-center justify-between gap-2 mb-3">
      <div class="flex items-center gap-1.5 min-w-0">
        <svg class="w-4 h-4 sm:w-3.5 sm:h-3.5 text-[var(--skin-accent)] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
        <span class="text-sm sm:text-xs font-bold text-[var(--deep-text)] dark:text-white/95">24 小时活跃分布</span>
      </div>
      {#if hoveredHour}
        <span class="text-xs sm:text-[11px] font-mono text-[var(--skin-accent)] font-semibold tabular-nums">
          {String(hoveredHour.hour).padStart(2, "0")}:00 · {hoveredHour.messages} 条
        </span>
      {:else if peakHour}
        <span class="text-xs sm:text-[11px] text-[var(--chat-meta-color)] tabular-nums">
          最活跃 {String(peakHour.hour).padStart(2, "0")}:00 ({peakHour.messages} 条)
        </span>
      {/if}
    </div>

    <div
      class="flex-1 min-h-[7.5rem] flex items-end gap-0 pt-2 px-0.5"
      role="group"
      aria-label="24 小时柱状分布"
      onmouseleave={() => (hoveredHour = null)}
    >
      {#each hourlyProfile as slot, idx (slot.hour)}
        {@const pct = slot.messages > 0 ? Math.max(8, Math.round((slot.messages / maxHourMsg) * 100)) : 4}
        {@const isPeak = peakHour?.hour === slot.hour && slot.messages > 0}
        <button
          type="button"
          class="group flex-1 h-full flex flex-col justify-end items-center px-[1px] sm:px-[2px] border-none bg-transparent cursor-pointer"
          aria-label={`${slot.hour} 点：${slot.messages} 条消息`}
          onmouseenter={() => (hoveredHour = slot)}
          onfocus={() => (hoveredHour = slot)}
          onblur={() => (hoveredHour = null)}
          onclick={() =>
            (hoveredHour = hoveredHour?.hour === slot.hour ? null : slot)}
        >
          <span
            class="chat-stats-hour-bar w-full rounded-t-md transition-all duration-150 {isPeak ? 'is-peak' : slot.messages > 0 ? 'is-active' : 'is-empty'}"
            style="height: {pct}%; --bar-delay: {idx * 16}ms;"
          ></span>
        </button>
      {/each}
    </div>
    <div class="flex items-center justify-between text-[11.5px] sm:text-[10px] font-mono text-[var(--chat-meta-color)] opacity-75 mt-1.5 px-0.5 tabular-nums">
      <span>00:00</span>
      <span>06:00</span>
      <span>12:00</span>
      <span>18:00</span>
      <span>23:00</span>
    </div>
  </section>

  <!-- 2. 互联友站活力分布圆环 -->
  {#if showSites && siteDistribution.length > 0}
    <section class="chat-stats-bento-card h-full flex flex-col lg:col-span-5" style="--stagger: 6;">
      <div class="flex items-center justify-between gap-2 mb-2.5">
        <span class="text-sm sm:text-xs font-bold text-[var(--deep-text)] dark:text-white/95 flex items-center gap-1.5">
          <svg class="w-4 h-4 sm:w-3.5 sm:h-3.5 text-[var(--skin-accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <span>友站贡献占比</span>
        </span>
        <span class="text-xs sm:text-[11px] text-[var(--chat-meta-color)] tabular-nums">{siteDistribution.length} 个站点</span>
      </div>

      <div class="flex-1 flex flex-col sm:flex-row sm:items-center gap-3.5 min-h-0">
        <div class="relative w-24 h-24 shrink-0 self-center sm:self-auto">
          <svg viewBox="0 0 100 100" class="w-full h-full -rotate-90">
            <circle cx="50" cy="50" r="42" fill="none" stroke="var(--skin-line)" stroke-width="10" opacity="0.4" />
            {#each donutSegments as seg, idx (seg.siteKey)}
              <circle
                cx="50"
                cy="50"
                r="42"
                fill="none"
                stroke={seg.color}
                stroke-width={hoveredSiteIdx === idx ? 12.5 : 10}
                stroke-dasharray={seg.dashArray}
                stroke-dashoffset={seg.dashOffset}
                stroke-linecap="butt"
                class="transition-all duration-200 cursor-pointer"
                onmouseenter={() => (hoveredSiteIdx = idx)}
                onmouseleave={() => (hoveredSiteIdx = null)}
                onclick={() => (hoveredSiteIdx = hoveredSiteIdx === idx ? null : idx)}
              />
            {/each}
          </svg>
          <div class="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none px-2">
            {#if hoveredSiteIdx !== null && donutSegments[hoveredSiteIdx]}
              <span class="text-[13px] sm:text-xs font-bold text-[var(--deep-text)] dark:text-white tabular-nums">{donutSegments[hoveredSiteIdx].sharePct}%</span>
              <span class="text-[11px] sm:text-[9.5px] text-[var(--chat-meta-color)] truncate max-w-[60px]">{donutSegments[hoveredSiteIdx].siteName}</span>
            {:else}
              <span class="text-[13px] sm:text-xs font-bold text-[var(--deep-text)] dark:text-white tabular-nums">{siteDistribution.length}</span>
              <span class="text-[11px] sm:text-[9.5px] text-[var(--chat-meta-color)]">联邦站点</span>
            {/if}
          </div>
        </div>

        <div class="flex-1 min-w-0 sm:h-28 sm:overflow-y-auto custom-scrollbar sm:pr-1 space-y-1">
          {#each donutSegments as seg, idx (seg.siteKey)}
            <button
              type="button"
              class="w-full flex items-center justify-between gap-2 text-[13px] sm:text-[11px] rounded-md px-1.5 py-1 sm:py-0.5 border-none bg-transparent text-left cursor-pointer transition-colors {hoveredSiteIdx === idx ? 'bg-black/5 dark:bg-white/8' : ''}"
              onmouseenter={() => (hoveredSiteIdx = idx)}
              onmouseleave={() => (hoveredSiteIdx = null)}
              onclick={() => (hoveredSiteIdx = hoveredSiteIdx === idx ? null : idx)}
            >
              <span class="flex items-center gap-1.5 min-w-0">
                <span class="w-2 h-2 rounded-full shrink-0" style="background: {seg.color};"></span>
                <span class="truncate text-[var(--deep-text)] dark:text-white/90 font-medium">{seg.siteName}</span>
              </span>
              <span class="shrink-0 font-mono text-xs sm:text-[10.5px] text-[var(--chat-meta-color)] tabular-nums">
                {seg.messages} <span class="opacity-70">({seg.sharePct}%)</span>
              </span>
            </button>
          {/each}
        </div>
      </div>
    </section>
  {/if}

  <!-- 3. 热门点歌金曲榜（横向铺满） -->
  <section class="chat-stats-bento-card lg:col-span-12" style="--stagger: 7;">
    <div class="flex items-center justify-between gap-2 mb-2.5">
      <span class="text-sm sm:text-xs font-bold text-[var(--deep-text)] dark:text-white/95 flex items-center gap-1.5">
        <svg class="w-4 h-4 sm:w-3.5 sm:h-3.5 text-[var(--skin-accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
        <span>热门点歌排行</span>
      </span>
      <span class="text-xs sm:text-[11px] text-[var(--chat-meta-color)] tabular-nums">Top {topTracks.length}</span>
    </div>

    {#if topTracks.length === 0}
      <div class="py-6 text-center text-[13px] sm:text-xs text-[var(--chat-meta-color)]">该时间段暂无点歌或轮播记录</div>
    {:else}
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {#each topTracks as tr, idx (tr.id + idx)}
          <div class="flex items-center gap-2.5 p-2 rounded-xl bg-black/2.5 dark:bg-white/3.5 hover:bg-black/5 dark:hover:bg-white/7 transition-colors">
            <span class="w-5 text-center font-mono text-[13px] sm:text-[11px] font-bold shrink-0 {idx < 3 ? 'text-[var(--skin-accent)]' : 'text-[var(--chat-meta-color)]'}">
              {idx + 1}
            </span>
            {#if tr.cover}
              <img src={tr.cover} alt="" class="w-9 h-9 sm:w-8 sm:h-8 rounded-lg object-cover shrink-0 ring-1 ring-black/10 dark:ring-white/10" loading="lazy" />
            {:else}
              <div class="w-9 h-9 sm:w-8 sm:h-8 rounded-lg bg-[var(--skin-accent-soft)] text-[var(--skin-accent)] flex items-center justify-center text-xs shrink-0">♪</div>
            {/if}
            <div class="min-w-0 flex-1">
              <div class="text-[13.5px] sm:text-xs font-semibold text-[var(--deep-text)] dark:text-white/90 truncate">{tr.title}</div>
              <div class="text-xs sm:text-[10.5px] text-[var(--chat-meta-color)] truncate">
                {tr.artist}{tr.lastRequesterName ? ` · ${tr.lastRequesterName}` : ""}
              </div>
            </div>
            <div class="text-right shrink-0 tabular-nums">
              {#if tr.requestCount > 0}
                <span class="text-xs sm:text-[11px] font-bold text-[var(--skin-accent)] font-mono">{tr.requestCount} 点</span>
              {/if}
              {#if tr.rotationCount > 0}
                <span class="block text-[11px] sm:text-[10px] text-[var(--chat-meta-color)] font-mono">{tr.rotationCount} 播</span>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>
