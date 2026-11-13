<script lang="ts">
import ChatAvatar from "./ChatAvatar.svelte";
import ChatMarkdownContent from "./ChatMarkdownContent.svelte";
import { openChatImageLightbox } from "./chatLightbox";
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
	canRecall?: boolean;
	canDelete?: boolean;
	stickerMap: Map<string, StickerItem>;
	onRecall?: (msgUid: string) => void;
	onDelete?: (msgUid: string) => void;
	onReply?: (message: ChatMessageRecord) => void;
	onJumpToMessage?: (msgUid: string) => void;
	onOpenUserProfile?: (seed: ChatUserDetailSeed) => void;
	onMention?: (name: string, userKey?: string) => void;
}

const {
	message,
	isSelf,
	isMentionedMe = false,
	isHighlighted = false,
	currentUserName = "",
	canRecall = false,
	canDelete = false,
	stickerMap,
	onRecall,
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
	message.source !== "matrix" &&
	message.attachments.length === 0 &&
		stickerSegments.some((seg) => seg.category === "sticker") &&
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
interface RecallNoticeParsed {
	actorName: string;
	targetName?: string;
}

const recallNoticeParsed = $derived.by<RecallNoticeParsed | null>(() => {
	if (message.kind !== "system") return null;
	const content = message.content?.trim() || "";
	const adminMatch = content.match(/^(.+?)\s+撤回了\s+(.+?)\s+的一条消息$/);
	if (adminMatch) {
		return {
			actorName: adminMatch[1].trim(),
			targetName: adminMatch[2].trim(),
		};
	}
	const selfMatch = content.match(/^(.+?)\s+撤回了一条消息$/);
	if (selfMatch) {
		return {
			actorName: selfMatch[1].trim(),
		};
	}
	return null;
});

function handleOpenSystemUserProfile(name: string, explicitUserKey?: string) {
	if (!onOpenUserProfile) return;
	const cleanName = name.trim();
	const key =
		explicitUserKey ||
		(message.userKey && (!message.name || message.name === cleanName)
			? message.userKey
			: "");
	const useMessageMeta = Boolean(key && key === message.userKey);
	onOpenUserProfile({
		userKey: key,
		name: cleanName || "成员",
		avatar: useMessageMeta ? message.avatar : undefined,
		url: useMessageMeta ? message.url : undefined,
		badge: useMessageMeta ? roleBadge?.label || message.badge : undefined,
		badgeType: useMessageMeta
			? roleBadge?.type || message.badgeType
			: undefined,
		isAdmin: useMessageMeta ? message.isAdmin : undefined,
		authType: key
			? key.startsWith("waline:")
				? "waline"
				: "guest"
			: undefined,
	});
}

function handleOpenProfileForReplyTo() {
	if (!onOpenUserProfile || !message.replyTo) return;
	const rep = message.replyTo;
	if (!rep.userKey && !rep.name) return;
	onOpenUserProfile({
		userKey: rep.userKey || "",
		name: rep.name || "用户",
		authType: rep.userKey
			? rep.userKey.startsWith("waline:")
				? "waline"
				: "guest"
			: undefined,
	});
}

function handleAvatarClick() {
	if (message.source === "matrix") return;
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
		onMention?.(message.name, message.userKey);
	}
}
</script>

