import { sanitizeStatus } from "../auth/verify";

export interface CustomProfileColumns {
	customName: string;
	customAvatar: string;
	customUrl: string;
	hasCustomUrl: boolean;
}

export function resolveEffectiveMemberProfile(params: {
	baseName: string;
	baseAvatar: string;
	baseUrl: string;
	custom?: Partial<CustomProfileColumns> | null;
	allowCustomName?: boolean;
}): {
	name: string;
	avatar: string;
	url: string;
} {
	const {
		baseName,
		baseAvatar,
		baseUrl,
		custom = null,
		allowCustomName = true,
	} = params;
	const customName = (custom?.customName || "").trim();
	const customAvatar = (custom?.customAvatar || "").trim();
	const name = allowCustomName && customName ? customName : baseName;
	const avatar = customAvatar || baseAvatar;
	const url = custom?.hasCustomUrl ? custom.customUrl || "" : baseUrl;
	return { name, avatar, url };
}

export interface MergeMemberStateSnapshot {
	notifyEmail: number;
	bio: string;
	status: string;
	firstSeenAt: number;
	lastSeenAt: number;
	lastNotifiedAt: number;
	lastReadAt: number;
}

export function pickEarliestPositiveTimestamp(
	values: Array<number | null | undefined>,
): number {
	let earliest = 0;
	for (const val of values) {
		if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) continue;
		if (earliest === 0 || val < earliest) {
			earliest = val;
		}
	}
	return earliest;
}

export function pickLatestPositiveTimestamp(
	values: Array<number | null | undefined>,
): number {
	let latest = 0;
	for (const val of values) {
		if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) continue;
		if (val > latest) {
			latest = val;
		}
	}
	return latest;
}

export function resolveMergedMemberMetadata(params: {
	existingTarget?: MergeMemberStateSnapshot | null;
	guestRows: MergeMemberStateSnapshot[];
	notifyEmailOverride?: boolean;
	defaultNotifyEmail?: number;
	bioOverride?: string;
	statusFromUser?: string;
	bioFromUser?: string;
	now: number;
}): {
	notifyInt: number;
	bio: string;
	status: string;
	firstSeenAt: number;
	lastReadAt: number;
	lastNotifiedAt: number;
} {
	const {
		existingTarget = null,
		guestRows,
		notifyEmailOverride,
		defaultNotifyEmail = 1,
		bioOverride,
		statusFromUser,
		bioFromUser,
		now,
	} = params;

	const sortedGuests = [...guestRows].sort(
		(a, b) => b.lastSeenAt - a.lastSeenAt,
	);
	const latestGuest = sortedGuests[0];

	const notifyInt =
		notifyEmailOverride !== undefined
			? notifyEmailOverride
				? 1
				: 0
			: existingTarget
				? existingTarget.notifyEmail
				: (latestGuest?.notifyEmail ?? defaultNotifyEmail);

	const guestBio = sortedGuests.find((g) => g.bio.trim().length > 0)?.bio ?? "";
	const bio =
		bioOverride !== undefined
			? bioOverride
			: existingTarget
				? existingTarget.bio
				: guestBio || bioFromUser || "";

	const guestStatus =
		sortedGuests.find((g) => g.status.trim() && g.status.trim() !== "在线")
			?.status ??
		latestGuest?.status ??
		"";
	const status = sanitizeStatus(
		statusFromUser || existingTarget?.status || guestStatus,
	);

	const firstSeenAt = pickEarliestPositiveTimestamp([
		existingTarget?.firstSeenAt,
		existingTarget?.lastSeenAt,
		...sortedGuests.flatMap((g) => [g.firstSeenAt, g.lastSeenAt]),
		now,
	]);

	const lastReadAt = pickLatestPositiveTimestamp([
		existingTarget?.lastReadAt,
		...sortedGuests.map((g) => g.lastReadAt),
	]);

	const lastNotifiedAt = pickLatestPositiveTimestamp([
		existingTarget?.lastNotifiedAt,
		...sortedGuests.map((g) => g.lastNotifiedAt),
	]);

	return {
		notifyInt,
		bio,
		status,
		firstSeenAt,
		lastReadAt,
		lastNotifiedAt,
	};
}

export function remapUserKeyList(
	keys: string[],
	guestKeySet: Set<string>,
	targetUserKey: string,
): { changed: boolean; next: string[] } {
	if (guestKeySet.size === 0 || keys.length === 0) {
		return { changed: false, next: keys };
	}
	let changed = false;
	const seen = new Set<string>();
	const next: string[] = [];
	for (const key of keys) {
		const mapped = guestKeySet.has(key) ? targetUserKey : key;
		if (mapped !== key) {
			changed = true;
		}
		if (!mapped || seen.has(mapped)) {
			if (mapped !== key || seen.has(mapped)) {
				changed = true;
			}
			continue;
		}
		seen.add(mapped);
		next.push(mapped);
	}
	return { changed, next };
}

export function remapReplyRefJson(
	replyToJson: string,
	guestKeySet: Set<string>,
	targetUserKey: string,
	targetName: string,
): { changed: boolean; nextJson: string } {
	if (!replyToJson || guestKeySet.size === 0) {
		return { changed: false, nextJson: replyToJson };
	}
	try {
		const parsed = JSON.parse(replyToJson) as {
			msgUid?: unknown;
			userKey?: unknown;
			name?: unknown;
			[key: string]: unknown;
		};
		if (
			!parsed ||
			typeof parsed !== "object" ||
			typeof parsed.userKey !== "string" ||
			!guestKeySet.has(parsed.userKey)
		) {
			return { changed: false, nextJson: replyToJson };
		}
		return {
			changed: true,
			nextJson: JSON.stringify({
				...parsed,
				userKey: targetUserKey,
				name: targetName,
			}),
		};
	} catch {
		return { changed: false, nextJson: replyToJson };
	}
}

export function remapPlaybackUserKeys<
	T extends {
		requesterKey: string;
		requesterName: string;
		isFallback: boolean;
		skipVotes: string[];
		errorReports: string[];
	},
>(
	playback: T,
	guestKeySet: Set<string>,
	targetUserKey: string,
	targetName: string,
): { changed: boolean; next: T } {
	if (guestKeySet.size === 0) {
		return { changed: false, next: playback };
	}
	let changed = false;
	let requesterKey = playback.requesterKey;
	let requesterName = playback.requesterName;
	if (!playback.isFallback && guestKeySet.has(playback.requesterKey)) {
		requesterKey = targetUserKey;
		requesterName = targetName;
		changed = true;
	}

	const votesRes = remapUserKeyList(
		playback.skipVotes,
		guestKeySet,
		targetUserKey,
	);
	if (votesRes.changed) {
		changed = true;
	}

	const reportsRes = remapUserKeyList(
		playback.errorReports,
		guestKeySet,
		targetUserKey,
	);
	if (reportsRes.changed) {
		changed = true;
	}

	if (!changed) {
		return { changed: false, next: playback };
	}

	return {
		changed: true,
		next: {
			...playback,
			requesterKey,
			requesterName,
			skipVotes: votesRes.next,
			errorReports: reportsRes.next,
		},
	};
}
