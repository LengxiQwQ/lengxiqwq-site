<script lang="ts">
import ChatAvatar from "./ChatAvatar.svelte";
import type { ChatStatsRange, ChatStatsTimelinePoint } from "./chatStatsTypes";

interface Props {
	points: ChatStatsTimelinePoint[];
	range: ChatStatsRange;
	animKey: string;
	onSelectDay?: (dayKey: string) => void;
}

const { points = [], range, animKey, onSelectDay }: Props = $props();

let showStickers = $state(true);
let showImages = $state(false);
let showMusic = $state(false);
let hoverIndex = $state<number | null>(null);
let hoverScreenLeftPct = $state<number>(50);
let svgEl = $state<SVGSVGElement | null>(null);
let chartWrapEl = $state<HTMLDivElement | null>(null);

const chartHeight = 200;
let chartWidth = $state(920);
const pad = { top: 20, right: 14, bottom: 28, left: 36 };
const innerW = $derived(Math.max(100, chartWidth - pad.left - pad.right));
const innerH = chartHeight - pad.top - pad.bottom;
const baseY = chartHeight - pad.bottom;

$effect(() => {
	const el = chartWrapEl;
	if (!el || typeof ResizeObserver === "undefined") return;
	const syncWidth = (w: number) => {
		const next = Math.max(360, Math.round(w));
		if (next !== chartWidth) chartWidth = next;
	};
	syncWidth(el.clientWidth);
	const ro = new ResizeObserver((entries) => {
		for (const entry of entries) {
			syncWidth(entry.contentRect.width);
		}
	});
	ro.observe(el);
	return () => ro.disconnect();
});

const maxVal = $derived.by(() => {
	let max = 0;
	for (const p of points) {
		if (p.messages > max) max = p.messages;
		if (showStickers && p.stickers > max) max = p.stickers;
		if (showImages && p.images > max) max = p.images;
		if (showMusic && p.musicRequests > max) max = p.musicRequests;
	}
	if (max <= 8) return Math.max(8, Math.ceil(max * 1.2));
	const mag = 10 ** Math.floor(Math.log10(max));
	const step = Math.max(5, mag / 2);
	return Math.ceil((max * 1.15) / step) * step;
});

function getX(index: number, total: number): number {
	if (total <= 1) return pad.left + innerW / 2;
	return pad.left + (index / (total - 1)) * innerW;
}

function getY(val: number): number {
	const clamped = Math.max(0, Math.min(val, maxVal));
	return baseY - (clamped / maxVal) * innerH;
}

function buildLinePath(getter: (p: ChatStatsTimelinePoint) => number): string {
	if (points.length === 0) return "";
	return points
		.map(
			(p, idx) =>
				`${idx === 0 ? "M" : "L"} ${getX(idx, points.length).toFixed(2)},${getY(getter(p)).toFixed(2)}`,
		)
		.join(" ");
}

function buildAreaPath(getter: (p: ChatStatsTimelinePoint) => number): string {
	if (points.length === 0) return "";
	const coords = points.map(
		(p, idx) =>
			`${getX(idx, points.length).toFixed(2)},${getY(getter(p)).toFixed(2)}`,
	);
	const firstX = getX(0, points.length).toFixed(2);
	const lastX = getX(points.length - 1, points.length).toFixed(2);
	return `M ${firstX},${baseY} L ${coords.join(" L ")} L ${lastX},${baseY} Z`;
}

const msgLinePath = $derived(buildLinePath((p) => p.messages));
const msgAreaPath = $derived(buildAreaPath((p) => p.messages));
const stickerLinePath = $derived(buildLinePath((p) => p.stickers));
const stickerAreaPath = $derived(buildAreaPath((p) => p.stickers));
const imageLinePath = $derived(buildLinePath((p) => p.images));
const musicLinePath = $derived(buildLinePath((p) => p.musicRequests));

