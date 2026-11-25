<script lang="ts">
import type { ChatMusicShareData } from "./chatShareProtocol";
import {
	formatPrivateMusicSec,
	privateMusic,
	resolveMusicExternalHref,
	toChatMusicTrack,
} from "./chatPrivateMusic.svelte";
import type { ChatMusicTrack } from "./musicTypes";
import {
	fetchFavoriteTrackStatus,
	type PlaylistAuth,
	toggleFavoriteTrack,
} from "./playlistClient";

interface Props {
	data: ChatMusicShareData;
	msgUid?: string;
	senderName?: string;
	senderAvatar?: string;
	senderUserKey?: string;
	isSelf?: boolean;
	chatServerUrl?: string;
	currentUserKey?: string;
	playlistAuth?: PlaylistAuth;
	isCurrentPlaying?: boolean;
	isQueued?: boolean;
	onEnqueueTrack?: (
		track: ChatMusicTrack,
		anchor?: HTMLElement,
	) => Promise<boolean> | void;
	onRequireAuth?: () => void;
	onFavoriteChanged?: () => void;
	onNotify?: (message: string, type?: "default" | "success" | "error") => void;
}

const {
	data,
	msgUid = "",
	senderName = "",
	senderAvatar = "",
	senderUserKey = "",
	isSelf = false,
	chatServerUrl = "",
	currentUserKey = "",
	playlistAuth,
	isCurrentPlaying = false,
	isQueued = false,
	onEnqueueTrack,
	onRequireAuth,
	onFavoriteChanged,
	onNotify,
}: Props = $props();

const isThisCardActive = $derived(privateMusic.isTrackMatching(data, msgUid));

let coverFailed = $state(false);
let isEnqueuing = $state(false);
let isSeeking = $state(false);
let previewSeekSec = $state<number | null>(null);
let scrubberEl = $state<HTMLDivElement | null>(null);
let isDraggingVolume = $state(false);
let volumeSliderEl = $state<HTMLDivElement | null>(null);

// Favorite state
let isFavorited = $state(false);
let isFavoriteToggling = $state(false);
let favCheckedKey = "";

const isPlaying = $derived(isThisCardActive && privateMusic.isPlaying);
const isLoadingAudio = $derived(isThisCardActive && privateMusic.isLoading);
const isBufferingSlow = $derived(isThisCardActive && privateMusic.isBufferingSlow && !isPlaying);
const audioError = $derived(isThisCardActive ? privateMusic.audioError : "");
const currentTimeSec = $derived(
	isSeeking && previewSeekSec !== null
		? previewSeekSec
		: isThisCardActive
			? privateMusic.currentTimeSec
			: 0,
);
const durationSec = $derived(
	isThisCardActive ? privateMusic.durationSec : data.durationSec || 0,
);
const previewVolume = $derived(privateMusic.volume);
const isPreviewMuted = $derived(privateMusic.isMuted);
const activeLyricText = $derived(
	isThisCardActive ? privateMusic.activeLyricText : "",
);

const effectiveDuration = $derived(
	durationSec > 0 ? durationSec : data.durationSec || 0,
);

const progressPercent = $derived(
	effectiveDuration > 0
		? Math.min(100, Math.max(0, (currentTimeSec / effectiveDuration) * 100))
		: 0,
);

const effectiveVolumePercent = $derived(
	Math.round(previewVolume * 100),
);

const platformLabel = $derived.by(() => {
	const p = (data.provider || data.sourcePlatform || "").toLowerCase();
	if (p === "qq" || p === "tencent") return "QQ音乐";
	if (p === "netease" || p === "ncm") return "网易云";
	if (p === "kugou") return "酷狗";
	if (p === "youtube" || p === "yt") return "YouTube";
	if (p === "local") return "本地音源";
	return p ? p.toUpperCase() : "音乐";
});

const artistText = $derived((data.artist || "").trim() || "未知歌手");
const externalHref = $derived(resolveMusicExternalHref(data));
const alreadyInRoom = $derived(isCurrentPlaying || isQueued);

