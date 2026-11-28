<script lang="ts">
import { untrack } from "svelte";
import type { InterconnectSite } from "@/types/chatConfig";
import ChatAvatar from "./ChatAvatar.svelte";
import ChatStatsFlowChart from "./ChatStatsFlowChart.svelte";
import ChatStatsVisuals from "./ChatStatsVisuals.svelte";
import { resolveExternalOrigin } from "./chatClient";
import {
	DEFAULT_CHAT_SERVER_URL,
	resolveReactionDisplay,
} from "./chatReactions";
import {
	fetchChatStats,
	formatDeltaBadge,
	formatStatNumber,
	getCachedChatStats,
	getLocalDayKey,
	shiftDayKeyLocal,
} from "./chatStatsClient";
import type {
	ChatStatsRange,
	ChatStatsResponse,
	ChatStatsRoomScope,
	ChatStatsSiteItem,
	ChatStatsUserRow,
} from "./chatStatsTypes";
import type { ChatUserDetailSeed } from "./chatTypes";
import LottieSticker from "./LottieSticker.svelte";
import type { StickerItem } from "./stickerLoader";

export type ChatStatsLayoutMode = "center" | "modal";

interface Props {
	active: boolean;
	layoutMode: ChatStatsLayoutMode;
	initialRoom?: ChatStatsRoomScope;
	initialRange?: ChatStatsRange;
	initialDate?: string;
	chatServerUrl?: string;
	interconnectSites?: InterconnectSite[];
	stickerMap?: Map<string, StickerItem>;
	showBackButton?: boolean;
	unreadChatCount?: number;
	onBackToChat?: () => void;
	onChangeLayoutMode?: (mode: ChatStatsLayoutMode) => void;
	onRoomChange?: (room: ChatStatsRoomScope) => void;
	onLoadingChange?: (loading: boolean) => void;
	onOpenUserProfile?: (seed: ChatUserDetailSeed) => void;
}

type LeaderboardSort =
	| "messages"
	| "chars"
	| "images"
	| "stickers"
	| "musicRequests"
	| "interactionScore";

const {
	active,
	layoutMode = "center",
	initialRoom = "interconnect",
	initialRange = "all",
	initialDate = "",
	chatServerUrl = DEFAULT_CHAT_SERVER_URL,
	interconnectSites = [],
	stickerMap,
	showBackButton = true,
	unreadChatCount = 0,
	onBackToChat,
	onChangeLayoutMode,
	onRoomChange,
	onLoadingChange,
	onOpenUserProfile,
}: Props = $props();

const ROOM_OPTIONS: Array<{ id: ChatStatsRoomScope; label: string }> = [
	{ id: "interconnect", label: "互联茶室" },
	{ id: "chat", label: "闲聊" },
	{ id: "all", label: "全站汇总" },
];

const RANGE_OPTIONS: Array<{ id: ChatStatsRange; label: string }> = [
	{ id: "day", label: "按天" },
	{ id: "3d", label: "近3天" },
	{ id: "week", label: "本周" },
	{ id: "month", label: "本月" },
	{ id: "all", label: "全部" },
];

const SORT_COLUMNS: Array<{ id: LeaderboardSort; label: string }> = [
	{ id: "messages", label: "发言" },
	{ id: "chars", label: "字数" },
	{ id: "images", label: "晒图" },
	{ id: "stickers", label: "表情" },
	{ id: "musicRequests", label: "点歌" },
	{ id: "interactionScore", label: "互动" },
];

let room = $state<ChatStatsRoomScope>(initialRoom);
let selectedSite = $state<string>("all");
let range = $state<ChatStatsRange>(initialRange);
let anchorDay = $state<string>(initialDate || getLocalDayKey());
let drillReturnState = $state<{
	range: ChatStatsRange;
	anchorDay: string;
} | null>(null);

let leaderboardSort = $state<LeaderboardSort>("messages");
let showAllMembers = $state(false);

let stats = $state<ChatStatsResponse | null>(null);
let isLoading = $state(false);
let errorMessage = $state("");
let animSeq = $state(0);
let failedStickerKeys = $state<Record<string, boolean>>({});
let siteDropdownOpen = $state(false);
let siteDropdownEl = $state<HTMLDivElement | null>(null);
let stickerViewportEl = $state<HTMLDivElement | null>(null);
let stickerCols = $state(6);
let stickerOffset = $state(0);
let exprViewportEl = $state<HTMLDivElement | null>(null);
let exprTrackEl = $state<HTMLDivElement | null>(null);
let exprViewportWidth = $state(0);
let exprTrackWidth = $state(0);
let exprOffsetPx = $state(0);
let isMobileWall = $state(false);

export function refresh() {
	void loadStats(true);
}

$effect(() => {
	onRoomChange?.(room);
});

$effect(() => {
	onLoadingChange?.(isLoading);
});

$effect(() => {
	if (typeof window === "undefined") return;
	const mq = window.matchMedia("(max-width: 767px)");
	const sync = () => {
		isMobileWall = mq.matches;
	};
	sync();
	mq.addEventListener("change", sync);
	return () => mq.removeEventListener("change", sync);
});

$effect(() => {
	if (!siteDropdownOpen) return;
	const onDocPointerDown = (e: PointerEvent) => {
		if (siteDropdownEl && !siteDropdownEl.contains(e.target as Node)) {
			siteDropdownOpen = false;
		}
	};
	const onDocKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") siteDropdownOpen = false;
	};
	document.addEventListener("pointerdown", onDocPointerDown);
	document.addEventListener("keydown", onDocKeyDown);
	return () => {
		document.removeEventListener("pointerdown", onDocPointerDown);
		document.removeEventListener("keydown", onDocKeyDown);
	};
});

$effect(() => {
	const el = stickerViewportEl;
	if (!el || typeof ResizeObserver === "undefined") return;
	const updateCols = (width: number) => {
		const next = Math.max(2, Math.floor((width + 10) / 114));
		if (next !== stickerCols) stickerCols = next;
	};
	updateCols(el.clientWidth);
	const ro = new ResizeObserver((entries) => {
		for (const entry of entries) {
			updateCols(entry.contentRect.width);
		}
	});
	ro.observe(el);
	return () => ro.disconnect();
});

$effect(() => {
	const total = stats?.topStickers?.length ?? 0;
	const maxOffset = Math.max(0, total - stickerCols);
	if (stickerOffset > maxOffset) stickerOffset = maxOffset;
});

$effect(() => {
	const vp = exprViewportEl;
	const tr = exprTrackEl;
	if (!vp || !tr || typeof ResizeObserver === "undefined") return;
	const syncWidths = () => {
		exprViewportWidth = vp.clientWidth;
		exprTrackWidth = tr.scrollWidth;
	};
	syncWidths();
	const ro = new ResizeObserver(() => syncWidths());
	ro.observe(vp);
	ro.observe(tr);
	return () => ro.disconnect();
});

$effect(() => {
	const _dep = stats;
	void _dep;
	exprOffsetPx = 0;
});

let displayKpis = $state({
	messages: 0,
	activeUsers: 0,
	chars: 0,
	stickers: 0,
	images: 0,
	musicRequests: 0,
});
let countUpRaf: number | null = null;

