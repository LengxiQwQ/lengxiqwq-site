import type { ChatMusicTrack } from "./musicTypes";

export type BadgeType = "host" | "accent" | "tag";

export interface ChatSessionUser {
	userKey: string;
	authType: "waline" | "guest";
	name: string;
	avatar: string;
	url: string;
	badge: string;
	badgeType: BadgeType;
	isAdmin: boolean;
	status?: string;
	notifyEmail?: boolean;
}

export interface ChatProfileDraft {
	nickname: string;
	badge: string;
	status: string;
	url: string;
	avatar?: string;
	notifyEmail?: boolean;
}

export interface ChatOnlineMember extends ChatSessionUser {
	status: string;
}

export interface ChatMentionCandidate {
	userKey: string;
	authType: "waline" | "guest";
	name: string;
	avatar: string;
	badge: string;
	badgeType: BadgeType;
	isAdmin: boolean;
	online: boolean;
	lastSeenAt: number;
}

export interface ImageAttachment {
	type: "image";
	url: string;
}

export interface ChatMessageRecord {
	id: number;
	msgUid: string;
	kind: "user" | "system";
	userKey: string;
	name: string;
	avatar: string;
	url: string;
	badge: string;
	badgeType: BadgeType;
	isAdmin: boolean;
	content: string;
	attachments: ImageAttachment[];
	mentions: string[];
	mentionKeys?: string[];
	createdAt: number;
}

export interface QueueEntry {
	uid: string;
	track: ChatMusicTrack;
	requesterKey: string;
	requesterName: string;
	createdAt: number;
}

export interface MusicHistoryEntry {
	track: ChatMusicTrack;
	requestCount: number;
	lastRequesterName: string;
	firstRequestedAt: number;
	lastRequestedAt: number;
}

export interface MusicHistoryLogEntry {
	id: number;
	track: ChatMusicTrack;
	requesterKey: string;
	requesterName: string;
	requesterAvatar: string;
	requestedAt: number;
	requestCount: number;
}

export interface CurrentPlayback {
	uid: string;
	track: ChatMusicTrack & {
		streamUrl: string;
		lrcUrl: string;
	};
	requesterKey: string;
	requesterName: string;
	isFallback: boolean;
	startedAt: number;
	durationSec: number;
	skipVotes: string[];
	errorReports: string[];
}

export interface RoomMusicState {
	current: CurrentPlayback | null;
	queue: QueueEntry[];
	history?: MusicHistoryEntry[];
	historyLogs?: MusicHistoryLogEntry[];
	requesterOnline: boolean;
	voteCount: number;
	voteThreshold: number;
	skipVoteNames?: string[];
	soloCooldownUntil?: number;
	serverTime: number;
}

export type ConnectionState =
	| "idle"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "offline";
