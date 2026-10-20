import {
	getFcircleDatePresentation,
	getFcircleRelativeDays,
} from "@/utils/fcircle-date-utils";

const STORAGE_KEYS = ["moments-view", "fcircle_preferred_view"];

const TODAY_MARKER_CLASSES = [
	"border-(--primary)",
	"bg-(--primary)",
	"text-white",
	"shadow-md",
	"shadow-(--primary)/20",
	"ring-4",
	"ring-(--primary)/15",
];
const YESTERDAY_MARKER_CLASSES = [
	"border-(--primary)",
	"bg-(--card-bg)",
	"text-(--primary)",
	"shadow-sm",
	"ring-2",
	"ring-(--primary)/10",
];
const DEFAULT_MARKER_CLASSES = [
	"border-(--line-divider)",
	"bg-(--card-bg)",
	"text-neutral-500",
	"dark:text-neutral-400",
	"md:hover:border-(--primary)",
];
const ALL_MARKER_CLASSES = [
	...TODAY_MARKER_CLASSES,
	...YESTERDAY_MARKER_CLASSES,
	...DEFAULT_MARKER_CLASSES,
];

function applyMarkerState(marker: HTMLElement, relativeDays: number) {
	marker.classList.remove(...ALL_MARKER_CLASSES);
	const classes =
		relativeDays === 0
			? TODAY_MARKER_CLASSES
			: relativeDays === 1
				? YESTERDAY_MARKER_CLASSES
				: DEFAULT_MARKER_CLASSES;
	marker.classList.add(...classes);

	marker
		.querySelector(".fcircle-date-today-icon")
		?.classList.toggle("hidden", relativeDays !== 0);
	marker
		.querySelector(".fcircle-date-calendar-icon")
		?.classList.toggle("hidden", relativeDays === 0);
}

function updateTodayStatStyle(todayCount: number) {
	const card = document.getElementById("fcircle-today-stat-card");
	const icon = document.getElementById("fcircle-today-stat-icon");
	const count = document.getElementById("fcircle-today-count");
	if (!card || !icon || !count) return;

	const active = todayCount > 0;

	card.classList.toggle("border-(--primary)/30", active);
	card.classList.toggle("bg-(--primary)/5", active);
	card.classList.toggle("md:hover:border-(--primary)", active);
	card.classList.toggle("border-(--line-divider)", !active);
	card.classList.toggle("md:hover:border-(--primary)/40", !active);

	icon.classList.toggle("bg-(--primary)", active);
	icon.classList.toggle("text-white", active);
	icon.classList.toggle("shadow-xs", active);
	icon.classList.toggle("bg-(--primary)/10", !active);
	icon.classList.toggle("text-(--primary)", !active);

	count.classList.toggle("text-(--primary)", active);
	count.classList.toggle("text-neutral-800", !active);
	count.classList.toggle("dark:text-neutral-200", !active);
}

/** 刷新时间线中各日期组的相对标签（今天/昨天）与今日统计 */
export function refreshFcircleRelativeDates(): void {
	const root = document.getElementById("fcircle-root");
	if (!root) return;

	const timeZone = root.dataset.timeZone || "UTC";
	const now = new Date();

	root
		.querySelectorAll<HTMLElement>(".fcircle-date-group[data-date-iso]")
		.forEach((group) => {
			const dateIso = group.dataset.dateIso;
			if (!dateIso) return;

			const presentation = getFcircleDatePresentation(dateIso, now, timeZone);
			const label = group.querySelector<HTMLElement>(".fcircle-date-label");
			const subLabel = group.querySelector<HTMLElement>(
				".fcircle-date-sublabel",
			);
			const marker = group.querySelector<HTMLElement>(".fcircle-date-marker");

			if (label) label.textContent = presentation.displayDate;
			if (subLabel) subLabel.textContent = presentation.subLabel;
			if (marker) applyMarkerState(marker, presentation.relativeDays);
		});

	let todayCount = 0;
	let weekCount = 0;

	root
		.querySelectorAll<HTMLElement>(
			"#fcircle-timeline-view .fcircle-timeline-card[data-pub-date], #timeline-view .fcircle-timeline-card[data-pub-date]",
		)
		.forEach((card) => {
			const dateIso = card.dataset.pubDate;
			if (!dateIso) return;

			const relativeDays = getFcircleRelativeDays(dateIso, now, timeZone);
			if (relativeDays === 0) todayCount++;
			if (relativeDays >= 0 && relativeDays <= 6) weekCount++;
		});

	const todayCountElement = document.getElementById("fcircle-today-count");
	const weekCountElement = document.getElementById("fcircle-week-count");
	if (todayCountElement) todayCountElement.textContent = String(todayCount);
	if (weekCountElement) weekCountElement.textContent = String(weekCount);
	updateTodayStatStyle(todayCount);
}

