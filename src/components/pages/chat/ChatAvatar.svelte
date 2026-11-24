<script module lang="ts">
const failedAvatarUrls = new Set<string>();
const loadedAvatarUrls = new Set<string>();
const downscaledAvatarUrls = new Map<string, string>();
const corsDisabledAvatarUrls = new Set<string>();
const pendingDownscaleUrls = new Map<string, Promise<string | null>>();
const MAX_AVATAR_URL_CACHE = 500;
const MAX_DOWNSCALED_CACHE = 300;
const AVATAR_THUMB_SIZE = 96;
let sharedThumbCanvas: HTMLCanvasElement | null = null;

function markAvatarFailed(url: string): void {
	if (!url) return;
	if (failedAvatarUrls.size >= MAX_AVATAR_URL_CACHE) {
		failedAvatarUrls.clear();
	}
	failedAvatarUrls.add(url);
}

function markAvatarLoaded(url: string): void {
	if (!url) return;
	if (loadedAvatarUrls.size >= MAX_AVATAR_URL_CACHE) {
		loadedAvatarUrls.clear();
	}
	loadedAvatarUrls.add(url);
}

export function getDownscaledAvatarUrl(url: string): string {
	if (!url || !canAttemptCorsDownscale(url)) {
		if (url && downscaledAvatarUrls.has(url)) {
			const old = downscaledAvatarUrls.get(url);
			if (old) URL.revokeObjectURL(old);
			downscaledAvatarUrls.delete(url);
		}
		return "";
	}
	return downscaledAvatarUrls.get(url) || "";
}

export function canCorsDownscaleAvatar(url: string): boolean {
	return canAttemptCorsDownscale(url);
}

export function downscaleImgElementInPlace(
	img: HTMLImageElement,
	rawUrl: string,
): void {
	if (!rawUrl || !canAttemptCorsDownscale(rawUrl)) return;
	if (img.naturalWidth <= 160 && img.naturalHeight <= 160) return;
	const initialSrc = img.currentSrc || img.src;
	void downscaleAvatarToBlobUrl(img, rawUrl).then((blobUrl) => {
		if (
			blobUrl &&
			img.isConnected &&
			(img.currentSrc || img.src) === initialSrc
		) {
			img.src = blobUrl;
		}
	});
}

function canAttemptCorsDownscale(url: string): boolean {
	if (!url || typeof window === "undefined") return false;
	if (corsDisabledAvatarUrls.has(url)) return false;
	if (url.startsWith("blob:") || url.startsWith("data:")) return false;
	if (/\.(?:gif|svg)(?:$|\?)/i.test(url)) return false;
	try {
		const parsed = new URL(url, window.location.href);
		if (parsed.origin === window.location.origin) {
			return !/\.(?:gif|svg)(?:$|\?)/i.test(parsed.pathname);
		}
	} catch {
		return false;
	}
	return false;
}

function downscaleAvatarToBlobUrl(
	img: HTMLImageElement,
	sourceUrl: string,
): Promise<string | null> {
	if (!sourceUrl || !canAttemptCorsDownscale(sourceUrl)) {
		return Promise.resolve(null);
	}
	const existing = downscaledAvatarUrls.get(sourceUrl);
	if (existing) return Promise.resolve(existing);
	const inflight = pendingDownscaleUrls.get(sourceUrl);
	if (inflight) return inflight;

	const task = new Promise<string | null>((resolve) => {
		try {
			const w = img.naturalWidth;
			const h = img.naturalHeight;
			if (!w || !h || (w <= 160 && h <= 160)) {
				resolve(null);
				return;
			}
			if (!sharedThumbCanvas) {
				sharedThumbCanvas = document.createElement("canvas");
				sharedThumbCanvas.width = AVATAR_THUMB_SIZE;
				sharedThumbCanvas.height = AVATAR_THUMB_SIZE;
			}
			const ctx = sharedThumbCanvas.getContext("2d");
			if (!ctx) {
				resolve(null);
				return;
			}
			ctx.clearRect(0, 0, AVATAR_THUMB_SIZE, AVATAR_THUMB_SIZE);
			const side = Math.min(w, h);
			const sx = Math.floor((w - side) / 2);
			const sy = Math.floor((h - side) / 2);
			ctx.drawImage(
				img,
				sx,
				sy,
				side,
				side,
				0,
				0,
				AVATAR_THUMB_SIZE,
				AVATAR_THUMB_SIZE,
			);
			sharedThumbCanvas.toBlob(
				(blob) => {
					if (!blob) {
						resolve(null);
						return;
					}
					if (downscaledAvatarUrls.size >= MAX_DOWNSCALED_CACHE) {
						const oldestKey = downscaledAvatarUrls.keys().next().value;
						if (oldestKey !== undefined) {
							const oldUrl = downscaledAvatarUrls.get(oldestKey);
							if (oldUrl) URL.revokeObjectURL(oldUrl);
							downscaledAvatarUrls.delete(oldestKey);
						}
					}
					const blobUrl = URL.createObjectURL(blob);
					downscaledAvatarUrls.set(sourceUrl, blobUrl);
					resolve(blobUrl);
				},
				"image/webp",
				0.86,
			);
		} catch {
			corsDisabledAvatarUrls.add(sourceUrl);
			resolve(null);
		}
	}).finally(() => {
		pendingDownscaleUrls.delete(sourceUrl);
	});

	pendingDownscaleUrls.set(sourceUrl, task);
	return task;
}
</script>

