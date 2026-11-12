<script lang="ts">
import ChatMarkdownContent from "./ChatMarkdownContent.svelte";
import type { ChatMessageRecord } from "./chatTypes";
import { parseChatSegments, type StickerItem } from "./stickerLoader";

interface Props {
	message: ChatMessageRecord;
	isSelf: boolean;
	isMentionedMe?: boolean;
	isHighlighted?: boolean;
	currentUserName?: string;
	canDelete?: boolean;
	stickerMap: Map<string, StickerItem>;
	onDelete?: (msgUid: string) => void;
	onMention?: (name: string) => void;
}

const {
	message,
	isSelf,
	isMentionedMe = false,
	isHighlighted = false,
	currentUserName = "",
	canDelete = false,
	stickerMap,
	onDelete,
	onMention,
}: Props = $props();

let imgError = $state(false);

$effect(() => {
	message.avatar;
	imgError = false;
});

const isAvatarUrl = $derived(
	!imgError &&
		(message.avatar.startsWith("http://") ||
			message.avatar.startsWith("https://") ||
			message.avatar.startsWith("/")),
);

const segments = $derived(
	parseChatSegments(message.content, stickerMap, message.mentions),
);

const stickerSegments = $derived(
	segments.filter((seg) => seg.kind === "sticker"),
);
const isStickerOnly = $derived(
	message.attachments.length === 0 &&
		stickerSegments.length > 0 &&
		segments.every(
			(seg) =>
				seg.kind === "sticker" ||
				(seg.kind === "text" && seg.text.trim() === ""),
		),
);

const formattedTime = $derived.by(() => {
	if (!message.createdAt) return "";
	const d = new Date(message.createdAt);
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	return `${h}:${m}`;
});
</script>

