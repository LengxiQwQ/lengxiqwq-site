import type { Env } from "../env.js";
import { QQMusicProvider } from "./providers/qq-music.js";
import { signStreamProxyUrl } from "./stream-signer.js";
import type { MusicProvider, StandardTrack } from "./types.js";

export interface PlayableTrack extends StandardTrack {
	streamUrl: string;
	lrcUrl: string;
	quality?: string;
}

export class MusicRegistry {
	private readonly providers = new Map<string, MusicProvider>();
	private readonly defaultOrder: string[] = [];

	constructor(providers: MusicProvider[]) {
		for (const p of providers) {
			this.providers.set(p.id, p);
			this.defaultOrder.push(p.id);
		}
	}

	listProviders(): Array<{ id: string; name: string }> {
		return this.defaultOrder
			.map((id) => this.providers.get(id))
			.filter((p): p is MusicProvider => Boolean(p))
			.map((p) => ({ id: p.id, name: p.name }));
	}

	async search(
		keyword: string,
		limit = 12,
		providerId?: string,
	): Promise<StandardTrack[]> {
		if (providerId && this.providers.has(providerId)) {
			const provider = this.providers.get(providerId);
			return provider ? provider.search(keyword, limit) : [];
		}

		// Search across registered providers in order; stop when results found
		for (const id of this.defaultOrder) {
			const provider = this.providers.get(id);
			if (!provider) continue;
			const results = await provider.search(keyword, limit);
			if (results.length > 0) {
				return results;
			}
		}
		return [];
	}

	async resolvePlayable(
		track: StandardTrack,
		workerOrigin: string,
		signSecret: string,
	): Promise<PlayableTrack | null> {
		if (track.provider === "local") {
			if (!track.url) return null;
			return {
				...track,
				streamUrl: track.url,
				lrcUrl: track.lrc ?? "",
			};
		}

		const provider = this.providers.get(track.provider);
		if (!provider) return null;

		const resolved = await provider.resolveStream(track.sourceId);
		if (!resolved) return null;

		const mimeType =
			resolved.ext === "m4a"
				? "audio/mp4"
				: resolved.ext === "ogg"
					? "audio/ogg"
					: resolved.ext === "flac"
						? "audio/flac"
						: "audio/mpeg";
		const finalUrl = resolved.needsProxy
			? await signStreamProxyUrl(
					workerOrigin,
					resolved.url,
					signSecret,
					"https://y.qq.com/",
					mimeType,
				)
			: resolved.url;

		const baseOrigin = workerOrigin.replace(/\/+$/, "");
		const lrcUrl =
			track.lrc ||
			`${baseOrigin}/api/music/lyric?provider=${encodeURIComponent(track.provider)}&id=${encodeURIComponent(track.sourceId)}`;

		return {
			...track,
			cover: track.cover || resolved.cover || "",
			durationSec:
				track.durationSec > 0 ? track.durationSec : (resolved.durationSec ?? 0),
			streamUrl: finalUrl,
			lrcUrl,
			quality: resolved.quality,
		};
	}

	async getLyric(providerId: string, sourceId: string): Promise<string | null> {
		const provider = this.providers.get(providerId);
		if (!provider) return null;
		return provider.getLyric(sourceId);
	}
}

export function createMusicRegistry(env: Env): MusicRegistry {
	return new MusicRegistry([new QQMusicProvider(env.CYAPI_KEY)]);
}
