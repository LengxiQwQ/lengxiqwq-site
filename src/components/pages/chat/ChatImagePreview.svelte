<script lang="ts">
import {
	chatImageLayout,
	type ChatImageDimensions,
	type ChatImageResizeDetail,
	getChatImageDimensions,
	rememberChatImageDimensions,
	validateChatImageDimensions,
} from "./chatImageLayout";
import { openChatImageLightbox } from "./chatLightbox";

interface Props {
	src: string;
	alt: string;
	metadata?: Partial<ChatImageDimensions>;
	inline?: boolean;
}

const { src, alt, metadata, inline = false }: Props = $props();
let loaded = $state<{ src: string; size: ChatImageDimensions }>();
const size = $derived(loaded?.src === src ? loaded.size : getChatImageDimensions(src, metadata));
const layout = $derived(chatImageLayout(size));

function handleLoad(event: Event & { currentTarget: HTMLImageElement }) {
	const img = event.currentTarget;
	const actual = validateChatImageDimensions(img.naturalWidth, img.naturalHeight);
	if (!actual || (actual.width === size?.width && actual.height === size.height)) return;
	const imageSrc = src;
	const apply = () => {
		rememberChatImageDimensions(imageSrc, actual);
		loaded = { src: imageSrc, size: actual };
	};
	// The virtual list captures its scroll anchor before the resize is applied.
	const resize = new CustomEvent<ChatImageResizeDetail>("chat-image-resize", {
		bubbles: true,
		cancelable: true,
		detail: { apply },
	});
	if (img.dispatchEvent(resize)) apply();
}
</script>

<a
  href={src}
  data-chat-image={src}
  class="{inline ? 'inline-flex align-top my-1' : 'flex w-fit'} min-w-0 max-w-full overflow-hidden rounded-lg border border-black/10 dark:border-white/10 cursor-zoom-in"
  onclick={(e) => {
    e.preventDefault();
    void openChatImageLightbox(src, e.currentTarget);
  }}
>
  <img
    {src}
    {alt}
    loading="lazy"
    decoding="async"
    width={size?.width}
    height={size?.height}
    style:--chat-preview-width={size ? `min(${layout.intrinsicWidth}px, ${layout.maxWidthRem}rem)` : `${layout.maxWidthRem}rem`}
    style:--chat-preview-ratio={layout.ratio}
    onload={handleLoad}
    class="chat-msg-image"
  />
</a>
