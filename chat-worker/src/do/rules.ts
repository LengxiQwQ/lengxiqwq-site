export const SOLO_COOLDOWN_MS = 20_000;
export const ADMIN_MENTION_COOLDOWN_MS = 0; // 站长不延迟不合并，每次离线 @ 或回复都立即发送
export const MEMBER_MENTION_COOLDOWN_MS = 5 * 60_000; // 普通成员离线 @ / 回复收集窗口 5 分钟
export const MESSAGE_RECALL_WINDOW_MS = 5 * 60_000; // 本人撤回消息有效时间 5 分钟

export function canRecallMessage(params: {
	msgUserKey: string;
	msgCreatedAt: number;
	actorUserKey: string;
	actorIsAdmin: boolean;
	now?: number;
}): { allowed: boolean; reason?: string } {
	const now = params.now ?? Date.now();
	if (!params.actorUserKey) {
		return { allowed: false, reason: "请先完成身份认证" };
	}
	if (params.actorIsAdmin) {
		return { allowed: true };
	}
	if (params.msgUserKey === params.actorUserKey) {
		if (now - params.msgCreatedAt > MESSAGE_RECALL_WINDOW_MS) {
			return { allowed: false, reason: "消息发送已超过 5 分钟，无法撤回" };
		}
		return { allowed: true };
	}
	return { allowed: false, reason: "无权撤回他人消息" };
}

export function canSilentDeleteMessage(params: {
	actorUserKey: string;
	actorIsAdmin: boolean;
}): { allowed: boolean; reason?: string } {
	if (!params.actorUserKey) {
		return { allowed: false, reason: "请先完成身份认证" };
	}
	if (!params.actorIsAdmin) {
		return { allowed: false, reason: "仅站长可执行静默删除操作" };
	}
	return { allowed: true };
}

export function buildRecallNoticeContent(params: {
	actorUserKey: string;
	actorName: string;
	msgUserKey: string;
	msgAuthorName: string;
}): string {
	const actor = params.actorName.trim() || "成员";
	if (params.actorUserKey === params.msgUserKey) {
		return `${actor} 撤回了一条消息`;
	}
	const target = params.msgAuthorName.trim() || "成员";
	return `${actor} 撤回了 ${target} 的一条消息`;
}

export function mergeNotificationTargets(params: {
	mentionUserKeys: string[];
	replyToUserKey?: string | null;
	senderUserKey: string;
}): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const push = (key: string | null | undefined) => {
		const clean = (key || "").trim();
		if (!clean || clean === params.senderUserKey || seen.has(clean)) return;
		seen.add(clean);
		out.push(clean);
	};
	for (const key of params.mentionUserKeys) {
		push(key);
	}
	push(params.replyToUserKey);
	return out;
}

export interface MentionCandidateRecord {
	userKey: string;
	name: string;
	online: boolean;
	lastSeenAt: number;
}

export function getMentionCooldownMs(isAdmin: boolean): number {
	return isAdmin ? ADMIN_MENTION_COOLDOWN_MS : MEMBER_MENTION_COOLDOWN_MS;
}

export function computeNextAlarmTimestamp(
	candidates: Array<number | null | undefined>,
): number | null {
	let earliest: number | null = null;
	for (const ts of candidates) {
		if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
		if (earliest === null || ts < earliest) {
			earliest = ts;
		}
	}
	return earliest;
}

function isMentionBoundaryChar(ch: string | undefined): boolean {
	if (!ch) return true;
	return /[\s,，.。!！?？:：;；()（）[\]【】<>《》"'"“”‘’~、\n\r\t@]/.test(ch);
}

function contentContainsMemberMention(
	lowerContent: string,
	memberName: string,
): boolean {
	const needle = `@${memberName.trim().toLowerCase()}`;
	if (needle.length <= 1) return false;
	let fromIndex = 0;
	while (fromIndex < lowerContent.length) {
		const idx = lowerContent.indexOf(needle, fromIndex);
		if (idx === -1) return false;
		const before = idx > 0 ? lowerContent[idx - 1] : undefined;
		const afterIdx = idx + needle.length;
		const after =
			afterIdx < lowerContent.length ? lowerContent[afterIdx] : undefined;
		// Allow @ directly following non-alphanumeric CJK/ASCII or whitespace; allow common trailing punctuation after name
		const validBefore = before === undefined || !/[A-Za-z0-9_]/.test(before);
		const validAfter = isMentionBoundaryChar(after);
		if (validBefore && validAfter) {
			return true;
		}
		fromIndex = idx + 1;
	}
	return false;
}

