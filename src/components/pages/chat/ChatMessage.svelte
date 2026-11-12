<script lang="ts">
import ChatAvatar from "./ChatAvatar.svelte";
import ChatMarkdownContent from "./ChatMarkdownContent.svelte";
import type { ChatMessageRecord, ChatUserDetailSeed } from "./chatTypes";
import {
	formatChatReplyPreview,
	parseChatSegments,
	type StickerItem,
} from "./stickerLoader";

interface Props {
	message: ChatMessageRecord;
	isSelf: boolean;
	isMentionedMe?: boolean;
	isHighlighted?: boolean;
	currentUserName?: string;
	canDelete?: boolean;
	deleteLabel?: string;
	stickerMap: Map<string, StickerItem>;
	onDelete?: (msgUid: string) => void;
	onReply?: (message: ChatMessageRecord) => void;
	onJumpToMessage?: (msgUid: string) => void;
	onOpenUserProfile?: (seed: ChatUserDetailSeed) => void;
	onMention?: (name: string) => void;
}

const {
	message,
	isSelf,
	isMentionedMe = false,
	isHighlighted = false,
	currentUserName = "",
	canDelete = false,
	deleteLabel = "撤回",
	stickerMap,
	onDelete,
	onReply,
	onJumpToMessage,
	onOpenUserProfile,
	onMention,
}: Props = $props();

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

const replyPreviewText = $derived.by(() => {
	if (!message.replyTo) return "";
	return formatChatReplyPreview(
		message.replyTo.content,
		stickerMap,
		message.replyTo.hasImage,
		message.replyTo.isRecalled,
	);
});

const roleBadge = $derived.by(() => {
	if (message.isAdmin) return { label: "站长", type: "host" as const };
	if (message.userKey.startsWith("waline:")) {
		return { label: "已认证", type: "accent" as const };
	}
	if (message.userKey.startsWith("guest:")) {
		return { label: "访客", type: "tag" as const };
	}
	return message.badge
		? { label: message.badge, type: message.badgeType }
		: null;
});
function handleAvatarClick() {
	if (onOpenUserProfile && message.userKey) {
		onOpenUserProfile({
			userKey: message.userKey,
			authType: message.userKey.startsWith("waline:") ? "waline" : "guest",
			name: message.name,
			avatar: message.avatar,
			url: message.url,
			badge: roleBadge?.label || message.badge,
			badgeType: roleBadge?.type || message.badgeType,
			isAdmin: message.isAdmin,
		});
		return;
	}
	if (!isSelf) {
		onMention?.(message.name);
	}
}
</script>

{#snippet replyQuoteBlock()}
  {#if message.replyTo}
    <button
      type="button"
      class="chat-reply-quote {isSelf ? 'self' : 'other'} {message.replyTo.isRecalled ? 'recalled' : ''}"
      title={message.replyTo.isRecalled ? "原消息已撤回" : "点击定位到原消息"}
      onclick={() => {
        if (message.replyTo && !message.replyTo.isRecalled) {
          onJumpToMessage?.(message.replyTo.msgUid);
        }
      }}
    >
      <span class="chat-reply-quote-author">{message.replyTo.name || "用户"}</span>
      <span class="chat-reply-quote-text">{replyPreviewText}</span>
    </button>
  {/if}
{/snippet}

{#if message.kind === "system"}
  <div class="w-full flex justify-center my-1.5">
    <div class="chat-system-msg">
      <span class="w-1.5 h-1.5 rounded-full bg-[var(--primary)] opacity-80 shrink-0"></span>
      <span>{message.content}</span>
    </div>
  </div>
{:else if isSelf}
  <div data-msg-uid={message.msgUid} class="flex flex-row-reverse items-start gap-2.5 my-1 group {isHighlighted ? 'chat-msg-jump-highlight' : ''}">
    <button
      type="button"
      class="p-0 border-none bg-transparent cursor-pointer shrink-0 rounded-full"
      title={`查看 ${message.name || "我"} 的个人资料`}
      onclick={handleAvatarClick}
    >
      <ChatAvatar
        src={message.avatar}
        name={message.name}
        fallback="我"
        alt={message.name || "我"}
        size="md"
      />
    </button>

    <div class="flex flex-col items-end max-w-[74%] min-w-0">
      {#if message.name || roleBadge || onReply || (canDelete && onDelete)}
        <div class="flex items-center justify-end gap-1.5 mb-1 px-0.5 min-w-0 max-w-full">
          {#if canDelete && onDelete}
            <button
              type="button"
              class="chat-msg-action-btn hover:text-red-500"
              onclick={() => onDelete?.(message.msgUid)}
            >
              {deleteLabel}
            </button>
          {/if}
          {#if onReply}
            <button
              type="button"
              class="chat-msg-action-btn hover:text-[var(--primary)]"
              onclick={() => onReply?.(message)}
            >
              回复
            </button>
          {/if}
          {#if roleBadge}
            <span class="chat-role-badge chat-role-badge--{roleBadge.type}">{roleBadge.label}</span>
          {/if}
          {#if message.name}
            <span class="text-xs text-[var(--chat-meta-color)] font-medium truncate">{message.name}</span>
          {/if}
        </div>
      {/if}

      {#if isStickerOnly}
        <div class="flex flex-col items-end gap-1">
          {#if message.replyTo}
            {@render replyQuoteBlock()}
          {/if}
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
        </div>
      {:else}
        <div class="chat-bubble chat-bubble-self">
          {#if message.replyTo}
            {@render replyQuoteBlock()}
          {/if}
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
      title={`查看 ${message.name} 的个人资料`}
      onclick={handleAvatarClick}
    >
      <ChatAvatar
        src={message.avatar}
        name={message.name}
        fallback="?"
        alt={message.name}
        size="md"
      />
    </button>

    <div class="flex flex-col items-start max-w-[74%] min-w-0">
      {#if message.name || roleBadge || onReply || (canDelete && onDelete)}
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
          {#if roleBadge}
            <span class="chat-role-badge chat-role-badge--{roleBadge.type}">{roleBadge.label}</span>
          {/if}
          {#if isMentionedMe}
            <span class="chat-mentioned-tag">@了你</span>
          {/if}
          {#if onReply}
            <button
              type="button"
              class="chat-msg-action-btn hover:text-[var(--primary)]"
              onclick={() => onReply?.(message)}
            >
              回复
            </button>
          {/if}
          {#if canDelete && onDelete}
            <button
              type="button"
              class="chat-msg-action-btn hover:text-red-500"
              onclick={() => onDelete?.(message.msgUid)}
            >
              {deleteLabel}
            </button>
          {/if}
        </div>
      {/if}

      {#if isStickerOnly}
        <div class="flex flex-col items-start gap-1">
          {#if message.replyTo}
            {@render replyQuoteBlock()}
          {/if}
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
        </div>
      {:else}
        <div class="chat-bubble chat-bubble-other {isMentionedMe ? 'chat-bubble-mentioned' : ''}">
          {#if message.replyTo}
            {@render replyQuoteBlock()}
          {/if}
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
