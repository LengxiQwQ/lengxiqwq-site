export interface StandardTrack {
	id: string;
	provider: string;
	sourceId: string;
	title: string;
	artist: string;
	album?: string;
	cover: string;
	durationSec: number;
	url?: string;
	lrc?: string;
}

export interface ResolvedStream {
	url: string;
	needsProxy: boolean;
	quality?: string;
	ext?: string;
	cover?: string;
	durationSec?: number;
	providerChannel?: string;
}

export interface MusicProvider {
	readonly id: string;
	readonly name: string;
	search(keyword: string, limit?: number): Promise<StandardTrack[]>;
	resolveStream(sourceId: string): Promise<ResolvedStream | null>;
	getLyric(sourceId: string): Promise<string | null>;
}