function animateKpis(target: {
	messages: number;
	activeUsers: number;
	chars: number;
	stickers: number;
	images: number;
	musicRequests: number;
}) {
	if (countUpRaf !== null) {
		cancelAnimationFrame(countUpRaf);
		countUpRaf = null;
	}
	if (
		typeof window === "undefined" ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	) {
		displayKpis = { ...target };
		return;
	}
	const startVals = untrack(() => ({ ...displayKpis }));
	const startTime = performance.now();
	const duration = 420;
	const step = (now: number) => {
		const t = Math.min(1, (now - startTime) / duration);
		const eased = 1 - (1 - t) ** 3;
		displayKpis = {
			messages: Math.round(
				startVals.messages + (target.messages - startVals.messages) * eased,
			),
			activeUsers: Math.round(
				startVals.activeUsers +
					(target.activeUsers - startVals.activeUsers) * eased,
			),
			chars: Math.round(
				startVals.chars + (target.chars - startVals.chars) * eased,
			),
			stickers: Math.round(
				startVals.stickers + (target.stickers - startVals.stickers) * eased,
			),
			images: Math.round(
				startVals.images + (target.images - startVals.images) * eased,
			),
			musicRequests: Math.round(
				startVals.musicRequests +
					(target.musicRequests - startVals.musicRequests) * eased,
			),
		};
		if (t < 1) {
			countUpRaf = requestAnimationFrame(step);
		} else {
			countUpRaf = null;
		}
	};
	countUpRaf = requestAnimationFrame(step);
}

let activeController: AbortController | null = null;
let loadedRequestKey = "";

async function loadStats(force = false) {
	const effectiveSite = room === "chat" ? "all" : selectedSite;
	const params = {
		room,
		range,
		site: effectiveSite,
		date: range === "all" ? "" : anchorDay,
	};
	const reqKey = `${params.room}|${params.site}|${params.range}|${params.date}`;
	if (!force && reqKey === loadedRequestKey && stats) {
		return;
	}
	activeController?.abort();
	const controller = new AbortController();
	activeController = controller;
	const cached = !force ? getCachedChatStats(chatServerUrl, params) : null;
	if (cached) {
		loadedRequestKey = reqKey;
		stats = cached;
		errorMessage = "";
		if (force) animSeq += 1;
		animateKpis(cached.summary);
		return;
	}
	isLoading = true;
	errorMessage = "";
	try {
		const res = await fetchChatStats(chatServerUrl, params, {
			force,
			signal: controller.signal,
		});
		if (controller.signal.aborted) return;
		loadedRequestKey = reqKey;
		stats = res;
		if (force) animSeq += 1;
		animateKpis(res.summary);
		if (!force) {
			setTimeout(() => {
				if (!active) return;
				if (range !== "day") prefetchRange("day");
				if (range !== "3d") prefetchRange("3d");
				if (range !== "week") prefetchRange("week");
			}, 120);
		}
	} catch (err) {
		if (controller.signal.aborted) return;
		errorMessage = err instanceof Error ? err.message : "统计数据加载失败";
	} finally {
		if (activeController === controller) {
			isLoading = false;
		}
	}
}

function prefetchRange(nextRange: ChatStatsRange) {
	if (!active) return;
	const targetDate = nextRange === "all" ? "" : todayKey;
	void fetchChatStats(chatServerUrl, {
		room,
		range: nextRange,
		date: targetDate,
	}).catch(() => {});
}

$effect(() => {
	if (!active) {
		activeController?.abort();
		loadedRequestKey = "";
		if (countUpRaf !== null) {
			cancelAnimationFrame(countUpRaf);
			countUpRaf = null;
		}
		return;
	}
	untrack(() => {
		room = initialRoom;
		selectedSite = "all";
		range = initialRange;
		anchorDay = initialDate || getLocalDayKey();
		drillReturnState = null;
		showAllMembers = false;
		failedStickerKeys = {};
	});
});

$effect(() => {
	if (!active) return;
	const curRoom = room;
	const curSite = selectedSite;
	const curRange = range;
	const curDay = anchorDay;
	void curRoom;
	void curSite;
	void curRange;
	void curDay;
	untrack(() => {
		void loadStats();
	});
});

const todayKey = $derived(stats?.availableRange?.todayKey || getLocalDayKey());
const minDayKey = $derived(stats?.availableRange?.minDay || "");
const maxDayKey = $derived(stats?.availableRange?.maxDay || todayKey);
const isAtToday = $derived(anchorDay >= todayKey);
const canStepPrev = $derived(!minDayKey || anchorDay > minDayKey);
const canStepNext = $derived(anchorDay < maxDayKey);

const quickDatePills = $derived.by(() => {
	const pills: Array<{ dayKey: string; label: string }> = [];
	for (let i = 0; i < 6; i++) {
		const dk = shiftDayKeyLocal(todayKey, -i);
		if (minDayKey && dk < minDayKey) break;
		const label = i === 0 ? "今天" : i === 1 ? "昨天" : dk.slice(5);
		pills.push({ dayKey: dk, label });
	}
	return pills;
});

function selectRange(nextRange: ChatStatsRange) {
	drillReturnState = null;
	showAllMembers = false;
	if (nextRange !== "day") {
		anchorDay = todayKey;
	} else if (range !== "day") {
		anchorDay = todayKey;
	}
	range = nextRange;
}

function stepDay(delta: number) {
	const next = shiftDayKeyLocal(anchorDay, delta);
	if (minDayKey && next < minDayKey) return;
	if (next > maxDayKey) return;
	drillReturnState = null;
	anchorDay = next;
}

function drillToDay(dayKey: string) {
	if (!dayKey) return;
	if (range !== "day") {
		drillReturnState = { range, anchorDay };
	}
	range = "day";
	anchorDay = dayKey;
}

function exitDrillDown() {
	if (!drillReturnState) return;
	range = drillReturnState.range;
	anchorDay = drillReturnState.anchorDay;
	drillReturnState = null;
}

function resolveSiteColor(
	siteKey: string,
	siteName: string,
	serverColor = "",
): string {
	if (serverColor) return serverColor;
	const matched = interconnectSites.find(
		(s) =>
			s.name === siteName ||
			s.chatName === siteName ||
			s.badge === siteName ||
			s.name === siteKey ||
			(siteKey === "local" && s.isSelf),
	);
	if (matched?.color) return matched.color;
	if (siteKey === "local") return "var(--skin-accent)";
	return "";
}

const enrichedSites = $derived.by<ChatStatsSiteItem[]>(() => {
	const list = (stats?.siteDistribution || []).map((s) => ({
		...s,
		color: resolveSiteColor(s.siteKey, s.siteName, s.color),
	}));
	const findConfigIndex = (site: ChatStatsSiteItem): number => {
		return interconnectSites.findIndex(
			(cfg) =>
				(site.siteKey === "local" && cfg.isSelf) ||
				cfg.name === site.siteName ||
				cfg.chatName === site.siteName ||
				cfg.badge === site.siteName ||
				cfg.name === site.siteKey,
		);
	};
	return list.sort((a, b) => {
		const idxA = findConfigIndex(a);
		const idxB = findConfigIndex(b);
		if (idxA >= 0 && idxB >= 0) return idxA - idxB;
		if (idxA >= 0) return -1;
		if (idxB >= 0) return 1;
		const aUnnamed = !a.siteName || a.siteName === "外部站点";
		const bUnnamed = !b.siteName || b.siteName === "外部站点";
		if (aUnnamed !== bUnnamed) return aUnnamed ? 1 : -1;
		return b.messages - a.messages;
	});
});

let rememberedSites = $state<Record<string, ChatStatsSiteItem>>({});

$effect(() => {
	const current = enrichedSites;
	if (current.length === 0) return;
	let changed = false;
	const next = { ...rememberedSites };
	for (const s of current) {
		if (
			!next[s.siteKey] ||
			next[s.siteKey].siteName !== s.siteName ||
			next[s.siteKey].color !== s.color
		) {
			next[s.siteKey] = { ...s, messages: 0, activeUsers: 0, sharePct: 0 };
			changed = true;
		}
	}
	if (changed) rememberedSites = next;
});

