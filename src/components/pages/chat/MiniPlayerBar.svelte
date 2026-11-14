<script lang="ts">
import { formatClockSeconds } from "./chatClient";
import type { CurrentPlayback } from "./chatTypes";

interface Props {
	currentPlay: CurrentPlayback;
	isListening: boolean;
	elapsedSec: number;
	durationSec: number;
	canDirectSkip: boolean;
	isSoloCoolingDown: boolean;
	soloCooldownRemainSec: number;
	hasVotedSkip: boolean;
	voteCount: number;
	voteThreshold: number;
	isSkippingTrack?: boolean;
	variant?: "panel" | "mobile";
	onOpenLyrics: () => void;
	onToggleListen: () => void;
	onSkipTrack: () => void;
	onVoteSkip: () => void;
}

const {
	currentPlay,
	isListening,
	elapsedSec,
	durationSec,
	canDirectSkip,
	isSoloCoolingDown,
	soloCooldownRemainSec,
	hasVotedSkip,
	voteCount,
	voteThreshold,
	isSkippingTrack = false,
	variant = "panel",
	onOpenLyrics,
	onToggleListen,
	onSkipTrack,
	onVoteSkip,
}: Props = $props();

let coverFailed = $state(false);

$effect(() => {
	currentPlay.uid;
	coverFailed = false;
});

const progressRatio = $derived(
	durationSec > 0 ? Math.min(1, Math.max(0, elapsedSec / durationSec)) : 0,
);
</script>

<div
  class={variant === "mobile" ? "chat-mobile-global-player" : "chat-mini-player"}
  role="region"
  aria-label="当前正在播放"
>
  <div class="chat-mini-progress-bar" aria-hidden="true">
    <div class="chat-mini-progress-fill" style="--pct: {progressRatio};"></div>
  </div>

  <button
    type="button"
    class="flex items-center gap-2 min-w-0 flex-1 text-left bg-transparent border-none p-0 cursor-pointer group"
    aria-label={`查看 ${currentPlay.track.title} 歌词与播放详情`}
    onclick={onOpenLyrics}
  >
    <div class="w-8 h-8 rounded-full overflow-hidden shrink-0 border border-white/70 dark:border-neutral-700/80 bg-(--primary)/12 flex items-center justify-center shadow-xs">
      {#if currentPlay.track.cover && !coverFailed}
        <img
          src={currentPlay.track.cover}
          alt=""
          class="w-full h-full object-cover chat-spin-slow"
          style={isListening ? "" : "animation-play-state: paused;"}
          onerror={() => (coverFailed = true)}
        />
      {:else}
        <span class="text-xs text-(--primary)">♪</span>
      {/if}
    </div>

    <div class="min-w-0 flex-1">
      <div class="text-xs font-bold text-[var(--deep-text)] group-hover:text-(--primary) transition-colors truncate">
        {currentPlay.track.title}
      </div>
      <div class="text-[10px] text-[var(--chat-meta-color)] truncate tabular-nums">
        {currentPlay.track.artist} · {formatClockSeconds(elapsedSec)}{durationSec > 0 ? ` / ${formatClockSeconds(durationSec)}` : ""}
      </div>
    </div>
  </button>

  <div class="flex items-center gap-1 shrink-0">
    <div class="chat-playlist-action-wrap">
      <button
        type="button"
        class="chat-queue-icon-btn w-7! h-7! rounded-lg! {isListening ? 'bg-(--primary)/14! text-[var(--chat-accent-text)]!' : ''}"
        aria-label={isListening ? "静音电台" : "开启收听"}
        onclick={onToggleListen}
      >
        {#if isListening}
          <span class="chat-eq-bars" aria-hidden="true">
            <span class="chat-eq-bar"></span>
            <span class="chat-eq-bar"></span>
            <span class="chat-eq-bar"></span>
          </span>
        {:else}
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
          </svg>
        {/if}
      </button>
      <span class="chat-playlist-tooltip" role="tooltip">
        {isListening ? "静音电台" : "开启收听"}
      </span>
    </div>

    <div class="chat-playlist-action-wrap">
      {#if canDirectSkip}
        <button
          type="button"
          disabled={isSkippingTrack}
          class="chat-queue-icon-btn w-7! h-7! rounded-lg! {voteCount > 0 ? 'bg-(--primary)/14! text-[var(--chat-accent-text)]!' : ''} disabled:opacity-75 disabled:cursor-wait!"
          aria-label={isSkippingTrack ? "正在切歌..." : voteCount > 0 ? `直接切歌（已有 ${voteCount}/${voteThreshold} 票）` : "直接切歌"}
          onclick={onSkipTrack}
        >
          {#if isSkippingTrack}
            <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity="0.25" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
            </svg>
          {:else}
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
            </svg>
          {/if}
        </button>
        <span class="chat-playlist-tooltip align-right" role="tooltip">
          {#if isSkippingTrack}
            正在切歌...
          {:else if voteCount > 0}
            直接切歌（已有 {voteCount}/{voteThreshold} 票）
          {:else}
            直接切歌
          {/if}
        </span>
      {:else if isSoloCoolingDown}
        <button
          type="button"
          class="chat-queue-icon-btn w-auto! px-1.5! h-7! rounded-lg! text-[10px] font-semibold tabular-nums"
          aria-label={`切歌冷却中 (${soloCooldownRemainSec}s)`}
          onclick={onSkipTrack}
        >
          {soloCooldownRemainSec}s
        </button>
        <span class="chat-playlist-tooltip align-right" role="tooltip">
          切歌冷却中（{soloCooldownRemainSec}s）
        </span>
      {:else}
        <button
          type="button"
          disabled={isSkippingTrack}
          class="chat-queue-icon-btn w-7! h-7! rounded-lg! {hasVotedSkip ? 'bg-(--primary)/14! text-[var(--chat-accent-text)]!' : ''} disabled:opacity-75 disabled:cursor-wait!"
          aria-pressed={hasVotedSkip}
          aria-label={isSkippingTrack ? "正在切歌..." : hasVotedSkip ? `取消投票（已投 ${voteCount}/${voteThreshold} 票）` : voteCount > 0 ? `投票切歌（已投 ${voteCount}/${voteThreshold} 票）` : "投票切歌"}
          onclick={onVoteSkip}
        >
          {#if isSkippingTrack}
            <svg class="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity="0.25" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
            </svg>
          {:else}
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
            </svg>
          {/if}
        </button>
        <span class="chat-playlist-tooltip align-right" role="tooltip">
          {#if isSkippingTrack}
            正在切歌...
          {:else if hasVotedSkip}
            取消投票（已投 {voteCount}/{voteThreshold} 票）
          {:else if voteCount > 0}
            投票切歌（已投 {voteCount}/{voteThreshold} 票）
          {:else}
            投票切歌
          {/if}
        </span>
      {/if}
    </div>
  </div>
</div>