// 第一行展示内容：保持歌曲名稳定展示，仅在报错或出现实时同步歌词时切换（避免加载状态来回闪烁）
const topLineContent = $derived.by(() => {
	if (audioError) {
		return { text: audioError, tone: "error" as const };
	}
	if ((isPlaying || currentTimeSec > 0) && activeLyricText) {
		return { text: activeLyricText, tone: "lyric" as const };
	}
	return { text: data.title || "未命名歌曲", tone: "title" as const };
});

const showSongArtistSubline = $derived(topLineContent.tone !== "title");

const formatSec = formatPrivateMusicSec;

function toMusicTrack(): ChatMusicTrack {
	return toChatMusicTrack(data, effectiveDuration || 0);
}

$effect(() => {
	const trackId = toChatMusicTrack(data).id || "";
	const userKey = currentUserKey || "";
	const server = (chatServerUrl || "").trim();
	const key = `${server}|${trackId}|${userKey}`;
	if (!server || !trackId || !userKey || key === favCheckedKey) return;
	favCheckedKey = key;
	void fetchFavoriteTrackStatus({
		chatServerUrl: server,
		token: playlistAuth?.token,
		trackId,
		userKey,
	})
		.then((res) => {
			if (favCheckedKey === key && res.ok) {
				isFavorited = Boolean(res.isFavorited);
			}
		})
		.catch(() => {
			// ignore
		});
});

async function togglePreview(event: MouseEvent) {
	event.stopPropagation();
	await privateMusic.playOrToggle({
		data,
		msgUid,
		senderName,
		senderAvatar,
		senderUserKey,
		chatServerUrl: chatServerUrl || "",
	});
}