<script lang="ts">
import { getAvatarInitials, getDiceBearGlassAvatar, resolveChatAvatarUrl } from "./chatClient";

type AvatarSize = "2xs" | "xs" | "sm" | "md" | "lg";

interface Props {
	src?: string;
	alternateSrc?: string;
	name?: string;
	fallback?: string;
	alt?: string;
	size?: AvatarSize;
	grayscale?: boolean;
	mutedTone?: boolean;
	lazy?: boolean;
	class?: string;
}

const {
	src = "",
	alternateSrc = "",
	name = "",
	fallback = "?",
	alt = "",
	size = "md",
	grayscale = false,
	mutedTone = false,
	lazy = false,
	class: extraClass = "",
}: Props = $props();

let imgError = $state(false);
let imgLoaded = $state(false);
let downscaledSrc = $state("");
let disableCorsForCurrent = $state(false);
let useAlternate = $state(false);
let diceBearError = $state(false);
let diceBearLoaded = $state(false);

const primaryUrl = $derived(resolveChatAvatarUrl(src));
const alternateUrl = $derived(resolveChatAvatarUrl(alternateSrc));
const resolvedSrc = $derived(
	alternateUrl && (useAlternate || !primaryUrl || failedAvatarUrls.has(primaryUrl))
		? alternateUrl
		: primaryUrl,
);

const diceBearSeed = $derived(name || fallback || "spectator");
const diceBearUrl = $derived(getDiceBearGlassAvatar(diceBearSeed));

$effect(() => {
	void primaryUrl;
	void alternateUrl;
	useAlternate = false;
});

$effect(() => {
	const cur = resolvedSrc;
	imgError = Boolean(cur && failedAvatarUrls.has(cur));
	disableCorsForCurrent = false;
	downscaledSrc = size === "lg" ? "" : getDownscaledAvatarUrl(cur);
	imgLoaded = Boolean(cur && loadedAvatarUrls.has(cur));
});

$effect(() => {
	const dbUrl = diceBearUrl;
	diceBearError = Boolean(dbUrl && failedAvatarUrls.has(dbUrl));
	diceBearLoaded = Boolean(dbUrl && loadedAvatarUrls.has(dbUrl));
});

const useCors = $derived(!downscaledSrc && !disableCorsForCurrent && canCorsDownscaleAvatar(resolvedSrc));

function handleAvatarLoad(img: HTMLImageElement): void {
	if (!resolvedSrc) return;
	markAvatarLoaded(resolvedSrc);
	imgLoaded = true;
	if (size !== "lg" && useCors && (img.naturalWidth > 160 || img.naturalHeight > 160)) {
		void downscaleAvatarToBlobUrl(img, resolvedSrc);
	}
}

function handleAvatarError(): void {
	const raw = resolvedSrc;
	imgLoaded = false;
	if (downscaledSrc) {
		if (downscaledAvatarUrls.get(raw) === downscaledSrc) {
			URL.revokeObjectURL(downscaledSrc);
			downscaledAvatarUrls.delete(raw);
		}
		downscaledSrc = "";
		disableCorsForCurrent = true;
		return;
	}
	if (useCors) {
		corsDisabledAvatarUrls.add(raw);
		disableCorsForCurrent = true;
		return;
	}
	markAvatarFailed(raw);
	if (alternateUrl && alternateUrl !== raw && !failedAvatarUrls.has(alternateUrl)) {
		useAlternate = true;
		return;
	}
	imgError = true;
}

function handleDiceBearLoad(): void {
	if (!diceBearUrl) return;
	markAvatarLoaded(diceBearUrl);
	diceBearLoaded = true;
}

function handleDiceBearError(): void {
	if (diceBearUrl) {
		markAvatarFailed(diceBearUrl);
	}
	diceBearLoaded = false;
	diceBearError = true;
}

const showCustomImage = $derived(Boolean(resolvedSrc) && !imgError);
const initials = $derived(getAvatarInitials(name, fallback));
const isMultiChar = $derived(Array.from(initials).length >= 2);

