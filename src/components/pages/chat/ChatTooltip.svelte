<script lang="ts">
import type { Snippet } from "svelte";
import { positionChatFloating } from "./chatFloating";

interface Props {
	text?: string;
	align?: "center" | "left" | "right";
	position?: "top" | "bottom";
	disabled?: boolean;
	class?: string;
	tooltipClass?: string;
	children?: Snippet;
	content?: Snippet | string;
}

const {
	text = "",
	align = "center",
	position = "top",
	disabled = false,
	class: className = "",
	tooltipClass = "",
	children,
	content,
}: Props = $props();

const placement = $derived(
	align === "left"
		? (`${position}-start` as const)
		: align === "right"
			? (`${position}-end` as const)
			: position,
);
</script>

<div class="chat-tooltip-wrap {className}">
  {#if children}
    {@render children()}
  {/if}
  {#if !disabled && (text || content)}
    <span
      data-chat-floating
      use:positionChatFloating={{ placement, hover: "tooltip", gap: 7 }}
      class="chat-tooltip {tooltipClass}"
      role="tooltip"
    >
      {#if typeof content === "function"}
        {@render content()}
      {:else if content}
        {content}
      {:else}
        {text}
      {/if}
    </span>
  {/if}
</div>
