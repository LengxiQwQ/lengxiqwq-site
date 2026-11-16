<script module lang="ts">
let activeGlobalVoiceStop: (() => void) | null = null;
</script>

<script lang="ts">
import ChatAvatar from "./ChatAvatar.svelte";
import ChatMarkdownContent from "./ChatMarkdownContent.svelte";
import ChatTooltip from "./ChatTooltip.svelte";
import {
	hasExplicitRoomMentionText,
	isExternalMatrixIdentity,
	resolveExternalOrigin,
	sanitizeChatUrl,
} from "./chatClient";
import type { InterconnectSite } from "./chatConfig";
import { openChatImageLightbox } from "./chatLightbox";
import type {
	ChatMessageRecord,
	ChatReadReceipt,
	ChatUserDetailSeed,
} from "./chatTypes";
import LottieSticker from "./LottieSticker.svelte";
import {
	formatChatReplyPreview,
	formatStickerAttachmentAlt,
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
	chatServerUrl?: string;
	interconnectSites?: InterconnectSite[];
	userNameMap?: Map<string, string>;
	userProfileMap?: Map<string, ChatUserDetailSeed>;
	readReceipts?: ChatReadReceipt[];
	onRecall?: (msgUid: string) => void;
	onDelete?: (msgUid: string) => void;
	onReply?: (message: ChatMessageRecord) => void;
	onEdit?: (message: ChatMessageRecord) => void;
	onPin?: (msgUid: string, unpin?: boolean) => void;
	onReaction?: (msgUid: string, key: string) => void;
	onVotePoll?: (pollUid: string, answerId: string) => void;
	onEndPoll?: (pollUid: string) => void;
	onJumpToMessage?: (msgUid: string) => void;
	onOpenUserProfile?: (seed: ChatUserDetailSeed) => void;
	onMention?: (name: string, userKey?: string) => void;
	onOpenMobileActions?: (
		message: ChatMessageRecord,
		meta: {
			isSelf: boolean;
			senderDisplayName: string;
			canRecall: boolean;
			canEdit: boolean;
			canDelete: boolean;
			isPinned: boolean;
		},
	) => void;
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
	chatServerUrl,
	interconnectSites = [],
	userNameMap = new Map(),
	userProfileMap = new Map(),
	readReceipts = [],
	onRecall,
	onDelete,
	onReply,
	onEdit,
	onPin,
	onReaction,
	onVotePoll,
	onEndPoll,
	onJumpToMessage,
	onOpenUserProfile,
	onMention,
	onOpenMobileActions,
}: Props = $props();

let showQuickReaction = $state(false);
let showMoreActions = $state(false);
let copySuccess = $state(false);
let reactionEl = $state<HTMLElement | null>(null);
let moreActionsEl = $state<HTMLElement | null>(null);
let bubbleW = $state(0);
let bubbleH = $state(0);

function trackBubbleBox(node: HTMLElement) {
	const sync = () => {
		const rect = node.getBoundingClientRect();
		const w = Math.round(rect.width * 100) / 100;
		const h = Math.round(rect.height * 100) / 100;
		if (w !== bubbleW) bubbleW = w;
		if (h !== bubbleH) bubbleH = h;
	};
	sync();
	if (typeof ResizeObserver === "undefined") return {};
	const ro = new ResizeObserver(sync);
	ro.observe(node);
	return {
		destroy() {
			ro.disconnect();
		},
	};
}

const bubblePath = $derived.by(() => {
	const w = bubbleW;
	const h = bubbleH;
	if (w <= 0 || h <= 0) return "";
	const r = Math.max(6, Math.min(16, Math.floor(Math.min(w, h) / 2)));
	const ty = Math.min(13, Math.max(8, h - r));
	return [
		"M -5 0",
		`L ${w - r} 0`,
		`A ${r} ${r} 0 0 1 ${w} ${r}`,
		`L ${w} ${h - r}`,
		`A ${r} ${r} 0 0 1 ${w - r} ${h}`,
		`L ${r} ${h}`,
		`A ${r} ${r} 0 0 1 0 ${h - r}`,
		`L 0 ${ty}`,
		`C 0 ${ty * 0.58}, -2.4 2.8, -5.8 1.3`,
		"Q -7 0, -5 0",
		"Z",
	].join(" ");
});

