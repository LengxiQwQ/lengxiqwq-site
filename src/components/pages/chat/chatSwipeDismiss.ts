/**
 * 移动端 / 平板端触摸滑动关闭与遮罩联动工具
 * 统一管理方向锁、滚动边界检测、瞬时速度判定与进度计算，避免各组件重复编写手势状态机。
 */

export interface SwipeDismissOptions {
	axis: "x" | "y";
	direction: 1 | -1;
	isActive?: () => boolean;
	canStart?: (target: EventTarget | null, event: TouchEvent) => boolean;
	ignoreSelector?: string;
	checkScrollBoundary?: boolean;
	getSize?: () => number;
	maxDragThresholdPx?: number;
	thresholdRatio?: number;
	minFlickDistancePx?: number;
	minFlickVelocity?: number;
	progressScale?: number;
	onDrag: (offsetPx: number, progress: number) => void;
	onDismiss: (offsetPx: number) => void;
	onCancel?: () => void;
}

export interface EdgeSwipeOpenOptions {
	isActive: () => boolean;
	ignoreSelector?: string;
	edgeWidthPx?: number;
	edgeRatio?: number;
	minDistancePx?: number;
	maxDurationMs?: number;
	onOpenLeft?: () => void;
	onOpenRight?: () => void;
}

const DEFAULT_IGNORE_SELECTOR =
	"input, textarea, select, [contenteditable='true'], [data-no-sheet-drag], .chat-sheet-handle, .chat-slim-slider, .chat-slider-control, .chat-picker-tabs, .chat-md-table-wrap, pre, code";

function isSwipeBlockedTarget(
	target: EventTarget | null,
	selector: string,
): boolean {
	if (!(target instanceof Element)) return true;
	return Boolean(target.closest(selector));
}

function canSwipeAlongScrollAxis(
	target: EventTarget | null,
	root: HTMLElement,
	axis: "x" | "y",
): boolean {
	let node: HTMLElement | null = target instanceof HTMLElement ? target : null;
	while (node && node !== root) {
		const style = getComputedStyle(node);
		if (axis === "y") {
			const overflowY = style.overflowY;
			if (
				(overflowY === "auto" || overflowY === "scroll") &&
				node.scrollHeight > node.clientHeight + 1 &&
				node.scrollTop > 1
			) {
				return false;
			}
		} else {
			const overflowX = style.overflowX;
			if (
				(overflowX === "auto" || overflowX === "scroll") &&
				node.scrollWidth > node.clientWidth + 2
			) {
				return false;
			}
		}
		node = node.parentElement;
	}
	return true;
}

/**
 * 将拖拽偏移量映射为遮罩透明度字符串（用于 `--chat-sheet-backdrop-alpha` 等 CSS 变量）
 */
export function formatSwipeBackdropAlpha(
	progress: number,
	minAlpha = 0.05,
	maxFade = 0.95,
): string {
	const clamped = Math.max(0, Math.min(1, progress));
	return Math.max(minAlpha, 1 - clamped * maxFade).toFixed(3);
}

/**
 * 为面板或弹窗挂载跟手滑动关闭手势，返回清理函数。
 */
