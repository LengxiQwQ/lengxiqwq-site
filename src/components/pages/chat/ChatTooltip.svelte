<script lang="ts">
import type { Snippet } from "svelte";

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

const alignClass = $derived(
	align === "left"
		? "align-left"
		: align === "right"
			? "align-right"
			: "",
);

const positionClass = $derived(
	position === "bottom" ? "position-bottom" : "",
);
</script>

<div class="chat-tooltip-wrap {className}">
  {#if children}
    {@render children()}
  {/if}
  {#if !disabled && (text || content)}
    <span class="chat-tooltip {alignClass} {positionClass} {tooltipClass}" role="tooltip">
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
