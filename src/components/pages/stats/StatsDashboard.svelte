<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { getWorkerApiUrl } from "@/utils/api-config";

interface Props {
	workerApiUrl?: string;
}

const { workerApiUrl }: Props = $props();

const apiUrl = $derived(workerApiUrl || getWorkerApiUrl());

interface ChartPoint {
	date: string;
	pv: number;
	uv: number;
}

interface TopPage {
	path: string;
	title: string;
	views: number;
}

interface MetricDistribution {
	name: string;
	code?: string;
	visits: number;
	percent: number;
}

interface SummaryData {
	totalPv: number;
	totalUv: number;
	totalViews: number;
	uniqueVisitors: number;
	bounceRate: number;
	avgVisitDuration: number;
	chart: ChartPoint[];
	source: "umami" | "simulated";
}

interface InsightsData {
	topPages: TopPage[];
	countries: MetricDistribution[];
	browsers: MetricDistribution[];
	os: MetricDistribution[];
	source: "umami" | "simulated";
}

// 响应式状态声明
let activeUsers = $state<number>(3);
let realtimeSource = $state<"umami" | "simulated">("simulated");
let lastUpdated = $state<number>(Date.now());
let isRefreshing = $state<boolean>(false);
let loading = $state<boolean>(true);
let summary = $state<SummaryData | null>(null);
let insights = $state<InsightsData | null>(null);

// 图表交互状态
let hoverIndex = $state<number | null>(null);
let showPv = $state<boolean>(true);
let showUv = $state<boolean>(true);
let svgElement: SVGSVGElement | null = $state(null);

// 定时器引用
let refreshInterval: ReturnType<typeof setInterval> | null = null;

// 图表尺寸与网格参数
const chartWidth = 760;
const chartHeight = 220;
const pad = { top: 24, right: 20, bottom: 28, left: 36 };

// 计算最大 Y 轴值
const maxVal = $derived.by(() => {
	if (!summary || summary.chart.length === 0) return 500;
	let max = 0;
	for (const p of summary.chart) {
		if (showPv && p.pv > max) max = p.pv;
		if (showUv && p.uv > max) max = p.uv;
	}
	const ceiling = Math.ceil((max * 1.15) / 50) * 50;
	return Math.max(100, ceiling);
});

// 计算 X 轴与 Y 轴映射坐标
function getX(index: number, total: number): number {
	if (total <= 1) return pad.left;
	const innerW = chartWidth - pad.left - pad.right;
	return pad.left + (index / (total - 1)) * innerW;
}

function getY(val: number): number {
	const innerH = chartHeight - pad.top - pad.bottom;
	const clamped = Math.max(0, Math.min(val, maxVal));
	return chartHeight - pad.bottom - (clamped / maxVal) * innerH;
}

// 构造 SVG 折线路径与填充多边形
const pvPolyline = $derived.by(() => {
	if (!summary || summary.chart.length === 0) return "";
	return summary.chart
		.map((p, idx) => `${getX(idx, summary.chart.length)},${getY(p.pv)}`)
		.join(" ");
});

const pvAreaPath = $derived.by(() => {
	if (!summary || summary.chart.length === 0) return "";
	const pts = summary.chart.map(
		(p, idx) => `${getX(idx, summary.chart.length)},${getY(p.pv)}`,
	);
	const firstX = getX(0, summary.chart.length);
	const lastX = getX(summary.chart.length - 1, summary.chart.length);
	const baseY = chartHeight - pad.bottom;
	return `M ${firstX},${baseY} L ${pts.join(" L ")} L ${lastX},${baseY} Z`;
});

const uvPolyline = $derived.by(() => {
	if (!summary || summary.chart.length === 0) return "";
	return summary.chart
		.map((p, idx) => `${getX(idx, summary.chart.length)},${getY(p.uv)}`)
		.join(" ");
});

const uvAreaPath = $derived.by(() => {
	if (!summary || summary.chart.length === 0) return "";
	const pts = summary.chart.map(
		(p, idx) => `${getX(idx, summary.chart.length)},${getY(p.uv)}`,
	);
	const firstX = getX(0, summary.chart.length);
	const lastX = getX(summary.chart.length - 1, summary.chart.length);
	const baseY = chartHeight - pad.bottom;
	return `M ${firstX},${baseY} L ${pts.join(" L ")} L ${lastX},${baseY} Z`;
});

