<script module lang="ts">
let activeGlobalVoiceStop: (() => void) | null = null;
</script>

<script lang="ts">
import ChatAvatar from "./ChatAvatar.svelte";
import ChatMarkdownContent from "./ChatMarkdownContent.svelte";
import { resolveExternalOrigin } from "./chatClient";
import type { InterconnectSite } from "./chatConfig";
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
	currentUserKey?: string;
	isAdmin?: boolean;
	isPinned?: boolean;
	canRecall?: boolean;
	canEdit?: boolean;
	canDelete?: boolean;
	stickerMap: Map<string, StickerItem>;
	interconnectSites?: InterconnectSite[];
	userNameMap?: Map<string, string>;
	onRecall?: (msgUid: string) => void;
	onDelete?: (msgUid: string) => void;
	onReply?: (message: ChatMessageRecord) => void;
	onEdit?: (message: ChatMessageRecord) => void;
	onPin?: (msgUid: string, unpin?: boolean) => void;
	onReaction?: (msgUid: string, key: string) => void;
	onVotePoll?: (pollUid: string, answerId: string) => void;
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
	currentUserKey = "",
	isAdmin = false,
	isPinned = false,
	canRecall = false,
	canEdit = false,
	canDelete = false,
	stickerMap,
	interconnectSites = [],
	userNameMap = new Map(),
	onRecall,
	onDelete,
	onReply,
	onEdit,
	onPin,
	onReaction,
	onVotePoll,
	onJumpToMessage,
	onOpenUserProfile,
	onMention,
}: Props = $props();

let showQuickReaction = $state(false);
let showMoreMenu = $state(false);
let copySuccess = $state(false);
let reactionEl = $state<HTMLElement | null>(null);
let moreMenuEl = $state<HTMLElement | null>(null);

const hasMoreActions = $derived(
	Boolean(
		(message.content && message.content.trim()) ||
			(onEdit && canEdit && !message.replyTo?.isRecalled) ||
			(isAdmin && onPin) ||
			(canRecall && onRecall) ||
			(canDelete && onDelete),
	),
);

async function handleCopy() {
	if (!message.content) return;
	try {
		await navigator.clipboard.writeText(message.content);
		copySuccess = true;
		setTimeout(() => {
			copySuccess = false;
			showMoreMenu = false;
		}, 800);
	} catch {
		showMoreMenu = false;
	}
}

$effect(() => {
	if (!showQuickReaction && !showMoreMenu) return;
	function handleOutside(e: PointerEvent) {
		const target = e.target as Node | null;
		if (
			showQuickReaction &&
			reactionEl &&
			target &&
			!reactionEl.contains(target)
		) {
			showQuickReaction = false;
		}
		if (
			showMoreMenu &&
			moreMenuEl &&
			target &&
			!moreMenuEl.contains(target)
		) {
			showMoreMenu = false;
		}
	}
	window.addEventListener("pointerdown", handleOutside, { capture: true });
	return () => {
		window.removeEventListener("pointerdown", handleOutside, { capture: true });
	};
});
let activeAudioUrl = $state<string | null>(null);
let audioPlayer = $state<HTMLAudioElement | null>(null);

function handleToggleAudio(url: string) {
	if (activeAudioUrl === url) {
		audioPlayer?.pause();
		activeAudioUrl = null;
		activeGlobalVoiceStop = null;
	} else {
		if (activeGlobalVoiceStop) {
			activeGlobalVoiceStop();
		}
		if (audioPlayer) audioPlayer.pause();
		activeAudioUrl = url;
		const a = new Audio(url);
		audioPlayer = a;
		activeGlobalVoiceStop = () => {
			a.pause();
			activeAudioUrl = null;
		};
		a.play().catch(() => {});
		a.onended = () => {
			if (activeAudioUrl === url) {
				activeAudioUrl = null;
				activeGlobalVoiceStop = null;
			}
		};
	}
}

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

const isFromOurServer = $derived(
	message.userKey.endsWith(":matrix.lengxiqwq.com") ||
		message.userKey.includes("matrix.lengxiqwq.com"),
);