export function attachSwipeDismiss(
	element: HTMLElement,
	options: SwipeDismissOptions,
): () => void {
	const {
		axis,
		direction,
		isActive = () => true,
		canStart,
		ignoreSelector = DEFAULT_IGNORE_SELECTOR,
		checkScrollBoundary = true,
		getSize,
		maxDragThresholdPx = axis === "x" ? 96 : 140,
		thresholdRatio = axis === "x" ? 0.28 : 0.25,
		minFlickDistancePx = axis === "x" ? 28 : 36,
		minFlickVelocity = axis === "x" ? 0.38 : 0.45,
		progressScale = axis === "x" ? 1 : 0.55,
		onDrag,
		onDismiss,
		onCancel,
	} = options;

	let tracking = false;
	let captured = false;
	let startX = 0;
	let startY = 0;
	let lastPrimary = 0;
	let lastTime = 0;
	let velocity = 0;
	let currentOffset = 0;

	const resolveSize = (): number => {
		if (getSize) return Math.max(180, getSize());
		const rect = element.getBoundingClientRect();
		const measured = axis === "x" ? rect.width : rect.height;
		return Math.max(180, measured || (axis === "x" ? 320 : 520));
	};

	const resetState = () => {
		tracking = false;
		captured = false;
		currentOffset = 0;
	};

	const onTouchStart = (e: TouchEvent) => {
		if (!isActive()) return;
		if (e.touches.length !== 1) {
			if (captured) onCancel?.();
			resetState();
			return;
		}
		if (isSwipeBlockedTarget(e.target, ignoreSelector)) return;
		if (canStart && !canStart(e.target, e)) return;
		if (
			checkScrollBoundary &&
			!canSwipeAlongScrollAxis(e.target, element, axis)
		) {
			return;
		}

		const touch = e.touches[0];
		tracking = true;
		captured = false;
		startX = touch.clientX;
		startY = touch.clientY;
		lastPrimary = axis === "x" ? touch.clientX : touch.clientY;
		lastTime = performance.now();
		velocity = 0;
		currentOffset = 0;
	};

	const onTouchMove = (e: TouchEvent) => {
		if (!tracking || e.touches.length !== 1) return;
		const touch = e.touches[0];
		const dx = touch.clientX - startX;
		const dy = touch.clientY - startY;
		const primaryDelta = axis === "x" ? dx : dy;
		const secondaryDelta = axis === "x" ? dy : dx;

		if (!captured) {
			if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
			const alongDirection = primaryDelta * direction > 0;
			if (
				!alongDirection ||
				Math.abs(primaryDelta) <= Math.abs(secondaryDelta) * 1.15
			) {
				resetState();
				return;
			}
			if (
				checkScrollBoundary &&
				!canSwipeAlongScrollAxis(e.target, element, axis)
			) {
				resetState();
				return;
			}
			captured = true;
		}

		if (e.cancelable) e.preventDefault();
		const pos = axis === "x" ? touch.clientX : touch.clientY;
		const now = performance.now();
		const dt = now - lastTime;
		if (dt > 0) {
			velocity = (pos - lastPrimary) / dt;
		}
		lastPrimary = pos;
		lastTime = now;

		currentOffset =
			direction > 0 ? Math.max(0, primaryDelta) : Math.min(0, primaryDelta);
		const size = resolveSize();
		const progress = Math.min(
			1,
			Math.abs(currentOffset) / Math.max(180, size * progressScale),
		);
		onDrag(currentOffset, progress);
	};

	const onTouchEnd = () => {
		if (!tracking) return;
		const wasCaptured = captured;
		const finalOffset = currentOffset;
		const finalVelocity = velocity;
		resetState();

		if (!wasCaptured) return;

		const size = resolveSize();
		const dist = Math.abs(finalOffset);
		const dirVelocity = finalVelocity * direction;
		const shouldDismiss =
			dist > Math.min(maxDragThresholdPx, size * thresholdRatio) ||
			(dist > minFlickDistancePx && dirVelocity > minFlickVelocity);

		if (shouldDismiss) {
			onDismiss(finalOffset);
		} else {
			onCancel?.();
		}
	};

	const onTouchCancel = () => {
		if (!tracking) return;
		const wasCaptured = captured;
		resetState();
		if (wasCaptured) onCancel?.();
	};

	element.addEventListener("touchstart", onTouchStart, { passive: true });
	element.addEventListener("touchmove", onTouchMove, { passive: false });
	element.addEventListener("touchend", onTouchEnd, { passive: true });
	element.addEventListener("touchcancel", onTouchCancel, { passive: true });

	return () => {
		element.removeEventListener("touchstart", onTouchStart);
		element.removeEventListener("touchmove", onTouchMove);
		element.removeEventListener("touchend", onTouchEnd);
		element.removeEventListener("touchcancel", onTouchCancel);
	};
}

/**
 * 为主舞台挂载边缘滑动打开抽屉的手势，返回清理函数。
 */
export function attachEdgeSwipeOpen(
	element: HTMLElement,
	options: EdgeSwipeOpenOptions,
): () => void {
	const {
		isActive,
		ignoreSelector = DEFAULT_IGNORE_SELECTOR,
		edgeWidthPx = 96,
		edgeRatio = 0.28,
		minDistancePx = 56,
		maxDurationMs = 600,
		onOpenLeft,
		onOpenRight,
	} = options;

	let start: { x: number; y: number; time: number } | null = null;

	const onTouchStart = (e: TouchEvent) => {
		if (!isActive() || e.touches.length !== 1) {
			start = null;
			return;
		}
		if (isSwipeBlockedTarget(e.target, ignoreSelector)) {
			start = null;
			return;
		}
		if (!canSwipeAlongScrollAxis(e.target, element, "x")) {
			start = null;
			return;
		}
		const touch = e.touches[0];
		start = { x: touch.clientX, y: touch.clientY, time: Date.now() };
	};

	const onTouchEnd = (e: TouchEvent) => {
		if (!start || e.changedTouches.length !== 1) {
			start = null;
			return;
		}
		const s = start;
		start = null;
		const touch = e.changedTouches[0];
		const dx = touch.clientX - s.x;
		const dy = touch.clientY - s.y;
		const dt = Date.now() - s.time;
		if (
			dt > maxDurationMs ||
			Math.abs(dx) < minDistancePx ||
			Math.abs(dy) > Math.abs(dx) * 0.65
		) {
			return;
		}
		const vw = window.innerWidth || 375;
		const edgeLimit = Math.min(edgeWidthPx, vw * edgeRatio);
		if (dx > 0 && s.x < edgeLimit) {
			onOpenLeft?.();
		} else if (dx < 0 && s.x > vw - edgeLimit) {
			onOpenRight?.();
		}
	};

	const onTouchCancel = () => {
		start = null;
	};

	element.addEventListener("touchstart", onTouchStart, { passive: true });
	element.addEventListener("touchend", onTouchEnd, { passive: true });
	element.addEventListener("touchcancel", onTouchCancel, { passive: true });

	return () => {
		element.removeEventListener("touchstart", onTouchStart);
		element.removeEventListener("touchend", onTouchEnd);
		element.removeEventListener("touchcancel", onTouchCancel);
	};
}