async function handleCopy(e: MouseEvent) {
	e.stopPropagation();
	if (!message.content) return;
	try {
		await navigator.clipboard.writeText(message.content);
		copySuccess = true;
		setTimeout(() => {
			copySuccess = false;
		}, 1200);
	} catch {
		// ignore
	}
}

$effect(() => {
	if (!showQuickReaction && !showMoreActions) return;
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
			showMoreActions &&
			moreActionsEl &&
			target &&
			!moreActionsEl.contains(target)
		) {
			showMoreActions = false;
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
	parseChatSegments(
		message.content,
		stickerMap,
		message.mentions,
		canRoomHighlight,
	),
);

const stickerSegments = $derived(
	segments.filter((seg) => seg.kind === "sticker"),
);
const isStickerOnly = $derived(
	message.attachments.length === 0 &&
		stickerSegments.length > 0 &&
		stickerSegments.length <= 3 &&
		stickerSegments.some((seg) => seg.category === "sticker") &&
		segments.every(
			(seg) =>
				seg.kind === "sticker" ||
				(seg.kind === "text" && seg.text.trim() === ""),
		),
);
const isStickerAttachmentOnly = $derived.by(() => {
	if (message.content.trim().length > 0) return false;
	if (
		!message.attachments ||
		message.attachments.length === 0 ||
		message.attachments.length > 3
	) {
		return false;
	}
	return message.attachments.every(
		(a) => a.type === "image" && Boolean(a.isSticker),
	);
});

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
		isExternalMatrixIdentity(message),
);