const dropdownSites = $derived.by<ChatStatsSiteItem[]>(() => {
	const byKey = new Map<string, ChatStatsSiteItem>();
	const matchCfgIdx = (site: ChatStatsSiteItem): number =>
		interconnectSites.findIndex(
			(cfg) =>
				(site.siteKey === "local" && cfg.isSelf) ||
				cfg.name === site.siteName ||
				cfg.chatName === site.siteName ||
				cfg.badge === site.siteName ||
				cfg.name === site.siteKey,
		);

	for (const s of enrichedSites) {
		byKey.set(s.siteKey, s);
	}
	for (const cfg of interconnectSites) {
		const key = cfg.isSelf ? "local" : cfg.name;
		const existing = [...byKey.values()].find(
			(s) =>
				(s.siteKey === "local" && cfg.isSelf) ||
				s.siteName === cfg.name ||
				s.siteName === cfg.chatName ||
				s.siteName === cfg.badge ||
				s.siteKey === cfg.name,
		);
		if (!existing && key) {
			byKey.set(key, {
				siteKey: key,
				siteName: cfg.chatName || cfg.badge || cfg.name,
				color: cfg.color || (cfg.isSelf ? "var(--skin-accent)" : ""),
				messages: 0,
				activeUsers: 0,
				sharePct: 0,
			});
		}
	}
	for (const [k, s] of Object.entries(rememberedSites)) {
		if (!byKey.has(k)) {
			byKey.set(k, { ...s, messages: 0, activeUsers: 0, sharePct: 0 });
		}
	}

	return [...byKey.values()].sort((a, b) => {
		const idxA = matchCfgIdx(a);
		const idxB = matchCfgIdx(b);
		if (idxA >= 0 && idxB >= 0) return idxA - idxB;
		if (idxA >= 0) return -1;
		if (idxB >= 0) return 1;
		const aUnnamed = !a.siteName || a.siteName === "外部站点";
		const bUnnamed = !b.siteName || b.siteName === "外部站点";
		if (aUnnamed !== bUnnamed) return aUnnamed ? 1 : -1;
		return b.messages - a.messages;
	});
});

const sortedLeaderboard = $derived.by(() => {
	const list = [...(stats?.leaderboards || [])];
	const key = leaderboardSort;
	const sorted = list
		.filter((u) => (u[key] || 0) > 0 || key === "messages")
		.sort((a, b) => (b[key] || 0) - (a[key] || 0) || b.messages - a.messages);
	return showAllMembers ? sorted : sorted.slice(0, 10);
});

const totalLeaderboardCount = $derived.by(() => {
	const list = stats?.leaderboards || [];
	const key = leaderboardSort;
	return list.filter((u) => (u[key] || 0) > 0 || key === "messages").length;
});

const maxLeaderboardVal = $derived(
	Math.max(1, sortedLeaderboard[0]?.[leaderboardSort] ?? 1),
);

const leaderboardByUserKey = $derived.by(() => {
	const map = new Map<string, ChatStatsUserRow>();
	for (const row of stats?.leaderboards || []) {
		map.set(row.userKey, row);
	}
	return map;
});

function resolveMvpBadge(
	mvp: NonNullable<ChatStatsResponse["highlights"]["talkKing"]>,
): {
	label: string;
	tone: string;
	color?: string;
} | null {
	const row = leaderboardByUserKey.get(mvp.userKey);
	const customList =
		mvp.customBadges && mvp.customBadges.length > 0
			? mvp.customBadges
			: row?.customBadges;
	const custom = customList?.[0];
	const siteColor =
		mvp.siteColor ||
		row?.siteColor ||
		resolveSiteColor(row?.siteKey || "", mvp.siteName || row?.siteName || "");
	if (custom?.text) {
		return {
			label: custom.text,
			tone: custom.color || "accent",
			color: siteColor,
		};
	}
	const isAdmin = Boolean(mvp.isAdmin ?? row?.isAdmin);
	const rawBadge = (mvp.badge || row?.badge || "").trim();
	if (isAdmin || rawBadge === "站长") {
		return { label: "站长", tone: "gold" };
	}
	if (
		rawBadge &&
		rawBadge !== "互联茶友" &&
		rawBadge !== "访客" &&
		rawBadge !== "茶友"
	) {
		const tone =
			row?.badgeType && row.badgeType !== "tag" ? row.badgeType : "accent";
		return { label: rawBadge, tone };
	}
	return null;
}

const selectedSiteMeta = $derived.by(() => {
	if (selectedSite === "all") return null;
	return dropdownSites.find((s) => s.siteKey === selectedSite) ?? null;
});

const visibleStickers = $derived.by(() => {
	const list = stats?.topStickers || [];
	return list.slice(stickerOffset, stickerOffset + stickerCols);
});

const maxStickerOffset = $derived(
	Math.max(0, (stats?.topStickers?.length ?? 0) - stickerCols),
);

const stickerPageStep = $derived(Math.max(1, Math.ceil(stickerCols * 0.7)));
const maxExprOffsetPx = $derived(
	Math.max(0, exprTrackWidth - exprViewportWidth),
);
const exprPageStepPx = $derived(
	Math.max(140, Math.round(exprViewportWidth * 0.7)),
);

const headerPeriodText = $derived.by(() => {
	if (!stats) return "数据概览";
	const dr = stats.dateRange;
	const roomTitle =
		room === "interconnect"
			? "#互联茶室"
			: room === "chat"
				? "#闲聊"
				: "全站双房间";
	if (range === "day") {
		return `${roomTitle} · ${dr.startDay}`;
	}
	return `${roomTitle} · ${dr.startDay} ~ ${dr.endDay} (${dr.daysCount}天)`;
});

function handleClickUser(user: {
	userKey: string;
	name: string;
	avatar?: string;
	badge?: string;
	siteName?: string;
	isAdmin?: boolean;
}) {
	if (!onOpenUserProfile || !user.userKey) return;
	const isExt =
		user.userKey.startsWith("matrix:") || user.userKey.startsWith("@");
	const origin = isExt
		? resolveExternalOrigin(
				{ name: user.name, userKey: user.userKey, site: user.siteName },
				interconnectSites,
			)
		: null;
	onOpenUserProfile({
		userKey: user.userKey,
		name: origin?.cleanName || user.name,
		avatar: user.avatar || "",
		badge: user.badge || "",
		site: origin?.siteName || user.siteName,
		siteUrl: origin?.siteUrl,
		isAdmin: user.isAdmin,
		authType: user.userKey.startsWith("waline:")
			? "waline"
			: user.userKey.startsWith("guest:")
				? "guest"
				: undefined,
	});
}

