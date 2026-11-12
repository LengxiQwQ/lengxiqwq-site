<script lang="ts">
import { getAvatarInitials, resolveChatAvatarUrl } from "./chatClient";

type AvatarSize = "2xs" | "xs" | "sm" | "md" | "lg";

interface Props {
	src?: string;
	name?: string;
	fallback?: string;
	alt?: string;
	size?: AvatarSize;
	grayscale?: boolean;
	mutedTone?: boolean;
	class?: string;
}

const {
	src = "",
	name = "",
	fallback = "?",
	alt = "",
	size = "md",
	grayscale = false,
	mutedTone = false,
	class: extraClass = "",
}: Props = $props();

let imgError = $state(false);

const resolvedSrc = $derived(resolveChatAvatarUrl(src));

$effect(() => {
	resolvedSrc;
	imgError = false;
});

const showImage = $derived(Boolean(resolvedSrc) && !imgError);
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
	size === "2xs" || size === "xs" || size === "lg" ? "bg-(--primary)/15" : "",
);

const fallbackTextColorClass = $derived(
	mutedTone
		? "text-[var(--chat-meta-color)]"
		: "text-[var(--chat-accent-text)]",
);
</script>

{#if showImage}
  <img
    src={resolvedSrc}
    alt={alt || name}
    class="{boxClass} object-cover shrink-0 {grayscale ? 'grayscale-[35%]' : ''} {extraClass}"
    onerror={() => (imgError = true)}
  />
{:else}
  <div
    class="{boxClass} {fallbackBgClass} {textSizeClass} {fallbackTextColorClass} inline-flex items-center justify-center font-bold leading-none select-none shrink-0 {extraClass}"
  >
    {initials}
  </div>
{/if}
