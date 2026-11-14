<script lang="ts">
import type { Snippet } from "svelte";

interface Props {
	text?: string;
	align?: "center" | "left" | "right";
	position?: "top" | "bottom";
	disabled?: boolean;
	class?: string;
	tooltipClass?: string;
	children: Snippet;
	content?: Snippet;
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
  {@render children()}
  {#if !disabled && (text || content)}
    <span class="chat-tooltip {alignClass} {positionClass} {tooltipClass}" role="tooltip">
      {#if content}
        {@render content()}
      {:else}
        {text}
      {/if}
    </span>
  {/if}
</div>