const externalOrigin = $derived.by(() => {
	if (!isExternal) return null;
	return resolveExternalOrigin(
		{
			userKey: message.userKey,
			name: message.name,
			source: message.source,
			badge: message.badge,
			site: message.site,
			siteUrl: message.siteUrl,
			url: message.url,
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
	if (externalOrigin?.site?.url) {
		return sanitizeChatUrl(externalOrigin.site.url, false);
	}
	if (message.url && !message.url.includes("matrix.lengxiqwq.com")) {
		return sanitizeChatUrl(message.url, false);
	}
	return sanitizeChatUrl(externalOrigin?.site?.url, false);
});

const safeAttachments = $derived.by(() =>
	(message.attachments || [])
		.map((att) => ({ ...att, url: sanitizeChatUrl(att.url, true) }))
		.filter((att) => Boolean(att.url)),
);

const canRoomHighlight = $derived(
	Boolean(
		hasExplicitRoomMentionText(message.content) &&
			(message.isAdmin ||
				message.mentionKeys?.includes("room") ||
				message.mentionKeys?.includes("@room")),
	),
);

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
			site: message.site,
			siteUrl: message.siteUrl,
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

interface ReactionUserItem {
	userKey: string;
	displayName: string;
	isMe: boolean;
	seed: ChatUserDetailSeed;
}

function resolveUserProfileSeed(
	key: string,
	fallbackName?: string,
	fallbackAvatar?: string,
): { displayName: string; isMe: boolean; seed: ChatUserDetailSeed } {
	const isMe = Boolean(currentUserKey && key === currentUserKey);
	const profile =
		userProfileMap.get(key) ||
		(key.startsWith("matrix:")
			? userProfileMap.get(key.slice(7))
			: userProfileMap.get(`matrix:${key}`));
	let resolvedFallback = fallbackName || userNameMap.get(key) || "";
	if (!resolvedFallback) {
		if (key.startsWith("matrix:") || (key.startsWith("@") && key.includes(":"))) {
			const cleanKey = key.replace(/^matrix:/, "");
			const match = cleanKey.match(/^@([^:]+):(.+)$/);
			resolvedFallback = match ? match[1] : cleanKey;
		} else if (key.startsWith("waline:") || key.startsWith("guest:")) {
			resolvedFallback = key.split(":")[1] || key;
		} else {
			resolvedFallback = key;
		}
	}
	const isExt = isExternalMatrixIdentity(key);
	const baseName = profile?.name || resolvedFallback || "成员";
	const origin = isExt
		? resolveExternalOrigin(
				{ name: baseName, userKey: key, site: profile?.site, siteUrl: profile?.siteUrl, url: profile?.url },
				interconnectSites,
			)
		: null;
	const displayName = origin?.siteName
		? `${origin.cleanName || baseName} (${origin.siteName})`
		: baseName;

	const seed: ChatUserDetailSeed = profile
		? {
				...profile,
				userKey: profile.userKey || key,
				name: origin?.cleanName || baseName,
				avatar: profile.avatar || fallbackAvatar,
			}
		: {
				userKey: key,
				name: origin?.cleanName || baseName,
				avatar: fallbackAvatar,
				authType: isExt
					? undefined
					: key.startsWith("waline:")
						? "waline"
						: key.startsWith("guest:")
							? "guest"
							: undefined,
			};
	return { displayName, isMe, seed };
}

function resolveReactionUsers(users: string[]): ReactionUserItem[] {
	if (!users || users.length === 0) return [];
	const seen = new Set<string>();
	const list: ReactionUserItem[] = [];
	for (const key of users) {
		if (!key || seen.has(key)) continue;
		seen.add(key);
		const { displayName, isMe, seed } = resolveUserProfileSeed(key);
		list.push({ userKey: key, displayName, isMe, seed });
	}
	return list;
}

let pointerStartPos: { x: number; y: number; time: number } | null = null;
let longPressTimer: number | null = null;

function clearLongPress() {
	if (longPressTimer !== null) {
		window.clearTimeout(longPressTimer);
		longPressTimer = null;
	}
}

function triggerMobileActions() {
	if (!onOpenMobileActions) return;
	onOpenMobileActions(message, {
		isSelf,
		senderDisplayName: senderDisplayName || message.name || "用户",
		canRecall,
		canEdit: Boolean(canEdit && !message.replyTo?.isRecalled),
		canDelete,
		isPinned,
	});
}

function handleBubblePointerDown(e: PointerEvent) {
	if (!onOpenMobileActions || typeof window === "undefined") return;
	if (!window.matchMedia("(width < 768px), (pointer: coarse)").matches) return;
	if (e.button !== 0 && e.pointerType === "mouse") return;
	const target = e.target as HTMLElement | null;
	if (
		target?.closest(
			"button, a:not([data-chat-image]), video, audio, input, textarea, .chat-msg-floating-actions",
		)
	) {
		return;
	}
	pointerStartPos = { x: e.clientX, y: e.clientY, time: Date.now() };
	clearLongPress();
	longPressTimer = window.setTimeout(() => {
		longPressTimer = null;
		pointerStartPos = null;
		triggerMobileActions();
	}, 460);
}

function handleBubblePointerMove(e: PointerEvent) {
	if (!pointerStartPos) return;
	if (
		Math.abs(e.clientX - pointerStartPos.x) > 10 ||
		Math.abs(e.clientY - pointerStartPos.y) > 10
	) {
		pointerStartPos = null;
		clearLongPress();
	}
}

function handleBubblePointerUp(e: PointerEvent) {
	clearLongPress();
	if (!pointerStartPos) return;
	const pos = pointerStartPos;
	pointerStartPos = null;
	if (
		Math.abs(e.clientX - pos.x) > 10 ||
		Math.abs(e.clientY - pos.y) > 10 ||
		Date.now() - pos.time > 500
	) {
		return;
	}
	const selection = window.getSelection?.();
	if (selection && selection.toString().trim().length > 0) return;
	const target = e.target as HTMLElement | null;
	if (
		target?.closest(
			"a, button, video, audio, input, textarea, [data-chat-image], .chat-msg-floating-actions",
		)
	) {
		return;
	}
	triggerMobileActions();
}
</script>

{#snippet renderBubbleBg(mirrored: boolean)}
  {#if bubblePath}
    <svg
      class="chat-bubble-bg"
      viewBox="0 0 {bubbleW} {bubbleH}"
      style="width: {bubbleW}px; height: {bubbleH}px;"
      shape-rendering="geometricPrecision"
      aria-hidden="true"
    >
      <g transform={mirrored ? `translate(${bubbleW} 0) scale(-1 1)` : undefined}>
        <path class="chat-bubble-shadow" transform="translate(0 1)" d={bubblePath} />
        <path class="chat-bubble-shape" d={bubblePath} />
      </g>
    </svg>
  {/if}
{/snippet}

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
  {@const canCopy = Boolean(message.content && message.content.trim())}
  {@const canEditMsg = Boolean(onEdit && canEdit && !message.replyTo?.isRecalled)}
  {@const canPinMsg = Boolean(isAdmin && onPin)}
  {@const canRecallMsg = Boolean(canRecall && onRecall)}
  {@const canDeleteMsg = Boolean(canDelete && onDelete)}
  {@const hasMoreActions = canCopy || canEditMsg || canPinMsg || canRecallMsg || canDeleteMsg}
  {#if onReaction || onReply || hasMoreActions}
    <div
      class="chat-msg-floating-actions {isSelfMsg ? 'self' : 'other'} {showQuickReaction || showMoreActions ? 'is-active' : ''}"
      role="toolbar"
      aria-label="消息快捷操作"
    >
      <!-- 快捷表情反应 -->
      {#if onReaction}
        <div class="relative inline-flex items-center" bind:this={reactionEl}>
          <ChatTooltip text="表情回应" disabled={showQuickReaction || showMoreActions}>
            <button
              type="button"
              class="chat-action-icon-btn {showQuickReaction ? 'active' : ''}"
              aria-label="表情回应"
              onclick={(e) => {
                e.stopPropagation();
                showMoreActions = false;
                showQuickReaction = !showQuickReaction;
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
          </ChatTooltip>

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
        <ChatTooltip text="回复" disabled={showMoreActions}>
          <button
            type="button"
            class="chat-action-icon-btn"
            aria-label="回复消息"
            onclick={(e) => {
              e.stopPropagation();
              showQuickReaction = false;
              showMoreActions = false;
              onReply?.(message);
            }}
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="9 17 4 12 9 7" />
              <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
            </svg>
          </button>
        </ChatTooltip>
      {/if}

      <!-- 收纳更多操作（点击展开） -->
      {#if hasMoreActions}
        <div class="relative inline-flex items-center" bind:this={moreActionsEl}>
          <ChatTooltip text="更多操作" disabled={showMoreActions || showQuickReaction}>
            <button
              type="button"
              class="chat-action-icon-btn {showMoreActions ? 'active' : ''}"
              aria-label="更多操作"
              aria-expanded={showMoreActions}
              onclick={(e) => {
                e.stopPropagation();
                showQuickReaction = false;
                showMoreActions = !showMoreActions;
              }}
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="5" cy="12" r="1.75" />
                <circle cx="12" cy="12" r="1.75" />
                <circle cx="19" cy="12" r="1.75" />
              </svg>
            </button>
          </ChatTooltip>

          {#if showMoreActions}
            <div class="chat-more-actions-popover {isSelfMsg ? 'self-popover' : 'other-popover'}" role="menu" aria-label="更多消息操作">
              {#if canCopy}
                <button
                  type="button"
                  role="menuitem"
                  class="chat-more-action-item {copySuccess ? 'text-emerald-500' : ''}"
                  onclick={(e) => {
                    void handleCopy(e);
                    showMoreActions = false;
                  }}
                >
                  <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                  </svg>
                  <span>{copySuccess ? "已复制" : "复制内容"}</span>
                </button>
              {/if}

              {#if canEditMsg}
                <button
                  type="button"
                  role="menuitem"
                  class="chat-more-action-item"
                  onclick={(e) => {
                    e.stopPropagation();
                    showMoreActions = false;
                    onEdit?.(message);
                  }}
                >
                  <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                  <span>编辑消息</span>
                </button>
              {/if}

              {#if canPinMsg}
                <button
                  type="button"
                  role="menuitem"
                  class="chat-more-action-item {isPinned ? 'text-[var(--skin-accent)]' : ''}"
                  onclick={(e) => {
                    e.stopPropagation();
                    showMoreActions = false;
                    onPin?.(message.msgUid, isPinned);
                  }}
                >
                  <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <line x1="12" y1="17" x2="12" y2="22" />
                    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
                  </svg>
                  <span>{isPinned ? "取消置顶" : "置顶消息"}</span>
                </button>
              {/if}

              {#if canRecallMsg}
                <button
                  type="button"
                  role="menuitem"
                  class="chat-more-action-item"
                  onclick={(e) => {
                    e.stopPropagation();
                    showMoreActions = false;
                    onRecall?.(message.msgUid);
                  }}
                >
                  <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                  <span>撤回消息</span>
                </button>
              {/if}

              {#if canDeleteMsg}
                <button
                  type="button"
                  role="menuitem"
                  class="chat-more-action-item text-red-500 hover:text-red-500"
                  onclick={(e) => {
                    e.stopPropagation();
                    showMoreActions = false;
                    onDelete?.(message.msgUid);
                  }}
                >
                  <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
        {@const reactionUsers = resolveReactionUsers(users)}
        <div class="chat-reaction-item">
          <button
            type="button"
            class="chat-reaction-pill {isMine ? 'is-active' : ''}"
            onclick={() => onReaction?.(message.msgUid, emoji)}
          >
            <span>{emoji}</span>
            <span class="text-[0.6875rem] font-medium opacity-85">{users.length}</span>
          </button>
          {#if reactionUsers.length > 0}
            <div
              class="chat-read-receipts-popover chat-reaction-popover {alignEnd ? 'align-right' : 'align-left'}"
              role="dialog"
              aria-label={`${emoji} 回应成员`}
            >
              <div class="text-[0.6875rem] font-semibold text-[var(--deep-text)] dark:text-white/90 px-1 pb-1 mb-1 border-b border-[var(--chat-divider-color)] flex items-center justify-between gap-2">
                <span class="flex items-center gap-1">
                  <span>{emoji}</span>
                  <span>回应成员</span>
                </span>
                <span class="text-[0.625rem] font-normal text-[var(--chat-meta-color)] tabular-nums">{reactionUsers.length} 人</span>
              </div>
              <div class="chat-read-receipts-list custom-scrollbar space-y-0.5">
                {#each reactionUsers as item (item.userKey)}
                  <button
                    type="button"
                    class="chat-reaction-user-btn"
                    onclick={(e) => {
                      e.stopPropagation();
                      onOpenUserProfile?.(item.seed);
                    }}
                  >
                    <ChatAvatar
                      src={item.seed.avatar}
                      name={item.seed.name}
                      size="xs"
                      class="w-4! h-4! text-[9px]!"
                    />
                    <span class="truncate flex-1 text-left">
                      {item.displayName}{item.isMe ? " (你)" : ""}
                    </span>
                    <svg class="w-3 h-3 shrink-0 opacity-45" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet renderAttachmentsBlock()}
  {#if safeAttachments.length > 0}
    <div class="flex flex-col gap-2 {message.replyTo || message.content.trim().length > 0 ? 'mt-2' : ''}">
      {#each safeAttachments as att (att.url)}
        {#if att.type === "image" && att.isSticker}
          <a
            href={att.url}
            data-chat-image={att.url}
            class="inline-block cursor-zoom-in"
            onclick={(e) => {
              e.preventDefault();
              void openChatImageLightbox(att.url, e.currentTarget);
            }}
          >
            <img
              src={att.url}
              loading="lazy"
              alt={formatStickerAttachmentAlt(att.name)}
              title={formatStickerAttachmentAlt(att.name)}
              decoding="async"
              class="chat-sticker-large single"
            />
          </a>
        {:else if att.type === "image"}
          <a
            href={att.url}
            data-chat-image={att.url}
            class="flex w-fit max-w-full overflow-hidden rounded-lg border border-black/10 dark:border-white/10 cursor-zoom-in"
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
      <div class="mt-2 text-[0.6875rem] text-[var(--chat-meta-color)] flex items-center justify-between gap-2">
        <span>共 {totalVotes} 票</span>
        {#if poll.ended}
          <span class="text-red-400">投票已截止</span>
        {:else if (isAdmin || isSelf) && onEndPoll}
          <button
            type="button"
            class="text-[0.6875rem] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 hover:text-red-400 transition-colors cursor-pointer"
            onclick={() => onEndPoll(message.msgUid)}
          >
            结束投票
          </button>
        {/if}
      </div>
    </div>
  {/if}
{/snippet}

{#snippet renderReadReceipts()}
  {@const readers = readReceipts.filter((r) => r.userKey === currentUserKey || r.userKey !== message.userKey)}
  {#if readers.length > 0}
    {@const shown = readers.slice(0, 4)}
    {@const restCount = readers.length - shown.length}
    <span
      class="chat-read-receipts-wrap ml-1 select-none"
      aria-label={`已读：${readers.map((r) => r.name).join("、")}`}
    >
      <span class="inline-flex items-center -space-x-1">
        {#each shown as reader (reader.userKey)}
          <span class="inline-flex rounded-full ring-1 ring-[var(--card-bg)] overflow-hidden">
            <ChatAvatar
              src={reader.avatar}
              name={reader.name}
              size="xs"
              class="w-3.5! h-3.5! text-[8px]!"
            />
          </span>
        {/each}
        {#if restCount > 0}
          <span class="text-[0.625rem] text-[var(--chat-meta-color)] pl-1.5 tabular-nums">+{restCount}</span>
        {/if}
      </span>
      <div
        class="chat-read-receipts-popover {isSelf ? 'align-right' : 'align-left'}"
        role="tooltip"
      >
        <div class="text-[0.6875rem] font-semibold text-[var(--deep-text)] dark:text-white/90 px-1 pb-1 mb-1 border-b border-[var(--chat-divider-color)] flex items-center justify-between gap-2">
          <span>已读成员</span>
          <span class="text-[0.625rem] font-normal text-[var(--chat-meta-color)] tabular-nums">{readers.length} 人</span>
        </div>
        <div class="chat-read-receipts-list custom-scrollbar space-y-0.5">
          {#each readers as reader (reader.userKey)}
            {@const resolved = resolveUserProfileSeed(reader.userKey, reader.name, reader.avatar)}
            <button
              type="button"
              class="chat-reaction-user-btn"
              onclick={(e) => {
                e.stopPropagation();
                onOpenUserProfile?.(resolved.seed);
              }}
            >
              <ChatAvatar
                src={resolved.seed.avatar}
                name={resolved.seed.name}
                size="xs"
                class="w-4! h-4! text-[8px]! shrink-0"
              />
              <span class="truncate flex-1 text-left">
                {resolved.displayName}{resolved.isMe ? " (你)" : ""}
              </span>
              <svg class="w-3 h-3 shrink-0 opacity-45" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          {/each}
        </div>
      </div>
    </span>
  {/if}
{/snippet}

{#snippet renderStickerOnlyBody(alignEnd: boolean)}
  <div class="flex flex-col {alignEnd ? 'items-end' : 'items-start'} gap-1">
    {#if message.replyTo}
      {@render replyQuoteBlock()}
    {/if}
    <div class="chat-sticker-only-wrap {alignEnd ? 'justify-end' : 'justify-start'}">
      {#each stickerSegments as seg, idx (`${idx}-${seg.code}`)}
        {#if seg.lottie}
          <LottieSticker
            name={seg.lottie}
            alt={seg.alt}
            className={seg.category === "sticker"
              ? `chat-sticker-large ${stickerSegments.length === 1 ? "single" : ""}`
              : `chat-sticker chat-sticker--lottie chat-sticker--${seg.category}`}
            chatServerUrl={chatServerUrl}
          />
        {:else}
          <img
            src={seg.url}
            alt={seg.alt}
            decoding="async"
            class={seg.category === "sticker"
              ? `chat-sticker-large ${stickerSegments.length === 1 ? "single" : ""}`
              : `chat-sticker chat-sticker--${seg.category}`}
          />
        {/if}
      {/each}
    </div>
  </div>
{/snippet}

{#snippet renderStickerAttachmentOnlyBody(alignEnd: boolean)}
  <div class="flex flex-col {alignEnd ? 'items-end' : 'items-start'} gap-1">
    {#if message.replyTo}
      {@render replyQuoteBlock()}
    {/if}
    <div class="chat-sticker-only-wrap {alignEnd ? 'justify-end' : 'justify-start'}">
      {#each safeAttachments as att (att.url)}
        <a
          href={att.url}
          data-chat-image={att.url}
          class="block cursor-zoom-in"
          onclick={(e) => {
            e.preventDefault();
            void openChatImageLightbox(att.url, e.currentTarget);
          }}
        >
          <img
            src={att.url}
            alt={formatStickerAttachmentAlt(att.name)}
            title={formatStickerAttachmentAlt(att.name)}
            loading="lazy"
            decoding="async"
            class="chat-sticker-large {safeAttachments.length === 1 ? 'single' : ''}"
          />
        </a>
      {/each}
    </div>
  </div>
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

    <div class="flex flex-col items-end max-w-[82%] md:max-w-[74%] min-w-0">
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
            <span class="text-[13px] md:text-xs text-[var(--chat-meta-color)] font-medium truncate">{senderDisplayName}</span>
          {/if}
        </div>
      {/if}

      <div
        class="relative max-w-full chat-msg-bubble-wrap"
        onpointerdown={handleBubblePointerDown}
        onpointermove={handleBubblePointerMove}
        onpointerup={handleBubblePointerUp}
        onpointercancel={clearLongPress}
      >
        {@render renderFloatingActions(true)}

        {#if isStickerOnly}
          {@render renderStickerOnlyBody(true)}
        {:else if isStickerAttachmentOnly}
          {@render renderStickerAttachmentOnlyBody(true)}
        {:else}
          <div
            use:trackBubbleBox
            class="chat-bubble chat-bubble-self {bubblePath ? 'chat-bubble-svg-ready' : ''}"
          >
            {@render renderBubbleBg(true)}
            {#if message.replyTo}
              {@render replyQuoteBlock()}
            {/if}
            {#if message.content.trim().length > 0}
              <div class={message.msgType === "emote" ? "italic opacity-90" : message.isEncryptedPlaceholder ? "opacity-75 text-xs" : ""}>
                {#if message.msgType === "emote"}
                  <span class="font-medium mr-1">* {externalOrigin?.cleanName || message.name}</span>
                {/if}
                <ChatMarkdownContent
                  content={message.content}
                  stickerMap={stickerMap}
                  mentions={message.mentions}
                  currentUserName={currentUserName}
                  canRoomHighlight={canRoomHighlight}
                  chatServerUrl={chatServerUrl}
                />
              </div>
            {/if}

            {@render renderAttachmentsBlock()}
            {@render renderPollBlock()}
          </div>
        {/if}
      </div>

      {@render renderReactions(true)}

      {#if formattedTime}
        <div class="flex items-center gap-1 mt-1 px-1 select-none">
          <span class="text-xs md:text-[0.6875rem] text-[var(--chat-meta-color)]">
            {formattedTime}
          </span>
          {#if message.isEdited}
            <span class="text-[11px] md:text-[0.625rem] text-[var(--chat-meta-color)] opacity-70">(已编辑)</span>
          {/if}
          {@render renderReadReceipts()}
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

    <div class="flex flex-col items-start max-w-[82%] md:max-w-[74%] min-w-0">
      {#if senderDisplayName || roleBadge || (message.customBadges && message.customBadges.length > 0) || isMentionedMe}
        <div class="flex items-center gap-1.5 mb-1 px-0.5 min-w-0 max-w-full">
          {#if effectiveSenderUrl}
            <a
              href={effectiveSenderUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="text-[13px] md:text-xs text-[var(--chat-meta-color)] hover:text-[var(--primary)] font-medium truncate no-underline"
            >
              {senderDisplayName}
            </a>
          {:else if senderDisplayName}
            <span class="text-[13px] md:text-xs text-[var(--chat-meta-color)] font-medium truncate">{senderDisplayName}</span>
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
            <span class="chat-mentioned-tag">提到了你</span>
          {/if}
        </div>
      {/if}

      <div
        class="relative max-w-full chat-msg-bubble-wrap"
        onpointerdown={handleBubblePointerDown}
        onpointermove={handleBubblePointerMove}
        onpointerup={handleBubblePointerUp}
        onpointercancel={clearLongPress}
      >
        {@render renderFloatingActions(false)}

        {#if isStickerOnly}
          {@render renderStickerOnlyBody(false)}
        {:else if isStickerAttachmentOnly}
          {@render renderStickerAttachmentOnlyBody(false)}
        {:else}
          <div
            use:trackBubbleBox
            class="chat-bubble chat-bubble-other {isMentionedMe ? 'chat-bubble-mentioned' : ''} {bubblePath ? 'chat-bubble-svg-ready' : ''}"
          >
            {@render renderBubbleBg(false)}
            {#if message.replyTo}
              {@render replyQuoteBlock()}
            {/if}
            {#if message.content.trim().length > 0}
              <div class={message.msgType === "emote" ? "italic opacity-90" : message.isEncryptedPlaceholder ? "opacity-75 text-xs" : ""}>
                {#if message.msgType === "emote"}
                  <span class="font-medium mr-1">* {externalOrigin?.cleanName || message.name}</span>
                {/if}
                <ChatMarkdownContent
                  content={message.content}
                  stickerMap={stickerMap}
                  mentions={message.mentions}
                  currentUserName={currentUserName}
                  canRoomHighlight={canRoomHighlight}
                  chatServerUrl={chatServerUrl}
                />
              </div>
            {/if}

            {@render renderAttachmentsBlock()}
            {@render renderPollBlock()}
          </div>
        {/if}
      </div>

      {@render renderReactions(false)}

      {#if formattedTime}
        <div class="flex items-center gap-1 mt-1 px-1 select-none">
          <span class="text-xs md:text-[0.6875rem] text-[var(--chat-meta-color)]">
            {formattedTime}
          </span>
          {#if message.isEdited}
            <span class="text-[11px] md:text-[0.625rem] text-[var(--chat-meta-color)] opacity-70">(已编辑)</span>
          {/if}
          {@render renderReadReceipts()}
        </div>
      {/if}
    </div>
  </div>
{/if}
