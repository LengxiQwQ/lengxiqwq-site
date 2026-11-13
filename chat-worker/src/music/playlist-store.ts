import type { StandardTrack } from "./types.js";

export const MAX_PLAYLISTS_PER_USER = 15;
export const MAX_SHARED_PLAYLISTS_PER_USER = 5;
export const MAX_TRACKS_PER_PLAYLIST = 3000;

export interface PlaylistTrackInput {
	sourcePlatform?: string;
	sourceTrackId?: string;
	title?: string;
	artist?: string;
	album?: string;
	cover?: string;
	durationSec?: number;
	sourceUrl?: string;
}

export interface StoredPlaylistTrack {
	position: number;
	sourcePlatform: string;
	sourceTrackId: string;
	title: string;
	artist: string;
	album: string;
	cover: string;
	durationSec: number;
	sourceUrl: string;
	matchedTrack: StandardTrack | null;
}

export interface SanitizedPlaylistPayload {
	title: string;
	platform: string;
	sourceUrl: string;
	coverUrl: string;
	creator: string;
	retrievalMode: "full" | "preview";
	tracks: StoredPlaylistTrack[];
}

export interface PlaylistSummary {
	id: string;
	ownerKey: string;
	ownerName: string;
	ownerAvatar: string;
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

export interface PlaylistDetail extends PlaylistSummary {
	tracks: StoredPlaylistTrack[];
}

export interface ExternalTrackTarget {
	sourcePlatform: string;
	sourceTrackId: string;
	title: string;
	artist: string;
	album?: string;
	cover?: string;
	durationSec?: number;
}

function sanitizeSafeHttpsUrl(raw: unknown, maxLen = 400): string {
	if (typeof raw !== "string") return "";
	const trimmed = raw.trim();
	if (!trimmed) return "";
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "https:") return "";
		return parsed.toString().slice(0, maxLen);
	} catch {
		return "";
	}
}

function sanitizeSourceUrl(raw: unknown, maxLen = 400): string {
	if (typeof raw !== "string") return "";
	const trimmed = raw.trim().replace(/\s+/g, " ");
	if (!trimmed) return "";
	return trimmed.slice(0, maxLen);
}

function sanitizePlatform(raw: unknown): string {
	if (typeof raw !== "string") return "";
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "");
	return cleaned.slice(0, 32);
}

/**
 * Check whether a QQ Music track identifier looks like an alphanumeric songmid
 * (usable directly by QQMusicProvider without an extra keyword search).
 */
export function isLikelyQQSongMid(rawId: string): boolean {
	const trimmed = rawId.trim();
	return /^[A-Za-z0-9]{10,24}$/.test(trimmed) && /[A-Za-z]/.test(trimmed);
}

/**
 * Validate and normalize an incoming playlist import/refresh payload from the frontend.
 */