{#snippet replyQuoteBlock()}
  {#if message.replyTo}
    <button
      type="button"
      class="chat-reply-quote {isSelf ? 'self' : 'other'} {message.replyTo.isRecalled ? 'recalled' : ''}"
      title={message.replyTo.isRecalled
        ? `原消息已撤回 · 点击查看 ${message.replyTo.name || "用户"} 的个人资料`
        : "点击定位到原消息"}
      onclick={() => {
        if (message.replyTo) {
          if (!message.replyTo.isRecalled) {
            onJumpToMessage?.(message.replyTo.msgUid);
          } else {
            handleOpenProfileForReplyTo();
          }
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
      {#if recallNoticeParsed}
        <span class="inline-flex flex-wrap items-center justify-center gap-x-1">
          <button
            type="button"
            class="chat-system-msg-link"
            title={`查看 ${recallNoticeParsed.actorName} 的个人资料`}
            onclick={() => handleOpenSystemUserProfile(recallNoticeParsed.actorName, message.userKey)}
          >{recallNoticeParsed.actorName}</button>
          {#if recallNoticeParsed.targetName}
            <span>撤回了</span>
            <button
              type="button"
              class="chat-system-msg-link"
              title={`查看 ${recallNoticeParsed.targetName} 的个人资料`}
              onclick={() => handleOpenSystemUserProfile(recallNoticeParsed.targetName || "", message.mentionKeys?.[0])}
            >{recallNoticeParsed.targetName}</button>
            <span>的一条消息</span>
          {:else}
            <span>撤回了一条消息</span>
          {/if}
        </span>
      {:else}
        <span>{message.content}</span>
      {/if}
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
      {#if message.name || roleBadge || onReply || (canRecall && onRecall) || (canDelete && onDelete)}
        <div class="flex items-center justify-end gap-1.5 mb-1 px-0.5 min-w-0 max-w-full">
          {#if canDelete && onDelete}
            <button
              type="button"
              class="chat-msg-action-btn hover:text-red-500"
              onclick={() => onDelete?.(message.msgUid)}
            >
              删除
            </button>
          {/if}
          {#if canRecall && onRecall}
            <button
              type="button"
              class="chat-msg-action-btn hover:text-[var(--primary)]"
              onclick={() => onRecall?.(message.msgUid)}
            >
              撤回
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
                decoding="async"
                class={seg.category === "sticker"
                  ? `chat-sticker-large ${stickerSegments.length === 1 ? "single" : ""}`
                  : `chat-sticker chat-sticker--${seg.category}`}
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
                  data-chat-image={att.url}
                  class="block overflow-hidden rounded-lg border border-black/10 dark:border-white/10 cursor-zoom-in"
                  onclick={(e) => {
                    e.preventDefault();
                    void openChatImageLightbox(att.url, e.currentTarget);
                  }}
                >
                  <img
                    src={att.url}
                    loading="lazy"
                    alt="聊天图片"
                    decoding="async"
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
    {#if message.source === "matrix"}
      <ChatAvatar src={message.avatar} name={message.name} size="md" />
    {:else}
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
    {/if}

    <div class="flex flex-col items-start max-w-[74%] min-w-0">
      {#if message.name || roleBadge || onReply || (canRecall && onRecall) || (canDelete && onDelete)}
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
          {#if canRecall && onRecall}
            <button
              type="button"
              class="chat-msg-action-btn hover:text-[var(--primary)]"
              onclick={() => onRecall?.(message.msgUid)}
            >
              撤回
            </button>
          {/if}
          {#if canDelete && onDelete}
            <button
              type="button"
              class="chat-msg-action-btn hover:text-red-500"
              onclick={() => onDelete?.(message.msgUid)}
            >
              删除
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
                decoding="async"
                class={seg.category === "sticker"
                  ? `chat-sticker-large ${stickerSegments.length === 1 ? "single" : ""}`
                  : `chat-sticker chat-sticker--${seg.category}`}
              />
            {/each}
          </div>
        </div>
      {:else}
        <div class="chat-bubble chat-bubble-other {isMentionedMe ? 'chat-bubble-mentioned' : ''}">
          {#if message.replyTo}
            {@render replyQuoteBlock()}
          {/if}
          {#if message.source === "matrix" && message.content.trim()}
            <p class="whitespace-pre-wrap break-words">{message.content}</p>
          {:else if message.content.trim().length > 0}
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
                  data-chat-image={att.url}
                  class="block overflow-hidden rounded-lg border border-black/10 dark:border-white/10 cursor-zoom-in"
                  onclick={(e) => {
                    e.preventDefault();
                    void openChatImageLightbox(att.url, e.currentTarget);
                  }}
                >
                  <img
                    src={att.url}
                    loading="lazy"
                    alt="聊天图片"
                    decoding="async"
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
