export type ChatStatsRange = "day" | "3d" | "week" | "month" | "all";
export type ChatStatsRoomScope = "interconnect" | "chat" | "all";

export interface ChatStatsSummary {
	messages: number;
	chars: number;
	activeUsers: number;
	images: number;
	stickers: number;
	reactions: number;
	textEmojis: number;
	musicRequests: number;
	musicRotations: number;
	shares: number;
	replies: number;
	mentions: number;
	videos: number;
	audios: number;
	files: number;
}

export interface ChatStatsUserRef {
	userKey: string;
	name: string;
	avatar: string;
	count: number;
}

export interface ChatStatsStickerRef {
	key: string;
	label: string;
	previewUrl?: string;
	lottieKey?: string;
	count: number;
}

export interface ChatStatsTimelinePoint {
	key: string;
	label: string;
	dayKey: string;
	ts: number;
	messages: number;
	stickers: number;
	images: number;
	musicRequests: number;
	activeUsers: number;
	topUser: ChatStatsUserRef | null;
	topSticker: ChatStatsStickerRef | null;
}

export interface ChatStatsMvp {
	userKey: string;
	name: string;
	avatar: string;
	badge?: string;
	badgeType?: string;
	isAdmin?: boolean;
	customBadges?: Array<{ text: string; color: string }>;
	siteName?: string;
	siteColor?: string;
	value: number;
	messages: number;
	chars: number;
	images: number;
	stickers: number;
	musicRequests: number;
}

export interface ChatStatsHighlights {
	talkKing: ChatStatsMvp | null;
	imageKing: ChatStatsMvp | null;
	stickerKing: ChatStatsMvp | null;
	musicKing: ChatStatsMvp | null;
	nightOwl: {
		userKey: string;
		name: string;
		avatar: string;
		count: number;
	} | null;
	morningFirst: {
		userKey: string;
		name: string;
		avatar: string;
		createdAt: number;
	} | null;
	peakBucket: {
		label: string;
		dayKey: string;
		messages: number;
	} | null;
}

export interface ChatStatsUserRow {
	userKey: string;
	name: string;
	avatar: string;
	badge: string;
	badgeType: string;
	isAdmin: boolean;
	customBadges?: Array<{ text: string; color: string }>;
	siteKey: string;
	siteName: string;
	siteColor: string;
	messages: number;
	chars: number;
	avgChars: number;
	images: number;
	stickers: number;
	reactionsGiven: number;
	reactionsReceived: number;
	textEmojis: number;
	musicRequests: number;
	repliesSent: number;
	repliesReceived: number;
	mentionsReceived: number;
	shares: number;
	videos: number;
	audios: number;
	files: number;
	activeDays: number;
	interactionScore: number;
	nightOwlMessages: number;
}

export interface ChatStatsStickerItem {
	key: string;
	label: string;
	kind: "lottie" | "sticker" | "emoji" | "mxc";
	previewUrl: string;
	lottieKey?: string;
	count: number;
	sharePct: number;
	topUser: ChatStatsUserRef | null;
}

export interface ChatStatsReactionItem {
	key: string;
	count: number;
	sharePct: number;
	topUser: ChatStatsUserRef | null;
}

export interface ChatStatsTextEmojiItem {
	key: string;
	count: number;
	sharePct: number;
	topUser: ChatStatsUserRef | null;
}

export interface ChatStatsSiteItem {
	siteKey: string;
	siteName: string;
	color: string;
	messages: number;
	activeUsers: number;
	sharePct: number;
}

export interface ChatStatsTrackItem {
	id: string;
	title: string;
	artist: string;
	cover: string;
	requestCount: number;
	rotationCount: number;
	totalCount: number;
	lastRequesterName: string;
}

export interface ChatStatsHourlySlot {
	hour: number;
	messages: number;
	stickers: number;
	images: number;
	musicRequests: number;
}

export interface ChatStatsHeatmapDay {
	dayKey: string;
	messages: number;
	stickers: number;
	images: number;
	activeUsers: number;
	topUserName: string;
	topUserAvatar: string;
}

export interface ChatStatsResponse {
	ok: boolean;
	room: ChatStatsRoomScope;
	site?: string;
	range: ChatStatsRange;
	dateRange: {
		startDay: string;
		endDay: string;
		daysCount: number;
		isLive: boolean;
	};
	availableRange: {
		minDay: string;
		maxDay: string;
		todayKey: string;
	};
	summary: ChatStatsSummary;
	previousSummary: ChatStatsSummary | null;
	timeline: ChatStatsTimelinePoint[];
	highlights: ChatStatsHighlights;
	leaderboards: ChatStatsUserRow[];
	topStickers: ChatStatsStickerItem[];
	topReactions: ChatStatsReactionItem[];
	topTextEmojis: ChatStatsTextEmojiItem[];
	siteDistribution: ChatStatsSiteItem[];
	topTracks: ChatStatsTrackItem[];
	hourlyProfile: ChatStatsHourlySlot[];
	heatmap: ChatStatsHeatmapDay[];
	error?: string;
}
