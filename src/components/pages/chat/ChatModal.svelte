<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	open: boolean;
	title: string;
	subtitle?: string;
	ariaLabel?: string;
	size?: "sm" | "md" | "lg";
	fillHeightOnDesktop?: boolean;
	lockedMinHeight?: number;
	onClose: () => void;
	headerExtra?: Snippet;
	children: Snippet;
}

const {
	open,
	title,
	subtitle = "",
	ariaLabel = "",
	size = "sm",
	fillHeightOnDesktop = false,
	lockedMinHeight = 0,
	onClose,
	headerExtra,
	children,
}: Props = $props();

let backdropEl: HTMLDivElement | null = $state(null);
let backdropPointerDown = false;

$effect(() => {
	if (!open) return;
	const handleKeydown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			onClose();
		}
	};
	document.addEventListener("keydown", handleKeydown);
	return () => document.removeEventListener("keydown", handleKeydown);
});

function handlePointerDown(e: PointerEvent) {
	backdropPointerDown = e.target === backdropEl;
}

function handleBackdropClick(e: MouseEvent) {
	if (backdropPointerDown && e.target === backdropEl) {
		onClose();
	}
	backdropPointerDown = false;
}

const sizeClass = $derived(
	size === "lg"
		? "chat-dialog-card--lg"
		: size === "md"
			? "chat-dialog-card--md"
			: "chat-dialog-card--sm",
);
</script>

{#if open}
  <div
    bind:this={backdropEl}
    class="chat-modal-backdrop"
    role="presentation"
    onpointerdown={handlePointerDown}
    onclick={handleBackdropClick}
  >
    <div
      class="chat-dialog-card {sizeClass} {fillHeightOnDesktop ? 'chat-dialog-card--fill-md' : ''}"
      style={lockedMinHeight > 0 ? `min-height: min(${lockedMinHeight}px, 100%);` : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel || title}
    >
      <header class="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-(--chat-divider-color)">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 min-w-0">
            <h3 class="text-sm font-bold text-[var(--deep-text)] m-0 truncate">
              {title}
            </h3>
            {#if headerExtra}
              {@render headerExtra()}
            {/if}
          </div>
          {#if subtitle}
            <p class="text-[11px] text-[var(--chat-meta-color)] mt-0.5 mb-0 truncate">
              {subtitle}
            </p>
          {/if}
        </div>
        <button
          type="button"
          class="chat-tool-btn w-7! h-7! shrink-0"
          aria-label="关闭弹窗"
          onclick={onClose}
        >
          <svg
            class="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
        {@render children()}
      </div>
    </div>
  </div>
{/if}
