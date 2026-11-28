<script lang="ts">
import { onDestroy, onMount, tick } from "svelte";

export interface SingleLineLyricTiming {
	key: string;
	durationSec: number | null;
	elapsedSec: number;
	isPlaying: boolean;
}

interface Props {
	text: string;
	isLyric?: boolean;
	timing?: SingleLineLyricTiming | null;
	class?: string;
	ariaLive?: "polite" | "off" | "assertive";
}

const {
	text,
	isLyric = true,
	timing = null,
	class: className = "",
	ariaLive,
}: Props = $props();

const START_PAUSE_SEC = 0.3;
const END_PAUSE_SEC = 0.7;
const FALLBACK_READING_PX_PER_SEC = 44;
const MIN_COMFORT_PX_PER_SEC = 40;
const MAX_COMFORT_SCROLL_SEC = 6.5;

let containerEl = $state<HTMLDivElement | null>(null);
let textEl = $state<HTMLSpanElement | null>(null);
let overflowPx = $state(0);
let offsetPx = $state(0);

let rafId = 0;
let resizeObserver: ResizeObserver | null = null;
let lastKey = "";
let lastPlaying = false;
let baseElapsedSec = 0;
let syncPerfMs = 0;

const isOverflowing = $derived(isLyric && overflowPx > 2);
const effectiveKey = $derived(timing?.key || text);
const effectivePlaying = $derived(timing ? timing.isPlaying : true);
const leftFadePx = $derived(
	isOverflowing ? Math.min(10, Math.max(0, Math.round(offsetPx))) : 0,
);
const rightFadePx = $derived(
	isOverflowing
		? Math.min(14, Math.max(0, Math.round(overflowPx - offsetPx)))
		: 0,
);
const maskStyle = $derived.by(() => {
	if (!isOverflowing || (leftFadePx === 0 && rightFadePx === 0)) {
		return undefined;
	}
	const stops = [
		leftFadePx > 0 ? `transparent 0px, black ${leftFadePx}px` : "black 0px",
		rightFadePx > 0
			? `black calc(100% - ${rightFadePx}px), transparent 100%`
			: "black 100%",
	];
	const grad = `linear-gradient(90deg, ${stops.join(", ")})`;
	return `-webkit-mask-image: ${grad}; mask-image: ${grad};`;
});

function computeScrollWindow(
	durationSec: number | null | undefined,
	overflow: number,
) {
	if (durationSec != null && durationSec > 0) {
		const startPause =
			durationSec >= 1.6 ? START_PAUSE_SEC : Math.max(0.06, durationSec * 0.15);
		const endPause =
			durationSec >= 1.6 ? END_PAUSE_SEC : Math.max(0.14, durationSec * 0.35);
		const availableScrollSec = Math.max(
			0.35,
			durationSec - startPause - endPause,
		);
		const comfortMaxScrollSec = Math.min(
			MAX_COMFORT_SCROLL_SEC,
			Math.max(1.4, overflow / MIN_COMFORT_PX_PER_SEC),
		);
		return {
			pauseSec: startPause,
			scrollSec: Math.min(availableScrollSec, comfortMaxScrollSec),
		};
	}

	return {
		pauseSec: START_PAUSE_SEC,
		scrollSec: Math.max(
			1.4,
			Math.min(MAX_COMFORT_SCROLL_SEC, overflow / FALLBACK_READING_PX_PER_SEC),
		),
	};
}

function stopRaf() {
	if (rafId) {
		cancelAnimationFrame(rafId);
		rafId = 0;
	}
}

function updateOffset(elapsed: number) {
	if (!isLyric || overflowPx <= 2) {
		offsetPx = 0;
		return;
	}
	const { pauseSec, scrollSec } = computeScrollWindow(
		timing?.durationSec,
		overflowPx,
	);
	const progress = Math.min(1, Math.max(0, (elapsed - pauseSec) / scrollSec));
	offsetPx = overflowPx * progress;
}