/** 应用时间线或平铺视图 */
export function switchFcircleView(mode: "timeline" | "grid" | "list"): void {
	const isTimeline = mode === "timeline";
	const effectiveMode = isTimeline ? "timeline" : "grid";

	const timelineView =
		document.getElementById("timeline-view") ||
		document.getElementById("fcircle-timeline-view");
	const gridView =
		document.getElementById("grid-view") ||
		document.getElementById("fcircle-list-view");

	const btnTimeline =
		document.getElementById("view-timeline") ||
		document.querySelector<HTMLElement>(
			'.fcircle-view-btn[data-view="timeline"]',
		);
	const btnGrid =
		document.getElementById("view-grid") ||
		document.querySelector<HTMLElement>(
			'.fcircle-view-btn[data-view="grid"], .fcircle-view-btn[data-view="list"]',
		);

	if (timelineView) timelineView.classList.toggle("hidden", !isTimeline);
	if (gridView) gridView.classList.toggle("hidden", isTimeline);

	if (btnTimeline) {
		btnTimeline.classList.toggle("bg-(--primary)", isTimeline);
		btnTimeline.classList.toggle("bg-[var(--primary)]", isTimeline);
		btnTimeline.classList.toggle("text-white", isTimeline);
		btnTimeline.classList.toggle("font-medium", isTimeline);
		btnTimeline.classList.toggle("opacity-60", !isTimeline);
		btnTimeline.setAttribute("aria-selected", isTimeline ? "true" : "false");
	}

	if (btnGrid) {
		btnGrid.classList.toggle("bg-(--primary)", !isTimeline);
		btnGrid.classList.toggle("bg-[var(--primary)]", !isTimeline);
		btnGrid.classList.toggle("text-white", !isTimeline);
		btnGrid.classList.toggle("font-medium", !isTimeline);
		btnGrid.classList.toggle("opacity-60", isTimeline);
		btnGrid.setAttribute("aria-selected", !isTimeline ? "true" : "false");
	}

	try {
		for (const key of STORAGE_KEYS) {
			localStorage.setItem(key, effectiveMode);
		}
	} catch {
		// 忽略隐私模式等存储异常
	}
}

/** 恢复当前保存的偏好视图 */
export function applySavedFcircleView(): void {
	const timelineView =
		document.getElementById("timeline-view") ||
		document.getElementById("fcircle-timeline-view");
	const gridView =
		document.getElementById("grid-view") ||
		document.getElementById("fcircle-list-view");

	if (!timelineView && !gridView) return;

	let saved: "timeline" | "grid" | "list" = "timeline";
	try {
		for (const key of STORAGE_KEYS) {
			const val = localStorage.getItem(key);
			if (val === "grid" || val === "list" || val === "timeline") {
				saved = val;
				break;
			}
		}
	} catch {
		// 忽略隐私模式等存储异常
	}

	switchFcircleView(saved);
	refreshFcircleRelativeDates();
}

/** 全局初始化友链朋友圈控制器（随全站布局常驻内存） */
export function initFcircleManager(): void {
	const fcircleWindow = window as Window & {
		__fcircleManagerInitialized?: boolean;
	};

	if (fcircleWindow.__fcircleManagerInitialized) {
		applySavedFcircleView();
		return;
	}
	fcircleWindow.__fcircleManagerInitialized = true;

	// 全局事件委托：捕获视图切换按钮点击（无论切页与否均 100% 响应）
	document.addEventListener("click", (e) => {
		const target = e.target as HTMLElement | null;
		const btn = target?.closest<HTMLElement>(
			"#view-timeline, #view-grid, .fcircle-view-btn",
		);
		if (!btn) return;

		const isTimeline =
			btn.id === "view-timeline" || btn.dataset.view === "timeline";
		switchFcircleView(isTimeline ? "timeline" : "grid");
	});

	// 监听 Swup / Astro 切页完成，还原视图与刷新相对时间
	document.addEventListener("astro:page-load", applySavedFcircleView);
	document.addEventListener("swup:content:replace", applySavedFcircleView);
	document.addEventListener("swup:contentReplaced", applySavedFcircleView);

	// 定时器与前后台切换刷新
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) refreshFcircleRelativeDates();
	});
	window.setInterval(refreshFcircleRelativeDates, 60_000);

	// 初始触发一次
	applySavedFcircleView();
}
