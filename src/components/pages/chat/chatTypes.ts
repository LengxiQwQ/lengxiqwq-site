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
	isolated?: boolean;
	status?: string;
	bio?: string;
	notifyEmail?: boolean;
}

export interface ChatProfileDraft {
	nickname: string;
	badge: string;
	status: string;
	bio?: string;
	url: string;
	avatar?: string;
	notifyEmail?: boolean;
}

export interface ChatOnlineMember extends ChatSessionUser {
	status: string;
	bio?: string;
	isMuted?: boolean;
}

export interface ChatUserDetailSeed {
	userKey: string;
	authType?: "waline" | "guest";
	name: string;
	avatar?: string;
	url?: string;
	badge?: string;
	badgeType?: BadgeType;
	isAdmin?: boolean;
	online?: boolean;
	status?: string;
	bio?: string;
}

export interface ChatUserRequestedTrackItem {
	logId?: number;
	track: ChatMusicTrack;
	requestedAt: number;
	requestCount: number;
}

export interface ChatUserTracksPage {
	items: ChatUserRequestedTrackItem[];
	hasMore: boolean;
	nextBeforeId: number;
}

export interface ChatUserTopTrackItem {
	track: ChatMusicTrack;
	requestCount: number;
	lastRequestedAt: number;
}

export interface ChatUserTopArtistItem {
	artist: string;
	count: number;
}

export interface ChatUserRecentMessage {
	msgUid: string;
	content: string;
	hasImage: boolean;
	createdAt: number;
}

export interface ChatUserDetailProfile {
	userKey: string;
	authType: "waline" | "guest";
	name: string;
	avatar: string;
	url: string;
	badge: string;
	badgeType: BadgeType;
	isAdmin: boolean;
	online: boolean;
	status: string;
	bio: string;
	firstSeenAt: number;
	lastSeenAt: number;
	stats: {
		messageCount: number;
		songRequestCount: number;
	};
	recentTracks: ChatUserRequestedTrackItem[];
	tracksHasMore?: boolean;
	tracksNextBeforeId?: number;
	topTracks?: ChatUserTopTrackItem[];
	topArtists?: ChatUserTopArtistItem[];
	recentMessages?: ChatUserRecentMessage[];
	playlists: Array<{
		id: string;
		title: string;
		platform: string;
		coverUrl: string;
		trackCount: number;
	}>;
}

export interface ChatMentionCandidate {
	userKey: string;
	authType: "waline" | "guest";
	name: string;
	avatar: string;
	url?: string;
	badge: string;
	badgeType: BadgeType;
	isAdmin: boolean;
	online: boolean;
	status?: string;
	bio?: string;
	lastSeenAt: number;
}

export interface ImageAttachment {
	type: "image";
	url: string;
}

export interface ChatReplyRef {
	msgUid: string;
	userKey: string;
	name: string;
	content: string;
	hasImage?: boolean;
	isRecalled?: boolean;
}

export interface ChatMessageRecord {
	source?: "matrix";
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
	replyTo?: ChatReplyRef | null;
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

export interface PlaylistSummary {
	id: string;
	ownerKey: string;
	ownerName: string;
	ownerAvatar?: string;
	title: string;
	platform: string;
	sourceUrl: string;
	coverUrl: string;
	creator: string;
	trackCount: number;
	retrievalMode: "full" | "preview";
	isPublic: boolean;
	isFeatured: boolean;
	isFallback: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface PlaylistTrackItem {
	position: number;
	sourcePlatform: string;
	sourceTrackId: string;
	title: string;
	artist: string;
	album: string;
	cover: string;
	durationSec: number;
	sourceUrl: string;
	matchedTrack: ChatMusicTrack | null;
}

export interface PlaylistDetail extends PlaylistSummary {
	tracks: PlaylistTrackItem[];
}

export interface PlaylistsResponse {
	featured: PlaylistSummary[];
	mine: PlaylistSummary[];
	shared: PlaylistSummary[];
	details?: Record<string, PlaylistDetail>;
}

export interface PlaylistImportTrackInput {
	sourcePlatform: string;
	sourceTrackId: string;
	title: string;
	artist: string;
	album: string;
	cover: string;
	durationSec: number;
	sourceUrl: string;
}

export interface PlaylistImportPayload {
	title: string;
	platform: string;
	sourceUrl: string;
	coverUrl: string;
	creator: string;
	retrievalMode: "full" | "preview";
	tracks: PlaylistImportTrackInput[];
}