const yTicks = $derived.by(() => {
	const step = maxVal / 4;
	return [0, step, step * 2, step * 3, maxVal].map((v) => Math.round(v));
});

const xTickIndices = $derived.by(() => {
	const len = points.length;
	if (len === 0) return [];
	if (len <= 8) return points.map((_, idx) => idx);
	const candidates = [
		0,
		Math.floor(len * 0.25),
		Math.floor(len * 0.5),
		Math.floor(len * 0.75),
		len - 1,
	];
	return [...new Set(candidates)];
});

const rangeSummary = $derived.by(() => {
	if (points.length === 0)
		return { totalMsg: 0, avgMsg: 0, peakMsg: 0, peakLabel: "" };
	let totalMsg = 0;
	let peakMsg = 0;
	let peakLabel = "";
	for (const p of points) {
		totalMsg += p.messages;
		if (p.messages > peakMsg) {
			peakMsg = p.messages;
			peakLabel = p.label;
		}
	}
	return {
		totalMsg,
		avgMsg: Math.round(totalMsg / points.length),
		peakMsg,
		peakLabel,
	};
});

function handleMouseMove(e: MouseEvent) {
	if (!svgEl || !chartWrapEl || points.length === 0) return;
	const ctm = svgEl.getScreenCTM();
	let svgX: number;
	if (ctm) {
		const pt = svgEl.createSVGPoint();
		pt.x = e.clientX;
		pt.y = e.clientY;
		svgX = pt.matrixTransform(ctm.inverse()).x;
	} else {
		const rect = svgEl.getBoundingClientRect();
		if (rect.width <= 0) return;
		svgX = ((e.clientX - rect.left) / rect.width) * chartWidth;
	}
	const ratio = Math.max(0, Math.min(1, (svgX - pad.left) / innerW));
	const idx = Math.round(ratio * Math.max(0, points.length - 1));
	const clampedIdx = Math.max(0, Math.min(points.length - 1, idx));
	hoverIndex = clampedIdx;

	const hx = getX(clampedIdx, points.length);
	const wrapRect = chartWrapEl.getBoundingClientRect();
	if (ctm && wrapRect.width > 0) {
		const dotPt = svgEl.createSVGPoint();
		dotPt.x = hx;
		dotPt.y = baseY;
		const screenX = dotPt.matrixTransform(ctm).x;
		hoverScreenLeftPct = Math.max(
			0,
			Math.min(100, ((screenX - wrapRect.left) / wrapRect.width) * 100),
		);
	} else {
		hoverScreenLeftPct = (hx / chartWidth) * 100;
	}
}

function handleClickChart() {
	if (hoverIndex === null || !onSelectDay) return;
	const pt = points[hoverIndex];
	if (pt && range !== "day" && pt.dayKey) {
		onSelectDay(pt.dayKey);
	}
}
</script>