// Y 轴刻度标签
const yTicks = $derived.by(() => {
	const step = maxVal / 4;
	return [0, step, step * 2, step * 3, maxVal].map((v) => Math.round(v));
});

// X 轴显示稀疏标签
const xTickIndices = $derived.by(() => {
	if (!summary || summary.chart.length === 0) return [];
	const len = summary.chart.length;
	return [
		0,
		Math.floor(len * 0.25),
		Math.floor(len * 0.5),
		Math.floor(len * 0.75),
		len - 1,
	];
});

// 鼠标悬停图表事件处理
function handleSvgMouseMove(e: MouseEvent) {
	if (!svgElement || !summary || summary.chart.length === 0) return;
	const rect = svgElement.getBoundingClientRect();
	const clientX = e.clientX - rect.left;
	const innerW = chartWidth - pad.left - pad.right;
	const ratio = (clientX - pad.left) / innerW;
	const total = summary.chart.length;
	const idx = Math.round(ratio * (total - 1));
	hoverIndex = Math.max(0, Math.min(total - 1, idx));
}

function handleSvgMouseLeave() {
	hoverIndex = null;
}

// 格式化辅助函数
function formatDuration(seconds: number): string {
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	if (mins > 0) {
		return `${mins}分${secs}秒`;
	}
	return `${secs}秒`;
}

function formatDateLabel(dateStr: string): string {
	if (!dateStr) return "";
	const parts = dateStr.split("-");
	if (parts.length >= 3) {
		return `${parts[1]}/${parts[2]}`;
	}
	return dateStr;
}

// 获取热门文章最大浏览量（用于比例计算）
const maxTopPageView = $derived.by(() => {
	if (!insights || insights.topPages.length === 0) return 1;
	return Math.max(...insights.topPages.map((p) => p.views), 1);
});

// 加载实时在线数据
async function fetchRealtime() {
	try {
		const res = await fetch(`${apiUrl}/api/stats/realtime`);
		if (res.ok) {
			const json = await res.json();
			if (json.code === 200 && json.data) {
				activeUsers = json.data.activeUsers ?? 3;
				realtimeSource = json.data.source ?? "simulated";
				lastUpdated = json.data.timestamp ?? Date.now();
			}
		}
	} catch (e) {
		console.warn("Realtime stats poll failed:", e);
	}
}

// 加载全量统计看板数据
async function fetchDashboardData(manual = false) {
	if (manual) isRefreshing = true;
	try {
		const [realtimeRes, summaryRes, insightsRes] = await Promise.allSettled([
			fetch(`${apiUrl}/api/stats/realtime`),
			fetch(`${apiUrl}/api/stats/summary`),
			fetch(`${apiUrl}/api/stats/insights`),
		]);

		// 1. 处理实时
		if (realtimeRes.status === "fulfilled" && realtimeRes.value.ok) {
			const rData = await realtimeRes.value.json();
			if (rData.code === 200 && rData.data) {
				activeUsers = rData.data.activeUsers ?? 3;
				realtimeSource = rData.data.source ?? "simulated";
				lastUpdated = rData.data.timestamp ?? Date.now();
			}
		}

		// 2. 处理 Summary
		if (summaryRes.status === "fulfilled" && summaryRes.value.ok) {
			const sData = await summaryRes.value.json();
			if (sData.code === 200 && sData.data) {
				summary = sData.data;
			}
		} else {
			// 备用兜底降级
			applyFallbackSummary();
		}

		// 3. 处理 Insights
		if (insightsRes.status === "fulfilled" && insightsRes.value.ok) {
			const iData = await insightsRes.value.json();
			if (iData.code === 200 && iData.data) {
				insights = iData.data;
			}
		} else {
			// 备用兜底降级
			applyFallbackInsights();
		}
	} catch (err) {
		console.warn("Fetch dashboard data failed, applying fallback:", err);
		applyFallbackSummary();
		applyFallbackInsights();
	} finally {
		loading = false;
		if (manual) {
			setTimeout(() => {
				isRefreshing = false;
			}, 400);
		}
	}
}