{#if message.kind === "system"}
  <div class="w-full flex justify-center my-1.5">
    <div class="chat-system-msg">
      <span class="w-1.5 h-1.5 rounded-full bg-[var(--primary)] opacity-80 shrink-0"></span>
      <span>{message.content}</span>
    </div>
  </div>
{:else if isSelf}
  <div data-msg-uid={message.msgUid} class="flex flex-row-reverse items-start gap-2.5 my-1 group {isHighlighted ? 'chat-msg-jump-highlight' : ''}">
    {#if isAvatarUrl}
      <img
        src={message.avatar}
        alt={message.name || "我"}
        class="chat-avatar"
        onerror={() => (imgError = true)}
      />
    {:else}
      <div class="chat-avatar flex items-center justify-center font-bold text-sm text-[var(--btn-content)] select-none">
        {message.name ? message.name.slice(0, 1) : "我"}
      </div>
    {/if}

    <div class="flex flex-col items-end max-w-[74%] min-w-0">
      {#if message.name || message.badge}
        <div class="flex items-center justify-end gap-1.5 mb-1 px-0.5 min-w-0 max-w-full">
          {#if canDelete && onDelete}
            <button
              type="button"
              class="opacity-0 group-hover:opacity-100 text-[11px] text-[var(--chat-meta-color)] hover:text-red-500 border-none bg-transparent cursor-pointer px-1 transition-opacity"
              onclick={() => onDelete?.(message.msgUid)}
            >
              撤回
            </button>
          {/if}
          {#if message.badge}
            <span class="chat-role-badge chat-role-badge--{message.badgeType}">{message.badge}</span>
          {/if}
          {#if message.name}
            <span class="text-xs text-[var(--chat-meta-color)] font-medium truncate">{message.name}</span>
          {/if}
        </div>
      {/if}

      {#if isStickerOnly}
        <div class="chat-sticker-only-wrap justify-end">
          {#each stickerSegments as seg, idx (`${idx}-${seg.code}`)}
            <img
              src={seg.url}
              alt={seg.alt}
              title={seg.alt}
              class="chat-sticker-large {stickerSegments.length === 1 ? 'single' : ''}"
              loading="lazy"
            />
          {/each}
        </div>
      {:else}
        <div class="chat-bubble chat-bubble-self">
          {#if message.content.trim().length > 0}
            <ChatMarkdownContent
              content={message.content}
              stickerMap={stickerMap}
              mentions={message.mentions}
              currentUserName={currentUserName}
            />
          {/if}

          {#if message.attachments.length > 0}
            <div class="chat-msg-images {message.content.trim().length > 0 ? 'mt-2' : ''}">
              {#each message.attachments as att (att.url)}
                <a
                  href={att.url}
                  data-fancybox="chat-images"
                  class="block overflow-hidden rounded-lg border border-black/10 dark:border-white/10"
                >
                  <img
                    src={att.url}
                    alt="聊天图片"
                    loading="lazy"
                    class="chat-msg-image"
                  />
                </a>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if formattedTime}
        <span class="text-[0.6875rem] text-[var(--chat-meta-color)] mt-1 px-1 select-none">
          {formattedTime}
        </span>
      {/if}
    </div>
  </div>
{:else}
  <div data-msg-uid={message.msgUid} class="flex items-start gap-2.5 my-1 group {isHighlighted ? 'chat-msg-jump-highlight' : ''}">
    <button
      type="button"
      class="p-0 border-none bg-transparent cursor-pointer shrink-0 rounded-full"
      title={`@ ${message.name}`}
      onclick={() => onMention?.(message.name)}
    >
      {#if isAvatarUrl}
        <img
          src={message.avatar}
          alt={message.name}
          class="chat-avatar"
          onerror={() => (imgError = true)}
        />
      {:else}
        <div class="chat-avatar flex items-center justify-center font-bold text-sm text-[var(--chat-accent-text)] select-none">
          {message.name ? message.name.slice(0, 1) : "?"}
        </div>
      {/if}
    </button>

    <div class="flex flex-col items-start max-w-[74%] min-w-0">
      {#if message.name || message.badge}
        <div class="flex items-center gap-1.5 mb-1 px-0.5 min-w-0 max-w-full">
          {#if message.url}
            <a
              href={message.url}
              target="_blank"
              rel="noopener noreferrer"
              class="text-xs text-[var(--chat-meta-color)] hover:text-[var(--primary)] font-medium truncate no-underline"
              title={`访问 ${message.name} 的主页`}
            >
              {message.name}
            </a>
          {:else if message.name}
            <span class="text-xs text-[var(--chat-meta-color)] font-medium truncate">{message.name}</span>
          {/if}
          {#if message.badge}
            <span class="chat-role-badge chat-role-badge--{message.badgeType}">{message.badge}</span>
          {/if}
          {#if isMentionedMe}
            <span class="chat-mentioned-tag">@了你</span>
          {/if}
          {#if canDelete && onDelete}
            <button
              type="button"
              class="opacity-0 group-hover:opacity-100 text-[11px] text-[var(--chat-meta-color)] hover:text-red-500 border-none bg-transparent cursor-pointer px-1 transition-opacity"
              onclick={() => onDelete?.(message.msgUid)}
            >
              删除
            </button>
          {/if}
        </div>
      {/if}

      {#if isStickerOnly}
        <div class="chat-sticker-only-wrap justify-start">
          {#each stickerSegments as seg, idx (`${idx}-${seg.code}`)}
            <img
              src={seg.url}
              alt={seg.alt}
              title={seg.alt}
              class="chat-sticker-large {stickerSegments.length === 1 ? 'single' : ''}"
              loading="lazy"
            />
          {/each}
        </div>
      {:else}
        <div class="chat-bubble chat-bubble-other {isMentionedMe ? 'chat-bubble-mentioned' : ''}">
          {#if message.content.trim().length > 0}
            <ChatMarkdownContent
              content={message.content}
              stickerMap={stickerMap}
              mentions={message.mentions}
              currentUserName={currentUserName}
            />
          {/if}

          {#if message.attachments.length > 0}
            <div class="chat-msg-images {message.content.trim().length > 0 ? 'mt-2' : ''}">
              {#each message.attachments as att (att.url)}
                <a
                  href={att.url}
                  data-fancybox="chat-images"
                  class="block overflow-hidden rounded-lg border border-black/10 dark:border-white/10"
                >
                  <img
                    src={att.url}
                    alt="聊天图片"
                    loading="lazy"
                    class="chat-msg-image"
                  />
                </a>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if formattedTime}
        <span class="text-[0.6875rem] text-[var(--chat-meta-color)] mt-1 px-1 select-none">
          {formattedTime}
        </span>
      {/if}
    </div>
  </div>
{/if}
