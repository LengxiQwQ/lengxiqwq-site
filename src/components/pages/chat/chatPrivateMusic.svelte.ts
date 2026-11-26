import type { ChatMusicShareData } from "./chatShareProtocol";
import type { ChatMusicTrack } from "./musicTypes";

export interface PrivateCardLyricLine {
	timeSec: number;
	text: string;
}

export interface PrivatePlayRequest {
	data: ChatMusicShareData;
	msgUid?: string;
	senderName?: string;
	senderAvatar?: string;
	senderUserKey?: string;
	chatServerUrl: string;
	seekToSec?: number;
}

export const DEFAULT_CHAT_MUSIC_VOLUME: number = 0.8;
const CHAT_MUSIC_VOLUME_STORAGE_KEY = "lx_chat_music_volume";
const PREVIEW_MUTED_STORAGE_KEY = "lx_chat_music_preview_muted";
const cardLyricsCache = new Map<string, PrivateCardLyricLine[]>();


export function readStoredChatMusicVolume(
	fallback: number = DEFAULT_CHAT_MUSIC_VOLUME,
): number {
	try {
		const raw = window.localStorage.getItem(CHAT_MUSIC_VOLUME_STORAGE_KEY);
		if (raw !== null) {
			const parsed = Number.parseFloat(raw);
			if (Number.isFinite(parsed)) {
				return Math.min(1, Math.max(0, parsed));
			}
		}
	} catch {
		// ignore storage errors
	}
	return Math.min(1, Math.max(0, fallback));
}