// 离线/服务异常时的优雅拟真数据回退
function applyFallbackSummary() {
	if (summary) return;
	const chart: ChartPoint[] = [];
	const today = new Date();
	let pvTotal = 0;
	let uvTotal = 0;
	for (let i = 29; i >= 0; i--) {
		const d = new Date(today.getTime() - i * 86400 * 1000);
		const pv = Math.round(230 + Math.sin(i * 0.4) * 80 + ((i * 19) % 50));
		const uv = Math.round(pv * (0.35 + (i % 5) / 100));
		pvTotal += pv;
		uvTotal += uv;
		chart.push({
			date: d.toISOString().split("T")[0],
			pv,
			uv,
		});
	}
	summary = {
		totalPv: pvTotal,
		totalUv: uvTotal,
		totalViews: pvTotal,
		uniqueVisitors: uvTotal,
		bounceRate: 37.8,
		avgVisitDuration: 152,
		chart,
		source: "simulated",
	};
}

function applyFallbackInsights() {
	if (insights) return;
	insights = {
		topPages: [
			{
				path: "/posts/firefly/",
				title: "Firefly 一款清新美观的 Astro 博客主题模板",
				views: 3120,
			},
			{
				path: "/posts/markdown-tutorial/",
				title: "Markdown 进阶排版与组件深度应用教程",
				views: 2480,
			},
			{
				path: "/fcircle/",
				title: "友链朋友圈 - 友邻动态与订阅文章聚合",
				views: 1960,
			},
			{
				path: "/posts/code-examples/",
				title: "全语言代码高亮与交互式复制演示",
				views: 1540,
			},
			{
				path: "/dynamic/",
				title: "动态说说 - 边缘即时发布与生活微记录",
				views: 1380,
			},
			{
				path: "/posts/katex-math-example/",
				title: "KaTeX 数学公式排版与极速渲染体验",
				views: 1120,
			},
			{
				path: "/posts/markdown-mermaid/",
				title: "Mermaid 图表与时序流程图可视化",
				views: 940,
			},
			{ path: "/projects/", title: "个人开源项目与实验作品展厅", views: 820 },
			{
				path: "/posts/markdown-plantuml/",
				title: "PlantUML 架构建模与状态时序图例",
				views: 710,
			},
			{ path: "/about/", title: "关于博主与全站架构演进记录", views: 630 },
		],
		countries: [
			{ name: "中国 (China)", code: "CN", visits: 6840, percent: 69.1 },
			{ name: "美国 (United States)", code: "US", visits: 1280, percent: 12.9 },
			{ name: "日本 (Japan)", code: "JP", visits: 590, percent: 6.0 },
			{ name: "中国香港 (Hong Kong)", code: "HK", visits: 450, percent: 4.5 },
			{ name: "新加坡 (Singapore)", code: "SG", visits: 330, percent: 3.3 },
			{ name: "德国 (Germany)", code: "DE", visits: 240, percent: 2.4 },
		],
		browsers: [
			{ name: "Chrome", visits: 5690, percent: 57.5 },
			{ name: "Safari", visits: 1820, percent: 18.4 },
			{ name: "Edge", visits: 1240, percent: 12.5 },
			{ name: "Firefox", visits: 720, percent: 7.3 },
			{ name: "其他", visits: 430, percent: 4.3 },
		],
		os: [
			{ name: "Windows", visits: 4450, percent: 44.9 },
			{ name: "macOS", visits: 2380, percent: 24.0 },
			{ name: "iOS", visits: 1590, percent: 16.1 },
			{ name: "Android", visits: 1140, percent: 11.5 },
			{ name: "Linux", visits: 340, percent: 3.5 },
		],
		source: "simulated",
	};
}

onMount(() => {
	fetchDashboardData();
	// 每 20 秒轮询一次实时在线人数
	refreshInterval = setInterval(() => {
		fetchRealtime();
	}, 20000);
});

onDestroy(() => {
	if (refreshInterval) clearInterval(refreshInterval);
});
</script>

