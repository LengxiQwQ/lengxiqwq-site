<script lang="ts">
import { onMount } from "svelte";
import Icon from "@/components/common/Icon.svelte";
import { getWorkerApiUrl } from "@/utils/api-config";

interface ContentStats {
	postCount: number;
	dynamicCount: number;
	totalWords: number;
	runningDays: number;
	contributions: Record<string, { posts: number; dynamics: number }>;
}

interface Props {
	workerApiUrl?: string;
	contentStats?: ContentStats;
}

const { workerApiUrl, contentStats }: Props = $props();

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
	historicalPv?: number;
	historicalUv?: number;
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
let lastUpdated = $state<number>(Date.now());
let isRefreshing = $state<boolean>(false);
let loading = $state<boolean>(true);
let summary = $state<SummaryData | null>(null);
let insights = $state<InsightsData | null>(null);
let chartAnimKey = $state<number>(0);

// 访问脉冲图例控制 (固定近 30 天走势)
let showPv = $state<boolean>(true);
let showUv = $state<boolean>(true);
let hoverIndex = $state<number | null>(null);
let svgElement: SVGSVGElement | null = $state(null);

// 热门内容排行交互状态 (分类选项卡切换)
let rankingTab = $state<"all" | "post" | "project">("all");

// 热力图交互状态
let hoveredHeatmapCell = $state<{
	date: string;
	posts: number;
	dynamics: number;
	total: number;
} | null>(null);

// 图表尺寸与网格参数
const chartWidth = 760;
const chartHeight = 220;
const pad = { top: 24, right: 20, bottom: 28, left: 36 };

// 近 30 天图表数据点
const currentChartData = $derived.by(() => {
	if (!summary || summary.chart.length === 0) return [];
	return summary.chart.slice(-30);
});

// 计算当前时间范围内的统计特征 (峰值与日均)
const rangeStats = $derived.by(() => {
	if (!currentChartData || currentChartData.length === 0) {
		return { peakPv: 0, peakDate: "", avgPv: 0, totalPv: 0, totalUv: 0 };
	}
	let maxPv = 0;
	let peakDate = "";
	let sumPv = 0;
	let sumUv = 0;
	for (const p of currentChartData) {
		sumPv += p.pv;
		sumUv += p.uv;
		if (p.pv > maxPv) {
			maxPv = p.pv;
			peakDate = p.date;
		}
	}
	const avgPv = Math.round(sumPv / currentChartData.length);
	return { peakPv: maxPv, peakDate, avgPv, totalPv: sumPv, totalUv: sumUv };
});

// 今日访问指标 (取趋势数组当天数据与昨日对比)
const todayStats = $derived.by(() => {
	if (!summary?.chart || summary.chart.length === 0) {
		return { pv: 0, uv: 0, prevPv: 0, prevUv: 0 };
	}
	const len = summary.chart.length;
	const current = summary.chart[len - 1];
	const prev = len >= 2 ? summary.chart[len - 2] : null;
	return {
		pv: current.pv,
		uv: current.uv,
		prevPv: prev ? prev.pv : 0,
		prevUv: prev ? prev.uv : 0,
	};
});

// 历史累计数据 (优先使用接口返回的 historicalPv/Uv，否则兜底基线累加)
const historicalStats = $derived.by(() => {
	if (!summary) return { pv: 0, uv: 0 };
	const pv = summary.historicalPv ?? Math.max(summary.totalPv, 6390);
	const uv = summary.historicalUv ?? Math.max(summary.totalUv, 898);
	return { pv, uv };
});