const boxClass = $derived(
	size === "2xs"
		? "w-4 h-4 rounded-full"
		: size === "xs"
			? "w-5 h-5 rounded-full"
			: size === "sm"
				? "chat-avatar-sm"
				: size === "lg"
					? "w-12 h-12 rounded-full border border-black/10 dark:border-white/15"
					: "chat-avatar",
);

const textSizeClass = $derived.by(() => {
	switch (size) {
		case "2xs":
			return isMultiChar ? "text-[7px] tracking-tighter" : "text-[9px]";
		case "xs":
			return isMultiChar ? "text-[8px] tracking-tighter" : "text-[10px]";
		case "sm":
			return isMultiChar ? "text-[10.5px] tracking-tight" : "text-xs";
		case "lg":
			return isMultiChar ? "text-sm tracking-tight" : "text-base";
		default:
			return isMultiChar ? "text-xs tracking-tight" : "text-sm";
	}
});

const fallbackBgClass = $derived(
	size === "2xs" || size === "xs" || size === "lg" ? "bg-(--primary)/15" : "bg-black/5 dark:bg-white/10",
);

const fallbackTextColorClass = $derived(
	mutedTone
		? "text-[var(--chat-meta-color)]"
		: "text-[var(--chat-accent-text)]",
);
</script>

{#if showCustomImage}
  {#if imgLoaded}
    <img
      src={downscaledSrc || resolvedSrc}
      loading={lazy ? "lazy" : "eager"}
      fetchpriority={lazy ? "low" : undefined}
      decoding="async"
      crossorigin={useCors ? "anonymous" : undefined}
      referrerpolicy="no-referrer"
      alt={alt || name}
      class="{boxClass} object-cover shrink-0 {grayscale ? 'grayscale-[35%]' : ''} {extraClass}"
      onload={(event) => handleAvatarLoad(event.currentTarget)}
      onerror={handleAvatarError}
    />
  {:else}
    <span class="{boxClass} relative inline-flex items-center justify-center shrink-0 overflow-hidden {extraClass}">
      {#if !diceBearError}
        <img
          src={diceBearUrl}
          alt=""
          loading="eager"
          decoding="async"
          aria-hidden="true"
          class="absolute inset-0 w-full h-full object-cover {grayscale ? 'grayscale-[35%]' : ''}"
        />
      {:else}
        <span
          class="absolute inset-0 {fallbackBgClass} {textSizeClass} {fallbackTextColorClass} inline-flex items-center justify-center font-bold leading-none select-none"
        >
          {initials}
        </span>
      {/if}
      <img
        src={downscaledSrc || resolvedSrc}
        loading={lazy ? "lazy" : "eager"}
        fetchpriority={lazy ? "low" : undefined}
        decoding="async"
        crossorigin={useCors ? "anonymous" : undefined}
        referrerpolicy="no-referrer"
        alt={alt || name}
        class="relative w-full h-full object-cover opacity-0 transition-opacity duration-150 {grayscale ? 'grayscale-[35%]' : ''}"
        onload={(event) => handleAvatarLoad(event.currentTarget)}
        onerror={handleAvatarError}
      />
    </span>
  {/if}
{:else if !diceBearError}
  {#if diceBearLoaded}
    <img
      src={diceBearUrl}
      loading={lazy ? "lazy" : "eager"}
      fetchpriority={lazy ? "low" : undefined}
      decoding="async"
      referrerpolicy="no-referrer"
      alt={alt || name}
      class="{boxClass} object-cover shrink-0 {grayscale ? 'grayscale-[35%]' : ''} {extraClass}"
      onload={handleDiceBearLoad}
      onerror={handleDiceBearError}
    />
  {:else}
    <span class="{boxClass} relative inline-flex items-center justify-center shrink-0 overflow-hidden {extraClass}">
      <span
        class="absolute inset-0 {fallbackBgClass} {textSizeClass} {fallbackTextColorClass} inline-flex items-center justify-center font-bold leading-none select-none"
      >
        {initials}
      </span>
      <img
        src={diceBearUrl}
        loading={lazy ? "lazy" : "eager"}
        fetchpriority={lazy ? "low" : undefined}
        decoding="async"
        referrerpolicy="no-referrer"
        alt={alt || name}
        class="relative w-full h-full object-cover opacity-0 transition-opacity duration-150 {grayscale ? 'grayscale-[35%]' : ''}"
        onload={handleDiceBearLoad}
        onerror={handleDiceBearError}
      />
    </span>
  {/if}
{:else}
  <div
    class="{boxClass} {fallbackBgClass} {textSizeClass} {fallbackTextColorClass} inline-flex items-center justify-center font-bold leading-none select-none shrink-0 {extraClass}"
  >
    {initials}
  </div>
{/if}
