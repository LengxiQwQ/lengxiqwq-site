export interface ChatMusicTrack {
	id: string;
	provider?: string;
	sourceId?: string;
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