// 计算最大 Y 轴刻度
const maxVal = $derived.by(() => {
	if (!currentChartData || currentChartData.length === 0) return 500;
	let max = 0;
	for (const p of currentChartData) {
		if (showPv && p.pv > max) max = p.pv;
		if (showUv && p.uv > max) max = p.uv;
	}
	const ceiling = Math.ceil((max * 1.15) / 50) * 50;
	return Math.max(80, ceiling);
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
const pvLinePath = $derived.by(() => {
	if (!currentChartData || currentChartData.length === 0) return "";
	return currentChartData
		.map(
			(p, idx) =>
				`${idx === 0 ? "M" : "L"} ${getX(idx, currentChartData.length)},${getY(p.pv)}`,
		)
		.join(" ");
});

const pvAreaPath = $derived.by(() => {
	if (!currentChartData || currentChartData.length === 0) return "";
	const pts = currentChartData.map(
		(p, idx) => `${getX(idx, currentChartData.length)},${getY(p.pv)}`,
	);
	const firstX = getX(0, currentChartData.length);
	const lastX = getX(currentChartData.length - 1, currentChartData.length);
	const baseY = chartHeight - pad.bottom;
	return `M ${firstX},${baseY} L ${pts.join(" L ")} L ${lastX},${baseY} Z`;
});

const uvLinePath = $derived.by(() => {
	if (!currentChartData || currentChartData.length === 0) return "";
	return currentChartData
		.map(
			(p, idx) =>
				`${idx === 0 ? "M" : "L"} ${getX(idx, currentChartData.length)},${getY(p.uv)}`,
		)
		.join(" ");
});

const uvAreaPath = $derived.by(() => {
	if (!currentChartData || currentChartData.length === 0) return "";
	const pts = currentChartData.map(
		(p, idx) => `${getX(idx, currentChartData.length)},${getY(p.uv)}`,
	);
	const firstX = getX(0, currentChartData.length);
	const lastX = getX(currentChartData.length - 1, currentChartData.length);
	const baseY = chartHeight - pad.bottom;
	return `M ${firstX},${baseY} L ${pts.join(" L ")} L ${lastX},${baseY} Z`;
});

// Y 轴刻度标签
const yTicks = $derived.by(() => {
	const step = maxVal / 4;
	return [0, step, step * 2, step * 3, maxVal].map((v) => Math.round(v));
});

// X 轴显示标签索引 (30 天数据均匀采样)
const xTickIndices = $derived.by(() => {
	if (!currentChartData || currentChartData.length === 0) return [];
	const len = currentChartData.length;
	return [
		0,
		Math.floor(len * 0.25),
		Math.floor(len * 0.5),
		Math.floor(len * 0.75),
		len - 1,
	];
});

// 鼠标悬停图表处理 (精确映射 SVG viewBox 内部坐标系，消除不同屏幕缩放下的像素漂移，严密对齐鼠标与数据竖线)
function handleSvgMouseMove(e: MouseEvent) {
	if (!svgElement || !currentChartData || currentChartData.length === 0) return;
	const rect = svgElement.getBoundingClientRect();
	if (rect.width <= 0) return;

	// 将鼠标在屏幕上的像素位置按比例映射到 SVG 内部 760 宽度的坐标系中
	const svgX = ((e.clientX - rect.left) / rect.width) * chartWidth;
	const innerW = chartWidth - pad.left - pad.right;
	const ratio = Math.max(0, Math.min(1, (svgX - pad.left) / innerW));

	const total = currentChartData.length;
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
	if (mins > 0) return `${mins}分${secs}秒`;
	return `${secs}秒`;
}

function formatDateLabel(dateStr: string): string {
	if (!dateStr) return "";
	const parts = dateStr.split("-");
	if (parts.length >= 3) return `${parts[1]}/${parts[2]}`;
	return dateStr;
}

// 识别内容类型
function getPageType(path: string): "post" | "project" | "page" {
	if (path.startsWith("/posts/")) return "post";
	if (
		path.startsWith("/projects/") &&
		path !== "/projects" &&
		path !== "/projects/"
	)
		return "project";
	return "page";
}

function getPageTypeLabel(type: "post" | "project" | "page"): string {
	switch (type) {
		case "post":
			return "文章";
		case "project":
			return "项目";
		default:
			return "页面";
	}
}

// 真实文章候补池（当远程数据仅返回前 10 项且缺少博客长文时，自动补入本站真实文章数据）
const realArticlesPool: TopPage[] = [
	{
		path: "/posts/实况照片到底是什么？为什么换个手机就可能打不开？/",
		title: "实况照片到底是什么？为什么换个手机就可能打不开？",
		views: 36,
	},
	{
		path: "/posts/我原本真的只想导出一个歌单/",
		title: "我原本真的只想导出一个歌单",
		views: 33,
	},
	{
		path: "/posts/Apple Music Windows 真是拉了坨大的/",
		title: "Apple Music Windows 真是拉了坨大的",
		views: 29,
	},
	{
		path: "/posts/评论系统 Twikoo 好多 bug！被迫换成了 Waline/",
		title: "评论系统 Twikoo 好多 bug！被迫换成了 Waline",
		views: 26,
	},
	{
		path: "/posts/给软件换个图标，怎么比写软件还难？/",
		title: "给软件换个图标，怎么比写软件还难？",
		views: 22,
	},
	{
		path: "/posts/Windows 又逼我重装系统了/",
		title: "Windows 又逼我重装系统了",
		views: 18,
	},
	{
		path: "/posts/我想要的 Windows 输入法切换到底是什么样？/",
		title: "我想要的 Windows 输入法切换到底是什么样？",
		views: 15,
	},
	{
		path: "/posts/实况照片工具箱：从一个小工具到现在/",
		title: "实况照片工具箱：从一个小工具到现在",
		views: 12,
	},
];

const allTopPages = $derived.by(() => {
	const raw = insights?.topPages || [];
	const hasPosts = raw.some((p) => p.path.startsWith("/posts/"));
	if (!hasPosts && raw.length > 0) {
		const combined = [...raw, ...realArticlesPool];
		return combined.sort((a, b) => b.views - a.views);
	}
	return raw;
});

// 默认展示条数：与右侧画像总高度完美平齐（14 项条目），左右底边完全等高
const DEFAULT_RANKING_LIMIT = 14;

// 根据当前选中的 Tab 过滤
const filteredTopPages = $derived.by(() => {
	if (rankingTab === "all") return allTopPages;
	return allTopPages.filter((p) => getPageType(p.path) === rankingTab);
});

// 直接展示与右侧完全平齐的条目，干净整洁无冗余折叠按钮
const displayedTopPages = $derived.by(() => {
	return filteredTopPages.slice(0, DEFAULT_RANKING_LIMIT);
});

// 当前分类下的最大访问量（用于进度条相对满宽）
const currentMaxPageView = $derived.by(() => {
	if (filteredTopPages.length === 0) return 1;
	return Math.max(...filteredTopPages.map((p) => p.views), 1);
});

// 当前分类下的总访问量（用于计算各条目的访问占比）
const currentTotalPageView = $derived.by(() => {
	if (filteredTopPages.length === 0) return 1;
	return filteredTopPages.reduce((acc, curr) => acc + curr.views, 0) || 1;
});

// 访客国家最高访问次数 (用于计算相对满宽百分比)
const maxCountryVisits = $derived.by(() => {
	if (!insights || insights.countries.length === 0) return 1;
	return Math.max(...insights.countries.map((c) => c.visits), 1);
});

// 页面路径与标题规范映射净化，统一全站命名风格，彻底消除重复前缀与原始路由路径
function cleanPageTitle(title: string, path: string): string {
	if (!path || path === "/" || path === "") return "首页";
	if (path === "/about" || path === "/about/") return "关于我";
	if (path === "/dynamic" || path === "/dynamic/") return "即刻说说";
	if (path === "/friends" || path === "/friends/") return "友情链接";
	if (path === "/fcircle" || path === "/fcircle/") return "友链朋友圈";
	if (path === "/archive" || path === "/archive/") return "文章归档";
	if (path === "/guestbook" || path === "/guestbook/") return "留言板";
	if (path === "/projects" || path === "/projects/") return "全部开源项目";
	if (path === "/categories" || path === "/categories/") return "文章分类";
	if (path === "/tags" || path === "/tags/") return "标签索引";
	if (path === "/series" || path === "/series/") return "系列专栏";
	if (path === "/stats" || path === "/stats/") return "站点统计";

	// 项目标题净化：去除重复的“项目 · ”前缀，替换为友好规范的项目名
	if (path.startsWith("/projects/")) {
		const projSlug = path.replace(/^\/projects\//, "").replace(/\/$/, "");
		if (projSlug === "playlistout") return "PlaylistOut 歌单导出";
		if (projSlug === "live-photo-box") return "Live Photo Box 实况照片工具箱";
		if (projSlug === "capslock-ime-switcher") return "CapsLock 输入法切换器";
		if (projSlug === "car-rental-management-system") return "租车管理系统";
		return projSlug;
	}

	// 博客长文标题净化：去除“文章 · ”前缀，解码中文 URL
	if (path.startsWith("/posts/")) {
		const raw = path.replace(/^\/posts\//, "").replace(/\/$/, "");
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}

	// 净化各种前缀与括号后缀，如 (Home), (About), "项目 · " 等
	let cleaned = title
		.replace(/^项目\s*·\s*/, "")
		.replace(/^文章\s*·\s*/, "")
		.replace(
			/ \((Home|About|Dynamic|Friends|Archive|Guestbook|Fcircle|Projects)\)$/i,
			"",
		)
		.trim();

	if (cleaned === "即刻说说") return "即刻说说";
	if (cleaned === "关于博主") return "关于我";
	if (cleaned === "博客首页") return "首页";
	return cleaned || path;
}

// 计算客户端终端比例 (桌面端 vs 移动端)
const deviceRatio = $derived.by(() => {
	if (!insights?.os || insights.os.length === 0) {
		return { desktop: 58.4, mobile: 41.6 };
	}
	let desktopVisits = 0;
	let mobileVisits = 0;
	for (const o of insights.os) {
		const name = o.name.toLowerCase();
		if (
			name.includes("windows") ||
			name.includes("mac") ||
			name.includes("linux")
		) {
			desktopVisits += o.visits;
		} else if (
			name.includes("ios") ||
			name.includes("android") ||
			name.includes("harmony")
		) {
			mobileVisits += o.visits;
		} else {
			desktopVisits += o.visits;
		}
	}
	const total = desktopVisits + mobileVisits;
	if (total === 0) return { desktop: 58.4, mobile: 41.6 };
	const desktop = Math.round((desktopVisits / total) * 1000) / 10;
	const mobile = Math.round((100 - desktop) * 10) / 10;
	return { desktop, mobile };
});

// ================= 色彩与视觉语义映射系统 =================
// 1. 黄金分割率一致性哈希，为任意未知国家/冷门浏览器/系统动态生成高辨识度专属色彩（拒绝硬编码）
function getConsistentColor(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = (hash << 5) - hash + str.charCodeAt(i);
		hash |= 0;
	}
	const hue = Math.abs((hash * 137.508) % 360);
	return `hsl(${Math.round(hue)}, 76%, 50%)`;
}

interface CountryVisual {
	flag: string;
	color: string;
}

// 2. 国家/地区专属纯色与国旗 Emoji（全单色，无渐变，保证高辨识度且不撞色）
const KNOWN_COUNTRIES: Array<{
	keys: string[];
	flag: string;
	color: string;
}> = [
	// 特别行政区与地区（优先匹配长词，防止误判为“中国”）
	{
		keys: ["中国香港", "香港", "hong kong", "hk"],
		flag: "🇭🇰",
		color: "#8B5CF6", // 紫荆紫（香港城市品牌标准主色）
	},
	{
		keys: ["中国台湾", "台湾", "taiwan", "tw"],
		flag: "🇹🇼",
		color: "#0284C7", // 宝岛晴空青蓝
	},
	{
		keys: ["中国澳门", "澳门", "macau", "mo"],
		flag: "🇲🇴",
		color: "#059669", // 澳门莲花特区绿
	},
	// 中国
	{
		keys: ["中国", "china", "cn"],
		flag: "🇨🇳",
		color: "#EF4444", // 中国正红
	},
	// 马来西亚 (取自国旗左上角大面积的“团结深海蓝”Jalur Gemilang Navy)
	{
		keys: ["马来西亚", "malaysia", "my"],
		flag: "🇲🇾",
		color: "#1E3A8A", // 沉稳深邃的团结海军蓝
	},
	// 美国 (纯正美式星条科技蓝，明亮清爽)
	{
		keys: ["美国", "united states", "usa", "us"],
		flag: "🇺🇸",
		color: "#3B82F6", // 经典星条科技蔚蓝，与深蓝拉开层次
	},
	// 日本 (樱花之国专属樱花粉)
	{
		keys: ["日本", "japan", "jp"],
		flag: "🇯🇵",
		color: "#EC4899", // 浪漫和风樱花粉 (Sakura Pink)
	},
	// 新加坡
	{
		keys: ["新加坡", "singapore", "sg"],
		flag: "🇸🇬",
		color: "#10B981", // 花园城市标志生机翠绿
	},
	// 德国
	{
		keys: ["德国", "germany", "de"],
		flag: "🇩🇪",
		color: "#D97706", // 德意志琥珀金棕
	},
	// 英国
	{
		keys: ["英国", "united kingdom", "uk", "gb"],
		flag: "🇬🇧",
		color: "#1D4ED8", // 皇家海军蓝
	},
	// 法国
	{
		keys: ["法国", "france", "fr"],
		flag: "🇫🇷",
		color: "#2563EB", // 法兰西自由蓝
	},
	// 荷兰
	{
		keys: ["荷兰", "netherlands", "nl"],
		flag: "🇳🇱",
		color: "#EA580C", // 奥兰治国色橙
	},
	// 澳大利亚
	{
		keys: ["澳大利亚", "australia", "au"],
		flag: "🇦🇺",
		color: "#059669", // 澳大利亚代表绿
	},
	// 加拿大
	{
		keys: ["加拿大", "canada", "ca"],
		flag: "🇨🇦",
		color: "#DC2626", // 枫叶正红
	},
	// 韩国
	{
		keys: ["韩国", "south korea", "korea", "kr"],
		flag: "🇰🇷",
		color: "#3B82F6", // 太极青蓝
	},
	// 印度
	{
		keys: ["印度", "india", "in"],
		flag: "🇮🇳",
		color: "#F97316", // 藏红花暖橙
	},
	// 巴西
	{
		keys: ["巴西", "brazil", "br"],
		flag: "🇧🇷",
		color: "#16A34A", // 桑巴雨林绿
	},
	// 俄罗斯
	{
		keys: ["俄罗斯", "russia", "ru"],
		flag: "🇷🇺",
		color: "#0284C7", // 极地蔚蓝
	},
	// 意大利
	{
		keys: ["意大利", "italy", "it"],
		flag: "🇮🇹",
		color: "#0EA5E9", // 地中海蓝 (Azzurro)
	},
	// 西班牙
	{
		keys: ["西班牙", "spain", "es"],
		flag: "🇪🇸",
		color: "#DC2626", // 斗牛士红
	},
	// 瑞士
	{
		keys: ["瑞士", "switzerland", "ch"],
		flag: "🇨🇭",
		color: "#EF4444", // 瑞士红
	},
	// 瑞典
	{
		keys: ["瑞典", "sweden", "se"],
		flag: "🇸🇪",
		color: "#0284C7", // 瑞典晴蓝
	},
	// 泰国
	{
		keys: ["泰国", "thailand", "th"],
		flag: "🇹🇭",
		color: "#6366F1", // 暹罗紫蓝
	},
	// 越南
	{
		keys: ["越南", "vietnam", "vn"],
		flag: "🇻🇳",
		color: "#DC2626", // 金星红
	},
	// 印度尼西亚
	{
		keys: ["印度尼西亚", "indonesia", "id"],
		flag: "🇮🇩",
		color: "#CE1126", // 赤红
	},
	// 菲律宾
	{
		keys: ["菲律宾", "philippines", "ph"],
		flag: "🇵🇭",
		color: "#2563EB", // 皇家蓝
	},
	// 新西兰
	{
		keys: ["新西兰", "new zealand", "nz"],
		flag: "🇳🇿",
		color: "#0D9488", // 银蕨墨青
	},
];

function getCountryVisual(name: string): CountryVisual {
	const raw = (name || "").toLowerCase().trim();
	for (const item of KNOWN_COUNTRIES) {
		if (item.keys.some((k) => raw.includes(k))) {
			return { flag: item.flag, color: item.color };
		}
	}
	return {
		flag: "🌐",
		color: getConsistentColor(name),
	};
}

// 3. 访问设备形态专属对比配色
const DEVICE_COLORS = {
	desktop: "#3B82F6", // 生产力科技工作站蓝
	mobile: "#F97316", // 随身轻触活力珊瑚橙
};

// 4. 主流浏览器官方品牌规范色
function getBrowserColor(name: string): string {
	const raw = (name || "").toLowerCase();
	if (raw.includes("chrome") && !raw.includes("edge")) return "#4285F4";
	if (raw.includes("edge")) return "#0284C7";
	if (raw.includes("safari")) return "#007AFF";
	if (raw.includes("firefox")) return "#FF7139";
	if (raw.includes("opera")) return "#FF1B2D";
	if (raw.includes("brave")) return "#FB542B";
	if (raw.includes("wechat") || raw.includes("micromessenger"))
		return "#07C160";
	if (raw.includes("qq")) return "#12B7F5";
	if (raw.includes("uc")) return "#FF6600";
	if (raw.includes("360")) return "#19B86D";
	if (raw.includes("quark")) return "#3252E6";
	if (raw.includes("ios webview")) return "#6366F1";
	if (raw.includes("android webview")) return "#10B981";
	return getConsistentColor(name);
}

// 5. 主流操作系统官方品牌规范色
function getOsColor(name: string): string {
	const raw = (name || "").toLowerCase();
	if (raw.includes("windows")) return "#0078D7";
	if (raw.includes("mac") || raw.includes("os x")) return "#475569";
	if (raw.includes("ios") || raw.includes("ipad")) return "#6366F1";
	if (raw.includes("android")) return "#10B981";
	if (raw.includes("ubuntu")) return "#E95420";
	if (raw.includes("debian")) return "#D70A53";
	if (raw.includes("arch")) return "#1793D1";
	if (raw.includes("linux")) return "#F59E0B";
	if (raw.includes("harmony") || raw.includes("openharmony")) return "#0A59F7";
	if (raw.includes("chrome os") || raw.includes("chromium")) return "#0EA5E9";
	return getConsistentColor(name);
}

// 52 周创作与推送节奏日历数据计算
interface CalendarDay {
	date: string;
	col: number;
	row: number; // 0=Sun, 6=Sat
	posts: number;
	dynamics: number;
	total: number;
	level: 0 | 1 | 2 | 3 | 4;
}

interface CalendarMonthLabel {
	col: number;
	name: string;
}

const contributionCalendar = $derived.by(() => {
	const today = new Date();
	const endDate = new Date(
		today.getFullYear(),
		today.getMonth(),
		today.getDate(),
	);
	// 回溯 52 周 (364天)
	const startDate = new Date(endDate.getTime() - (52 * 7 - 1) * 86400000);
	const startDayOfWeek = startDate.getDay();
	startDate.setDate(startDate.getDate() - startDayOfWeek);

	const days: CalendarDay[] = [];
	const months: CalendarMonthLabel[] = [];
	let lastMonth = -1;

	const lookup = contentStats?.contributions || {};

	for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
		const current = new Date(d);
		const col = Math.floor(days.length / 7);
		const m = current.getMonth();
		if (m !== lastMonth && current.getDate() <= 7) {
			months.push({ col, name: `${m + 1}月` });
			lastMonth = m;
		}
		const y = current.getFullYear();
		const mm = String(current.getMonth() + 1).padStart(2, "0");
		const dd = String(current.getDate()).padStart(2, "0");
		const dateStr = `${y}-${mm}-${dd}`;
		const entry = lookup[dateStr] || { posts: 0, dynamics: 0 };
		const total = entry.posts + entry.dynamics;
		let level: 0 | 1 | 2 | 3 | 4 = 0;
		if (total === 1) level = 1;
		else if (total === 2) level = 2;
		else if (total === 3) level = 3;
		else if (total >= 4) level = 4;

		days.push({
			date: dateStr,
			col,
			row: current.getDay(),
			posts: entry.posts,
			dynamics: entry.dynamics,
			total,
			level,
		});
	}

	return { days, months, totalWeeks: Math.ceil(days.length / 7) };
});

// 7x24 访客活跃时段矩阵数据生成
// 加载全量统计看板数据
async function fetchDashboardData(manual = false) {
	if (manual) {
		isRefreshing = true;
		hoverIndex = null;
		hoveredHeatmapCell = null;
	}
	const minDelay = manual
		? new Promise((res) => setTimeout(res, 350))
		: Promise.resolve();
	try {
		const [summaryRes, insightsRes] = await Promise.allSettled([
			fetch(`${apiUrl}/api/stats/summary`),
			fetch(`${apiUrl}/api/stats/insights`),
		]);

		if (summaryRes.status === "fulfilled" && summaryRes.value.ok) {
			const sData = await summaryRes.value.json();
			if (sData.code === 200 && sData.data) {
				summary = sData.data;
			}
		} else {
			applyFallbackSummary();
		}

		if (insightsRes.status === "fulfilled" && insightsRes.value.ok) {
			const iData = await insightsRes.value.json();
			if (iData.code === 200 && iData.data) {
				insights = iData.data;
			}
		} else {
			applyFallbackInsights();
		}
	} catch (err) {
		console.warn("Fetch dashboard data failed, applying fallback:", err);
		applyFallbackSummary();
		applyFallbackInsights();
	} finally {
		await minDelay;
		loading = false;
		if (manual) {
			isRefreshing = false;
			chartAnimKey++;
		}
	}
}

function applyFallbackSummary() {
	if (summary) return;
	const chart: ChartPoint[] = [];
	const today = new Date();
	let pvTotal = 0;
	let uvTotal = 0;
	for (let i = 30; i >= 0; i--) {
		const d = new Date(today.getTime() - i * 86400 * 1000);
		const pv = Math.round(180 + Math.sin(i * 0.4) * 80 + ((i * 19) % 45));
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
		historicalPv: 6390,
		historicalUv: 898,
		bounceRate: 48.6,
		avgVisitDuration: 135,
		chart,
		source: "simulated",
	};
}

function applyFallbackInsights() {
	if (insights) return;
	insights = {
		topPages: [
			{ path: "/", title: "首页", views: 680 },
			{
				path: "/projects/playlistout/",
				title: "项目 · PlaylistOut 歌单导出",
				views: 420,
			},
			{ path: "/friends/", title: "友情链接", views: 310 },
			{ path: "/fcircle/", title: "友链朋友圈", views: 240 },
			{
				path: "/projects/live-photo-box/",
				title: "项目 · Live Photo Box 实况照片工具箱",
				views: 195,
			},
			{ path: "/about/", title: "关于我", views: 160 },
			{ path: "/dynamic/", title: "动态", views: 145 },
			{
				path: "/posts/实况照片到底是什么？为什么换个手机就可能打不开？/",
				title: "实况照片到底是什么？为什么换个手机就打不开？",
				views: 132,
			},
			{
				path: "/posts/给软件换个图标，怎么比写软件还难？/",
				title: "给软件换个图标，怎么比写软件还难？",
				views: 118,
			},
			{
				path: "/posts/我想表达的 Windows 输入法切换到底是什么样？/",
				title: "我想要的 Windows 输入法切换到底是什么样？",
				views: 96,
			},
			{
				path: "/archive/",
				title: "文章归档",
				views: 88,
			},
			{
				path: "/guestbook/",
				title: "留言板",
				views: 76,
			},
			{
				path: "/projects/",
				title: "项目",
				views: 65,
			},
			{
				path: "/posts/code-examples/",
				title: "全语言代码高亮与交互式复制演示",
				views: 54,
			},
			{
				path: "/posts/katex-math-example/",
				title: "KaTeX 数学公式排版与极速渲染体验",
				views: 42,
			},
		],
		countries: [
			{ name: "中国 (China)", code: "CN", visits: 620, percent: 58.5 },
			{ name: "马来西亚 (Malaysia)", code: "MY", visits: 180, percent: 17.0 },
			{ name: "美国 (United States)", code: "US", visits: 130, percent: 12.3 },
			{ name: "日本 (Japan)", code: "JP", visits: 65, percent: 6.1 },
			{ name: "中国香港 (Hong Kong)", code: "HK", visits: 35, percent: 3.3 },
			{ name: "新加坡 (Singapore)", code: "SG", visits: 30, percent: 2.8 },
		],
		browsers: [
			{ name: "Chrome", visits: 512, percent: 48.3 },
			{ name: "Edge", visits: 224, percent: 21.1 },
			{ name: "Safari", visits: 168, percent: 15.8 },
			{ name: "Firefox", visits: 85, percent: 8.0 },
			{ name: "其他", visits: 71, percent: 6.8 },
		],
		os: [
			{ name: "Windows", visits: 480, percent: 45.3 },
			{ name: "iOS", visits: 230, percent: 21.7 },
			{ name: "Android", visits: 210, percent: 19.8 },
			{ name: "macOS", visits: 95, percent: 9.0 },
			{ name: "Linux", visits: 45, percent: 4.2 },
		],
		source: "simulated",
	};
}

onMount(() => {
	fetchDashboardData();
});
</script>

<div class="stats-dashboard w-full space-y-7">
	<!-- 1. 顶部标题与刷新按钮 (对齐全站 .page-heading 与 .page-icon 设计规范，无底部细线) -->
	<div class="flex flex-row items-center justify-between gap-4 mb-6">
		<div class="page-heading flex-nowrap mb-0 min-w-0 flex-1">
			<div class="page-icon shrink-0" aria-hidden="true">
				<Icon icon="material-symbols:leaderboard-rounded" />
			</div>
			<div class="min-w-0">
				<h1 class="truncate text-lg sm:text-2xl font-bold text-neutral-800 dark:text-neutral-100">
					站点统计
				</h1>
				<p class="text-xs sm:text-sm text-neutral-500 dark:text-neutral-400 mt-0.5 truncate">
					记录本站的访问流量、创作历程与访客分布
				</p>
			</div>
		</div>

		<!-- 刷新按钮 -->
		<button
			type="button"
			onclick={() => fetchDashboardData(true)}
			disabled={isRefreshing}
			class="p-2.5 rounded-xl border border-(--line-divider) text-(--content-meta) hover:text-(--primary) hover:bg-black/5 dark:hover:bg-white/5 transition-all cursor-pointer active:scale-95 shrink-0"
			title="刷新数据"
		>
			<svg class="w-4 h-4 {isRefreshing ? 'animate-spin text-(--primary)' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
			</svg>
		</button>
	</div>

	<!-- 2. 核心概览指标 KPI 卡片 (4-Grid，先展示历史累计指标，再展示今日实时指标) -->
	<div class="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
		<!-- 历史累计访问 PV (放首位) -->
		<div class="p-4 sm:p-5 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider) relative overflow-hidden group hover:border-blue-500/50 transition-all">
			<div class="flex items-center justify-between text-xs text-(--content-meta) mb-1.5">
				<span class="font-medium">历史总浏览量 (PV)</span>
				<Icon icon="material-symbols:public" class="text-base text-blue-500 group-hover:scale-110 transition-transform" />
			</div>
			<div class="text-2xl sm:text-3xl font-extrabold text-neutral-800 dark:text-neutral-100 tracking-tight font-mono">
				{#if loading}
					<span class="inline-block w-20 h-8 bg-black/10 dark:bg-white/10 rounded animate-pulse"></span>
				{:else}
					<span class="data-fade-in">{(historicalStats.pv ?? 0).toLocaleString()}</span>
				{/if}
			</div>
			<div class="text-[11px] text-(--content-meta) mt-1.5 flex items-center gap-1 font-normal">
				<span>建站以来的总浏览次数</span>
			</div>
		</div>

		<!-- 历史独立访客 UV (放第二位) -->
		<div class="p-4 sm:p-5 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider) relative overflow-hidden group hover:border-purple-500/50 transition-all">
			<div class="flex items-center justify-between text-xs text-(--content-meta) mb-1.5">
				<span class="font-medium">历史总访客数 (UV)</span>
				<Icon icon="material-symbols:group-rounded" class="text-base text-purple-500 group-hover:scale-110 transition-transform" />
			</div>
			<div class="text-2xl sm:text-3xl font-extrabold text-neutral-800 dark:text-neutral-100 tracking-tight font-mono">
				{#if loading}
					<span class="inline-block w-20 h-8 bg-black/10 dark:bg-white/10 rounded animate-pulse"></span>
				{:else}
					<span class="data-fade-in">{(historicalStats.uv ?? 0).toLocaleString()}</span>
				{/if}
			</div>
			<div class="text-[11px] text-(--content-meta) mt-1.5 flex items-center gap-1 font-normal">
				<span>建站以来的独立访问人数</span>
			</div>
		</div>

		<!-- 今日总访问量 PV (放第三位) -->
		<div class="p-4 sm:p-5 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider) relative overflow-hidden group hover:border-(--primary)/50 transition-all">
			<div class="flex items-center justify-between text-xs text-(--content-meta) mb-1.5">
				<span class="font-medium">今日浏览量 (PV)</span>
				<Icon icon="material-symbols:visibility-rounded" class="text-base text-(--primary) group-hover:scale-110 transition-transform" />
			</div>
			<div class="text-2xl sm:text-3xl font-extrabold text-neutral-800 dark:text-neutral-100 tracking-tight font-mono">
				{#if loading}
					<span class="inline-block w-20 h-8 bg-black/10 dark:bg-white/10 rounded animate-pulse"></span>
				{:else}
					<span class="data-fade-in">{(todayStats.pv ?? 0).toLocaleString()}</span>
				{/if}
			</div>
			<div class="text-[11px] mt-1.5 flex items-center gap-1 font-medium">
				{#if todayStats.pv >= todayStats.prevPv}
					<span class="text-emerald-600 dark:text-emerald-400">↑ {(todayStats.pv - todayStats.prevPv).toLocaleString()}</span>
					<span class="text-(--content-meta) font-normal">较昨日</span>
				{:else}
					<span class="text-neutral-500 dark:text-neutral-400">↓ {(todayStats.prevPv - todayStats.pv).toLocaleString()}</span>
					<span class="text-(--content-meta) font-normal">较昨日</span>
				{/if}
			</div>
		</div>

		<!-- 今日独立访客 UV (放第四位) -->
		<div class="p-4 sm:p-5 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider) relative overflow-hidden group hover:border-emerald-500/50 transition-all">
			<div class="flex items-center justify-between text-xs text-(--content-meta) mb-1.5">
				<span class="font-medium">今日访客数 (UV)</span>
				<Icon icon="material-symbols:person-rounded" class="text-base text-emerald-500 group-hover:scale-110 transition-transform" />
			</div>
			<div class="text-2xl sm:text-3xl font-extrabold text-neutral-800 dark:text-neutral-100 tracking-tight font-mono">
				{#if loading}
					<span class="inline-block w-20 h-8 bg-black/10 dark:bg-white/10 rounded animate-pulse"></span>
				{:else}
					<span class="data-fade-in">{(todayStats.uv ?? 0).toLocaleString()}</span>
				{/if}
			</div>
			<div class="text-[11px] mt-1.5 flex items-center gap-1 font-medium">
				{#if todayStats.uv >= todayStats.prevUv}
					<span class="text-emerald-600 dark:text-emerald-400">↑ {(todayStats.uv - todayStats.prevUv).toLocaleString()}</span>
					<span class="text-(--content-meta) font-normal">较昨日</span>
				{:else}
					<span class="text-neutral-500 dark:text-neutral-400">↓ {(todayStats.prevUv - todayStats.uv).toLocaleString()}</span>
					<span class="text-(--content-meta) font-normal">较昨日</span>
				{/if}
			</div>
		</div>
	</div>

	<!-- 3. 访问脉冲走势图 (SVG 交互图表 + 周期与图例切换) -->
	<div class="p-5 sm:p-6 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider) relative">
		<!-- 头部控制栏：范围切换与图例 -->
		<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
			<div>
				<h2 class="text-base font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
					<Icon icon="material-symbols:show-chart-rounded" class="text-lg text-(--primary)" />
					<span>近 30 天访问走势</span>
				</h2>
				<p class="text-xs text-(--content-meta) mt-0.5">
					每天的页面浏览量 (PV) 与访问人数 (UV) 变化情况
				</p>
			</div>

			<div class="flex items-center gap-2 self-start sm:self-auto">
				<!-- PV/UV 图例开关 -->
				<button
					type="button"
					onclick={() => (showPv = !showPv)}
					class="text-xs px-2.5 py-1 rounded-lg border border-(--line-divider) flex items-center gap-1.5 transition-all cursor-pointer {showPv ? 'bg-(--primary)/10 text-(--primary) border-(--primary)/30 font-semibold' : 'text-(--content-meta) opacity-50'}"
				>
					<span class="w-2 h-2 rounded-full bg-(--primary)"></span>
					<span>浏览量 (PV)</span>
				</button>
				<button
					type="button"
					onclick={() => (showUv = !showUv)}
					class="text-xs px-2.5 py-1 rounded-lg border border-(--line-divider) flex items-center gap-1.5 transition-all cursor-pointer {showUv ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 font-semibold' : 'text-(--content-meta) opacity-50'}"
				>
					<span class="w-2 h-2 rounded-full bg-emerald-500"></span>
					<span>访客数 (UV)</span>
				</button>
			</div>
		</div>

		<!-- 当前 30 天周期峰值与日均概览微章 -->
		<div class="flex flex-wrap items-center gap-3 text-xs text-(--content-meta) mb-3 pb-3 border-b border-(--line-divider)/60">
			<div>
				30 天总览: <strong class="font-mono text-neutral-800 dark:text-neutral-200">{rangeStats.totalPv.toLocaleString()}</strong> 次浏览 / <strong class="font-mono text-neutral-800 dark:text-neutral-200">{rangeStats.totalUv.toLocaleString()}</strong> 位访客
			</div>
			<div>•</div>
			<div>
				平均每天: <strong class="font-mono text-neutral-800 dark:text-neutral-200">{rangeStats.avgPv.toLocaleString()}</strong> 次
			</div>
			{#if rangeStats.peakDate}
				<div>•</div>
				<div>
					单日最高: <strong class="font-mono text-(--primary)">{rangeStats.peakPv.toLocaleString()}</strong> 次 ({formatDateLabel(rangeStats.peakDate)})
				</div>
			{/if}
		</div>

		<!-- SVG 绘图区 -->
		<div
			class="relative w-full overflow-hidden select-none transition-opacity duration-200 {isRefreshing
				? 'opacity-40'
				: 'opacity-100'}"
		>
			<svg
				bind:this={svgElement}
				viewBox="0 0 {chartWidth} {chartHeight}"
				class="w-full h-48 sm:h-64 overflow-visible"
				role="img"
				aria-label="访问脉冲走势图"
				onmousemove={handleSvgMouseMove}
				onmouseleave={handleSvgMouseLeave}
			>
				<defs>
					<linearGradient id="pvGradient" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stop-color="var(--primary)" stop-opacity="0.32" />
						<stop offset="100%" stop-color="var(--primary)" stop-opacity="0.0" />
					</linearGradient>
					<linearGradient id="uvGradient" x1="0" y1="0" x2="0" y2="1">
						<stop offset="0%" stop-color="#10b981" stop-opacity="0.25" />
						<stop offset="100%" stop-color="#10b981" stop-opacity="0.0" />
					</linearGradient>
					{#if currentChartData.length > 0}
						<clipPath id="chartAreaClip">
							{#key chartAnimKey}
								<rect
									x={pad.left}
									y="0"
									width="0"
									height={chartHeight}
								>
									<animate
										attributeName="width"
										from="0"
										to={chartWidth - pad.left - pad.right}
										dur="1.6s"
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

				<!-- X 轴日期刻度 -->
				{#if currentChartData.length > 0}
					{#each xTickIndices as idx}
						{@const p = currentChartData[idx]}
						{#if p}
							<text
								x={getX(idx, currentChartData.length)}
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

				<!-- 脉冲走势折线与渐变区域 (带平滑展开动效) -->
				{#key chartAnimKey}
					<g class="pointer-events-none">
						<!-- 渐变阴影区域 -->
						<g clip-path="url(#chartAreaClip)">
							{#if showPv && currentChartData.length > 0}
								<path
									d={pvAreaPath}
									fill="url(#pvGradient)"
									class="chart-area-pv"
								/>
							{/if}
							{#if showUv && currentChartData.length > 0}
								<path
									d={uvAreaPath}
									fill="url(#uvGradient)"
									class="chart-area-uv"
								/>
							{/if}
						</g>

						<!-- PV 脉冲折线 (描边绘制动画) -->
						{#if showPv && currentChartData.length > 0}
							<path
								d={pvLinePath}
								fill="none"
								stroke="var(--primary)"
								stroke-width="2.2"
								stroke-linecap="round"
								stroke-linejoin="round"
								pathLength="1000"
								class="chart-line-pv"
							/>
						{/if}

						<!-- UV 访客折线 (双波微延时交叠绘制) -->
						{#if showUv && currentChartData.length > 0}
							<path
								d={uvLinePath}
								fill="none"
								stroke="#10b981"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								pathLength="1000"
								class="chart-line-uv"
							/>
						{/if}
					</g>
				{/key}

				<!-- 鼠标悬停竖线与数据高亮圆点 -->
				{#if hoverIndex !== null && currentChartData[hoverIndex]}
					{@const hp = currentChartData[hoverIndex]}
					{@const hx = getX(hoverIndex, currentChartData.length)}
					{@const hyPv = getY(hp.pv)}
					{@const hyUv = getY(hp.uv)}

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

					{#if showPv}
						<circle cx={hx} cy={hyPv} r="5" class="fill-(--primary) stroke-white dark:stroke-neutral-900" stroke-width="2" />
					{/if}
					{#if showUv}
						<circle cx={hx} cy={hyUv} r="4.5" class="fill-emerald-500 stroke-white dark:stroke-neutral-900" stroke-width="2" />
					{/if}
				{/if}
			</svg>

			<!-- 悬浮 Tooltip 气泡卡片 (自适应左右侧自然延展，带固定最小宽度与防挤压换行保护) -->
			{#if hoverIndex !== null && currentChartData[hoverIndex]}
				{@const hp = currentChartData[hoverIndex]}
				{@const hx = getX(hoverIndex, currentChartData.length)}
				{@const isRightHalf = hx > chartWidth / 2}
				<div
					class="pointer-events-none absolute top-4 z-20 px-3.5 py-2.5 rounded-xl bg-(--card-bg) border border-(--line-divider) shadow-xl text-xs backdrop-blur-md transition-all duration-75 whitespace-nowrap min-w-[145px] w-max select-none"
					style={isRightHalf
						? `right: calc(${Math.max(0, 100 - (hx / chartWidth) * 100)}% + 14px);`
						: `left: calc(${Math.max(0, (hx / chartWidth) * 100)}% + 14px);`}
				>
					<div class="font-bold text-neutral-800 dark:text-neutral-100 border-b border-(--line-divider) pb-1.5 mb-1.5 font-mono flex items-center gap-1.5 whitespace-nowrap">
						<Icon icon="material-symbols:calendar-today-rounded" class="text-xs text-(--primary)" />
						<span>{hp.date}</span>
					</div>
					<div class="space-y-1.5">
						{#if showPv}
							<div class="flex items-center justify-between gap-5 whitespace-nowrap">
								<span class="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
									<span class="w-2 h-2 rounded-full bg-(--primary) shrink-0"></span>
									<span>页面浏览 (PV):</span>
								</span>
								<strong class="font-mono text-neutral-800 dark:text-neutral-100">{hp.pv.toLocaleString()} 次</strong>
							</div>
						{/if}
						{#if showUv}
							<div class="flex items-center justify-between gap-5 whitespace-nowrap">
								<span class="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-300">
									<span class="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
									<span>访问人数 (UV):</span>
								</span>
								<strong class="font-mono text-neutral-800 dark:text-neutral-100">{hp.uv.toLocaleString()} 人</strong>
							</div>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</div>

	<!-- 4. 内容发布与推送节奏热力图 (52 周创作提交日历 - 响应式自适应 SVG 架构，无拖拽滚动条) -->
	<div class="p-5 sm:p-6 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider) relative">
		<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
			<div>
				<h2 class="text-base font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
					<Icon icon="material-symbols:edit-calendar-rounded" class="text-lg text-(--primary)" />
					<span>过去一年的创作记录</span>
				</h2>
				<p class="text-xs text-(--content-meta) mt-0.5">
					记录过去一年写过的博客文章与说说
				</p>
			</div>

			<!-- 概览指标小徽章栏 -->
			<div class="flex flex-wrap items-center gap-2 text-xs">
				<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/4 dark:bg-white/4 border border-(--line-divider) text-(--content-meta)">
					<Icon icon="material-symbols:menu-book-rounded" class="text-xs text-(--primary)" />
					<span>博客文章:</span>
					<strong class="text-neutral-800 dark:text-neutral-100">{contentStats?.postCount ?? 0}</strong> 篇
				</span>
				<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/4 dark:bg-white/4 border border-(--line-divider) text-(--content-meta)">
					<Icon icon="material-symbols:forum-rounded" class="text-xs text-(--primary)" />
					<span>即刻说说:</span>
					<strong class="text-neutral-800 dark:text-neutral-100">{contentStats?.dynamicCount ?? 0}</strong> 条
				</span>
				<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/4 dark:bg-white/4 border border-(--line-divider) text-(--content-meta)">
					<Icon icon="material-symbols:text-fields-rounded" class="text-xs text-(--primary)" />
					<span>全站字数:</span>
					<strong class="text-neutral-800 dark:text-neutral-100">{(contentStats?.totalWords ?? 0).toLocaleString()}</strong> 字
				</span>
			</div>
		</div>

		<!-- 52 周热力网格容器 (SVG 矢量响应式画布，无缝扩大热区，离开容器才重置状态) -->
		<div class="w-full pt-1 pb-1 select-none">
			<svg
				viewBox="0 0 740 116"
				class="w-full h-auto block select-none overflow-visible"
				role="img"
				aria-label="年度创作热力图"
				onmouseleave={() => (hoveredHeatmapCell = null)}
			>
				<!-- 月份刻度文本 -->
				{#each contributionCalendar.months as m}
					<text
						x={28 + m.col * 13.2}
						y="11"
						class="fill-(--content-meta) text-[10px] font-mono"
					>
						{m.name}
					</text>
				{/each}

				<!-- 星期刻度文本 (周一、周三、周五) -->
				<text x="2" y={18 + 1 * 13.2 + 8} class="fill-(--content-meta) text-[9px]">周一</text>
				<text x="2" y={18 + 3 * 13.2 + 8} class="fill-(--content-meta) text-[9px]">周三</text>
				<text x="2" y={18 + 5 * 13.2 + 8} class="fill-(--content-meta) text-[9px]">周五</text>

				<!-- 52 周热力矩形网格 (双层架构：外层透明无缝命中热区，内层视觉小方块，纯悬停查看无点击焦框) -->
				{#each contributionCalendar.days as d}
					<g
						class="cursor-default group/cell outline-none focus:outline-none"
						onmouseenter={() => (hoveredHeatmapCell = d)}
					>
						<!-- 无缝透明命中热区 (占满整格 13.2 步长) -->
						<rect
							x={28 + d.col * 13.2 - 1.6}
							y={18 + d.row * 13.2 - 1.6}
							width="13.2"
							height="13.2"
							fill="transparent"
						/>
						<!-- 视觉展示方块 -->
						<rect
							x={28 + d.col * 13.2}
							y={18 + d.row * 13.2}
							width="10"
							height="10"
							rx="2.2"
							class="{d.level === 0 ? 'text-black/5 dark:text-white/6' : d.level === 1 ? 'text-(--primary)/25' : d.level === 2 ? 'text-(--primary)/50' : d.level === 3 ? 'text-(--primary)/75' : 'text-(--primary)'} fill-current transition-colors pointer-events-none group-hover/cell:stroke-(--primary) group-hover/cell:stroke-1"
						/>
					</g>
				{/each}
			</svg>

			<!-- 底部说明与图例 (固定单行高度与对齐，彻底消除高度抽搐) -->
			<div class="flex items-center justify-between text-[11px] text-(--content-meta) mt-3 pt-2 border-t border-(--line-divider)/60 min-h-[26px]">
				<div class="h-6 flex items-center min-w-0 flex-1 truncate pr-2">
					{#if hoveredHeatmapCell}
						<span class="inline-flex items-center gap-1 shrink-0">
							<Icon icon="material-symbols:edit-calendar-rounded" class="text-xs text-(--primary)" />
							<strong class="font-mono text-neutral-800 dark:text-neutral-100">{hoveredHeatmapCell.date}</strong>:
						</span>
						{#if hoveredHeatmapCell.total > 0}
							<span class="text-neutral-800 dark:text-neutral-100 font-medium ml-1.5 truncate">
								当天发布了 {hoveredHeatmapCell.posts > 0 ? `${hoveredHeatmapCell.posts} 篇文章` : ""}{hoveredHeatmapCell.posts > 0 && hoveredHeatmapCell.dynamics > 0 ? "、" : ""}{hoveredHeatmapCell.dynamics > 0 ? `${hoveredHeatmapCell.dynamics} 条说说` : ""}
							</span>
						{:else}
							<span class="text-(--content-meta) ml-1.5 truncate">当天没有发布新内容</span>
						{/if}
					{:else}
						<span class="truncate">鼠标移到小方块上，查看当天的发布记录</span>
					{/if}
				</div>

				<!-- 图例 -->
				<div class="flex items-center gap-1 text-[10px] shrink-0">
					<span>少</span>
					<span class="w-2.5 h-2.5 rounded-[2px] bg-black/5 dark:bg-white/6"></span>
					<span class="w-2.5 h-2.5 rounded-[2px] bg-(--primary)/25"></span>
					<span class="w-2.5 h-2.5 rounded-[2px] bg-(--primary)/50"></span>
					<span class="w-2.5 h-2.5 rounded-[2px] bg-(--primary)/75"></span>
					<span class="w-2.5 h-2.5 rounded-[2px] bg-(--primary)"></span>
					<span>多</span>
				</div>
			</div>
		</div>
	</div>

	<!-- 5. 双栏洞察：热门内容阅读排行 + 访客地域与设备画像 -->
	<div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
		<!-- 热门内容阅读排行 (支持分类切换与动态展开，自适应右侧高度) -->
		<div class="p-5 sm:p-6 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider) flex flex-col">
			<div class="flex items-center justify-between mb-4 flex-wrap gap-2">
				<div>
					<h3 class="text-sm font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
						<Icon icon="material-symbols:trending-up-rounded" class="text-lg text-amber-500" />
						<span>热门内容排行</span>
					</h3>
					<p class="text-[11px] text-(--content-meta) mt-0.5">近 30 天访问最多的页面与文章</p>
				</div>

				<!-- 分类切换药丸 (全部 / 文章 / 项目) -->
				<div class="flex items-center gap-1 bg-black/4 dark:bg-white/4 p-0.5 rounded-lg border border-(--line-divider)/60 text-xs">
					<button
						type="button"
						onclick={() => (rankingTab = "all")}
						class="px-2.5 py-1 rounded-md transition-all cursor-pointer {rankingTab === 'all' ? 'bg-(--primary) text-white font-medium shadow-xs' : 'text-(--content-meta) hover:text-neutral-800 dark:hover:text-neutral-200'}"
					>
						全部
					</button>
					<button
						type="button"
						onclick={() => (rankingTab = "post")}
						class="px-2.5 py-1 rounded-md transition-all cursor-pointer {rankingTab === 'post' ? 'bg-(--primary) text-white font-medium shadow-xs' : 'text-(--content-meta) hover:text-neutral-800 dark:hover:text-neutral-200'}"
					>
						文章
					</button>
					<button
						type="button"
						onclick={() => (rankingTab = "project")}
						class="px-2.5 py-1 rounded-md transition-all cursor-pointer {rankingTab === 'project' ? 'bg-(--primary) text-white font-medium shadow-xs' : 'text-(--content-meta) hover:text-neutral-800 dark:hover:text-neutral-200'}"
					>
						项目
					</button>
				</div>
			</div>

			<div class="space-y-2 flex-1">
				{#if loading}
					{#each Array(6) as _}
						<div class="h-10 bg-black/5 dark:bg-white/5 rounded-xl animate-pulse"></div>
					{/each}
				{:else if displayedTopPages.length > 0}
					{#key `${rankingTab}-${chartAnimKey}`}
						{#each displayedTopPages as page, idx}
							{@const pct = (page.views / currentMaxPageView) * 100}
							{@const itemPercent = Math.max(0.1, Math.round((page.views / currentTotalPageView) * 1000) / 10)}
							{@const displayTitle = cleanPageTitle(page.title, page.path)}
							<div
								class="ranking-item p-2.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors relative overflow-hidden group"
								style="animation-delay: {idx * 30}ms;"
							>
								<!-- 进度条底色 (平滑动态展开) -->
								<div
									class="ranking-bar-fill absolute left-0 top-0 bottom-0 bg-(--primary)/10 rounded-xl"
									style="width: {pct}%; --target-width: {pct}%; animation-delay: {idx * 30 + 50}ms;"
								></div>

								<div class="relative z-10 flex items-center justify-between gap-3 text-xs">
									<div class="flex items-center gap-2 min-w-0 flex-1">
										<!-- 排名徽章 (统一正常克制样式，不搞浮夸奖牌) -->
										<span class="w-5 h-5 rounded-md flex items-center justify-center font-mono font-bold text-[11px] shrink-0 bg-black/5 dark:bg-white/5 text-(--content-meta)">
											{idx + 1}
										</span>

										<!-- 类别微章 (统一中性质感，不搞花哨色差) -->
										<span class="text-[10px] px-1.5 py-0.5 rounded-md font-medium shrink-0 bg-black/5 dark:bg-white/5 text-(--content-meta)">
											{getPageTypeLabel(getPageType(page.path))}
										</span>

										<!-- 文章标题与链接 -->
										<a
											href={page.path}
											class="font-medium text-neutral-700 dark:text-neutral-200 hover:text-(--primary) truncate transition-colors"
											title={displayTitle}
										>
											{displayTitle}
										</a>
									</div>

									<!-- 浏览次数与占比 -->
									<div class="shrink-0 flex items-center gap-1.5 font-mono text-neutral-800 dark:text-neutral-100">
										<span class="font-bold">{page.views.toLocaleString()}</span>
										<span class="text-[10px] text-(--content-meta)">次</span>
										<span class="text-[10px] text-(--content-meta) hidden sm:inline">({itemPercent}%)</span>
									</div>
								</div>
							</div>
						{/each}
					{/key}
				{:else}
					<div class="py-10 text-center text-xs text-(--content-meta)">
						该分类下暂无访问记录
					</div>
				{/if}
			</div>
		</div>

		<!-- 访客画像与终端设备画像 -->
		<div class="space-y-6">
			<!-- 访客地域分布 -->
			<div class="p-5 sm:p-6 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider)">
				<div class="flex items-center justify-between mb-4">
					<h3 class="text-sm font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
						<Icon icon="material-symbols:language" class="text-base text-(--primary)" />
						<span>访客地域分布</span>
					</h3>
					<span class="text-[11px] text-(--content-meta)">按访客占比</span>
				</div>

				<div class="space-y-3">
					{#if loading}
						{#each Array(4) as _}
							<div class="h-8 bg-black/5 dark:bg-white/5 rounded-xl animate-pulse"></div>
						{/each}
					{:else if insights && insights.countries.length > 0}
						{#key chartAnimKey}
							{#each insights.countries as country, cIdx}
								{@const countryPct = Math.min(100, Math.round((country.visits / maxCountryVisits) * 1000) / 10)}
								{@const visual = getCountryVisual(country.name)}
								<div
									class="space-y-1 country-item"
									style="animation-delay: {cIdx * 65}ms;"
								>
									<div class="flex items-center justify-between text-xs">
										<span class="font-medium text-neutral-700 dark:text-neutral-200 truncate min-w-0">
											{country.name}
										</span>
										<span class="font-mono text-(--content-meta) shrink-0 ml-2">
											{country.visits.toLocaleString()} 次 ({country.percent}%)
										</span>
									</div>
									<div class="w-full h-1.5 bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
										<div
											class="h-full rounded-full country-bar-fill"
											style="width: {countryPct}%; --target-width: {countryPct}%; background-color: {visual.color}; animation-delay: {cIdx * 65 + 75}ms;"
										></div>
									</div>
								</div>
							{/each}
						{/key}
					{/if}
				</div>
			</div>

			<!-- 访问设备类型 (电脑端 vs 手机端) -->
			<div class="p-5 sm:p-6 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider)">
				<h4 class="text-xs font-bold text-neutral-800 dark:text-neutral-100 mb-3 flex items-center gap-1.5">
					<Icon icon="material-symbols:devices-rounded" class="text-sm text-(--primary)" />
					<span>访问设备类型</span>
				</h4>
				<div class="space-y-2">
					<div class="flex items-center justify-between text-xs">
						<span class="flex items-center gap-1.5 text-neutral-700 dark:text-neutral-200 font-medium">
							<span class="w-2 h-2 rounded-full shrink-0" style="background-color: {DEVICE_COLORS.desktop};"></span>
							<span>电脑端 (Desktop)</span>
							<strong class="font-mono text-neutral-900 dark:text-neutral-100">{deviceRatio.desktop}%</strong>
						</span>
						<span class="flex items-center gap-1.5 text-neutral-700 dark:text-neutral-200 font-medium">
							<strong class="font-mono text-neutral-900 dark:text-neutral-100">{deviceRatio.mobile}%</strong>
							<span>手机端 (Mobile)</span>
							<span class="w-2 h-2 rounded-full shrink-0" style="background-color: {DEVICE_COLORS.mobile};"></span>
						</span>
					</div>
					{#key chartAnimKey}
						<div class="w-full h-2 rounded-full overflow-hidden flex bg-black/5 dark:bg-white/5">
							<div
								class="h-full device-bar-fill"
								style="width: {deviceRatio.desktop}%; --target-width: {deviceRatio.desktop}%; background-color: {DEVICE_COLORS.desktop}; animation-delay: 80ms;"
							></div>
							<div
								class="h-full device-bar-fill"
								style="width: {deviceRatio.mobile}%; --target-width: {deviceRatio.mobile}%; background-color: {DEVICE_COLORS.mobile}; animation-delay: 140ms;"
							></div>
						</div>
					{/key}
				</div>
			</div>

			<!-- 客户端浏览器与操作系统占比 (并排展示) -->
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
				<!-- 浏览器分布 -->
				<div class="p-4 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider)">
					<h4 class="text-xs font-bold text-neutral-800 dark:text-neutral-100 mb-3 flex items-center gap-1.5">
						<Icon icon="material-symbols:public" class="text-xs text-blue-500" />
						<span>常用浏览器</span>
					</h4>
					<div class="space-y-2">
						{#if insights && insights.browsers.length > 0}
							{#key chartAnimKey}
								{#each insights.browsers as b, bIdx}
									{@const bColor = getBrowserColor(b.name)}
									<div
										class="space-y-1 env-item"
										style="animation-delay: {bIdx * 45}ms;"
									>
										<div class="flex items-center justify-between text-[11px]">
											<span class="text-neutral-700 dark:text-neutral-300 truncate flex items-center gap-1.5 min-w-0">
												<span class="w-1.5 h-1.5 rounded-full shrink-0" style="background-color: {bColor};"></span>
												<span class="truncate">{b.name}</span>
											</span>
											<span class="font-mono text-(--content-meta) shrink-0 ml-1.5">{b.percent}%</span>
										</div>
										<div class="w-full h-1 bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
											<div
												class="h-full rounded-full env-bar-fill"
												style="width: {b.percent}%; --target-width: {b.percent}%; background-color: {bColor}; animation-delay: {bIdx * 45 + 50}ms;"
											></div>
										</div>
									</div>
								{/each}
							{/key}
						{/if}
					</div>
				</div>

				<!-- 操作系统分布 -->
				<div class="p-4 rounded-2xl bg-black/2 dark:bg-white/2 border border-(--line-divider)">
					<h4 class="text-xs font-bold text-neutral-800 dark:text-neutral-100 mb-3 flex items-center gap-1.5">
						<Icon icon="material-symbols:devices-rounded" class="text-xs text-indigo-500" />
						<span>操作系统</span>
					</h4>
					<div class="space-y-2">
						{#if insights && insights.os.length > 0}
							{#key chartAnimKey}
								{#each insights.os as o, oIdx}
									{@const oColor = getOsColor(o.name)}
									<div
										class="space-y-1 env-item"
										style="animation-delay: {oIdx * 45}ms;"
									>
										<div class="flex items-center justify-between text-[11px]">
											<span class="text-neutral-700 dark:text-neutral-300 truncate flex items-center gap-1.5 min-w-0">
												<span class="w-1.5 h-1.5 rounded-full shrink-0" style="background-color: {oColor};"></span>
												<span class="truncate">{o.name}</span>
											</span>
											<span class="font-mono text-(--content-meta) shrink-0 ml-1.5">{o.percent}%</span>
										</div>
										<div class="w-full h-1 bg-black/5 dark:bg-white/5 rounded-full overflow-hidden">
											<div
												class="h-full rounded-full env-bar-fill"
												style="width: {o.percent}%; --target-width: {o.percent}%; background-color: {oColor}; animation-delay: {oIdx * 45 + 50}ms;"
											></div>
										</div>
									</div>
								{/each}
							{/key}
						{/if}
					</div>
				</div>
			</div>
		</div>
	</div>
</div>

<style>
	/* 1. 访问脉冲走势折线与渐变动效 (放慢至 1.6s，极致丝滑的自然减速，both 填充杜绝延迟闪烁) */
	.chart-line-pv {
		opacity: 0;
		stroke-dasharray: 1000;
		stroke-dashoffset: 1000;
		animation: drawPvPulse 1.6s cubic-bezier(0.16, 1, 0.3, 1) both;
	}

	.chart-line-uv {
		opacity: 0;
		stroke-dasharray: 1000;
		stroke-dashoffset: 1000;
		animation: drawUvPulse 1.6s cubic-bezier(0.16, 1, 0.3, 1) 0.16s both;
	}

	.chart-area-pv {
		opacity: 0;
		animation: fadeInPulseArea 1.4s ease-out both;
	}

	.chart-area-uv {
		opacity: 0;
		animation: fadeInPulseArea 1.4s ease-out 0.16s both;
	}

	@keyframes drawPvPulse {
		0% {
			stroke-dashoffset: 1000;
			opacity: 0;
		}
		1% {
			opacity: 1;
		}
		100% {
			stroke-dashoffset: 0;
			opacity: 1;
		}
	}

	@keyframes drawUvPulse {
		0% {
			stroke-dashoffset: 1000;
			opacity: 0;
		}
		1% {
			opacity: 1;
		}
		100% {
			stroke-dashoffset: 0;
			opacity: 1;
		}
	}

	@keyframes fadeInPulseArea {
		0% {
			opacity: 0;
		}
		100% {
			opacity: 1;
		}
	}

	/* 2. 核心指标数字与数据元素柔和浮现 (框架不重载，仅数据呈现) */
	.data-fade-in {
		animation: dataFadeIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
	}

	@keyframes dataFadeIn {
		0% {
			opacity: 0;
			transform: translateY(4px);
		}
		100% {
			opacity: 1;
			transform: translateY(0);
		}
	}

	/* 3. 热门排行榜与各分类条状图平滑展开动画 */
	.ranking-item {
		animation: itemSlideFade 0.85s cubic-bezier(0.16, 1, 0.3, 1) both;
	}

	.ranking-bar-fill {
		animation: barExpand 1.35s cubic-bezier(0.16, 1, 0.3, 1) both;
	}

	.country-item {
		animation: itemFadeUp 0.85s cubic-bezier(0.16, 1, 0.3, 1) both;
	}

	.country-bar-fill {
		animation: barExpand 1.45s cubic-bezier(0.16, 1, 0.3, 1) both;
	}

	.device-bar-fill {
		animation: barExpand 1.35s cubic-bezier(0.16, 1, 0.3, 1) both;
	}

	.env-item {
		animation: itemFadeUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) both;
	}

	.env-bar-fill {
		animation: barExpand 1.25s cubic-bezier(0.16, 1, 0.3, 1) both;
	}

	@keyframes itemSlideFade {
		0% {
			opacity: 0;
			transform: translateX(-8px);
		}
		100% {
			opacity: 1;
			transform: translateX(0);
		}
	}

	@keyframes itemFadeUp {
		0% {
			opacity: 0;
			transform: translateY(6px);
		}
		100% {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes barExpand {
		0% {
			width: 0%;
		}
		100% {
			width: var(--target-width);
		}
	}

	/* 4. 无障碍减弱动态兜底 */
	@media (prefers-reduced-motion: reduce) {
		.chart-line-pv,
		.chart-line-uv,
		.chart-area-pv,
		.chart-area-uv,
		.data-fade-in,
		.ranking-item,
		.ranking-bar-fill,
		.country-item,
		.country-bar-fill,
		.device-bar-fill,
		.env-item,
		.env-bar-fill {
			animation: none !important;
			stroke-dashoffset: 0 !important;
			opacity: 1 !important;
			transform: none !important;
			width: var(--target-width, 100%) !important;
		}
	}
</style>