export function sanitizePlaylistPayload(
	raw: unknown,
): { ok: true; data: SanitizedPlaylistPayload } | { ok: false; error: string } {
	if (!raw || typeof raw !== "object") {
		return { ok: false, error: "歌单数据格式错误" };
	}

	const obj = raw as Record<string, unknown>;
	const title =
		typeof obj.title === "string"
			? obj.title.replace(/\s+/g, " ").trim().slice(0, 80)
			: "";
	if (!title) {
		return { ok: false, error: "缺少歌单名称" };
	}

	const platform = sanitizePlatform(obj.platform) || "external";
	const sourceUrl = sanitizeSourceUrl(obj.sourceUrl, 400);
	if (!sourceUrl) {
		return { ok: false, error: "缺少歌单来源链接" };
	}

	const coverUrl = sanitizeSafeHttpsUrl(obj.coverUrl, 400);
	const creator =
		typeof obj.creator === "string"
			? obj.creator.replace(/\s+/g, " ").trim().slice(0, 80)
			: "";
	const retrievalMode = obj.retrievalMode === "preview" ? "preview" : "full";

	if (!Array.isArray(obj.tracks)) {
		return { ok: false, error: "歌单曲目列表格式错误" };
	}

	const tracks: StoredPlaylistTrack[] = [];
	for (const item of obj.tracks.slice(0, MAX_TRACKS_PER_PLAYLIST)) {
		if (!item || typeof item !== "object") continue;
		const t = item as Record<string, unknown>;
		const trackTitle =
			typeof t.title === "string"
				? t.title.replace(/\s+/g, " ").trim().slice(0, 120)
				: "";
		if (!trackTitle) continue;

		const trackArtist =
			(typeof t.artist === "string"
				? t.artist.replace(/\s+/g, " ").trim().slice(0, 120)
				: "") || "未知歌手";
		const album =
			typeof t.album === "string"
				? t.album.replace(/\s+/g, " ").trim().slice(0, 120)
				: "";
		const sourcePlatform = sanitizePlatform(t.sourcePlatform) || platform;
		const sourceTrackId =
			typeof t.sourceTrackId === "string"
				? t.sourceTrackId.trim().slice(0, 80)
				: "";
		const cover = sanitizeSafeHttpsUrl(t.cover, 400);
		const durationSec =
			typeof t.durationSec === "number" &&
			Number.isFinite(t.durationSec) &&
			t.durationSec > 0
				? Math.min(7200, Math.round(t.durationSec))
				: 0;
		const trackSourceUrl = sanitizeSafeHttpsUrl(t.sourceUrl, 400);

		let matchedTrack: StandardTrack | null = null;
		if (sourcePlatform === "qqmusic" && isLikelyQQSongMid(sourceTrackId)) {
			matchedTrack = {
				id: `qq:${sourceTrackId}`,
				provider: "qq",
				sourceId: sourceTrackId,
				title: trackTitle,
				artist: trackArtist,
				album: album || undefined,
				cover,
				durationSec,
			};
		}

		tracks.push({
			position: tracks.length,
			sourcePlatform,
			sourceTrackId,
			title: trackTitle,
			artist: trackArtist,
			album,
			cover,
			durationSec,
			sourceUrl: trackSourceUrl,
			matchedTrack,
		});
	}

	if (tracks.length === 0) {
		return { ok: false, error: "歌单内没有可保存的曲目" };
	}

	return {
		ok: true,
		data: {
			title,
			platform,
			sourceUrl,
			coverUrl: coverUrl || tracks.find((t) => t.cover)?.cover || "",
			creator,
			retrievalMode,
			tracks,
		},
	};
}

function normalizeCompareText(input: string): string {
	return input
		.toLowerCase()
		.replace(/[（(][^）)]*[）)]/g, " ")
		.replace(/[\s\-_·.,'"!?！？，。、/\\:：|]+/g, "")
		.trim();
}

function normalizeExactText(input: string): string {
	return input
		.toLowerCase()
		.replace(/[\s\-_·.,'"!?！？，。、/\\:：|]+/g, "")
		.trim();
}

function splitArtistTokens(artist: string): string[] {
	return artist
		.split(/[/,&、;；]+/)
		.map((s) => normalizeExactText(s))
		.filter(Boolean);
}

/**
 * Score search candidates against an external playlist track and select the best playable match.
 */
export function pickBestMatchedTrack(
	candidates: StandardTrack[],
	target: { title: string; artist: string; durationSec?: number },
): StandardTrack | null {
	if (candidates.length === 0) return null;

	const targetExactTitle = normalizeExactText(target.title);
	const targetBaseTitle = normalizeCompareText(target.title);
	const targetArtists = splitArtistTokens(target.artist);
	const targetDuration = target.durationSec ?? 0;

	let best: StandardTrack | null = null;
	let bestScore = -1;

	for (const candidate of candidates) {
		let score = 0;
		const candExactTitle = normalizeExactText(candidate.title);
		const candBaseTitle = normalizeCompareText(candidate.title);

		if (targetExactTitle && candExactTitle === targetExactTitle) {
			score += 60;
		} else if (targetBaseTitle && candBaseTitle === targetBaseTitle) {
			score += 48;
		} else if (
			targetBaseTitle &&
			candBaseTitle &&
			(candBaseTitle.includes(targetBaseTitle) ||
				targetBaseTitle.includes(candBaseTitle))
		) {
			score += 25;
		}

		const candArtists = splitArtistTokens(candidate.artist);
		let artistScore = 0;
		for (const ta of targetArtists) {
			if (ta === "未知歌手") continue;
			for (const ca of candArtists) {
				if (ca === ta) {
					artistScore = Math.max(artistScore, 35);
				} else if (ca.includes(ta) || ta.includes(ca)) {
					artistScore = Math.max(artistScore, 18);
				}
			}
		}
		score += artistScore;

		if (targetDuration > 0 && candidate.durationSec > 0) {
			const diff = Math.abs(candidate.durationSec - targetDuration);
			if (diff <= 3) {
				score += 15;
			} else if (diff <= 8) {
				score += 8;
			} else if (diff > 30) {
				score -= 20;
			}
		}

		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}

	return bestScore >= 45 ? best : null;
}

export function extractPrimaryArtist(artist: string): string {
	const first = artist.split(/[/,&、;；]+/)[0]?.trim() || "";
	return first === "未知歌手" ? "" : first;
}