// Progress scrubber handlers (zero-lag pointer capture)
function getRatioFromPointer(el: HTMLElement | null, clientX: number): number {
	if (!el) return 0;
	const rect = el.getBoundingClientRect();
	if (rect.width <= 0) return 0;
	return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

function commitSeekToRatio(ratio: number) {
	const total = effectiveDuration || 0;
	if (total <= 0) return;
	previewSeekSec = null;
	if (isThisCardActive) {
		privateMusic.setScrubbing(false);
		privateMusic.commitScrubRatio(ratio, true);
		return;
	}
	void privateMusic.playOrToggle({
		data,
		msgUid,
		senderName,
		senderAvatar,
		senderUserKey,
		chatServerUrl: chatServerUrl || "",
		seekToSec: Math.min(1, Math.max(0, ratio)) * total,
	});
}

function handleScrubberPointerDown(event: PointerEvent) {
	if (event.button !== 0 && event.pointerType === "mouse") return;
	event.stopPropagation();
	event.preventDefault();
	isSeeking = true;
	if (isThisCardActive) {
		privateMusic.setScrubbing(true);
	}
	try {
		scrubberEl?.setPointerCapture(event.pointerId);
	} catch {
		// ignore
	}
	const ratio = getRatioFromPointer(scrubberEl, event.clientX);
	if (effectiveDuration > 0) {
		previewSeekSec = ratio * effectiveDuration;
	}
}

function handleScrubberPointerMove(event: PointerEvent) {
	if (!isSeeking) return;
	event.stopPropagation();
	const ratio = getRatioFromPointer(scrubberEl, event.clientX);
	if (effectiveDuration > 0) {
		previewSeekSec = ratio * effectiveDuration;
	}
}

function handleScrubberPointerUp(event: PointerEvent) {
	if (!isSeeking) return;
	event.stopPropagation();
	isSeeking = false;
	if (isThisCardActive) {
		privateMusic.setScrubbing(false);
	}
	try {
		scrubberEl?.releasePointerCapture(event.pointerId);
	} catch {
		// ignore
	}
	const ratio = getRatioFromPointer(scrubberEl, event.clientX);
	commitSeekToRatio(ratio);
}

function handleScrubberPointerCancel(event: PointerEvent) {
	if (!isSeeking) return;
	event.stopPropagation();
	isSeeking = false;
	previewSeekSec = null;
	if (isThisCardActive) {
		privateMusic.setScrubbing(false);
	}
	try {
		scrubberEl?.releasePointerCapture(event.pointerId);
	} catch {
		// ignore
	}
}

function handleScrubberKeyDown(event: KeyboardEvent) {
	if (effectiveDuration <= 0) return;
	let delta = 0;
	if (event.key === "ArrowRight") delta = 5;
	else if (event.key === "ArrowLeft") delta = -5;
	else return;
	event.preventDefault();
	event.stopPropagation();
	const next = Math.min(effectiveDuration, Math.max(0, currentTimeSec + delta));
	commitSeekToRatio(next / effectiveDuration);
}

// Volume handlers (zero-lag pointer capture)
function applyVolume(ratio: number) {
	privateMusic.setVolume(ratio);
}

function togglePreviewMute(event: MouseEvent) {
	event.stopPropagation();
	privateMusic.toggleMute();
}

function handleVolumePointerDown(event: PointerEvent) {
	if (event.button !== 0 && event.pointerType === "mouse") return;
	event.stopPropagation();
	event.preventDefault();
	isDraggingVolume = true;
	try {
		volumeSliderEl?.setPointerCapture(event.pointerId);
	} catch {
		// ignore
	}
	applyVolume(getRatioFromPointer(volumeSliderEl, event.clientX));
}

function handleVolumePointerMove(event: PointerEvent) {
	if (!isDraggingVolume) return;
	event.stopPropagation();
	applyVolume(getRatioFromPointer(volumeSliderEl, event.clientX));
}

function handleVolumePointerUp(event: PointerEvent) {
	if (!isDraggingVolume) return;
	event.stopPropagation();
	isDraggingVolume = false;
	try {
		volumeSliderEl?.releasePointerCapture(event.pointerId);
	} catch {
		// ignore
	}
	applyVolume(getRatioFromPointer(volumeSliderEl, event.clientX));
}

function handleVolumePointerCancel(event: PointerEvent) {
	if (!isDraggingVolume) return;
	event.stopPropagation();
	isDraggingVolume = false;
	try {
		volumeSliderEl?.releasePointerCapture(event.pointerId);
	} catch {
		// ignore
	}
}

function handleVolumeKeyDown(event: KeyboardEvent) {
	let delta = 0;
	if (event.key === "ArrowRight" || event.key === "ArrowUp") delta = 0.05;
	else if (event.key === "ArrowLeft" || event.key === "ArrowDown") delta = -0.05;
	else return;
	event.preventDefault();
	event.stopPropagation();
	applyVolume(previewVolume + delta);
}

async function handleToggleFavorite(event: MouseEvent) {
	event.stopPropagation();
	if (!currentUserKey || !playlistAuth?.token) {
		onRequireAuth?.();
		return;
	}
	if (isFavoriteToggling || !chatServerUrl) return;
	isFavoriteToggling = true;
	try {
		const res = await toggleFavoriteTrack({
			chatServerUrl,
			token: playlistAuth.token,
			authKind: playlistAuth.kind,
			track: toMusicTrack(),
			userKey: currentUserKey,
		});
		isFavorited = Boolean(res.favorited);
		onFavoriteChanged?.();
		onNotify?.(
			isFavorited
				? `已将《${data.title}》收藏到全站共享收藏`
				: `已取消收藏《${data.title}》`,
			"success",
		);
	} catch (err) {
		onNotify?.(
			err instanceof Error ? err.message : "收藏操作失败",
			"error",
		);
	} finally {
		isFavoriteToggling = false;
	}
}

async function handleEnqueue(event: MouseEvent) {
	event.stopPropagation();
	if (!onEnqueueTrack || isEnqueuing || alreadyInRoom) return;
	const anchor = event.currentTarget as HTMLElement;
	isEnqueuing = true;
	try {
		const res = await onEnqueueTrack(toMusicTrack(), anchor);
		if (res === true) {
			onNotify?.(`已将《${data.title}》加入点歌台队列`, "success");
		}
	} catch (err) {
		onNotify?.(
			err instanceof Error ? err.message : "点歌请求发送失败，请重试",
			"error",
		);
	} finally {
		isEnqueuing = false;
	}
}
</script>

<div
  class="chat-music-card relative overflow-hidden rounded-2xl text-left transition-colors duration-200 {isSelf ? 'chat-music-card--self' : 'chat-music-card--peer'} {isPlaying ? 'chat-music-card--playing' : ''}"
  role="region"
  aria-label={`音乐分享：${data.title} - ${data.artist}`}
>
  <div class="relative z-10 p-3.5 flex flex-col gap-2 min-w-0">
    <!-- 顶部主区：静态圆角矩形封面 + 两行可选中复制文本 + 博客原生底色播放键 -->
    <div class="flex items-center gap-3 min-w-0">
      <div class="relative shrink-0 w-[52px] h-[52px] rounded-xl overflow-hidden border border-black/8 dark:border-white/10 bg-(--primary)/10 shadow-xs flex items-center justify-center select-none">
        {#if data.cover && !coverFailed}
          <img
            src={data.cover}
            alt={`${data.title} 封面`}
            loading="lazy"
            decoding="async"
            class="w-full h-full object-cover block"
            onerror={() => {
              coverFailed = true;
            }}
          />
        {:else}
          <svg class="w-6 h-6 block text-(--primary) opacity-60" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
          </svg>
        {/if}
      </div>

      <!-- 中间两行文本：允许鼠标自由选中与复制 -->
      <div
        class="flex-1 min-w-0 flex flex-col justify-center gap-1 select-text cursor-text"
        onpointerdown={(e) => e.stopPropagation()}
        onclick={(e) => e.stopPropagation()}
      >
        <div
          class="text-[13.5px] font-bold h-5 leading-5 truncate transition-colors duration-200 {topLineContent.tone === 'lyric'
            ? 'text-(--primary)'
            : topLineContent.tone === 'error'
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-[var(--deep-text)]'}"
          title={topLineContent.text}
          aria-live="polite"
        >
          {topLineContent.text}
        </div>

        <div class="flex items-center min-w-0 h-4 text-[12px] leading-4 overflow-hidden">
          {#if showSongArtistSubline}
            <span
              class="font-medium text-[var(--deep-text)] truncate shrink-0 max-w-[68%]"
              title={data.title}
            >
              {data.title}
            </span>
            <span
              class="text-[var(--chat-meta-color)] truncate min-w-0 flex-1"
              title={artistText}
            >
              &nbsp;-&nbsp;{artistText}
            </span>
          {:else}
            <span
              class="text-[var(--chat-meta-color)] truncate min-w-0 flex-1"
              title={artistText}
            >
              {artistText}
            </span>
          {/if}
        </div>
      </div>

      <!-- 右侧：博客原生同款底色圆角矩形播放/暂停键 -->
      <button
        type="button"
        class="chat-music-play-btn w-10 h-10 rounded-xl inline-flex items-center justify-center border-none cursor-pointer transition-[background-color,color,transform] duration-150 active:scale-95 shrink-0 select-none {isPlaying
          ? 'bg-(--primary) text-white hover:brightness-110'
          : 'bg-(--btn-regular-bg) hover:bg-(--btn-regular-bg-hover) active:bg-(--btn-regular-bg-active) text-(--primary)'}"
        aria-label={isPlaying ? `暂停 ${data.title}` : `试听 ${data.title}`}
        onclick={togglePreview}
      >
        {#if isBufferingSlow}
          <svg class="w-[17px] h-[17px] block animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.6" opacity="0.28" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" />
          </svg>
        {:else if isPlaying}
          <svg class="w-[17px] h-[17px] block" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="5.5" y="4.5" width="4.5" height="15" rx="1.6" />
            <rect x="14" y="4.5" width="4.5" height="15" rx="1.6" />
          </svg>
        {:else}
          <svg class="w-[17px] h-[17px] block" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8.5 5.45c0-1.08 1.19-1.74 2.11-1.17l9.28 5.79c.86.54.86 1.8 0 2.34l-9.28 5.79c-.92.57-2.11-.09-2.11-1.17V5.45z" />
          </svg>
        {/if}
      </button>
    </div>

    <!-- 进度条 + 下方：左侧时间 / 右侧迷你音量调节 -->
    <div class="flex flex-col gap-1 min-w-0 select-none pt-1">
      <div class="py-1.5">
        <div
          bind:this={scrubberEl}
          role="slider"
          tabindex="0"
          aria-label="拖动调整试听进度"
          aria-valuemin={0}
          aria-valuemax={Math.round(effectiveDuration)}
          aria-valuenow={Math.round(currentTimeSec)}
          class="chat-slim-slider {isSeeking ? 'chat-slim-slider--dragging' : ''}"
          style="--pct: {progressPercent / 100};"
          onclick={(e) => e.stopPropagation()}
          onpointerdown={handleScrubberPointerDown}
          onpointermove={handleScrubberPointerMove}
          onpointerup={handleScrubberPointerUp}
          onpointercancel={handleScrubberPointerCancel}
          onkeydown={handleScrubberKeyDown}
        >
          {#if isLoadingAudio && currentTimeSec === 0}
            <div class="w-full h-full rounded-full overflow-hidden pointer-events-none">
              <div class="chat-music-track-loading h-full w-1/3 bg-(--primary) rounded-full"></div>
            </div>
          {:else}
            <div class="chat-slim-slider-fill"></div>
          {/if}
          <div class="chat-slim-slider-thumb"></div>
        </div>
      </div>

      <div class="flex items-center justify-between gap-2 h-5">
        <div class="text-[10.5px] leading-none text-neutral-400 flex items-center gap-1.5 min-w-0 truncate">
          <span class="font-mono tabular-nums inline-flex items-center gap-1 shrink-0">
            <span class="text-neutral-600 dark:text-neutral-300">{formatSec(currentTimeSec)}</span>
            <span class="opacity-50" aria-hidden="true">/</span>
            <span>{formatSec(effectiveDuration)}</span>
          </span>
          <span class="opacity-50 shrink-0" aria-hidden="true">·</span>
          <span class="truncate text-neutral-500 dark:text-neutral-400">{platformLabel}</span>
        </div>

        <!-- 与「分享音乐」/「点歌台」一致的音量调节 -->
        <div class="flex items-center gap-1.5 shrink-0 h-full">
          <button
            type="button"
            class="inline-flex items-center justify-center w-5 h-5 rounded-md border-none bg-transparent text-neutral-400 hover:text-(--primary) cursor-pointer transition-colors p-0"
            aria-label={isPreviewMuted || previewVolume === 0 ? "取消静音" : "静音试听"}
            onclick={togglePreviewMute}
          >
            {#if isPreviewMuted || previewVolume === 0}
              <svg class="w-3.5 h-3.5 block" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
              </svg>
            {:else}
              <svg class="w-3.5 h-3.5 block" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
              </svg>
            {/if}
          </button>

          <div class="w-16 flex items-center">
            <div
              bind:this={volumeSliderEl}
              role="slider"
              tabindex="0"
              aria-label="试听音量"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={effectiveVolumePercent}
              class="chat-slim-slider {isDraggingVolume ? 'chat-slim-slider--dragging' : ''}"
              style="--pct: {effectiveVolumePercent / 100};"
              onclick={(e) => e.stopPropagation()}
              onpointerdown={handleVolumePointerDown}
              onpointermove={handleVolumePointerMove}
              onpointerup={handleVolumePointerUp}
              onpointercancel={handleVolumePointerCancel}
              onkeydown={handleVolumeKeyDown}
            >
              <div class="chat-slim-slider-fill"></div>
              <div class="chat-slim-slider-thumb"></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部操作行：全为真实可交互的博客原生底色圆角按钮，均衡排布 -->
    <div class="flex items-center gap-2 pt-0.5 min-w-0 select-none">
      <!-- 一键全站收藏 -->
      <button
        type="button"
        disabled={isFavoriteToggling}
        class="flex-1 inline-flex items-center justify-center gap-1 h-7.5 px-2.5 rounded-lg bg-(--btn-regular-bg) hover:bg-(--btn-regular-bg-hover) active:bg-(--btn-regular-bg-active) text-[11.5px] font-semibold border-none cursor-pointer transition-all active:scale-95 disabled:opacity-60 disabled:cursor-wait min-w-0 {isFavorited ? 'text-amber-500 dark:text-amber-400' : 'text-neutral-600 dark:text-neutral-300 hover:text-amber-500'}"
        aria-label={isFavorited ? `取消收藏 ${data.title}` : `收藏 ${data.title}`}
        onclick={handleToggleFavorite}
      >
        <svg
          class="w-3.5 h-3.5 block shrink-0"
          viewBox="0 0 24 24"
          fill={isFavorited ? "currentColor" : "none"}
          stroke="currentColor"
          stroke-width={isFavorited ? "1.2" : "2"}
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polygon points="12 1.9 14.35 9.15 21.95 9.15 15.8 13.62 18.15 20.87 12 16.39 5.85 20.87 8.2 13.62 2.05 9.15 9.65 9.15" />
        </svg>
        <span class="truncate">{isFavorited ? "已收藏" : "收藏"}</span>
      </button>

      {#if onEnqueueTrack}
        {#if alreadyInRoom}
          <span
            class="flex-1 inline-flex items-center justify-center gap-1 h-7.5 px-2.5 rounded-lg bg-neutral-100 dark:bg-white/8 text-neutral-500 dark:text-neutral-400 text-[11.5px] font-semibold min-w-0"
            aria-label={isCurrentPlaying ? "点歌台正在播放这首歌" : "这首歌已在点歌台待播队列中"}
          >
            <svg class="w-3.5 h-3.5 block shrink-0 text-(--primary)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span class="truncate">{isCurrentPlaying ? "房间在播" : "已入队"}</span>
          </span>
        {:else}
          <button
            type="button"
            disabled={isEnqueuing}
            class="flex-1 inline-flex items-center justify-center gap-1 h-7.5 px-2.5 rounded-lg bg-(--btn-regular-bg) hover:bg-(--btn-regular-bg-hover) active:bg-(--btn-regular-bg-active) text-(--primary) text-[11.5px] font-semibold border-none cursor-pointer transition-all active:scale-95 disabled:opacity-60 disabled:cursor-wait min-w-0"
            aria-label={`点歌 ${data.title} 加入点歌台`}
            onclick={handleEnqueue}
          >
            {#if isEnqueuing}
              <svg class="w-3.5 h-3.5 block shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
              </svg>
              <span class="truncate">点歌中</span>
            {:else}
              <svg class="w-3.5 h-3.5 block shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span class="truncate">点歌</span>
            {/if}
          </button>
        {/if}
      {/if}

      {#if externalHref}
        <a
          href={externalHref}
          target="_blank"
          rel="noopener noreferrer"
          class="flex-1 inline-flex items-center justify-center gap-1 h-7.5 px-2.5 rounded-lg bg-(--btn-regular-bg) hover:bg-(--btn-regular-bg-hover) active:bg-(--btn-regular-bg-active) text-neutral-600 dark:text-neutral-300 hover:text-(--primary) text-[11.5px] font-semibold transition-all active:scale-95 no-underline min-w-0"
          aria-label="在新窗口打开原曲链接"
          onclick={(e) => e.stopPropagation()}
        >
          <span class="truncate">查看原曲</span>
          <svg class="w-3 h-3 block shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>
      {/if}
    </div>
  </div>
</div>

<style>
  .chat-music-card {
    width: 356px;
    max-width: 100%;
    background-color: var(--skin-surface, #ffffff);
    border: 1px solid var(--skin-line, rgba(0, 0, 0, 0.1));
    box-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.06);
    color: var(--skin-text);
  }

  .chat-music-card:hover {
    border-color: color-mix(in srgb, var(--primary) 42%, var(--skin-line, rgba(0, 0, 0, 0.12)));
  }

  .chat-music-card--playing {
    border-color: color-mix(in srgb, var(--primary) 50%, var(--skin-line, rgba(0, 0, 0, 0.12)));
  }

  .chat-music-track-loading {
    opacity: 0.75;
    animation: chat-music-indeterminate 1.2s ease-in-out infinite;
  }

  @keyframes chat-music-indeterminate {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(350%);
    }
  }

  :global(.dark) .chat-music-card {
    background-color: var(--skin-surface, #1e1e20);
    border-color: var(--skin-line, rgba(255, 255, 255, 0.12));
    box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.35);
  }

  @media (max-width: 480px) {
    .chat-music-card {
      width: min(356px, calc(100vw - 84px));
    }
  }
</style>