function formatClock(ts?: number): string {
	if (!ts) return "";
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function resolveUserSiteBadge(u: ChatStatsUserRow): {
	label: string;
	color: string;
} {
	const color = resolveSiteColor(u.siteKey, u.siteName, u.siteColor);
	return {
		label: u.siteName || (u.isAdmin ? "站长" : u.badge || "成员"),
		color,
	};
}

function getLeaderboardSortUnit(sort: LeaderboardSort): string {
	switch (sort) {
		case "messages":
			return "条";
		case "chars":
			return "字";
		case "images":
			return "图";
		case "stickers":
			return "表情";
		case "musicRequests":
			return "首";
		case "interactionScore":
			return "互动";
	}
}

function getMobileSecondaryMetrics(
	u: ChatStatsUserRow,
	sort: LeaderboardSort,
): string[] {
	const items: string[] = [];
	if (sort !== "messages") items.push(`${formatStatNumber(u.messages)}条`);
	if (sort !== "chars") items.push(`${formatStatNumber(u.chars)}字`);
	else items.push(`均${u.avgChars}字`);
	if (sort !== "images" && u.images > 0) items.push(`${u.images}图`);
	if (sort !== "stickers" && u.stickers > 0) items.push(`${u.stickers}表情`);
	if (sort !== "musicRequests" && u.musicRequests > 0)
		items.push(`${u.musicRequests}点歌`);
	if (sort !== "interactionScore" && u.interactionScore > 0)
		items.push(`互动${u.interactionScore}`);
	return items;
}

function resolveStickerUrl(
	key: string,
	label: string,
	previewUrl = "",
): string {
	if (key.startsWith("sticker:")) {
		const parts = key.split(":");
		const pack = parts[1] || "";
		const item = parts.slice(2).join(":");
		const fromMap =
			stickerMap?.get(`:${pack}_${item}:`) ||
			stickerMap?.get(`:${item}:`) ||
			stickerMap?.get(`:${label}:`);
		if (fromMap?.url) return fromMap.url;
	}
	if (previewUrl) return previewUrl;
	const fromMap = stickerMap?.get(`:${label}:`) || stickerMap?.get(key);
	return fromMap?.url || "";
}
</script>

<div class="chat-stats-workspace relative flex-1 min-h-0 flex flex-col overflow-hidden" data-stats-layout={layoutMode}>
  <!-- 顶部工作台标题栏（嵌入中栏时显示；浮窗模式由 ChatModal 提供外框标题） -->
  {#if layoutMode !== "modal"}
    <header class="chat-panel-header shrink-0 px-4 sm:px-5">
      <div class="flex items-center gap-2.5 min-w-0 flex-1">
        {#if showBackButton && onBackToChat}
          <button
            type="button"
            class="chat-stats-back-btn shrink-0 {unreadChatCount > 0 ? 'has-unread' : ''}"
            onclick={onBackToChat}
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
            <span>返回聊天</span>
            {#if unreadChatCount > 0}
              <span class="chat-stats-back-badge">{unreadChatCount > 99 ? "99+" : unreadChatCount}</span>
            {/if}
          </button>
        {/if}
        <div class="min-w-0 flex items-center gap-2 flex-wrap">
          <h2 class="text-sm font-bold text-[var(--deep-text)] dark:text-white/95 m-0 truncate">
            茶室数据看板
          </h2>
          <span class="text-xs text-[var(--chat-meta-color)] truncate hidden sm:inline">
            {headerPeriodText}
          </span>
        </div>
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          class="chat-tool-btn w-7! h-7! rounded-lg! shrink-0"
          aria-label="刷新统计数据"
          disabled={isLoading}
          onclick={() => void loadStats(true)}
        >
          <svg class="w-3.5 h-3.5 {isLoading ? 'animate-spin text-[var(--skin-accent)]' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
        </button>

        {#if onChangeLayoutMode}
          <div class="hidden lg:inline-flex chat-stats-segmented" role="group" aria-label="切换展示形态">
            <button
              type="button"
              class="chat-stats-seg-btn is-active"
              onclick={() => onChangeLayoutMode("center")}
            >
              中栏视图
            </button>
            <button
              type="button"
              class="chat-stats-seg-btn"
              onclick={() => onChangeLayoutMode("modal")}
            >
              悬浮弹窗
            </button>
          </div>
        {/if}
      </div>
    </header>
  {/if}

  <!-- 单一主垂直滚动流：移动端筛选条随页面滚动释放可视空间，桌面端吸顶固定 -->
  <div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
    <!-- 筛选与快捷日期条 -->
    <div class="md:sticky md:top-0 md:z-20 px-4 sm:px-6 py-2.5 border-b border-[var(--chat-divider-color)]/80 bg-[var(--skin-surface)]/92 md:backdrop-blur-md flex flex-col md:flex-row md:flex-wrap md:items-center md:justify-between gap-2">
      <div class="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 w-full md:w-auto">
        <div class="flex items-center justify-between gap-2 w-full sm:w-auto">
          <div class="chat-stats-segmented shrink-0" role="tablist" aria-label="统计房间范围">
            {#each ROOM_OPTIONS as opt (opt.id)}
              <button
                type="button"
                role="tab"
                aria-selected={room === opt.id}
                class="chat-stats-seg-btn {room === opt.id ? 'is-active' : ''}"
                onclick={() => {
                  room = opt.id;
                  if (opt.id === "chat") selectedSite = "all";
                }}
              >
                {opt.label}
              </button>
            {/each}
          </div>

          {#if room !== "chat" && dropdownSites.length > 1}
            <div bind:this={siteDropdownEl} class="chat-stats-site-dropdown relative sm:order-3">
              <button
                type="button"
                class="chat-stats-site-dropdown-btn {selectedSite !== 'all' ? 'is-filtered' : ''}"
                aria-haspopup="listbox"
                aria-expanded={siteDropdownOpen}
                onclick={() => (siteDropdownOpen = !siteDropdownOpen)}
              >
                <span
                  class="w-2 h-2 rounded-sm shrink-0"
                  style="background: {selectedSiteMeta?.color || 'var(--skin-accent)'};"
                  aria-hidden="true"
                ></span>
                <span class="truncate max-w-[96px] sm:max-w-[112px]">
                  {selectedSiteMeta ? selectedSiteMeta.siteName : `全部 (${dropdownSites.length})`}
                </span>
                <svg class="w-3.5 h-3.5 opacity-65 shrink-0 transition-transform duration-150 {siteDropdownOpen ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>

              {#if siteDropdownOpen}
                <div class="chat-stats-site-dropdown-menu" role="listbox" aria-label="选择茶室站点">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selectedSite === "all"}
                    class="chat-stats-site-dropdown-item {selectedSite === 'all' ? 'is-active' : ''}"
                    onclick={() => {
                      selectedSite = "all";
                      siteDropdownOpen = false;
                    }}
                  >
                    <span class="flex items-center gap-2 min-w-0">
                      <span class="w-2 h-2 rounded-sm shrink-0 bg-[var(--skin-accent)]" aria-hidden="true"></span>
                      <span class="truncate">全部茶室</span>
                    </span>
                    <span class="text-xs sm:text-[10.5px] font-mono opacity-70 tabular-nums shrink-0">{dropdownSites.length} 站</span>
                  </button>
                  {#each dropdownSites as s (s.siteKey)}
                    <button
                      type="button"
                      role="option"
                      aria-selected={selectedSite === s.siteKey}
                      class="chat-stats-site-dropdown-item {selectedSite === s.siteKey ? 'is-active' : ''}"
                      onclick={() => {
                        selectedSite = s.siteKey;
                        siteDropdownOpen = false;
                      }}
                    >
                      <span class="flex items-center gap-2 min-w-0">
                        <span class="w-2 h-2 rounded-sm shrink-0" style="background: {s.color || 'var(--skin-accent)'};" aria-hidden="true"></span>
                        <span class="truncate">{s.siteName}</span>
                      </span>
                      <span class="text-xs sm:text-[10.5px] font-mono opacity-70 tabular-nums shrink-0">{s.activeUsers}人</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <div class="chat-stats-segmented chat-stats-segmented--range w-full sm:w-auto" role="tablist" aria-label="统计时间周期">
          {#each RANGE_OPTIONS as opt (opt.id)}
            <button
              type="button"
              role="tab"
              aria-selected={range === opt.id}
              class="chat-stats-seg-btn flex-1 sm:flex-initial text-center {range === opt.id ? 'is-active' : ''}"
              onpointerenter={() => prefetchRange(opt.id)}
              onclick={() => selectRange(opt.id)}
            >
              {opt.label}
            </button>
          {/each}
        </div>
      </div>

      {#if drillReturnState || range !== "all" || (layoutMode === "modal" && onChangeLayoutMode)}
        <div class="flex items-center justify-between sm:justify-start gap-1.5 flex-wrap">
          {#if drillReturnState}
            <button
              type="button"
              class="px-2.5 py-1 text-xs sm:text-[11px] font-semibold rounded-lg bg-[var(--skin-accent-soft)] text-[var(--skin-accent)] border-none cursor-pointer hover:opacity-90"
              onclick={exitDrillDown}
            >
              ← 返回周期
            </button>
          {/if}

          {#if range === "day"}
            <div class="hidden xl:inline-flex items-center gap-1">
              {#each quickDatePills as qp (qp.dayKey)}
                <button
                  type="button"
                  class="chat-stats-mini-tab {anchorDay === qp.dayKey ? 'is-active' : ''}"
                  onclick={() => {
                    drillReturnState = null;
                    anchorDay = qp.dayKey;
                  }}
                >
                  {qp.label}
                </button>
              {/each}
            </div>
          {/if}

          {#if range !== "all"}
            <div class="inline-flex items-center flex-1 sm:flex-initial justify-between sm:justify-start rounded-lg border border-[var(--skin-line)] bg-[var(--skin-surface)] p-0.5">
              <button
                type="button"
                class="w-7 h-7 sm:w-6 sm:h-6 rounded-md flex items-center justify-center text-[var(--chat-meta-color)] hover:text-[var(--deep-text)] hover:bg-black/5 dark:hover:bg-white/8 border-none bg-transparent cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="前一天"
                disabled={!canStepPrev}
                onclick={() => stepDay(-1)}
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
              </button>
              <input
                type="date"
                bind:value={anchorDay}
                min={minDayKey || undefined}
                max={maxDayKey}
                aria-label="选择日期"
                class="bg-transparent border-none text-[13px] sm:text-[11.5px] font-mono font-semibold text-[var(--deep-text)] dark:text-white/90 px-1.5 py-0.5 outline-none cursor-pointer tabular-nums"
                onchange={() => {
                  drillReturnState = null;
                }}
              />
              <button
                type="button"
                class="w-7 h-7 sm:w-6 sm:h-6 rounded-md flex items-center justify-center text-[var(--chat-meta-color)] hover:text-[var(--deep-text)] hover:bg-black/5 dark:hover:bg-white/8 border-none bg-transparent cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                aria-label="后一天"
                disabled={!canStepNext}
                onclick={() => stepDay(1)}
              >
                <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
              </button>
            </div>
          {/if}

          {#if range === "day" && anchorDay !== maxDayKey}
            <button
              type="button"
              class="xl:hidden chat-stats-mini-tab"
              onclick={() => {
                drillReturnState = null;
                anchorDay = maxDayKey;
              }}
            >
              回到今天
            </button>
          {/if}

          {#if layoutMode === "modal" && onChangeLayoutMode}
            <button
              type="button"
              class="hidden lg:inline-flex chat-stats-mini-tab ml-1"
              onclick={() => onChangeLayoutMode("center")}
            >
              嵌入中栏
            </button>
          {/if}
        </div>
      {/if}
    </div>

    <div class="mx-auto w-full max-w-6xl px-4 sm:px-6 py-4 sm:py-5 space-y-5 sm:space-y-6 transition-opacity duration-200 {isLoading && stats ? 'opacity-50' : 'opacity-100'}">
      {#if errorMessage && stats}
        <div class="flex items-center justify-between gap-2 px-3.5 py-2 rounded-xl bg-rose-500/10 border border-rose-500/25 text-xs text-rose-600 dark:text-rose-400">
          <span class="truncate">{errorMessage}</span>
          <button
            type="button"
            class="shrink-0 font-semibold underline border-none bg-transparent text-inherit cursor-pointer p-0"
            onclick={() => void loadStats(true)}
          >
            重试
          </button>
        </div>
      {/if}
      {#if errorMessage && !stats}
        <div class="p-10 rounded-2xl bg-[var(--skin-rail)] text-center space-y-3">
          <p class="m-0 text-sm font-semibold text-[var(--deep-text)] dark:text-white/90">{errorMessage}</p>
          <button
            type="button"
            class="chat-send-btn px-4! py-1.5! h-auto! rounded-xl! text-xs! font-semibold cursor-pointer"
            onclick={() => void loadStats(true)}
          >
            重试加载
          </button>
        </div>
      {:else if !stats}
        <div class="space-y-6 animate-pulse" aria-busy="true">
          <div class="h-16 rounded-2xl bg-[var(--skin-rail)]"></div>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            {#each [1, 2, 3, 4] as i (i)}
              <div class="h-28 rounded-2xl bg-[var(--skin-rail)]"></div>
            {/each}
          </div>
          <div class="h-44 rounded-2xl bg-[var(--skin-rail)]"></div>
        </div>
      {:else}
        {@const prev = stats.previousSummary}
        {@const kpiItems = [
          { label: "发言消息", value: displayKpis.messages, raw: stats.summary.messages, prev: prev?.messages, mobileOnly: false },
          { label: "活跃茶友", value: displayKpis.activeUsers, raw: stats.summary.activeUsers, prev: prev?.activeUsers, mobileOnly: false },
          { label: "有效字数", value: displayKpis.chars, raw: stats.summary.chars, prev: prev?.chars, mobileOnly: true },
          { label: "表情贴纸", value: displayKpis.stickers, raw: stats.summary.stickers, prev: prev?.stickers, mobileOnly: false },
          { label: "晒图数量", value: displayKpis.images, raw: stats.summary.images, prev: prev?.images, mobileOnly: false },
          { label: "电台点歌", value: displayKpis.musicRequests, raw: stats.summary.musicRequests, prev: prev?.musicRequests, mobileOnly: false },
        ]}

        <!-- 1. 轻量化数字概览带（移动端整齐 2×3 均等网格，桌面端 5 列横向概览带） -->
        <section class="chat-stats-kpi-strip">
          <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-y-4 gap-x-4 sm:gap-x-6">
            {#each kpiItems as item (item.label)}
              {@const delta = formatDeltaBadge(item.raw, item.prev)}
              <div class="min-w-0 {item.mobileOnly ? 'sm:hidden' : ''}">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="text-[13px] sm:text-xs font-medium text-[var(--chat-meta-color)] truncate">{item.label}</span>
                  {#if delta}
                    <span class="chat-stats-delta is-{delta.direction} shrink-0">{delta.text}</span>
                  {/if}
                </div>
                <div class="text-[24px] sm:text-[26px] font-extrabold text-[var(--deep-text)] dark:text-white/95 tabular-nums tracking-tight mt-1 sm:mt-0.5 leading-none">
                  {formatStatNumber(item.value)}
                </div>
              </div>
            {/each}
          </div>

          <div class="grid grid-cols-2 sm:flex sm:flex-wrap sm:items-center gap-x-4 gap-y-2 text-[13px] sm:text-xs text-[var(--chat-meta-color)] tabular-nums mt-4 pt-3 border-t border-[var(--skin-line)]/60">
            <span class="hidden sm:inline">有效输出 <strong class="text-[var(--deep-text)] dark:text-white/90">{formatStatNumber(stats.summary.chars)}</strong> 字</span>
            <span>回复互动 <strong class="text-[var(--deep-text)] dark:text-white/90">{formatStatNumber(stats.summary.replies)}</strong> 次</span>
            <span>消息回应 <strong class="text-[var(--deep-text)] dark:text-white/90">{formatStatNumber(stats.summary.reactions)}</strong> 次</span>
            <span>分享卡片 <strong class="text-[var(--deep-text)] dark:text-white/90">{formatStatNumber(stats.summary.shares)}</strong> 张</span>
            {#if stats.summary.musicRotations > 0}
              <span>歌单轮播 <strong class="text-[var(--deep-text)] dark:text-white/90">{formatStatNumber(stats.summary.musicRotations)}</strong> 首</span>
            {/if}
          </div>
        </section>

        <!-- 2. 首屏主角舞台：今日话痨、晒图王、表情王、点歌王 -->
        {@const mvpDefs = [
          { id: "talk", title: "话痨王", icon: "🗣️", unit: "条消息", sub: (m: NonNullable<typeof stats.highlights.talkKing>) => `输出 ${formatStatNumber(m.chars)} 字`, data: stats.highlights.talkKing, tint: "var(--skin-accent)" },
          { id: "image", title: "晒图王", icon: "🖼️", unit: "张图片", sub: (m: NonNullable<typeof stats.highlights.imageKing>) => `共发言 ${m.messages} 条`, data: stats.highlights.imageKing, tint: "var(--chat-stats-c3)" },
          { id: "sticker", title: "表情王", icon: "✨", unit: "个表情", sub: (m: NonNullable<typeof stats.highlights.stickerKing>) => `占全站 ${stats.summary.stickers > 0 ? Math.round((m.stickers / stats.summary.stickers) * 100) : 0}%`, data: stats.highlights.stickerKing, tint: "var(--chat-stats-c2)" },
          { id: "music", title: "点歌王", icon: "🎵", unit: "首点播", sub: () => "点歌最多", data: stats.highlights.musicKing, tint: "var(--chat-stats-c4)" },
        ]}
        <section class="space-y-3">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <h3 class="text-sm sm:text-xs font-bold uppercase tracking-wider text-[var(--chat-meta-color)] m-0">
              {range === "day" ? "当日之最" : "周期之最"}
            </h3>
            {#if stats.highlights.morningFirst || stats.highlights.nightOwl}
              <div class="flex items-center gap-2 flex-wrap">
                {#if stats.highlights.morningFirst}
                  <button
                    type="button"
                    class="chat-stats-fun-pill"
                    onclick={() => stats?.highlights.morningFirst && handleClickUser(stats.highlights.morningFirst)}
                  >
                    <span>🌅</span>
                    <span>早安:</span>
                    <strong class="text-[var(--deep-text)] dark:text-white/90 truncate max-w-[110px]">{stats.highlights.morningFirst.name}</strong>
                    <span class="font-mono opacity-75">{formatClock(stats.highlights.morningFirst.createdAt)}</span>
                  </button>
                {/if}
                {#if stats.highlights.nightOwl}
                  <button
                    type="button"
                    class="chat-stats-fun-pill"
                    onclick={() => stats?.highlights.nightOwl && handleClickUser(stats.highlights.nightOwl)}
                  >
                    <span>🌙</span>
                    <span>夜猫:</span>
                    <strong class="text-[var(--deep-text)] dark:text-white/90 truncate max-w-[110px]">{stats.highlights.nightOwl.name}</strong>
                    <span class="font-mono opacity-75">凌晨{stats.highlights.nightOwl.count}条</span>
                  </button>
                {/if}
              </div>
            {/if}
          </div>

          <div class="chat-stats-mvp-grid">
            {#each mvpDefs as mvp, idx (mvp.id)}
              {@const mvpBadge = mvp.data ? resolveMvpBadge(mvp.data) : null}
              <div class="chat-stats-spotlight-card" style="--stagger: {idx}; --mvp-tint: {mvp.tint};">
                <div class="flex items-center justify-between gap-1.5 mb-2 sm:mb-2.5 min-w-0">
                  <div class="text-[13px] sm:text-[11px] font-bold text-[var(--chat-meta-color)] flex items-center gap-1 shrink-0">
                    <span>{mvp.icon}</span>
                    <span>{mvp.title}</span>
                  </div>
                  {#if mvpBadge}
                    <span
                      class="chat-role-badge chat-role-badge--{mvpBadge.tone} text-[11px]! sm:text-[10px]! px-1.5! py-0! leading-4 truncate max-w-[74px] sm:max-w-[96px]"
                      style={mvpBadge.tone === "site" && mvpBadge.color ? `--site-badge-color: ${mvpBadge.color};` : undefined}
                    >
                      {mvpBadge.label}
                    </span>
                  {/if}
                </div>
                {#if mvp.data}
                  <button
                    type="button"
                    class="w-full flex items-center gap-2 sm:gap-2.5 text-left border-none bg-transparent p-0 cursor-pointer group"
                    onclick={() => mvp.data && handleClickUser(mvp.data)}
                  >
                    <ChatAvatar src={mvp.data.avatar} name={mvp.data.name} size="sm" ring />
                    <div class="min-w-0 flex-1">
                      <div class="text-[13.5px] sm:text-xs font-bold text-[var(--deep-text)] dark:text-white/95 truncate group-hover:text-[var(--skin-accent)] transition-colors">
                        {mvp.data.name}
                      </div>
                      <div class="flex items-baseline gap-1 flex-wrap text-base sm:text-sm font-extrabold font-mono tabular-nums mt-0.5 leading-tight" style="color: var(--mvp-tint);">
                        <span>{formatStatNumber(mvp.data.value)}</span>
                        <span class="text-xs sm:text-[10.5px] font-sans font-normal text-[var(--chat-meta-color)]">{mvp.unit}</span>
                      </div>
                      <div class="text-xs sm:text-[10.5px] text-[var(--chat-meta-color)] truncate mt-0.5">
                        {mvp.sub(mvp.data)}
                      </div>
                    </div>
                  </button>
                {:else}
                  <div class="py-3 text-[13px] sm:text-xs text-[var(--chat-meta-color)] opacity-70">暂无上榜</div>
                {/if}
              </div>
            {/each}
          </div>
        </section>

        <!-- 3. 热门表情墙（手机端直接横向滑动，桌面端左右翻页）+ 回应 & Emoji 流 -->
        <section class="space-y-3">
          <div class="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
            <h3 class="text-sm sm:text-xs font-bold uppercase tracking-wider text-[var(--chat-meta-color)] m-0">
              热门表情墙
            </h3>
            <span class="text-xs sm:text-[11px] text-[var(--chat-meta-color)] tabular-nums">
              贴纸 {stats.topStickers.length} · 回应 {stats.topReactions.length} · Emoji {stats.topTextEmojis.length}
            </span>
          </div>

          {#snippet stickerTile(st: (typeof stats.topStickers)[number], rank: number)}
            {@const imgUrl = resolveStickerUrl(st.key, st.label, st.previewUrl)}
            <div class="chat-stats-sticker-tile {rank === 0 ? 'is-crown' : ''} {isMobileWall ? 'is-mobile-scroll-tile' : ''}">
              <div class="flex items-center justify-between w-full text-xs sm:text-[10px] font-mono">
                <span class={rank === 0 ? "text-amber-500 font-bold" : "text-[var(--chat-meta-color)]"}>
                  #{rank + 1}
                </span>
                <span class="font-bold text-[var(--skin-accent)] tabular-nums">{st.count}次</span>
              </div>

              <div class="w-12 h-12 rounded-xl bg-[var(--skin-surface)] flex items-center justify-center overflow-hidden p-1 my-1.5">
                {#if st.kind === "lottie" && st.lottieKey}
                  <LottieSticker name={st.lottieKey} alt={st.label} className="w-10 h-10" chatServerUrl={chatServerUrl} />
                {:else if imgUrl && !failedStickerKeys[st.key]}
                  <img
                    src={imgUrl}
                    alt={st.label}
                    class="w-full h-full object-contain block"
                    loading="lazy"
                    onerror={() => {
                      failedStickerKeys = { ...failedStickerKeys, [st.key]: true };
                    }}
                  />
                {:else}
                  <span class="text-xs sm:text-[10px] font-semibold text-[var(--chat-meta-color)] text-center line-clamp-2">{st.label}</span>
                {/if}
              </div>

              <div class="text-xs sm:text-[11px] font-semibold text-[var(--deep-text)] dark:text-white/95 truncate w-full text-center">
                {st.label}
              </div>
              {#if st.topUser}
                <button
                  type="button"
                  class="mt-1 inline-flex items-center gap-1 text-xs sm:text-[10px] text-[var(--chat-meta-color)] hover:text-[var(--skin-accent)] border-none bg-transparent p-0 cursor-pointer max-w-full"
                  onclick={() => st.topUser && handleClickUser(st.topUser)}
                >
                  <ChatAvatar src={st.topUser.avatar} name={st.topUser.name} size="2xs" />
                  <span class="truncate">{st.topUser.name}</span>
                </button>
              {/if}
            </div>
          {/snippet}

          {#if stats.topStickers.length > 0}
            {#if isMobileWall}
              <div class="chat-stats-sticker-scroll-row" role="region" aria-label="热门贴纸横向滚动列表">
                {#each stats.topStickers as st, idx (st.key)}
                  {@render stickerTile(st, idx)}
                {/each}
              </div>
            {:else}
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="chat-stats-sticker-nav-btn"
                  aria-label="上一页热门表情"
                  disabled={stickerOffset <= 0}
                  onclick={() => (stickerOffset = Math.max(0, stickerOffset - stickerPageStep))}
                >
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>

                <div bind:this={stickerViewportEl} class="flex-1 min-w-0 overflow-hidden">
                  <div
                    class="chat-stats-sticker-grid"
                    style="grid-template-columns: repeat({stickerCols}, minmax(0, 1fr));"
                  >
                    {#each visibleStickers as st, idx (st.key)}
                      {@render stickerTile(st, stickerOffset + idx)}
                    {/each}
                  </div>
                </div>

                <button
                  type="button"
                  class="chat-stats-sticker-nav-btn"
                  aria-label="下一页热门表情"
                  disabled={stickerOffset >= maxStickerOffset}
                  onclick={() => (stickerOffset = Math.min(maxStickerOffset, stickerOffset + stickerPageStep))}
                >
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              </div>
            {/if}
          {:else}
            <div class="py-4 text-[13px] sm:text-xs text-[var(--chat-meta-color)]">该时间段暂无贴纸发送记录</div>
          {/if}

          <!-- 活跃表情回应 + 文本 Emoji：手机端直接横向滚动，桌面端左右翻页 -->
          {#snippet reactionEmojiChips()}
            {#each stats.topReactions.slice(0, 30) as rc (rc.key)}
              {@const disp = resolveReactionDisplay(rc.key, chatServerUrl, stickerMap)}
              <span class="chat-stats-expr-chip shrink-0" title={rc.topUser ? `回应 ${rc.count} 次 · 最爱：${rc.topUser.name}` : `回应 ${rc.count} 次`}>
                {#if disp.type === "image" && disp.url}
                  <img src={disp.url} alt={disp.alt} class="w-4.5 h-4.5 sm:w-4 sm:h-4 object-contain rounded-xs" loading="lazy" />
                {:else}
                  <span class="text-base sm:text-sm leading-none">{disp.text}</span>
                {/if}
                <span class="font-mono text-[13px] sm:text-[11px] font-semibold text-[var(--deep-text)] dark:text-white/90 tabular-nums">{rc.count}</span>
                <span class="text-[11.5px] sm:text-[9.5px] text-[var(--chat-meta-color)]">回应</span>
              </span>
            {/each}

            {#each stats.topTextEmojis.slice(0, 30) as em (em.key)}
              <span class="chat-stats-expr-chip shrink-0" title={em.topUser ? `发送 ${em.count} 次 · 最多：${em.topUser.name}` : `发送 ${em.count} 次`}>
                <span class="text-base sm:text-sm leading-none">{em.key}</span>
                <span class="font-mono text-[13px] sm:text-[11px] font-semibold text-[var(--deep-text)] dark:text-white/90 tabular-nums">{em.count}</span>
              </span>
            {/each}
          {/snippet}

          {#if stats.topReactions.length > 0 || stats.topTextEmojis.length > 0}
            {#if isMobileWall}
              <div class="chat-stats-expr-scroll-row pt-0.5" role="region" aria-label="活跃表情回应与 Emoji 横向滚动列表">
                {@render reactionEmojiChips()}
              </div>
            {:else}
              <div class="flex items-center gap-2 pt-0.5">
                <button
                  type="button"
                  class="chat-stats-sticker-nav-btn h-7! w-7!"
                  aria-label="上一页活跃表情回应"
                  disabled={exprOffsetPx <= 0}
                  onclick={() => (exprOffsetPx = Math.max(0, exprOffsetPx - exprPageStepPx))}
                >
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>

                <div bind:this={exprViewportEl} class="flex-1 min-w-0 overflow-hidden">
                  <div
                    bind:this={exprTrackEl}
                    class="inline-flex flex-nowrap items-center gap-1.5 transition-transform duration-200 ease-out"
                    style="transform: translate3d(-{Math.min(exprOffsetPx, maxExprOffsetPx)}px, 0, 0);"
                  >
                    {@render reactionEmojiChips()}
                  </div>
                </div>

                <button
                  type="button"
                  class="chat-stats-sticker-nav-btn h-7! w-7!"
                  aria-label="下一页活跃表情回应"
                  disabled={exprOffsetPx >= maxExprOffsetPx}
                  onclick={() => (exprOffsetPx = Math.min(maxExprOffsetPx, exprOffsetPx + exprPageStepPx))}
                >
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              </div>
            {/if}
          {/if}
        </section>

        <!-- 4. 全维度活跃成员排行（移动端排序胶囊 + 双行易读行卡片；桌面端 6 列排序表） -->
        <section class="space-y-2.5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-sm sm:text-xs font-bold uppercase tracking-wider text-[var(--chat-meta-color)] m-0">
              活跃成员排行<span class="hidden sm:inline">（点击列名排序）</span>
            </h3>
            <span class="text-xs sm:text-[11px] text-[var(--chat-meta-color)] tabular-nums">
              共 {totalLeaderboardCount} 位活跃成员
            </span>
          </div>

          {#if sortedLeaderboard.length === 0}
            <div class="py-8 text-center text-[13px] sm:text-xs text-[var(--chat-meta-color)] rounded-2xl bg-[var(--skin-rail)]">
              当前时间段暂无活跃发言记录
            </div>
          {:else}
            <div class="chat-stats-table-wrap">
              <!-- 移动端全维度排序胶囊条 -->
              <div class="chat-stats-mobile-sort-bar sm:hidden" role="tablist" aria-label="排行榜排序维度">
                {#each SORT_COLUMNS as col (col.id)}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={leaderboardSort === col.id}
                    class="chat-stats-mobile-sort-pill {leaderboardSort === col.id ? 'is-active' : ''}"
                    onclick={() => (leaderboardSort = col.id)}
                  >
                    <span>{col.label}</span>
                    {#if leaderboardSort === col.id}
                      <span aria-hidden="true">↓</span>
                    {/if}
                  </button>
                {/each}
              </div>

              <!-- 桌面端表头排序栏 -->
              <div class="chat-stats-table-head hidden sm:flex">
                <span class="pl-2">成员</span>
                <div class="chat-stats-table-cols">
                  {#each SORT_COLUMNS as col (col.id)}
                    <button
                      type="button"
                      class="chat-stats-sort-col {leaderboardSort === col.id ? 'is-active' : ''}"
                      onclick={() => (leaderboardSort = col.id)}
                    >
                      <span>{col.label}</span>
                      {#if leaderboardSort === col.id}
                        <span aria-hidden="true">↓</span>
                      {/if}
                    </button>
                  {/each}
                </div>
              </div>

              <!-- 行列表 -->
              <div class="space-y-1">
                {#each sortedLeaderboard as u, idx (u.userKey)}
                  {@const val = u[leaderboardSort] || 0}
                  {@const barPct = Math.max(3, Math.round((val / maxLeaderboardVal) * 100))}
                  {@const siteMeta = resolveUserSiteBadge(u)}
                  {@const mobileSubMetrics = getMobileSecondaryMetrics(u, leaderboardSort)}
                  <button
                    type="button"
                    class="chat-stats-table-row group"
                    onclick={() => handleClickUser(u)}
                  >
                    <span class="chat-stats-rank-bar" style="width: {barPct}%;" aria-hidden="true"></span>

                    <div class="relative z-1 flex items-center gap-2.5 min-w-0 flex-1">
                      <span class="w-5 text-center font-mono text-[13px] sm:text-xs font-extrabold shrink-0 {idx === 0 ? 'text-amber-500' : idx === 1 ? 'text-slate-400' : idx === 2 ? 'text-amber-700 dark:text-amber-500/80' : 'text-[var(--chat-meta-color)]'}">
                        {idx + 1}
                      </span>
                      <ChatAvatar src={u.avatar} name={u.name} size="sm" />
                      <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-1.5 min-w-0">
                          <span class="text-sm sm:text-xs font-semibold text-[var(--deep-text)] dark:text-white/95 truncate group-hover:text-[var(--skin-accent)] transition-colors">
                            {u.name}
                          </span>
                          {#if u.customBadges && u.customBadges.length > 0}
                            <span
                              class="inline-flex chat-role-badge chat-role-badge--{u.customBadges[0].color || 'accent'} text-[11px]! sm:text-[9.5px]! px-1.5! py-0! leading-4 shrink-0 truncate max-w-[78px] sm:max-w-[92px]"
                              style={u.customBadges[0].color === "site" && siteMeta.color && u.siteKey !== "local" ? `--site-badge-color: ${siteMeta.color};` : undefined}
                            >
                              {u.customBadges[0].text}
                            </span>
                          {:else if u.isAdmin}
                            <span class="inline-flex chat-role-badge chat-role-badge--gold text-[11px]! sm:text-[9.5px]! px-1.5! py-0! leading-4 shrink-0">
                              站长
                            </span>
                          {:else if siteMeta.label && siteMeta.label !== "成员"}
                            <span
                              class="inline-flex chat-role-badge {u.siteKey === 'local' ? 'chat-role-badge--accent' : 'chat-role-badge--site'} text-[11px]! sm:text-[9.5px]! px-1.5! py-0! leading-4 shrink-0 truncate max-w-[78px] sm:max-w-[92px]"
                              style={u.siteKey !== "local" && siteMeta.color ? `--site-badge-color: ${siteMeta.color};` : undefined}
                            >
                              {siteMeta.label}
                            </span>
                          {/if}
                        </div>
                        <div class="sm:hidden flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-[var(--chat-meta-color)] tabular-nums mt-0.5">
                          {#each mobileSubMetrics as metric}
                            <span>{metric}</span>
                          {/each}
                        </div>
                      </div>
                    </div>

                    <!-- 移动端右侧主排序指标 -->
                    <div class="relative z-1 sm:hidden shrink-0 text-right pl-1.5">
                      <div class="font-mono text-[15px] font-extrabold text-[var(--skin-accent)] tabular-nums leading-tight">
                        {formatStatNumber(val)}
                      </div>
                      <div class="text-xs text-[var(--chat-meta-color)] leading-tight">
                        {getLeaderboardSortUnit(leaderboardSort)}
                      </div>
                    </div>

                    <!-- 桌面端 6 列全指标 -->
                    <div class="relative z-1 hidden sm:grid chat-stats-table-cols font-mono text-xs tabular-nums">
                      <span class="chat-stats-col-val {leaderboardSort === 'messages' ? 'is-primary' : ''}">{formatStatNumber(u.messages)}</span>
                      <span class="chat-stats-col-val {leaderboardSort === 'chars' ? 'is-primary' : ''}">{formatStatNumber(u.chars)}</span>
                      <span class="chat-stats-col-val {leaderboardSort === 'images' ? 'is-primary' : ''}">{u.images}</span>
                      <span class="chat-stats-col-val {leaderboardSort === 'stickers' ? 'is-primary' : ''}">{u.stickers}</span>
                      <span class="chat-stats-col-val {leaderboardSort === 'musicRequests' ? 'is-primary' : ''}">{u.musicRequests}</span>
                      <span class="chat-stats-col-val {leaderboardSort === 'interactionScore' ? 'is-primary' : ''}">{u.interactionScore}</span>
                    </div>
                  </button>
                {/each}
              </div>

              {#if totalLeaderboardCount > 10}
                <div class="pt-2 text-center">
                  <button
                    type="button"
                    class="px-4 py-1.5 sm:px-3.5 sm:py-1 text-[13px] sm:text-xs font-semibold rounded-lg bg-black/5 dark:bg-white/8 hover:bg-black/10 dark:hover:bg-white/12 text-[var(--deep-text)] dark:text-white/90 border-none cursor-pointer transition-colors"
                    onclick={() => (showAllMembers = !showAllMembers)}
                  >
                    {showAllMembers ? "收起榜单 ↑" : `展开全部 ${totalLeaderboardCount} 位成员 ↓`}
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </section>

        <!-- 5. 沉底扩展区：走势折线 + 时段分布 + 友站占比 + 点歌排行 -->
        <section class="space-y-4 pt-2 border-t border-[var(--skin-line)]/70">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-sm sm:text-xs font-bold uppercase tracking-wider text-[var(--chat-meta-color)] m-0">
              趋势与分布
            </h3>
            {#if stats.highlights.peakBucket}
              <span class="text-xs sm:text-[11px] text-[var(--chat-meta-color)] tabular-nums">
                ⚡ 峰值 {stats.highlights.peakBucket.label} ({stats.highlights.peakBucket.messages} 条)
              </span>
            {/if}
          </div>

          <ChatStatsFlowChart
            points={stats.timeline}
            range={stats.range}
            animKey={`${stats.room}:${stats.range}:${stats.dateRange.startDay}:${stats.dateRange.endDay}:${animSeq}`}
            onSelectDay={drillToDay}
          />

          <ChatStatsVisuals
            hourlyProfile={stats.hourlyProfile}
            siteDistribution={enrichedSites}
            topTracks={stats.topTracks}
            showSites={room !== "chat"}
          />
        </section>
      {/if}
    </div>
  </div>
</div>