function tickFrame() {
	rafId = 0;
	if (!isLyric || overflowPx <= 2 || !effectivePlaying) return;
	const now = performance.now();
	const elapsed = baseElapsedSec + Math.max(0, (now - syncPerfMs) / 1000);
	updateOffset(elapsed);
	const { pauseSec, scrollSec } = computeScrollWindow(
		timing?.durationSec,
		overflowPx,
	);
	if (elapsed < pauseSec + scrollSec) {
		rafId = requestAnimationFrame(tickFrame);
	}
}

function startRafIfNeeded() {
	if (!isLyric || overflowPx <= 2 || !effectivePlaying) {
		stopRaf();
		return;
	}
	const { pauseSec, scrollSec } = computeScrollWindow(
		timing?.durationSec,
		overflowPx,
	);
	const now = performance.now();
	const elapsed = baseElapsedSec + Math.max(0, (now - syncPerfMs) / 1000);
	if (elapsed < pauseSec + scrollSec && !rafId) {
		rafId = requestAnimationFrame(tickFrame);
	}
}

function measureOverflow() {
	if (!containerEl || !textEl || !isLyric) {
		overflowPx = 0;
		offsetPx = 0;
		stopRaf();
		return;
	}
	const containerWidth = containerEl.getBoundingClientRect().width;
	const textWidth = Math.max(
		textEl.scrollWidth,
		textEl.getBoundingClientRect().width,
	);
	const diff = Math.ceil(textWidth - containerWidth);
	overflowPx = diff > 2 ? diff + 4 : 0;
	if (overflowPx <= 2) {
		offsetPx = 0;
		stopRaf();
		return;
	}
	const currentElapsed = effectivePlaying
		? baseElapsedSec + Math.max(0, (performance.now() - syncPerfMs) / 1000)
		: baseElapsedSec;
	updateOffset(currentElapsed);
	startRafIfNeeded();
}

$effect(() => {
	// Track text changes and re-measure after DOM updates
	text;
	isLyric;
	void tick().then(() => {
		measureOverflow();
	});
});

$effect(() => {
	const key = effectiveKey;
	const playing = effectivePlaying;
	const propElapsed = Math.max(0, timing?.elapsedSec ?? 0);
	const now = performance.now();

	if (key !== lastKey) {
		lastKey = key;
		lastPlaying = playing;
		baseElapsedSec = propElapsed;
		syncPerfMs = now;
		updateOffset(baseElapsedSec);
		startRafIfNeeded();
		return;
	}

	if (playing !== lastPlaying) {
		if (!playing) {
			baseElapsedSec = baseElapsedSec + Math.max(0, (now - syncPerfMs) / 1000);
			syncPerfMs = now;
			lastPlaying = false;
			stopRaf();
			updateOffset(baseElapsedSec);
		} else {
			baseElapsedSec = Math.max(baseElapsedSec, propElapsed);
			syncPerfMs = now;
			lastPlaying = true;
			updateOffset(baseElapsedSec);
			startRafIfNeeded();
		}
		return;
	}

	const estimatedNow = playing
		? baseElapsedSec + Math.max(0, (now - syncPerfMs) / 1000)
		: baseElapsedSec;
	if (Math.abs(propElapsed - estimatedNow) > 0.45) {
		baseElapsedSec = propElapsed;
		syncPerfMs = now;
		updateOffset(baseElapsedSec);
		startRafIfNeeded();
	}
});

onMount(() => {
	if (typeof ResizeObserver !== "undefined" && containerEl) {
		resizeObserver = new ResizeObserver(() => {
			measureOverflow();
		});
		resizeObserver.observe(containerEl);
	}
	measureOverflow();
});

onDestroy(() => {
	stopRaf();
	resizeObserver?.disconnect();
	resizeObserver = null;
});
</script>

<div
	bind:this={containerEl}
	class="overflow-hidden whitespace-nowrap {className}"
	style={maskStyle}
	title={text}
	aria-live={ariaLive}
>
	<span
		bind:this={textEl}
		class={isLyric
			? "inline-block whitespace-nowrap will-change-transform"
			: "block truncate"}
		style={isOverflowing ? `transform: translate3d(${-offsetPx}px, 0, 0);` : undefined}
	>
		{text}
	</span>
</div>