const isExternal = $derived(
	!isSelf &&
		!isFromOurServer &&
		(message.source === "matrix" ||
			message.userKey.startsWith("matrix:") ||
			(message.userKey.startsWith("@") && message.userKey.includes(":")) ||
			message.badge === "互联茶友" ||
			message.badge === "Detached" ||
			message.badge === "听雨" ||
			message.badge === "GBK"),
);

const externalOrigin = $derived.by(() => {
	if (!isExternal) return null;
	return resolveExternalOrigin(
		{
			userKey: message.userKey,
			name: message.name,
			source: message.source,
			badge: message.badge,
		},
		interconnectSites,
	);
});

const senderDisplayName = $derived.by(() => {
	if (isExternal && externalOrigin) {
		return `${externalOrigin.cleanName} · ${externalOrigin.siteName}`;
	}
	return message.name;
});

const effectiveSenderUrl = $derived.by(() => {
	if (isFromOurServer || isSelf) return "https://lengxiqwq.com";
	if (externalOrigin?.site?.url) return externalOrigin.site.url;
	if (message.url && !message.url.includes("matrix.lengxiqwq.com")) return message.url;
	return externalOrigin?.site?.url || "";
});

const roleBadge = $derived.by(() => {
	if (isExternal) return null;
	if (message.isAdmin) return { label: "站长", type: "host" as const };
	if (message.userKey.startsWith("waline:")) {
		return { label: "认证", type: "accent" as const };
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
		customBadges: useMessageMeta ? message.customBadges : undefined,
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
	if (onOpenUserProfile && message.userKey) {
		onOpenUserProfile({
			userKey: message.userKey,
			authType: (isExternal || message.source === "matrix" || message.userKey.startsWith("matrix:") || message.userKey.startsWith("@"))
				? undefined
				: message.userKey.startsWith("waline:") ? "waline" : "guest",
			name: message.name,
			avatar: message.avatar,
			url: message.url,
			badge: roleBadge?.label || message.badge,
			badgeType: roleBadge?.type || message.badgeType,
			customBadges: message.customBadges,
			isAdmin: message.isAdmin,
		});
		return;
	}
	if (!isSelf && !isExternal) {
		onMention?.(externalOrigin?.cleanName || message.name, message.userKey);
	}
}

function formatReactionTooltip(users: string[]): string {
	if (!users || users.length === 0) return "";
	const names = users.map((key) => {
		if (currentUserKey && key === currentUserKey) return "你";
		if (userNameMap.has(key)) return userNameMap.get(key)!;
		if (key.startsWith("matrix:") || (key.startsWith("@") && key.includes(":"))) {
			const cleanKey = key.replace(/^matrix:/, "");
			const match = cleanKey.match(/^@([^:]+):(.+)$/);
			if (match) {
				const [, uName] = match;
				const origin = resolveExternalOrigin(cleanKey, interconnectSites);
				return origin?.siteName ? `${uName} (${origin.siteName})` : uName;
			}
			return cleanKey;
		}
		if (key.startsWith("waline:") || key.startsWith("guest:")) {
			return key.split(":")[1] || key;
		}
		return key;
	});

	const uniqueNames = [...new Set(names)];

	if (uniqueNames.length <= 3) {
		return uniqueNames.join("、");
	}
	return `${uniqueNames.slice(0, 3).join("、")} 等 ${uniqueNames.length} 人`;
}
</script>

{#snippet replyQuoteBlock()}
  {#if message.replyTo}
    <button
      type="button"
      class="chat-reply-quote {isSelf ? 'self' : 'other'} {message.replyTo.isRecalled ? 'recalled' : ''}"
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

{#snippet renderFloatingActions(isSelfMsg: boolean)}
  {#if onReaction || onReply || hasMoreActions}
    <div
      class="chat-msg-floating-actions {isSelfMsg ? 'self' : 'other'} {showQuickReaction || showMoreMenu ? 'is-active' : ''}"
      role="toolbar"
      aria-label="消息快捷操作"
    >
      <!-- 快捷表情反应（Telegram 风格 SmilePlus 图标） -->
      {#if onReaction}
        <div class="relative inline-flex items-center" bind:this={reactionEl}>
          <button
            type="button"
            class="chat-action-icon-btn {showQuickReaction ? 'active' : ''}"
            aria-label="添加表情反应"
            title="表情回应"
            onclick={(e) => {
              e.stopPropagation();
              showQuickReaction = !showQuickReaction;
              showMoreMenu = false;
            }}
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M22 11v1a10 10 0 1 1-9-10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
              <path d="M16 5h6" />
              <path d="M19 2v6" />
            </svg>
          </button>

          {#if showQuickReaction}
            <div class="chat-quick-reactions-popover {isSelfMsg ? 'self-popover' : 'other-popover'}">
              {#each ["👍", "❤️", "😂", "🎉", "🔥", "👀"] as em (em)}
                <button
                  type="button"
                  class="chat-quick-reaction-btn"
                  onclick={() => {
                    onReaction?.(message.msgUid, em);
                    showQuickReaction = false;
                  }}
                >
                  {em}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- 快捷回复 -->
      {#if onReply}
        <button
          type="button"
          class="chat-action-icon-btn"
          aria-label="回复消息"
          title="回复"
          onclick={(e) => {
            e.stopPropagation();
            onReply?.(message);
          }}
        >
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="9 17 4 12 9 7" />
            <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
          </svg>
        </button>
      {/if}

      <!-- 更多操作下拉菜单（···） -->
      {#if hasMoreActions}
        <div class="relative inline-flex items-center" bind:this={moreMenuEl}>
          <button
            type="button"
            class="chat-action-icon-btn {showMoreMenu ? 'active' : ''}"
            aria-label="更多操作"
            title="更多"
            onclick={(e) => {
              e.stopPropagation();
              showMoreMenu = !showMoreMenu;
              showQuickReaction = false;
            }}
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="19" cy="12" r="1.5" />
            </svg>
          </button>

          {#if showMoreMenu}
            <div class="chat-msg-menu-popover {isSelfMsg ? 'self-menu' : 'other-menu'}">
              {#if message.content && message.content.trim()}
                <button
                  type="button"
                  class="chat-msg-menu-item"
                  onclick={handleCopy}
                >
                  <svg class="w-3.5 h-3.5 shrink-0 opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                  </svg>
                  <span>{copySuccess ? "已复制 ✓" : "复制内容"}</span>
                </button>
              {/if}

              {#if onEdit && canEdit && !message.replyTo?.isRecalled}
                <button
                  type="button"
                  class="chat-msg-menu-item"
                  onclick={() => {
                    showMoreMenu = false;
                    onEdit?.(message);
                  }}
                >
                  <svg class="w-3.5 h-3.5 shrink-0 opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                  <span>编辑消息</span>
                </button>
              {/if}

              {#if isAdmin && onPin}
                <button
                  type="button"
                  class="chat-msg-menu-item"
                  onclick={() => {
                    showMoreMenu = false;
                    onPin?.(message.msgUid, isPinned);
                  }}
                >
                  <svg class="w-3.5 h-3.5 shrink-0 opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="12" y1="17" x2="12" y2="22" />
                    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
                  </svg>
                  <span>{isPinned ? "取消置顶" : "置顶消息"}</span>
                </button>
              {/if}

              {#if canRecall && onRecall}
                <button
                  type="button"
                  class="chat-msg-menu-item"
                  onclick={() => {
                    showMoreMenu = false;
                    onRecall?.(message.msgUid);
                  }}
                >
                  <svg class="w-3.5 h-3.5 shrink-0 text-[var(--primary)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                  <span>撤回消息</span>
                </button>
              {/if}

              {#if canDelete && onDelete}
                <div class="chat-msg-menu-divider"></div>
                <button
                  type="button"
                  class="chat-msg-menu-item danger"
                  onclick={() => {
                    showMoreMenu = false;
                    onDelete?.(message.msgUid);
                  }}
                >
                  <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 6h18" />
                    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                  </svg>
                  <span>删除消息</span>
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet renderReactions(alignEnd: boolean)}
  {@const reactionEntries = Object.entries(message.reactions || {}).filter(([_, users]) => Array.isArray(users) && users.length > 0)}
  {#if reactionEntries.length > 0}
    <div class="chat-reaction-pills {alignEnd ? 'justify-end' : 'justify-start'}">
      {#each reactionEntries as [emoji, users] (emoji)}
        {@const isMine = Boolean(currentUserKey && users.includes(currentUserKey))}
        {@const tooltipText = formatReactionTooltip(users)}
        <button
          type="button"
          class="chat-reaction-pill {isMine ? 'is-active' : ''}"
          onclick={() => onReaction?.(message.msgUid, emoji)}
        >
          <span>{emoji}</span>
          <span class="text-[0.6875rem] font-medium opacity-85">{users.length}</span>
          {#if tooltipText}
            <span class="chat-reaction-tooltip" role="tooltip">{tooltipText}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet renderAttachmentsBlock()}
  {#if message.attachments && message.attachments.length > 0}
    <div class="flex flex-col gap-2 mt-2">
      {#each message.attachments as att (att.url)}
        {#if att.type === "image"}
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
        {:else if att.type === "audio"}
          <div class="chat-voice-msg">
            <button
              type="button"
              class="chat-voice-play-btn"
              aria-label={activeAudioUrl === att.url ? "暂停" : "播放语音"}
              onclick={() => handleToggleAudio(att.url)}
            >
              {#if activeAudioUrl === att.url}
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" rx="1"/>
                  <rect x="14" y="4" width="4" height="16" rx="1"/>
                </svg>
              {:else}
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              {/if}
            </button>
            <div class="flex flex-col min-w-0 flex-1">
              <span class="text-xs font-semibold truncate">{att.name || "语音留言"}</span>
              <span class="text-[0.6875rem] text-[var(--chat-meta-color)]">
                {att.duration ? `${att.duration} 秒` : "音频片段"}
              </span>
            </div>
          </div>
        {:else if att.type === "video"}
          <video
            src={att.url}
            controls
            preload="metadata"
            class="chat-msg-video"
          >
            <track kind="captions"/>
          </video>
        {:else if att.type === "file"}
          <a
            href={att.url}
            download={att.name || "下载文件"}
            target="_blank"
            rel="noopener noreferrer"
            class="chat-file-card"
          >
            <div class="w-8 h-8 rounded-lg bg-[var(--skin-accent)]/15 text-[var(--skin-accent)] flex items-center justify-center shrink-0">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
            </div>
            <div class="flex flex-col min-w-0 flex-1">
              <span class="text-xs font-medium truncate">{att.name || "文件附件"}</span>
              {#if att.size}
                <span class="text-[0.6875rem] text-[var(--chat-meta-color)]">
                  {att.size > 1024 * 1024 ? `${(att.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(att.size / 1024)} KB`}
                </span>
              {/if}
            </div>
          </a>
        {/if}
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet renderPollBlock()}
  {#if message.kind === "poll" && message.poll}
    {@const poll = message.poll}
    {@const totalVotes = Object.values(poll.votes || {}).reduce((acc, list) => acc + (Array.isArray(list) ? list.length : 0), 0)}
    <div class="chat-poll-card my-1">
      <div class="flex items-center justify-between gap-2 mb-2">
        <span class="text-xs font-bold text-[var(--skin-text)]">{poll.question}</span>
        <span class="text-[0.6875rem] text-[var(--chat-meta-color)] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10">
          {poll.ended ? "已结束" : poll.maxSelections > 1 ? "多选" : "单选"}
        </span>
      </div>
      <div class="flex flex-col gap-1.5">
        {#each poll.answers as ans (ans.id)}
          {@const votesList = poll.votes?.[ans.id] || []}
          {@const count = votesList.length}
          {@const percent = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0}
          {@const isMyVote = Boolean(currentUserKey && votesList.includes(currentUserKey))}
          <button
            type="button"
            disabled={poll.ended}
            class="chat-poll-option {isMyVote ? 'is-selected' : ''}"
            onclick={() => onVotePoll?.(message.msgUid, ans.id)}
          >
            <div class="chat-poll-progress" style="width: {percent}%"></div>
            <span class="relative z-10 truncate text-[var(--skin-text)]">{ans.text}</span>
            <span class="relative z-10 text-[0.6875rem] text-[var(--chat-meta-color)] shrink-0 ml-2 font-medium">
              {percent}% ({count})
            </span>
          </button>
        {/each}
      </div>
      <div class="mt-2 text-[0.6875rem] text-[var(--chat-meta-color)] flex justify-between">
        <span>共 {totalVotes} 票</span>
        {#if poll.ended}
          <span class="text-red-400">投票已截止</span>
        {/if}
      </div>
    </div>
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
            onclick={() => handleOpenSystemUserProfile(recallNoticeParsed.actorName, message.userKey)}
          >{recallNoticeParsed.actorName}</button>
          {#if recallNoticeParsed.targetName}
            <span>撤回了</span>
            <button
              type="button"
              class="chat-system-msg-link"
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
      {#if senderDisplayName || roleBadge || (message.customBadges && message.customBadges.length > 0)}
        <div class="flex items-center justify-end gap-1.5 mb-1 px-0.5 min-w-0 max-w-full">
          {#if roleBadge}
            <span class="chat-role-badge chat-role-badge--{roleBadge.type}">{roleBadge.label}</span>
          {/if}
          {#if message.customBadges && message.customBadges.length > 0}
            {#each message.customBadges as b (b.text)}
              <span class="chat-role-badge chat-role-badge--{b.color}">{b.text}</span>
            {/each}
          {/if}
          {#if senderDisplayName}
            <span class="text-xs text-[var(--chat-meta-color)] font-medium truncate">{senderDisplayName}</span>
          {/if}
        </div>
      {/if}

      <div class="relative max-w-full">
        {@render renderFloatingActions(true)}

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

            {@render renderAttachmentsBlock()}
            {@render renderPollBlock()}
          </div>
        {/if}
      </div>

      {@render renderReactions(true)}

      {#if formattedTime}
        <div class="flex items-center gap-1 mt-1 px-1 select-none">
          <span class="text-[0.6875rem] text-[var(--chat-meta-color)]">
            {formattedTime}
          </span>
          {#if message.isEdited}
            <span class="text-[0.625rem] text-[var(--chat-meta-color)] opacity-70">(已编辑)</span>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{:else}
  <div data-msg-uid={message.msgUid} class="flex items-start gap-2.5 my-1 group {isHighlighted ? 'chat-msg-jump-highlight' : ''}">
    <button
      type="button"
      class="p-0 border-none bg-transparent cursor-pointer shrink-0 rounded-full"
      onclick={handleAvatarClick}
    >
      <ChatAvatar
        src={message.avatar}
        name={externalOrigin?.cleanName || message.name}
        fallback="?"
        alt={senderDisplayName}
        size="md"
      />
    </button>

    <div class="flex flex-col items-start max-w-[74%] min-w-0">
      {#if senderDisplayName || roleBadge || (message.customBadges && message.customBadges.length > 0) || isMentionedMe}
        <div class="flex items-center gap-1.5 mb-1 px-0.5 min-w-0 max-w-full">
          {#if effectiveSenderUrl}
            <a
              href={effectiveSenderUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="text-xs text-[var(--chat-meta-color)] hover:text-[var(--primary)] font-medium truncate no-underline"
            >
              {senderDisplayName}
            </a>
          {:else if senderDisplayName}
            <span class="text-xs text-[var(--chat-meta-color)] font-medium truncate">{senderDisplayName}</span>
          {/if}
          {#if roleBadge}
            <span class="chat-role-badge chat-role-badge--{roleBadge.type}">{roleBadge.label}</span>
          {/if}
          {#if message.customBadges && message.customBadges.length > 0}
            {#each message.customBadges as b (b.text)}
              <span class="chat-role-badge chat-role-badge--{b.color}">{b.text}</span>
            {/each}
          {/if}
          {#if isMentionedMe}
            <span class="chat-mentioned-tag">@了你</span>
          {/if}
        </div>
      {/if}

      <div class="relative max-w-full">
        {@render renderFloatingActions(false)}

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
            {#if message.content.trim().length > 0}
              <ChatMarkdownContent
                content={message.content}
                stickerMap={stickerMap}
                mentions={message.mentions}
                currentUserName={currentUserName}
              />
            {/if}

            {@render renderAttachmentsBlock()}
            {@render renderPollBlock()}
          </div>
        {/if}
      </div>

      {@render renderReactions(false)}

      {#if formattedTime}
        <div class="flex items-center gap-1 mt-1 px-1 select-none">
          <span class="text-[0.6875rem] text-[var(--chat-meta-color)]">
            {formattedTime}
          </span>
          {#if message.isEdited}
            <span class="text-[0.625rem] text-[var(--chat-meta-color)] opacity-70">(已编辑)</span>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}