export function resolveMentionTargets(params: {
	senderUserKey: string;
	content: string;
	rawTokens: string[];
	explicitKeys?: string[];
	candidates: MentionCandidateRecord[];
}): { targetUserKeys: string[]; matchedNames: string[] } {
	const {
		senderUserKey,
		content,
		rawTokens,
		explicitKeys = [],
		candidates,
	} = params;
	const lowerContent = content.toLowerCase();

	const sortedCandidates = [...candidates]
		.filter((c) => c.userKey && c.userKey !== senderUserKey && c.name.trim())
		.sort((a, b) => {
			if (a.online !== b.online) return a.online ? -1 : 1;
			if (a.name.length !== b.name.length) return b.name.length - a.name.length;
			return b.lastSeenAt - a.lastSeenAt;
		});

	const byKey = new Map<string, MentionCandidateRecord>();
	for (const c of sortedCandidates) {
		byKey.set(c.userKey, c);
	}

	const targetKeys: string[] = [];
	const seenKeys = new Set<string>();
	const explicitMatchedNames = new Set<string>();
	const mentionNames = new Set<string>(rawTokens);

	// 1. Honor explicit userKeys from autocomplete selection if their @Name is actually in content
	for (const key of explicitKeys) {
		const cand = byKey.get(key);
		if (!cand || seenKeys.has(cand.userKey)) continue;
		if (contentContainsMemberMention(lowerContent, cand.name)) {
			seenKeys.add(cand.userKey);
			targetKeys.push(cand.userKey);
			mentionNames.add(cand.name);
			explicitMatchedNames.add(cand.name.trim().toLowerCase());
		}
	}

	// 2. Match remaining @Name occurrences against known candidates (online & longer/newer first)
	// Skip candidates whose exact name was already disambiguated via explicit userKey selection
	for (const cand of sortedCandidates) {
		if (seenKeys.has(cand.userKey)) continue;
		if (explicitMatchedNames.has(cand.name.trim().toLowerCase())) continue;
		if (contentContainsMemberMention(lowerContent, cand.name)) {
			seenKeys.add(cand.userKey);
			targetKeys.push(cand.userKey);
			mentionNames.add(cand.name);
		}
	}

	return {
		targetUserKeys: targetKeys,
		matchedNames: Array.from(mentionNames),
	};
}

export function formatReplyPreview(content: string, maxLen = 120): string {
	const normalized = content.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLen) return normalized;
	return `${normalized.slice(0, maxLen).trimEnd()}…`;
}

export function computeVoteThreshold(
	onlineMemberCount: number,
	isFallback: boolean,
	requesterOnline: boolean,
): number {
	// Fallback tracks are ambient BGM: anyone can cut/skip them immediately.
	if (isFallback) return 1;
	const count = Math.max(1, onlineMemberCount);
	if (count <= 1) return 1;
	if (!requesterOnline) {
		return Math.min(3, Math.max(2, Math.ceil(count / 2)));
	}
	// When 2+ members are online and requester is still here, require majority (>= 2)
	return Math.max(2, Math.floor(count / 2) + 1);
}

/**
 * Determine whether a user can directly skip the currently playing track.
 * Fallback tracks act as ambient background music and can be skipped by anyone at any time.
 */
export function canDirectSkipTrack(params: {
	isFallback: boolean;
	isAdmin: boolean;
	isTrackRequester: boolean;
	onlineMemberCount: number;
	otherUnmutedCount?: number;
	soloCooldownUntil: number;
	now?: number;
}): { allowed: boolean; reason?: string } {
	if (params.isFallback || params.isAdmin || params.isTrackRequester) {
		return { allowed: true };
	}
	const now = params.now ?? Date.now();
	if (params.onlineMemberCount <= 1) {
		if (now >= params.soloCooldownUntil) {
			return { allowed: true };
		}
		const remainSec = Math.max(
			1,
			Math.ceil((params.soloCooldownUntil - now) / 1000),
		);
		return {
			allowed: false,
			reason: `房友刚离开，需等待 ${remainSec} 秒后再切歌`,
		};
	}
	if (params.otherUnmutedCount === 0) {
		return { allowed: true };
	}
	return {
		allowed: false,
		reason: "当前有其他在线成员正在收听，请使用投票切歌",
	};
}

/**
 * Determine whether a newly enqueued track should cut over immediately instead of waiting in queue.
 */
export function shouldPlayEnqueuedImmediately(params: {
	hasCurrentPlayback: boolean;
	currentIsFallback: boolean;
	existingQueueLength: number;
}): boolean {
	if (params.existingQueueLength > 0) return false;
	return !params.hasCurrentPlayback || params.currentIsFallback;
}