<section class="p-4 sm:p-5 rounded-2xl bg-[var(--skin-rail)] border border-[var(--skin-line)] relative">
  <!-- 头部标题与图例切换 -->
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 mb-3">
    <div>
      <h4 class="text-sm font-bold text-[var(--deep-text)] dark:text-white/95 m-0 flex items-center gap-1.5">
        <svg class="w-4 h-4 text-[var(--skin-accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
        <span>{range === "day" ? "24 小时发言走势" : "周期发言走势"}</span>
      </h4>
      <p class="text-[11px] text-[var(--chat-meta-color)] mt-0.5 mb-0">
        {range === "day" ? "当日各时段消息与互动变化" : "按日统计消息、表情、晒图与点歌变化（点击节点可查看单日详情）"}
      </p>
    </div>

    <div class="flex flex-wrap items-center gap-1.5 self-start sm:self-auto">
      <span class="text-xs px-2.5 py-1 rounded-lg border border-[var(--skin-accent)]/30 bg-[var(--skin-accent-soft)] text-[var(--skin-accent)] font-semibold flex items-center gap-1.5">
        <span class="w-2 h-2 rounded-sm bg-[var(--skin-accent)]"></span>
        <span>消息数</span>
      </span>
      <button
        type="button"
        class="text-xs px-2.5 py-1 rounded-lg border flex items-center gap-1.5 transition-all cursor-pointer {showStickers ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 font-semibold' : 'border-[var(--skin-line)] text-[var(--chat-meta-color)] opacity-55 bg-transparent'}"
        onclick={() => (showStickers = !showStickers)}
      >
        <span class="w-2 h-2 rounded-sm bg-emerald-500"></span>
        <span>表情</span>
      </button>
      <button
        type="button"
        class="text-xs px-2.5 py-1 rounded-lg border flex items-center gap-1.5 transition-all cursor-pointer {showImages ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30 font-semibold' : 'border-[var(--skin-line)] text-[var(--chat-meta-color)] opacity-55 bg-transparent'}"
        onclick={() => (showImages = !showImages)}
      >
        <span class="w-2 h-2 rounded-sm bg-sky-500"></span>
        <span>晒图</span>
      </button>
      <button
        type="button"
        class="text-xs px-2.5 py-1 rounded-lg border flex items-center gap-1.5 transition-all cursor-pointer {showMusic ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 font-semibold' : 'border-[var(--skin-line)] text-[var(--chat-meta-color)] opacity-55 bg-transparent'}"
        onclick={() => (showMusic = !showMusic)}
      >
        <span class="w-2 h-2 rounded-sm bg-amber-500"></span>
        <span>点歌</span>
      </button>
    </div>
  </div>

  <!-- 周期概览行 -->
  <div class="flex flex-wrap items-center gap-3 text-xs text-[var(--chat-meta-color)] mb-3 pb-2.5 border-b border-[var(--skin-line)]/60 tabular-nums">
    <div>
      合计: <strong class="font-mono text-[var(--deep-text)] dark:text-white/90">{rangeSummary.totalMsg.toLocaleString()}</strong> 条
    </div>
    <span>·</span>
    <div>
      {range === "day" ? "每小时均:" : "日均:"} <strong class="font-mono text-[var(--deep-text)] dark:text-white/90">{rangeSummary.avgMsg.toLocaleString()}</strong> 条
    </div>
    {#if rangeSummary.peakMsg > 0}
      <span>·</span>
      <div>
        最高峰值: <strong class="font-mono text-[var(--skin-accent)]">{rangeSummary.peakMsg.toLocaleString()}</strong> 条 ({rangeSummary.peakLabel})
      </div>
    {/if}
  </div>

  <!-- SVG 绘图区（与全站博客统计页同款清晰折线风格） -->
  <div bind:this={chartWrapEl} class="relative w-full overflow-hidden select-none">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <svg
      bind:this={svgEl}
      viewBox="0 0 {chartWidth} {chartHeight}"
      style="height: {chartHeight}px;"
      class="w-full block overflow-visible {range !== 'day' ? 'cursor-pointer' : ''}"
      role="img"
      aria-label="聊天室发言走势折线图"
      onmousemove={handleMouseMove}
      onmouseleave={() => (hoverIndex = null)}
      onclick={handleClickChart}
    >
      <defs>
        <linearGradient id="chatTrendMsgGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--skin-accent)" stop-opacity="0.28" />
          <stop offset="100%" stop-color="var(--skin-accent)" stop-opacity="0.0" />
        </linearGradient>
        <linearGradient id="chatTrendStickerGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#10b981" stop-opacity="0.2" />
          <stop offset="100%" stop-color="#10b981" stop-opacity="0.0" />
        </linearGradient>
        {#if points.length > 0}
          <clipPath id="chatTrendAreaClip">
            {#key animKey}
              <rect x={pad.left} y="0" width="0" height={chartHeight}>
                <animate
                  attributeName="width"
                  from="0"
                  to={innerW}
                  dur="1.1s"
                  fill="freeze"
                  calcMode="spline"
                  keySplines="0.16 1 0.3 1"
                  keyTimes="0; 1"
                />
              </rect>
            {/key}
          </clipPath>
        {/if}
      </defs>

      <!-- Y 轴参考线与刻度 -->
      {#each yTicks as tickVal}
        {@const yPos = getY(tickVal)}
        <line
          x1={pad.left}
          y1={yPos}
          x2={chartWidth - pad.right}
          y2={yPos}
          stroke="currentColor"
          class="text-black/6 dark:text-white/6"
          stroke-dasharray="3,3"
        />
        <text
          x={pad.left - 6}
          y={yPos + 3}
          text-anchor="end"
          font-size="9"
          class="fill-neutral-400 dark:fill-neutral-500 font-mono"
        >
          {tickVal}
        </text>
      {/each}

      <!-- X 轴刻度 -->
      {#if points.length > 0}
        {#each xTickIndices as idx}
          {@const pt = points[idx]}
          {#if pt}
            <text
              x={getX(idx, points.length)}
              y={chartHeight - 8}
              text-anchor="middle"
              font-size="9"
              class="fill-neutral-400 dark:fill-neutral-500 font-mono"
            >
              {pt.label}
            </text>
          {/if}
        {/each}
      {/if}

      <!-- 折线与区域（无脉冲、无发光滤镜） -->
      {#key animKey}
        <g class="pointer-events-none">
          <g clip-path="url(#chatTrendAreaClip)">
            {#if points.length > 0}
              <path d={msgAreaPath} fill="url(#chatTrendMsgGrad)" />
            {/if}
            {#if showStickers && points.length > 0}
              <path d={stickerAreaPath} fill="url(#chatTrendStickerGrad)" />
            {/if}
          </g>

          {#if showMusic && points.length > 0}
            <path
              d={musicLinePath}
              fill="none"
              stroke="#f59e0b"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              pathLength="1000"
              class="chat-trend-line-sub"
            />
          {/if}

          {#if showImages && points.length > 0}
            <path
              d={imageLinePath}
              fill="none"
              stroke="#0ea5e9"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              pathLength="1000"
              class="chat-trend-line-sub"
            />
          {/if}

          {#if showStickers && points.length > 0}
            <path
              d={stickerLinePath}
              fill="none"
              stroke="#10b981"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              pathLength="1000"
              class="chat-trend-line-sub"
            />
          {/if}

          {#if points.length > 0}
            <path
              d={msgLinePath}
              fill="none"
              stroke="var(--skin-accent)"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              pathLength="1000"
              class="chat-trend-line-main"
            />
          {/if}
        </g>
      {/key}

      <!-- 悬停竖线与高亮点 -->
      {#if hoverIndex !== null && points[hoverIndex]}
        {@const hp = points[hoverIndex]}
        {@const hx = getX(hoverIndex, points.length)}

        <line
          x1={hx}
          y1={pad.top}
          x2={hx}
          y2={baseY}
          stroke="currentColor"
          class="text-[var(--skin-accent)]/60"
          stroke-width="1.5"
          stroke-dasharray="2,2"
        />

        <circle cx={hx} cy={getY(hp.messages)} r="4.5" fill="var(--skin-accent)" class="stroke-white dark:stroke-neutral-900" stroke-width="2" />
        {#if showStickers}
          <circle cx={hx} cy={getY(hp.stickers)} r="4" fill="#10b981" class="stroke-white dark:stroke-neutral-900" stroke-width="2" />
        {/if}
        {#if showImages}
          <circle cx={hx} cy={getY(hp.images)} r="4" fill="#0ea5e9" class="stroke-white dark:stroke-neutral-900" stroke-width="2" />
        {/if}
        {#if showMusic}
          <circle cx={hx} cy={getY(hp.musicRequests)} r="4" fill="#f59e0b" class="stroke-white dark:stroke-neutral-900" stroke-width="2" />
        {/if}
      {/if}
    </svg>

    <!-- 悬浮提示卡 -->
    {#if hoverIndex !== null && points[hoverIndex]}
      {@const hp = points[hoverIndex]}
      {@const isRightHalf = hoverScreenLeftPct > 50}
      <div
        class="pointer-events-none absolute top-2 z-20 px-3 py-2 rounded-xl bg-[var(--skin-surface)] border border-[var(--skin-line)] shadow-lg text-xs whitespace-nowrap min-w-[144px] select-none"
        style={isRightHalf
          ? `right: calc(${Math.max(0, 100 - hoverScreenLeftPct)}% + 12px);`
          : `left: calc(${Math.max(0, hoverScreenLeftPct)}% + 12px);`}
      >
        <div class="font-bold text-[var(--deep-text)] dark:text-white/95 border-b border-[var(--skin-line)] pb-1 mb-1.5 font-mono flex items-center justify-between gap-3">
          <span>{hp.label}</span>
          <span class="text-[10px] font-normal text-[var(--chat-meta-color)]">{hp.activeUsers} 人活跃</span>
        </div>
        <div class="space-y-1">
          <div class="flex items-center justify-between gap-4">
            <span class="flex items-center gap-1.5 text-[var(--chat-meta-color)]">
              <span class="w-2 h-2 rounded-sm bg-[var(--skin-accent)] shrink-0"></span>
              <span>消息</span>
            </span>
            <strong class="font-mono text-[var(--deep-text)] dark:text-white/95">{hp.messages} 条</strong>
          </div>
          {#if showStickers}
            <div class="flex items-center justify-between gap-4">
              <span class="flex items-center gap-1.5 text-[var(--chat-meta-color)]">
                <span class="w-2 h-2 rounded-sm bg-emerald-500 shrink-0"></span>
                <span>表情</span>
              </span>
              <strong class="font-mono text-[var(--deep-text)] dark:text-white/95">{hp.stickers} 个</strong>
            </div>
          {/if}
          {#if showImages}
            <div class="flex items-center justify-between gap-4">
              <span class="flex items-center gap-1.5 text-[var(--chat-meta-color)]">
                <span class="w-2 h-2 rounded-sm bg-sky-500 shrink-0"></span>
                <span>晒图</span>
              </span>
              <strong class="font-mono text-[var(--deep-text)] dark:text-white/95">{hp.images} 张</strong>
            </div>
          {/if}
          {#if showMusic}
            <div class="flex items-center justify-between gap-4">
              <span class="flex items-center gap-1.5 text-[var(--chat-meta-color)]">
                <span class="w-2 h-2 rounded-sm bg-amber-500 shrink-0"></span>
                <span>点歌</span>
              </span>
              <strong class="font-mono text-[var(--deep-text)] dark:text-white/95">{hp.musicRequests} 首</strong>
            </div>
          {/if}
        </div>
        {#if hp.topUser}
          <div class="mt-1.5 pt-1 border-t border-[var(--skin-line)]/70 flex items-center gap-1.5 text-[10.5px] text-[var(--chat-meta-color)]">
            <ChatAvatar src={hp.topUser.avatar} name={hp.topUser.name} size="2xs" />
            <span class="truncate max-w-[95px]">{hp.topUser.name}</span>
            <span class="font-mono ml-auto">{hp.topUser.count}条</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
.chat-trend-line-main {
	stroke-dasharray: 1000;
	stroke-dashoffset: 1000;
	animation: chatTrendDraw 0.9s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

.chat-trend-line-sub {
	stroke-dasharray: 1000;
	stroke-dashoffset: 1000;
	animation: chatTrendDraw 1.05s cubic-bezier(0.16, 1, 0.3, 1) 0.08s forwards;
}

@keyframes chatTrendDraw {
	to {
		stroke-dashoffset: 0;
	}
}

@media (prefers-reduced-motion: reduce) {
	.chat-trend-line-main,
	.chat-trend-line-sub {
		animation: none !important;
		stroke-dashoffset: 0 !important;
	}
}
</style>