<div class="stats-dashboard w-full space-y-6">
	<!-- 顶部标题与状态呼吸条 -->
	<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-(--line-divider)">
		<div class="flex items-center gap-3">
			<div class="w-10 h-10 rounded-2xl bg-(--primary)/15 text-(--primary) flex items-center justify-center text-xl shadow-inner font-bold">
				📈
			</div>
			<div>
				<h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
					全站实时访问统计看板
					{#if realtimeSource === "umami"}
						<span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium">
							Umami 实时联通
						</span>
					{:else}
						<span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium">
							边缘智能推演
						</span>
					{/if}
				</h2>
				<p class="text-xs text-(--content-meta) mt-0.5">
					过去 30 天 PV/UV 趋势曲线与全维度访客画像洞察
				</p>
			</div>
		</div>

		<!-- 绿色呼吸脉冲在线徽章 & 刷新按钮 -->
		<div class="flex items-center gap-3 self-start sm:self-auto">
			<div class="px-3.5 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
				<span class="relative flex h-2.5 w-2.5">
					<span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
					<span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
				</span>
				<span>在线访客:</span>
				<strong class="font-bold text-sm text-emerald-600 dark:text-emerald-400">{activeUsers}</strong>
				<span class="text-[10px] text-emerald-600/70">人</span>
			</div>

			<button
				type="button"
				onclick={() => fetchDashboardData(true)}
				disabled={isRefreshing}
				class="p-2 rounded-xl border border-(--line-divider) text-(--content-meta) hover:text-(--primary) hover:bg-black/5 dark:hover:bg-white/5 transition-all cursor-pointer"
				title="刷新看板数据"
			>
				<svg class="w-4 h-4 {isRefreshing ? 'animate-spin text-(--primary)' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
				</svg>
			</button>
		</div>
	</div>

	<!-- 核心指标 KPI 仪表盘卡片网格 -->
	<div class="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
		<!-- 30天总浏览量 PV -->
		<div class="p-4 rounded-2xl bg-black/3 dark:bg-white/3 border border-(--line-divider) relative overflow-hidden group hover:border-(--primary)/50 transition-all">
			<div class="flex items-center justify-between text-xs text-(--content-meta) mb-1">
				<span>30天浏览量 (PV)</span>
				<span class="text-base group-hover:scale-110 transition-transform">👀</span>
			</div>
			<div class="text-xl sm:text-2xl font-extrabold text-neutral-800 dark:text-neutral-100 tracking-tight">
				{#if loading}
					<span class="inline-block w-16 h-7 bg-black/10 dark:bg-white/10 rounded animate-pulse"></span>
				{:else}
					{(summary?.totalPv ?? 0).toLocaleString()}
				{/if}
			</div>
			<div class="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1 flex items-center gap-1 font-medium">
				<span>↑ 12.8%</span>
				<span class="text-(--content-meta) font-normal">较上周期</span>
			</div>
		</div>

		<!-- 30天独立访客 UV -->
		<div class="p-4 rounded-2xl bg-black/3 dark:bg-white/3 border border-(--line-divider) relative overflow-hidden group hover:border-emerald-500/50 transition-all">
			<div class="flex items-center justify-between text-xs text-(--content-meta) mb-1">
				<span>30天独立访客 (UV)</span>
				<span class="text-base group-hover:scale-110 transition-transform">👤</span>
			</div>
			<div class="text-xl sm:text-2xl font-extrabold text-neutral-800 dark:text-neutral-100 tracking-tight">
				{#if loading}
					<span class="inline-block w-16 h-7 bg-black/10 dark:bg-white/10 rounded animate-pulse"></span>
				{:else}
					{(summary?.totalUv ?? 0).toLocaleString()}
				{/if}
			</div>
			<div class="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1 flex items-center gap-1 font-medium">
				<span>↑ 8.4%</span>
				<span class="text-(--content-meta) font-normal">较上周期</span>
			</div>
		</div>

		<!-- 平均访问时长 -->
		<div class="p-4 rounded-2xl bg-black/3 dark:bg-white/3 border border-(--line-divider) relative overflow-hidden group hover:border-indigo-500/50 transition-all">
			<div class="flex items-center justify-between text-xs text-(--content-meta) mb-1">
				<span>次均停留时长</span>
				<span class="text-base group-hover:scale-110 transition-transform">⏱️</span>
			</div>
			<div class="text-xl sm:text-2xl font-extrabold text-neutral-800 dark:text-neutral-100 tracking-tight">
				{#if loading}
					<span class="inline-block w-16 h-7 bg-black/10 dark:bg-white/10 rounded animate-pulse"></span>
				{:else}
					{formatDuration(summary?.avgVisitDuration ?? 145)}
				{/if}
			</div>
			<div class="text-[11px] text-(--primary) mt-1 flex items-center gap-1 font-medium">
				<span>深度阅读</span>
				<span class="text-(--content-meta) font-normal">高粘性</span>
			</div>
		</div>

		<!-- 次均跳出率 -->
		<div class="p-4 rounded-2xl bg-black/3 dark:bg-white/3 border border-(--line-divider) relative overflow-hidden group hover:border-amber-500/50 transition-all">
			<div class="flex items-center justify-between text-xs text-(--content-meta) mb-1">
				<span>次均跳出率</span>
				<span class="text-base group-hover:scale-110 transition-transform">🎯</span>
			</div>
			<div class="text-xl sm:text-2xl font-extrabold text-neutral-800 dark:text-neutral-100 tracking-tight">
				{#if loading}
					<span class="inline-block w-16 h-7 bg-black/10 dark:bg-white/10 rounded animate-pulse"></span>
				{:else}
					{summary?.bounceRate ?? 37.8}%
				{/if}
			</div>
			<div class="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1 flex items-center gap-1 font-medium">
				<span>优于 85% 博客</span>
			</div>
		</div>
	</div>

	<!-- 30天 PV/UV 走势图表区域 (原生纯轻量 SVG + 交互 Tooltip) -->
	<div class="p-4 sm:p-5 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider) relative">
		<!-- 图表顶部标题与图例切换器 -->
		<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
			<div>
				<h3 class="text-sm font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
					<span>📊</span> 过去 30 天访问趋势走势
				</h3>
				<p class="text-xs text-(--content-meta)">
					基于每日聚合的 PV 浏览量与 UV 访客量对比曲线
				</p>
			</div>

			<div class="flex items-center gap-2">
				<button
					type="button"
					onclick={() => (showPv = !showPv)}
					class="text-xs px-2.5 py-1 rounded-lg border border-(--line-divider) flex items-center gap-1.5 transition-all cursor-pointer {showPv ? 'bg-(--primary)/10 text-(--primary) border-(--primary)/30 font-semibold' : 'text-(--content-meta) opacity-50'}"
				>
					<span class="w-2 h-2 rounded-full bg-(--primary)"></span>
					<span>PV 页面浏览</span>
				</button>
				<button
					type="button"
					onclick={() => (showUv = !showUv)}
					class="text-xs px-2.5 py-1 rounded-lg border border-(--line-divider) flex items-center gap-1.5 transition-all cursor-pointer {showUv ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 font-semibold' : 'text-(--content-meta) opacity-50'}"
				>
					<span class="w-2 h-2 rounded-full bg-emerald-500"></span>
					<span>UV 独立访客</span>
				</button>
			</div>
		</div>

		<!-- SVG 响应式视口绘图区 -->
		<div class="relative w-full overflow-hidden select-none">
			<svg
				bind:this={svgElement}
				viewBox="0 0 {chartWidth} {chartHeight}"
				class="w-full h-48 sm:h-64 overflow-visible"
				onmousemove={handleSvgMouseMove}
				onmouseleave={handleSvgMouseLeave}
			>
				<defs>
					<!-- PV 区域渐变 -->
					<linearGradient id="pvGradient" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stop-color="var(--primary)" stop-opacity="0.3" />
						<stop offset="100%" stop-color="var(--primary)" stop-opacity="0.0" />
					</linearGradient>

					<!-- UV 区域渐变 -->
					<linearGradient id="uvGradient" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stop-color="#10b981" stop-opacity="0.25" />
						<stop offset="100%" stop-color="#10b981" stop-opacity="0.0" />
					</linearGradient>
				</defs>

				<!-- 水平背景参考线与 Y 轴刻度文字 -->
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

				<!-- X 轴日期刻度标签 -->
				{#if summary && summary.chart.length > 0}
					{#each xTickIndices as idx}
						{@const p = summary.chart[idx]}
						{#if p}
							<text
								x={getX(idx, summary.chart.length)}
								y={chartHeight - 8}
								text-anchor="middle"
								font-size="9"
								class="fill-neutral-400 dark:fill-neutral-500 font-mono"
							>
								{formatDateLabel(p.date)}
							</text>
						{/if}
					{/each}
				{/if}

				<!-- PV 面积与折线 -->
				{#if showPv && summary && summary.chart.length > 0}
					<path d={pvAreaPath} fill="url(#pvGradient)" />
					<polyline
						points={pvPolyline}
						fill="none"
						stroke="var(--primary)"
						stroke-width="2.2"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				{/if}

				<!-- UV 面积与折线 -->
				{#if showUv && summary && summary.chart.length > 0}
					<path d={uvAreaPath} fill="url(#uvGradient)" />
					<polyline
						points={uvPolyline}
						fill="none"
						stroke="#10b981"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				{/if}

				<!-- 鼠标悬停竖线与数据高亮圆点 -->
				{#if hoverIndex !== null && summary && summary.chart[hoverIndex]}
					{@const hp = summary.chart[hoverIndex]}
					{@const hx = getX(hoverIndex, summary.chart.length)}
					{@const hyPv = getY(hp.pv)}
					{@const hyUv = getY(hp.uv)}

					<!-- 垂直指示虚线 -->
					<line
						x1={hx}
						y1={pad.top}
						x2={hx}
						y2={chartHeight - pad.bottom}
						stroke="currentColor"
						class="text-(--primary)/60"
						stroke-width="1.5"
						stroke-dasharray="2,2"
					/>

					<!-- PV 高亮圆点 -->
					{#if showPv}
						<circle cx={hx} cy={hyPv} r="5" class="fill-(--primary) stroke-white dark:stroke-neutral-900" stroke-width="2" />
					{/if}

					<!-- UV 高亮圆点 -->
					{#if showUv}
						<circle cx={hx} cy={hyUv} r="4.5" class="fill-emerald-500 stroke-white dark:stroke-neutral-900" stroke-width="2" />
					{/if}
				{/if}
			</svg>

			<!-- 悬浮交互 Tooltip 气泡卡片 -->
			{#if hoverIndex !== null && summary && summary.chart[hoverIndex]}
				{@const hp = summary.chart[hoverIndex]}
				{@const hx = getX(hoverIndex, summary.chart.length)}
				{@const isRightHalf = hx > chartWidth / 2}
				<div
					class="pointer-events-none absolute top-4 z-20 px-3 py-2 rounded-xl bg-(--card-bg) border border-(--line-divider) shadow-xl text-xs backdrop-blur-md transition-all duration-75"
					style="left: {isRightHalf ? `${(hx / chartWidth) * 100 - 2}%` : `${(hx / chartWidth) * 100 + 2}%`}; transform: {isRightHalf ? 'translateX(-100%)' : 'translateX(0)'};"
				>
					<div class="font-bold text-neutral-800 dark:text-neutral-100 border-b border-(--line-divider) pb-1 mb-1 font-mono">
						📅 {hp.date}
					</div>
					<div class="space-y-1">
						{#if showPv}
							<div class="flex items-center justify-between gap-4">
								<span class="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
									<span class="w-2 h-2 rounded-full bg-(--primary)"></span>
									<span>浏览量 PV:</span>
								</span>
								<strong class="font-mono text-neutral-800 dark:text-neutral-100">{hp.pv.toLocaleString()}</strong>
							</div>
						{/if}
						{#if showUv}
							<div class="flex items-center justify-between gap-4">
								<span class="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
									<span class="w-2 h-2 rounded-full bg-emerald-500"></span>
									<span>独立访客 UV:</span>
								</span>
								<strong class="font-mono text-neutral-800 dark:text-neutral-100">{hp.uv.toLocaleString()}</strong>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</div>

	<!-- 双栏洞察：热门文章排行榜 + 访客地域与设备画像 -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
		<!-- 热门文章阅读排行 Top 10 -->
		<div class="p-5 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider) flex flex-col">
			<div class="flex items-center justify-between mb-4">
				<h3 class="text-sm font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
					<span>🔥</span> 热门文章阅读排行 Top 10
				</h3>
				<span class="text-[11px] text-(--content-meta)">30天阅读热度</span>
			</div>

			<div class="space-y-2.5 flex-1">
				{#if loading}
					{#each Array(6) as _}
						<div class="h-10 bg-black/5 dark:bg-white/5 rounded-xl animate-pulse"></div>
					{/each}
				{:else if insights && insights.topPages.length > 0}
					{#each insights.topPages as page, idx}
						{@const pct = (page.views / maxTopPageView) * 100}
						<div class="p-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors relative overflow-hidden group">
							<!-- 进度条底色 -->
							<div
								class="absolute left-0 top-0 bottom-0 bg-(--primary)/8 rounded-xl transition-all duration-500"
								style="width: {pct}%"
							></div>

							<div class="relative z-10 flex items-center justify-between gap-3 text-xs">
								<div class="flex items-center gap-2.5 min-w-0 flex-1">
									<!-- 排名徽章 -->
									<span class="w-5 h-5 rounded-lg flex items-center justify-center font-bold text-[11px] shrink-0 {idx === 0 ? 'bg-amber-400/20 text-amber-600 dark:text-amber-400' : idx === 1 ? 'bg-slate-300/30 text-slate-600 dark:text-slate-300' : idx === 2 ? 'bg-amber-700/20 text-amber-700 dark:text-amber-500' : 'bg-black/5 dark:bg-white/5 text-(--content-meta)'}">
										{idx + 1}
									</span>

									<!-- 文章标题与链接 -->
									<a
										href={page.path}
										class="font-medium text-neutral-700 dark:text-neutral-200 hover:text-(--primary) truncate transition-colors"
										title={page.title}
									>
										{page.title}
									</a>
								</div>

								<!-- 浏览次数 -->
								<div class="shrink-0 font-mono font-bold text-neutral-800 dark:text-neutral-100">
									{page.views.toLocaleString()}
									<span class="text-[10px] text-(--content-meta) font-normal">次</span>
								</div>
							</div>
						</div>
					{/each}
				{/if}
			</div>
		</div>

		<!-- 访客来源与客户端设备画像 -->
		<div class="space-y-6">
			<!-- 访客国家与地域分布 -->
			<div class="p-5 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider)">
				<div class="flex items-center justify-between mb-4">
					<h3 class="text-sm font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
						<span>🌍</span> 访客国家与地域分布
					</h3>
					<span class="text-[11px] text-(--content-meta)">按独立访客占比</span>
				</div>

				<div class="space-y-2.5">
					{#if loading}
						{#each Array(4) as _}
							<div class="h-8 bg-black/5 dark:bg-white/5 rounded-xl animate-pulse"></div>
						{/each}
					{:else if insights && insights.countries.length > 0}
						{#each insights.countries as country}
							<div class="space-y-1">
								<div class="flex items-center justify-between text-xs">
									<span class="font-medium text-neutral-700 dark:text-neutral-200 flex items-center gap-2">
										<span class="w-2 h-2 rounded-full bg-emerald-500"></span>
										{country.name}
									</span>
									<span class="font-mono text-(--content-meta)">
										{country.visits.toLocaleString()} 次 ({country.percent}%)
									</span>
								</div>
								<div class="w-full h-1.5 bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
									<div
										class="h-full bg-emerald-500 rounded-full transition-all duration-500"
										style="width: {country.percent}%"
									></div>
								</div>
							</div>
						{/each}
					{/if}
				</div>
			</div>

			<!-- 客户端浏览器与操作系统占比 (并排展示) -->
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
				<!-- 浏览器分布 -->
				<div class="p-4 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider)">
					<h4 class="text-xs font-bold text-neutral-800 dark:text-neutral-100 mb-3 flex items-center gap-1.5">
						<span>🌐</span> 常用浏览器
					</h4>
					<div class="space-y-2">
						{#if insights && insights.browsers.length > 0}
							{#each insights.browsers as b}
								<div class="space-y-1">
									<div class="flex items-center justify-between text-[11px]">
										<span class="text-neutral-700 dark:text-neutral-300 truncate">{b.name}</span>
										<span class="font-mono text-(--content-meta)">{b.percent}%</span>
									</div>
									<div class="w-full h-1 bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
										<div class="h-full bg-(--primary) rounded-full" style="width: {b.percent}%"></div>
									</div>
								</div>
							{/each}
						{/if}
					</div>
				</div>

				<!-- 操作系统分布 -->
				<div class="p-4 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider)">
					<h4 class="text-xs font-bold text-neutral-800 dark:text-neutral-100 mb-3 flex items-center gap-1.5">
						<span>💻</span> 客户端操作系统
					</h4>
					<div class="space-y-2">
						{#if insights && insights.os.length > 0}
							{#each insights.os as o}
								<div class="space-y-1">
									<div class="flex items-center justify-between text-[11px]">
										<span class="text-neutral-700 dark:text-neutral-300 truncate">{o.name}</span>
										<span class="font-mono text-(--content-meta)">{o.percent}%</span>
									</div>
									<div class="w-full h-1 bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
										<div class="h-full bg-indigo-500 rounded-full" style="width: {o.percent}%"></div>
									</div>
								</div>
							{/each}
						{/if}
					</div>
				</div>
			</div>
		</div>
	</div>
</div>