function readStoredPreviewMuted(): boolean {
	try {
		return window.localStorage.getItem(PREVIEW_MUTED_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

export function writeStoredChatMusicVolume(volume: number): number {
	const clamped = Math.min(
		1,
		Math.max(0, Number.isFinite(volume) ? volume : DEFAULT_CHAT_MUSIC_VOLUME),
	);
	try {
		window.localStorage.setItem(CHAT_MUSIC_VOLUME_STORAGE_KEY, String(clamped));
	} catch {
		// ignore
	}
	return clamped;
}

function writeStoredPreviewMuted(muted: boolean): void {
	try {
		window.localStorage.setItem(PREVIEW_MUTED_STORAGE_KEY, muted ? "1" : "0");
	} catch {
		// ignore
	}
}

function notifyRoomPreviewState(playing: boolean): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(
		new CustomEvent("lx-chat-music-preview-state", { detail: { playing } }),
	);
}

function resolveMediaArtworkUrl(raw?: string): string {
	const trimmed = (raw || "").trim();
	if (!trimmed || typeof window === "undefined") return "";
	try {
		return new URL(trimmed, window.location.origin).toString();
	} catch {
		return "";
	}
}

const PRIVATE_MEDIA_ACTIONS: MediaSessionAction[] = [
	"play",
	"pause",
	"stop",
	"seekbackward",
	"seekforward",
	"seekto",
	"previoustrack",
	"nexttrack",
];

export function formatPrivateMusicSec(sec: number): string {
	if (!Number.isFinite(sec) || sec <= 0) return "0:00";
	const total = Math.floor(sec);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

export function getPrivateTrackKey(data: ChatMusicShareData): string {
	const id = (data.id || "").trim();
	if (id) return id;
	const provider = (data.provider || data.sourcePlatform || "").trim().toLowerCase();
	const sourceId = (data.sourceId || "").trim();
	if (provider && sourceId) return `${provider}:${sourceId}`;
	return `${(data.title || "").trim().toLowerCase()}|${(data.artist || "").trim().toLowerCase()}`;
}

export function resolveMusicExternalHref(data: ChatMusicShareData): string {
	const raw = (data.sourceUrl || data.url || "").trim();
	if (/^https?:\/\//i.test(raw)) return raw;
	const provider = (data.provider || data.sourcePlatform || "").toLowerCase();
	let bareId = (data.sourceId || "").trim();
	if (!bareId && data.id) {
		const idx = data.id.indexOf(":");
		bareId = idx > 0 ? data.id.slice(idx + 1).trim() : data.id.trim();
	}
	if (provider === "qq" && bareId) {
		return `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(bareId)}`;
	}
	if (provider === "netease" && bareId) {
		return `https://music.163.com/#/song?id=${encodeURIComponent(bareId)}`;
	}
	return "";
}

export function toChatMusicTrack(
	data: ChatMusicShareData,
	durationFallback = 0,
): ChatMusicTrack {
	return {
		id:
			data.id ||
			`${data.provider || data.sourcePlatform || "track"}:${data.sourceId || data.title}`,
		provider: data.provider || data.sourcePlatform || undefined,
		sourceId: data.sourceId || undefined,
		sourcePlatform: data.sourcePlatform || data.provider || undefined,
		title: data.title || "未命名歌曲",
		artist: data.artist || "未知歌手",
		album: data.album || "",
		cover: data.cover || "",
		url: data.sourceUrl || data.url || "",
		durationSec: data.durationSec || durationFallback || 0,
	};
}

export function parseCardLrc(lrcText: string): PrivateCardLyricLine[] {
	const lines: PrivateCardLyricLine[] = [];
	const tagRegex = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
	for (const rawLine of lrcText.split(/\r?\n/)) {
		const tags = [...rawLine.matchAll(tagRegex)];
		if (tags.length === 0) continue;
		const text = rawLine.replace(tagRegex, "").trim();
		if (!text) continue;
		if (/^(ar|ti|al|by|offset)\s*:/i.test(text)) continue;
		for (const match of tags) {
			const min = Number(match[1] || 0);
			const sec = Number(match[2] || 0);
			const fracRaw = match[3] || "";
			const frac = fracRaw
				? Number(fracRaw) / (fracRaw.length >= 3 ? 1000 : fracRaw.length === 2 ? 100 : 10)
				: 0;
			const timeSec = min * 60 + sec + frac;
			if (Number.isFinite(timeSec) && timeSec >= 0) {
				lines.push({ timeSec, text });
			}
		}
	}
	lines.sort((a, b) => a.timeSec - b.timeSec);
	return lines;
}

export function resolveMusicLyricUrl(
	data: ChatMusicShareData,
	chatServerUrl: string,
): string {
	const base = (chatServerUrl || "").replace(/\/+$/, "");
	if (!base) return "";
	let provider = (data.provider || data.sourcePlatform || "").toLowerCase();
	let bareId = (data.sourceId || "").trim();
	if (!bareId && data.id) {
		const idx = data.id.indexOf(":");
		if (idx > 0) {
			if (!provider) provider = data.id.slice(0, idx).toLowerCase();
			bareId = data.id.slice(idx + 1).trim();
		} else {
			bareId = data.id.trim();
		}
	}
	if (!provider || !bareId) return "";
	return `${base}/api/music/lyric?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(bareId)}`;
}

class PrivateMusicController {
	activeData: ChatMusicShareData | null = $state(null);
	activeMsgUid: string = $state("");
	activeSenderName: string = $state("");
	activeSenderAvatar: string = $state("");
	activeSenderUserKey: string = $state("");
	activeChatServerUrl: string = $state("");
	activeTrackKey: string = $state("");
	isPlaying: boolean = $state(false);
	isLoading: boolean = $state(false);
	isBufferingSlow: boolean = $state(false);
	audioError: string = $state("");
	currentTimeSec: number = $state(0);
	durationSec: number = $state(0);
	volume: number = $state(
		typeof window !== "undefined" && typeof window.localStorage !== "undefined"
			? readStoredChatMusicVolume()
			: DEFAULT_CHAT_MUSIC_VOLUME,
	);
	isMuted: boolean = $state(
		typeof window !== "undefined" && typeof window.localStorage !== "undefined"
			? readStoredPreviewMuted()
			: false,
	);
	lyrics: PrivateCardLyricLine[] = $state([]);
	lyricsStatus: "idle" | "loading" | "ready" | "empty" = $state("idle");

	private audioEl: HTMLAudioElement | null = null;
	private pendingSeekSec: number | null = null;
	private isSeeking = false;
	private seekIgnoreUntil = 0;
	private lyricAbort: AbortController | null = null;
	private playRequestSeq = 0;
	private bufferingSlowTimer: ReturnType<typeof setTimeout> | null = null;
	private listenerBound = false;
	private mediaSessionOwned = $state(false);

	private clearSlowBuffering(): void {
		if (this.bufferingSlowTimer !== null) {
			clearTimeout(this.bufferingSlowTimer);
			this.bufferingSlowTimer = null;
		}
		this.isBufferingSlow = false;
	}

	private scheduleSlowBuffering(delayMs = 140): void {
		this.clearSlowBuffering();
		this.bufferingSlowTimer = setTimeout(() => {
			this.bufferingSlowTimer = null;
			if (this.isLoading && !this.isPlaying) {
				this.isBufferingSlow = true;
			}
		}, delayMs);
	}

	constructor() {
		this.bindGlobalStopListener();
	}

	get ownsMediaSession(): boolean {
		return this.mediaSessionOwned;
	}

	private clearMediaSession(): void {
		if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
			return;
		}
		try {
			navigator.mediaSession.playbackState = "none";
		} catch {
			// ignore
		}
		if (typeof navigator.mediaSession.setPositionState === "function") {
			try {
				navigator.mediaSession.setPositionState();
			} catch {
				// ignore
			}
		}
		for (const action of PRIVATE_MEDIA_ACTIONS) {
			try {
				navigator.mediaSession.setActionHandler(action, null);
			} catch {
				// ignore
			}
		}
	}

	private syncMediaSessionPosition(): void {
		if (
			!this.mediaSessionOwned ||
			!this.activeData ||
			typeof navigator === "undefined" ||
			!("mediaSession" in navigator) ||
			typeof navigator.mediaSession.setPositionState !== "function"
		) {
			return;
		}
		const rawDuration =
			this.audioEl &&
			Number.isFinite(this.audioEl.duration) &&
			this.audioEl.duration > 0
				? this.audioEl.duration
				: this.effectiveDuration;
		if (!Number.isFinite(rawDuration) || rawDuration <= 0) {
			try {
				navigator.mediaSession.setPositionState();
			} catch {
				// ignore
			}
			return;
		}
		const position = Math.min(
			rawDuration,
			Math.max(0, Number.isFinite(this.currentTimeSec) ? this.currentTimeSec : 0),
		);
		const playbackRate =
			this.audioEl &&
			Number.isFinite(this.audioEl.playbackRate) &&
			this.audioEl.playbackRate > 0
				? this.audioEl.playbackRate
				: 1;
		try {
			navigator.mediaSession.setPositionState({
				duration: rawDuration,
				playbackRate,
				position,
			});
		} catch {
			// ignore
		}
	}

	private seekToSeconds(targetSec: number, startIfPaused = false): void {
		if (!this.activeData || !Number.isFinite(targetSec)) return;
		const total =
			this.audioEl &&
			Number.isFinite(this.audioEl.duration) &&
			this.audioEl.duration > 0
				? this.audioEl.duration
				: this.effectiveDuration;
		const clamped =
			total > 0 ? Math.min(total, Math.max(0, targetSec)) : Math.max(0, targetSec);
		this.currentTimeSec = clamped;
		this.seekIgnoreUntil = Date.now() + 260;
		if (
			this.audioEl &&
			Number.isFinite(this.audioEl.duration) &&
			this.audioEl.duration > 0
		) {
			try {
				this.audioEl.currentTime = clamped;
			} catch {
				// ignore
			}
			this.syncMediaSessionPosition();
			if (startIfPaused && !this.isPlaying && !this.isLoading) {
				void this.startPlayback(clamped);
			}
		} else if (startIfPaused) {
			void this.startPlayback(clamped);
		} else {
			this.pendingSeekSec = clamped;
			this.syncMediaSessionPosition();
		}
	}

	private syncMediaSession(): void {
		if (
			!this.mediaSessionOwned ||
			!this.activeData ||
			typeof navigator === "undefined" ||
			!("mediaSession" in navigator)
		) {
			return;
		}
		if (typeof MediaMetadata !== "undefined") {
			const coverUrl = resolveMediaArtworkUrl(this.activeData.cover);
			const artist = (this.activeData.artist || "").trim() || "未知歌手";
			const album = this.activeSenderName
				? `私人试听 · 分享自 ${this.activeSenderName}`
				: "聊天室私人试听";
			try {
				navigator.mediaSession.metadata = new MediaMetadata({
					title: this.activeData.title || "未命名歌曲",
					artist,
					album,
					artwork: coverUrl ? [{ src: coverUrl, sizes: "200x200" }] : [],
				});
			} catch {
				// ignore metadata errors
			}
		}
		try {
			navigator.mediaSession.playbackState =
				this.isPlaying || this.isLoading ? "playing" : "paused";
		} catch {
			// ignore
		}
		const handlers: Partial<
			Record<MediaSessionAction, MediaSessionActionHandler | null>
		> = {
			play: () => {
				if (!this.isPlaying && !this.isLoading) {
					void this.startPlayback();
				}
			},
			pause: () => {
				this.pause(true);
			},
			stop: () => {
				this.stop(true, true);
			},
			seekbackward: (details) => {
				const offset =
					typeof details.seekOffset === "number" &&
					Number.isFinite(details.seekOffset) &&
					details.seekOffset > 0
						? details.seekOffset
						: 10;
				this.seekToSeconds(this.currentTimeSec - offset, false);
			},
			seekforward: (details) => {
				const offset =
					typeof details.seekOffset === "number" &&
					Number.isFinite(details.seekOffset) &&
					details.seekOffset > 0
						? details.seekOffset
						: 10;
				this.seekToSeconds(this.currentTimeSec + offset, false);
			},
			seekto: (details) => {
				if (
					typeof details.seekTime !== "number" ||
					!Number.isFinite(details.seekTime)
				) {
					return;
				}
				if (
					details.fastSeek &&
					this.audioEl &&
					typeof this.audioEl.fastSeek === "function"
				) {
					try {
						const total = this.effectiveDuration;
						const clamped =
							total > 0
								? Math.min(total, Math.max(0, details.seekTime))
								: Math.max(0, details.seekTime);
						this.audioEl.fastSeek(clamped);
						this.currentTimeSec = clamped;
						this.seekIgnoreUntil = Date.now() + 260;
						this.syncMediaSessionPosition();
						return;
					} catch {
						// fallback below
					}
				}
				this.seekToSeconds(details.seekTime, false);
			},
		};
		for (const action of PRIVATE_MEDIA_ACTIONS) {
			try {
				navigator.mediaSession.setActionHandler(action, handlers[action] ?? null);
			} catch {
				// Some browsers expose only a subset of actions.
			}
		}
		this.syncMediaSessionPosition();
	}

	private bindGlobalStopListener(): void {
		if (
			this.listenerBound ||
			typeof window === "undefined" ||
			typeof window.addEventListener !== "function"
		) {
			return;
		}
		this.listenerBound = true;
		window.addEventListener("lx-chat-music-preview-stop", () => {
			// 房友点歌台开始播放，交出媒体控制权并暂停私有试听（不再反推 lx-chat-music-preview-state）
			this.mediaSessionOwned = false;
			this.pause(false);
		});
	}

	get effectiveDuration(): number {
		if (this.durationSec > 0) return this.durationSec;
		return this.activeData?.durationSec || 0;
	}

	get progressPercent(): number {
		const total = this.effectiveDuration;
		if (total <= 0) return 0;
		return Math.min(100, Math.max(0, (this.currentTimeSec / total) * 100));
	}

	get activeLyricIndex(): number {
		if (this.lyrics.length === 0) return -1;
		const t = this.currentTimeSec + 0.15;
		let lo = 0;
		let hi = this.lyrics.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (this.lyrics[mid].timeSec <= t) {
				found = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return found;
	}

	get activeLyricText(): string {
		const idx = this.activeLyricIndex;
		return idx >= 0 ? this.lyrics[idx]?.text || "" : "";
	}

	isTrackMatching(data: ChatMusicShareData, msgUid?: string): boolean {
		if (!this.activeData) return false;
		const uid = (msgUid || "").trim();
		if (uid && this.activeMsgUid) {
			return uid === this.activeMsgUid;
		}
		return getPrivateTrackKey(data) === this.activeTrackKey;
	}

	private applyVolumeToAudio(player: HTMLAudioElement | null): void {
		if (!player) return;
		player.volume = this.volume;
		player.muted = this.isMuted || this.volume === 0;
	}

	private applyPendingSeek(player: HTMLAudioElement): void {
		if (this.pendingSeekSec === null) return;
		if (Number.isFinite(player.duration) && player.duration > 0) {
			const target = Math.min(player.duration, Math.max(0, this.pendingSeekSec));
			this.pendingSeekSec = null;
			try {
				player.currentTime = target;
				this.currentTimeSec = target;
			} catch {
				// ignore
			}
		}
	}

	private async fetchFallbackPreviewUrl(
		data: ChatMusicShareData,
		chatServerUrl: string,
	): Promise<string> {
		const key = getPrivateTrackKey(data);
		const base = (chatServerUrl || "").replace(/\/+$/, "");
		if (!base) return "";
		const resp = await fetch(`${base}/api/music/preview`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ track: toChatMusicTrack(data) }),
			signal: AbortSignal.timeout(42_000),
		});

		const json = (await resp.json().catch(() => null)) as {
			ok?: boolean;
			error?: string;
			streamUrl?: string;
			proxyUrl?: string;
			directUrl?: string;
			durationSec?: number;
		} | null;
		if (!resp.ok || !json?.ok) throw new Error(json?.error || "试听暂时不可用");
		if (json.durationSec && !this.durationSec && this.activeTrackKey === key) {
			this.durationSec = json.durationSec;
		}
		const nextUrl = json.streamUrl || json.proxyUrl || json.directUrl || "";
		return nextUrl;
	}

	async ensureLyricsLoaded(): Promise<void> {
		if (!this.activeData) return;
		if (this.lyricsStatus === "ready" || this.lyricsStatus === "loading") return;
		const url = resolveMusicLyricUrl(this.activeData, this.activeChatServerUrl);
		if (!url) {
			this.lyricsStatus = "empty";
			return;
		}
		const cached = cardLyricsCache.get(url);
		if (cached) {
			this.lyrics = cached;
			this.lyricsStatus = cached.length > 0 ? "ready" : "empty";
			return;
		}
		this.lyricsStatus = "loading";
		this.lyricAbort?.abort();
		const controller = new AbortController();
		this.lyricAbort = controller;
		try {
			const resp = await fetch(url, { signal: controller.signal });
			if (!resp.ok) {
				if (this.lyricAbort === controller) this.lyricsStatus = "empty";
				return;
			}
			const text = await resp.text();
			if (this.lyricAbort !== controller) return;
			const parsed = parseCardLrc(text);
			cardLyricsCache.set(url, parsed);
			this.lyrics = parsed;
			this.lyricsStatus = parsed.length > 0 ? "ready" : "empty";
		} catch {
			if (this.lyricAbort === controller) {
				this.lyricsStatus = "empty";
			}
		}
	}

	private bindAudioEvents(
		player: HTMLAudioElement,
		allowFallback: boolean,
		requestSeq: number,
	): void {
		player.ontimeupdate = () => {
			if (
				this.audioEl !== player ||
				this.isSeeking ||
				Date.now() < this.seekIgnoreUntil
			) {
				return;
			}
			this.currentTimeSec = player.currentTime || 0;
		};
		player.onloadedmetadata = () => {
			if (this.audioEl !== player) return;
			if (Number.isFinite(player.duration) && player.duration > 0) {
				this.durationSec = player.duration;
			}
			this.applyPendingSeek(player);
			this.syncMediaSessionPosition();
		};
		player.onseeked = () => {
			if (this.audioEl !== player) return;
			if (!this.isSeeking && Date.now() >= this.seekIgnoreUntil) {
				this.currentTimeSec = player.currentTime || 0;
			}
			this.syncMediaSessionPosition();
		};
		player.onplaying = () => {
			if (this.audioEl !== player) return;
			this.applyPendingSeek(player);
			this.clearSlowBuffering();
			this.isLoading = false;
			this.isPlaying = true;
			this.audioError = "";
			notifyRoomPreviewState(true);
			this.syncMediaSession();
		};
		player.onwaiting = () => {
			if (this.audioEl !== player) return;
			this.isLoading = true;
			if (!this.isPlaying) {
				this.scheduleSlowBuffering(160);
			}
		};
		player.onpause = () => {
			if (this.audioEl !== player) return;
			this.clearSlowBuffering();
			this.isPlaying = false;
			this.isLoading = false;
			this.syncMediaSession();
		};
		player.onended = () => {
			if (this.audioEl !== player) return;
			this.stop(true, true);
		};
		player.onerror = async () => {
			if (this.audioEl !== player || requestSeq !== this.playRequestSeq) return;
			if (allowFallback && this.activeData) {
				try {
					this.isLoading = true;
					this.scheduleSlowBuffering(140);
					const fallbackUrl = await this.fetchFallbackPreviewUrl(
						this.activeData,
						this.activeChatServerUrl,
					);
					if (
						requestSeq === this.playRequestSeq &&
						fallbackUrl &&
						fallbackUrl !== player.src
					) {
						const fallbackPlayer = new Audio(fallbackUrl);
						fallbackPlayer.preload = "auto";
						this.applyVolumeToAudio(fallbackPlayer);
						this.audioEl = fallbackPlayer;
						this.bindAudioEvents(fallbackPlayer, false, requestSeq);
						await fallbackPlayer.play();
						return;
					}
				} catch {
					// fall through
				}
			}
			if (requestSeq === this.playRequestSeq) {
				this.stop(false, true);
				this.audioError = "试听暂不可用";
			}
		};
	}

	pause(notifyRoom = true): void {
		this.stop(false, notifyRoom);
	}

	stop(resetTime = false, notifyRoom = true): void {
		const wasActive = this.isPlaying || this.isLoading;
		this.playRequestSeq += 1;
		if (this.audioEl) {
			this.audioEl.pause();
			if (resetTime) {
				try {
					this.audioEl.currentTime = 0;
				} catch {
					// ignore
				}
				this.currentTimeSec = 0;
			}
		}
		this.clearSlowBuffering();
		this.isPlaying = false;
		this.isLoading = false;
		this.pendingSeekSec = null;
		this.syncMediaSession();
		if (notifyRoom && wasActive) {
			notifyRoomPreviewState(false);
		}
	}

	private teardownAudioOnly(): void {
		this.playRequestSeq += 1;
		this.clearSlowBuffering();
		if (this.audioEl) {
			this.audioEl.onplaying = null;
			this.audioEl.ontimeupdate = null;
			this.audioEl.onloadedmetadata = null;
			this.audioEl.onseeked = null;
			this.audioEl.onwaiting = null;
			this.audioEl.onpause = null;
			this.audioEl.onended = null;
			this.audioEl.onerror = null;
			this.audioEl.pause();
			this.audioEl = null;
		}
		this.isPlaying = false;
		this.isLoading = false;
		this.pendingSeekSec = null;
	}

	private async startPlayback(seekToSec?: number): Promise<void> {
		if (!this.activeData) return;
		this.bindGlobalStopListener();
		this.audioError = "";
		void this.ensureLyricsLoaded();
		if (typeof seekToSec === "number" && Number.isFinite(seekToSec)) {
			this.pendingSeekSec = seekToSec;
			this.currentTimeSec = seekToSec;
		}

		this.volume = readStoredChatMusicVolume(this.volume);
		this.isMuted = readStoredPreviewMuted();
		this.mediaSessionOwned = true;
		notifyRoomPreviewState(true);
		this.syncMediaSession();

		const reqSeq = ++this.playRequestSeq;

		if (this.audioEl?.src && !this.audioEl.error) {
			this.applyVolumeToAudio(this.audioEl);
			this.applyPendingSeek(this.audioEl);
			this.isLoading = true;
			if (this.audioEl.readyState < 3) {
				this.scheduleSlowBuffering(140);
			}
			try {
				await this.audioEl.play();
				return;
			} catch {
				// reload source below
			}
		}

		this.isLoading = true;
		this.scheduleSlowBuffering(140);
		let primaryUrl = this.activeData.sharedAudioUrl || "";
		let previewError = "暂无试听音源";
		let allowFallback = true;

		if (!primaryUrl) {
			allowFallback = false;
			try {
				primaryUrl = await this.fetchFallbackPreviewUrl(
					this.activeData,
					this.activeChatServerUrl,
				);
			} catch (error) {
				previewError = error instanceof Error && error.name === "Error" ? error.message : "试听连接暂时不可用";
				primaryUrl = "";
			}
		}

		if (reqSeq !== this.playRequestSeq) return;

		if (!primaryUrl) {
			this.isLoading = false;
			this.audioError = previewError;
			notifyRoomPreviewState(false);
			return;
		}

		const player = new Audio(primaryUrl);
		player.preload = "auto";
		this.applyVolumeToAudio(player);
		this.audioEl = player;
		this.bindAudioEvents(player, allowFallback, reqSeq);

		try {
			await player.play();
		} catch {
			if (reqSeq !== this.playRequestSeq) return;
			if (!allowFallback) {
				this.stop(false, true);
				this.audioError = "试听启动失败";
			}
		}
	}

	async playOrToggle(req: PrivatePlayRequest): Promise<void> {
		const {
			data,
			msgUid = "",
			senderName = "",
			senderAvatar = "",
			senderUserKey = "",
			chatServerUrl,
			seekToSec,
		} = req;
		const sameTrack = this.isTrackMatching(data, msgUid);
		if (sameTrack && seekToSec === undefined) {
			if (msgUid && !this.activeMsgUid) {
				this.activeMsgUid = msgUid;
			}
			if (senderName && !this.activeSenderName) {
				this.activeSenderName = senderName;
			}
			if (senderAvatar && !this.activeSenderAvatar) {
				this.activeSenderAvatar = senderAvatar;
			}
			if (senderUserKey && !this.activeSenderUserKey) {
				this.activeSenderUserKey = senderUserKey;
			}
			if (this.isPlaying || this.isLoading) {
				this.pause(true);
				return;
			}
			await this.startPlayback();
			return;
		}

		if (!sameTrack) {
			const hadActive = this.isPlaying || this.isLoading;
			this.teardownAudioOnly();
			this.lyricAbort?.abort();
			this.lyricAbort = null;
			this.activeData = data;
			this.activeMsgUid = msgUid;
			this.activeSenderName = senderName;
			this.activeSenderAvatar = senderAvatar;
			this.activeSenderUserKey = senderUserKey;
			this.activeChatServerUrl = chatServerUrl;
			this.activeTrackKey = getPrivateTrackKey(data);
			this.currentTimeSec = typeof seekToSec === "number" ? seekToSec : 0;
			this.durationSec = data.durationSec || 0;
			this.lyrics = [];
			this.lyricsStatus = "idle";
			this.audioError = "";
			if (hadActive) {
				notifyRoomPreviewState(false);
			}
		} else if (chatServerUrl) {
			this.activeChatServerUrl = chatServerUrl;
		}

		await this.startPlayback(seekToSec);
	}

	async toggleActivePlay(): Promise<void> {
		if (!this.activeData) return;
		if (this.isPlaying || this.isLoading) {
			this.pause(true);
			return;
		}
		await this.startPlayback();
	}

	setScrubbing(active: boolean): void {
		this.isSeeking = active;
	}

	previewScrubRatio(ratio: number): void {
		const total = this.effectiveDuration;
		if (total <= 0) return;
		this.currentTimeSec = Math.min(1, Math.max(0, ratio)) * total;
	}

	commitScrubRatio(ratio: number, startIfPaused = true): void {
		const total = this.effectiveDuration;
		if (total <= 0 || !this.activeData) return;
		const targetSec = Math.min(1, Math.max(0, ratio)) * total;
		this.seekToSeconds(targetSec, startIfPaused);
	}

	setVolume(next: number, options?: { unmuteIfActive?: boolean }): void {
		const clamped = writeStoredChatMusicVolume(next);
		this.volume = clamped;
		if (options?.unmuteIfActive !== false && clamped > 0 && this.isMuted) {
			this.isMuted = false;
			writeStoredPreviewMuted(false);
		}
		this.applyVolumeToAudio(this.audioEl);
	}

	toggleMute(): void {
		this.isMuted = !this.isMuted;
		writeStoredPreviewMuted(this.isMuted);
		if (!this.isMuted && this.volume === 0) {
			this.volume = writeStoredChatMusicVolume(0.5);
		}
		this.applyVolumeToAudio(this.audioEl);
	}

	resetSessionState(): void {
		const hadMediaOwnership = this.mediaSessionOwned;
		this.mediaSessionOwned = false;
		this.stop(true, true);
		this.teardownAudioOnly();
		if (hadMediaOwnership) {
			this.clearMediaSession();
		}
		this.lyricAbort?.abort();
		this.lyricAbort = null;
		this.activeData = null;
		this.activeMsgUid = "";
		this.activeSenderName = "";
		this.activeSenderAvatar = "";
		this.activeSenderUserKey = "";
		this.activeTrackKey = "";
		this.currentTimeSec = 0;
		this.durationSec = 0;
		this.lyrics = [];
		this.lyricsStatus = "idle";
		this.audioError = "";
	}
}

export const privateMusic: PrivateMusicController = new PrivateMusicController();
