export interface ChatMusicTrack {
	id: string;
	provider?: string;
	sourceId?: string;
	sourcePlatform?: string;
	playlistId?: string;
	position?: number;
	title: string;
	artist: string;
	album?: string;
	url?: string;
	streamUrl?: string;
	cover: string;
	lrc?: string;
	lrcUrl?: string;
	durationSec?: number;
	quality?: string;
}
