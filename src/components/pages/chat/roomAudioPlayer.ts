import type { CurrentPlayback } from "./chatTypes";

export type AudioStatus =
	| "idle"
	| "preparing"
	| "loading"
	| "playing"
	| "recovering"
	| "blocked"
	| "error";
export const audioStatusLabel: Record<AudioStatus, string> = {
	idle: "未收听",
	preparing: "准备同步播放",
	loading: "正在缓冲",
	playing: "正在收听",
	recovering: "正在恢复播放",
	blocked: "点击恢复收听",
	error: "加载失败，点击重试",
};

const INITIAL_ALIGN_THRESHOLD_SEC = 0.5;
const PLAYBACK_DRIFT_SEEK_SEC = 2.2;
const SEEK_COOLDOWN_MS = 5000;
const INITIAL_SEEK_COOLDOWN_MS = 900;

export function correctionForDrift(
	drift: number,
	bufferedHeadroom = 0,
): {
	seek: boolean;
	rate: number;
} {
	if (
		Math.abs(drift) >= (bufferedHeadroom >= 2 ? 0.5 : PLAYBACK_DRIFT_SEEK_SEC)
	) {
		return { seek: true, rate: 1 };
	}
	return { seek: false, rate: 1 };
}

interface Callbacks {
	now: () => number;
	status: (status: AudioStatus, intent: boolean) => void;
	ready: (uid: string, revision: number) => void;
	error: (uid: string, revision: number) => void;
	ended: (uid: string) => void;
	duration: (uid: string, duration: number) => void;
}

let instanceCounter = 0;

/**
 * Simple, deterministic timestamp-offset audio controller.
 * - Never uses a second <audio> element (prevents Chromium HttpCache exclusive write lock deadlocks).
 * - Never mutates playbackRate during playback (prevents iPad/iOS CoreAudio Time-Pitch DSP stutters).
 * - Aligns playhead directly to (serverNow - startedAt) / 1000 once active playback begins.
 */
export class RoomAudioPlayer {
	private readonly cid =
		`${Date.now().toString(36)}_${(++instanceCounter).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
	private play: CurrentPlayback | null = null;
	private key = "";
	private activeSrc = "";
	private intent = false;
	private status: AudioStatus = "idle";
	private volume = 1;
	private epoch = 0;
	private retries = 0;
	private retryAt = 0;
	private waitingSince = 0;
	private lastSeek = Number.NEGATIVE_INFINITY;
	private initialAligned = false;
	private initialSeeks = 0;
	private lastProgress = 0;
	private progressAt = 0;
	private readySent = false;
	private reported = false;
	private durationSent = false;
	private endedSent = false;
	private starting = false;
	private destroyed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private preloadUrl = "";
	private preparedBlob: Blob | null = null;
	private preloadRetryAt = 0;
	private objectUrl = "";
	private awaitingStart = false;
	private followMuted = false;
	private bufferEnd = 0;
	private preloadAbort: AbortController | null = null;
	private desiredPreload: CurrentPlayback | null = null;
	private listeners: [string, EventListener][] = [];

	private resume = () => {
		if (document.hidden || !this.intent || this.status === "blocked") return;
		this.progressAt = performance.now();
		if (this.waitingSince) this.waitingSince = this.progressAt;
		if (this.status === "error") this.listen();
		else this.check();
	};

	constructor(
		private readonly audio: HTMLAudioElement,
		private readonly callbacks: Callbacks,
	) {
		for (const event of [
			"loadedmetadata",
			"durationchange",
			"canplay",
			"canplaythrough",
			"progress",
			"playing",
			"timeupdate",
			"waiting",
			"stalled",
			"seeked",
			"ended",
			"error",
			"pause",
		]) {
			const listener = () => this.onEvent(event);
			audio.addEventListener(event, listener);
			this.listeners.push([event, listener]);
		}
		document.addEventListener("visibilitychange", this.resume);
		window.addEventListener("online", this.resume);
		window.addEventListener("pageshow", this.resume);
		this.tick();
	}

	private emit(status: AudioStatus): void {
		this.status = status;
		this.callbacks.status(status, this.intent);
	}

	private emitIfChanged(status: AudioStatus): void {
		if (this.status !== status) this.emit(status);
	}

	/**
	 * Attach a per-tab client instance ID (_cid) to real HTTP stream URLs so that multiple tabs
	 * in the same browser never block each other on Chromium's HttpCache exclusive media lock.
	 */
	private buildStreamSrc(rawUrl: string, revision = 0, suffix = ""): string {
		if (!rawUrl) return "";
		if (!rawUrl.includes("/api/music/stream")) return rawUrl;
		const sep = rawUrl.includes("?") ? "&" : "?";
		const clientTag = suffix ? `${this.cid}_${suffix}` : this.cid;
		return `${rawUrl}${sep}_cid=${clientTag}${revision > 0 ? `&_rev=${revision}` : ""}`;
	}

	setVolume(volume: number): void {
		this.volume = Math.min(1, Math.max(0, volume));
		if (this.initialAligned || !this.intent || !this.play) {
			this.audio.volume = this.volume;
		}
	}

	setTrack(play: CurrentPlayback | null): void {
		const key = play
			? `${play.uid}:${play.sourceRevision ?? 0}:${play.track.streamUrl}`
			: "";
		this.play = play;
		if (key === this.key) {
			this.check();
			return;
		}
		const prepared =
			play?.track.streamUrl === this.preloadUrl && !play?.sourceRevision
				? this.preparedBlob
				: null;
		this.preparedBlob = null;
		this.preloadUrl = "";
		this.cancelPreloadFetch();
		if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
		this.objectUrl = prepared ? URL.createObjectURL(prepared) : "";
		this.awaitingStart = false;
		this.bufferEnd = 0;
		this.key = key;
		this.epoch++;
		this.starting = false;
		this.retries = 0;
		this.retryAt = 0;
		this.waitingSince = 0;
		this.initialSeeks = 0;
		this.readySent =
			this.reported =
			this.durationSent =
			this.endedSent =
			this.initialAligned =
				false;
		this.lastSeek = Number.NEGATIVE_INFINITY;
		this.progressAt = performance.now();
		this.lastProgress = 0;
		this.audio.pause();
		this.audio.playbackRate = 1;
		if (!play?.track.streamUrl) {
			this.activeSrc = "";
			this.audio.muted = true;
			this.audio.removeAttribute("src");
			this.audio.load();
			this.emit("idle");
			return;
		}
		this.activeSrc =
			this.objectUrl ||
			this.buildStreamSrc(play.track.streamUrl, play.sourceRevision ?? 0);
		this.audio.src = this.activeSrc;
		this.audio.load();
		if ((this.intent || this.followMuted) && this.scheduled()) {
			this.awaitingStart = true;
			this.audio.muted = true;
			this.emit(this.intent ? "preparing" : "idle");
		} else if (this.intent) this.start();
		else if (this.followMuted) this.startMuted();
		else {
			this.audio.muted = true;
			this.emit("idle");
		}
	}

	private cancelPreloadFetch(): void {
		if (this.preloadAbort) {
			this.preloadAbort.abort();
			this.preloadAbort = null;
		}
	}

	preloadNext(play: CurrentPlayback | null): void {
		if (this.desiredPreload?.track.streamUrl !== play?.track.streamUrl) {
			this.preloadRetryAt = 0;
			this.cancelPreloadFetch();
			this.preparedBlob = null;
			this.preloadUrl = "";
		}
		this.desiredPreload = play;
		if (!play) {
			this.preloadUrl = "";
			this.cancelPreloadFetch();
			return;
		}
		this.maybeRunPreload();
	}

	private maybeRunPreload(): void {
		if (typeof fetch !== "function" || performance.now() < this.preloadRetryAt)
			return;
		const connection = (
			navigator as Navigator & {
				connection?: { saveData?: boolean; effectiveType?: string };
			}
		).connection;
		if (
			connection?.saveData ||
			/^(slow-)?2g$/.test(connection?.effectiveType ?? "")
		) {
			return;
		}
		if (
			(this.intent && this.status !== "playing") ||
			!this.play ||
			(this.intent && !this.initialAligned) ||
			this.starting ||
			this.audio.seeking
		) {
			return;
		}
		const url = this.desiredPreload?.track.streamUrl ?? "";
		if (!url || url === this.preloadUrl || url === this.play.track.streamUrl) {
			return;
		}
		// Only warm the next track once the current track has buffered at least 10s ahead
		const ranges = this.audio.buffered;
		let bufferedAhead = 0;
		if (ranges && typeof ranges.length === "number") {
			for (let i = 0; i < ranges.length; i++) {
				const s = ranges.start(i);
				const e = ranges.end(i);
				if (
					this.audio.currentTime >= s - 0.5 &&
					this.audio.currentTime <= e + 0.5
				) {
					bufferedAhead = e - this.audio.currentTime;
					break;
				}
			}
		}
		const duration = this.audio.duration;
		const fullyBuffered =
			Number.isFinite(duration) &&
			duration > 0 &&
			ranges?.length > 0 &&
			ranges.end(ranges.length - 1) >= duration - 0.5;
		if (bufferedAhead < 10 && !fullyBuffered) return;

		this.preloadUrl = url;
		this.cancelPreloadFetch();
		// Keep one complete next song for direct use by the same media element.
		const controller = new AbortController();
		this.preloadAbort = controller;
		void fetch(this.buildStreamSrc(url, 0, "pre"), {
			signal: controller.signal,
		})
			.then(async (response) => {
				const size = Number(response.headers.get("content-length"));
				if (response.status !== 200 || !(size > 0 && size <= 8 * 1024 * 1024)) {
					await response.body?.cancel();
					return;
				}
				const blob = await response.blob();
				if (this.preloadAbort === controller && blob.size === size)
					this.preparedBlob = blob;
			})
			.catch(() => {
				if (this.preloadAbort === controller) {
					this.preloadUrl = "";
					this.preloadRetryAt = performance.now() + 30000;
				}
			})
			.finally(() => {
				if (this.preloadAbort === controller) this.preloadAbort = null;
			});
	}

	listen(): void {
		this.intent = true;
		this.followMuted = false;
		if (
			this.play &&
			!this.starting &&
			!this.retryAt &&
			!this.audio.paused &&
			!this.audio.ended &&
			!this.audio.error &&
			!this.audio.seeking &&
			this.audio.readyState >= 3 &&
			!this.scheduled() &&
			Math.abs(this.audio.currentTime - this.expected()) <
				INITIAL_ALIGN_THRESHOLD_SEC
		) {
			this.initialAligned = true;
			this.audio.volume = this.volume;
			this.audio.muted = false;
			this.progressAt = performance.now();
			this.emit("playing");
			return;
		}
		this.lastSeek = Number.NEGATIVE_INFINITY;
		this.initialAligned = false;
		this.initialSeeks = 0;
		this.retries = 0;
		this.retryAt = 0;
		this.reported = false;
		this.epoch++;
		this.starting = false;
		if (!this.play) {
			this.emit("idle");
			return;
		}
		if (!this.activeSrc && this.play.track.streamUrl) {
			this.activeSrc = this.buildStreamSrc(
				this.play.track.streamUrl,
				this.play.sourceRevision ?? 0,
			);
			this.audio.src = this.activeSrc;
		}
		if (this.audio.error || this.status === "error") this.audio.load();
		this.start(); // Synchronous play() retains the explicit user gesture on Safari.
	}

	stop(): void {
		this.followMuted = !this.destroyed && (this.intent || this.followMuted);
		this.intent = false;
		this.epoch++;
		this.starting = false;
		this.retryAt = this.waitingSince = 0;
		this.awaitingStart = this.followMuted && this.scheduled();
		this.audio.muted = true;
		this.audio.playbackRate = 1;
		// Keep a running stream on the room timeline while locally muted.
		this.emit("idle");
	}

	private startMuted(): void {
		this.awaitingStart = false;
		this.audio.muted = true;
		void this.audio.play().catch(() => {});
	}

	private scheduled(): boolean {
		return (
			!!this.play &&
			this.play.phase === "scheduled" &&
			this.callbacks.now() < this.play.startedAt
		);
	}

	private expected(): number {
		return this.play
			? Math.max(0, (this.callbacks.now() - this.play.startedAt) / 1000)
			: 0;
	}

	private isTargetSeekable(target: number): boolean {
		const duration = this.audio.duration;
		if (!Number.isFinite(duration) || duration <= 0) {
			return this.audio.readyState >= 1;
		}
		const seekable = (
			this.audio as HTMLAudioElement & {
				seekable?: TimeRanges;
			}
		).seekable;
		if (
			seekable &&
			typeof seekable.length === "number" &&
			seekable.length > 0
		) {
			for (let i = 0; i < seekable.length; i++) {
				if (
					target >= seekable.start(i) - 0.25 &&
					target <= seekable.end(i) + 0.25
				) {
					return true;
				}
			}
			return false;
		}
		return true;
	}

	private align(force = false): void {
		if (!this.play || this.audio.readyState < 1 || this.audio.seeking) {
			return;
		}
		if (this.audio.playbackRate !== 1) {
			this.audio.playbackRate = 1;
		}
		const mono = performance.now();
		const duration = this.audio.duration;
		const maxTime =
			Number.isFinite(duration) && duration > 0
				? Math.max(0, duration - 0.2)
				: Number.POSITIVE_INFINITY;
		const target = Math.min(this.expected(), maxTime);
		const drift = target - this.audio.currentTime;

		// 1. Initial alignment on track start / late join / unmute
		if (force || !this.initialAligned) {
			const threshold =
				this.initialSeeks === 0
					? INITIAL_ALIGN_THRESHOLD_SEC
					: PLAYBACK_DRIFT_SEEK_SEC;
			const needsSeek = Math.abs(drift) > threshold;
			if (!needsSeek) {
				if (
					!this.starting &&
					!this.audio.paused &&
					this.audio.readyState >= 2
				) {
					this.initialAligned = true;
					this.audio.volume = this.volume;
				}
				return;
			}
			if (mono - this.lastSeek < INITIAL_SEEK_COOLDOWN_MS) return;
			if (!this.isTargetSeekable(target)) return;
			try {
				this.audio.currentTime = target;
				this.lastSeek = mono;
				this.initialSeeks++;
				if (
					!this.starting &&
					!this.audio.paused &&
					!this.audio.seeking &&
					this.audio.readyState >= 2
				) {
					this.initialAligned = true;
					this.audio.volume = this.volume;
				} else if (
					this.initialSeeks >= 2 &&
					!this.starting &&
					!this.audio.paused
				) {
					this.initialAligned = true;
					this.audio.volume = this.volume;
				}
			} catch {
				return;
			}
			return;
		}

		if (this.starting || this.audio.paused || this.audio.readyState < 2) {
			return;
		}

		// Correct smaller drift only if the destination is already buffered.
		const ranges = this.audio.buffered;
		let headroom = 0;
		for (let i = 0; i < ranges.length; i++) {
			if (ranges.start(i) <= target && target <= ranges.end(i)) {
				headroom = ranges.end(i) - target;
				break;
			}
		}
		if (correctionForDrift(drift, headroom).seek) {
			if (mono - this.lastSeek < SEEK_COOLDOWN_MS) return;
			if (!this.isTargetSeekable(target)) return;
			try {
				this.audio.currentTime = target;
				this.lastSeek = mono;
			} catch {
				return;
			}
		}
	}

	private start(): void {
		if (this.destroyed || !this.intent || !this.play || this.starting) return;
		this.awaitingStart = false;
		const epoch = this.epoch;
		this.starting = true;
		this.waitingSince = performance.now();
		this.progressAt = this.waitingSince;
		this.audio.playbackRate = 1;
		const isScheduledFuture = this.scheduled();
		const needsInitialSeek =
			!this.initialAligned && this.expected() > INITIAL_ALIGN_THRESHOLD_SEC;
		if (needsInitialSeek && this.audio.readyState >= 1) {
			this.align(true);
		}
		// Hold volume at 0 while seeking to a mid-song offset so the listener never hears a 0.0s blip before the seek lands.
		this.audio.volume =
			needsInitialSeek && (!this.initialAligned || this.audio.seeking)
				? 0
				: this.volume;
		this.audio.muted =
			isScheduledFuture || (needsInitialSeek && !this.initialAligned);
		this.emit(
			isScheduledFuture ? "preparing" : this.retries ? "recovering" : "loading",
		);
		try {
			void this.audio.play().then(
				() => {
					if (epoch !== this.epoch || this.destroyed) return;
					this.starting = false;
					if (isScheduledFuture && this.scheduled()) {
						this.audio.pause();
						this.audio.currentTime = 0;
						this.awaitingStart = true;
					}
					this.check();
				},
				(error: unknown) => {
					if (epoch !== this.epoch || this.destroyed) return;
					this.starting = false;
					if (
						error instanceof DOMException &&
						error.name === "NotAllowedError"
					) {
						this.audio.muted = true;
						this.emit("blocked");
					} else {
						this.fail();
					}
				},
			);
		} catch {
			this.starting = false;
			this.fail();
		}
	}

	private fail(): void {
		if (
			!this.intent ||
			!this.play ||
			this.retryAt ||
			this.status === "blocked" ||
			this.status === "error"
		)
			return;
		this.audio.muted = true;
		this.audio.playbackRate = 1;
		if (this.retries < 3) {
			this.retryAt = performance.now() + [350, 900, 1800][this.retries++];
			this.emit("recovering");
		} else {
			this.emit("error");
			if (!this.reported && navigator.onLine) {
				this.reported = true;
				this.callbacks.error(this.play.uid, this.play.sourceRevision ?? 0);
			}
		}
	}

	private check(): void {
		if (
			this.followMuted &&
			!this.intent &&
			this.awaitingStart &&
			!this.scheduled()
		) {
			this.startMuted();
		}

		if (
			!this.play ||
			!this.intent ||
			this.destroyed ||
			this.status === "blocked" ||
			this.status === "error"
		)
			return;
		const mono = performance.now();
		if (this.awaitingStart && !this.scheduled()) {
			this.start();
			return;
		}
		if (this.retryAt) {
			if (mono >= this.retryAt && navigator.onLine) {
				this.retryAt = 0;
				this.epoch++;
				this.starting = false;
				this.initialAligned = false;
				this.initialSeeks = 0;
				this.bufferEnd = 0;
				this.activeSrc = this.buildStreamSrc(
					this.play.track.streamUrl,
					this.play.sourceRevision ?? 0,
					`r${this.retries}`,
				);
				this.audio.src = this.activeSrc;
				this.audio.load();
				this.start();
			}
			return;
		}
		const audio = this.audio;
		if (
			!this.readySent &&
			audio.readyState >= 3 &&
			audio.buffered.length &&
			audio.buffered.start(0) <= 0.5 &&
			audio.buffered.end(0) >= 0.5
		) {
			this.readySent = true;
			this.callbacks.ready(this.play.uid, this.play.sourceRevision ?? 0);
		}
		if (this.scheduled()) {
			audio.muted = true;
			this.emitIfChanged("preparing");
		} else if (audio.readyState >= 1) {
			if (!this.initialAligned) {
				if (this.expected() > INITIAL_ALIGN_THRESHOLD_SEC) {
					audio.volume = 0;
				}
				this.align(true);
			} else if (!this.starting && audio.readyState >= 2 && !audio.paused) {
				this.align(false);
			}
			if (
				!this.starting &&
				audio.readyState >= 2 &&
				!audio.paused &&
				!audio.seeking &&
				this.initialAligned
			) {
				audio.volume = this.volume;
				audio.muted = false;
				this.waitingSince = 0;
				this.emitIfChanged("playing");
				this.maybeRunPreload();
			}
		}
		if (Math.abs(audio.currentTime - this.lastProgress) > 0.02) {
			this.lastProgress = audio.currentTime;
			this.progressAt = mono;
		}
		const ranges = audio.buffered;
		const end = ranges.length ? ranges.end(ranges.length - 1) : 0;
		if (
			end > this.bufferEnd &&
			(audio.readyState < 3 || audio.seeking || this.starting)
		) {
			this.progressAt = mono;
			if (this.waitingSince) this.waitingSince = mono;
		}
		this.bufferEnd = end;
		const timeout =
			!this.initialAligned || audio.readyState < 3 ? 4_500 : 9_000;
		if (!this.scheduled() && !audio.ended && mono - this.progressAt > timeout)
			this.fail();
		if (
			this.waitingSince &&
			mono - this.waitingSince > timeout &&
			!this.scheduled()
		)
			this.fail();
	}

	private onEvent(event: string): void {
		if (!this.play) return;
		if (!this.intent && event === "progress") this.maybeRunPreload();
		const attrSrc = this.audio.getAttribute("src") || "";
		if (attrSrc !== this.activeSrc && attrSrc !== this.play.track.streamUrl) {
			return;
		}
		if (event === "error") {
			this.fail();
			return;
		}
		if (
			event === "ended" &&
			!this.endedSent &&
			!this.scheduled() &&
			this.intent
		) {
			this.endedSent = true;
			this.callbacks.ended(this.play.uid);
		}
		if (
			!this.durationSent &&
			Number.isFinite(this.audio.duration) &&
			this.audio.duration > 0
		) {
			this.durationSent = true;
			this.callbacks.duration(this.play.uid, this.audio.duration);
		}
		if (
			(event === "waiting" || event === "stalled") &&
			this.intent &&
			!this.scheduled() &&
			this.status !== "error" &&
			this.status !== "blocked" &&
			!this.retryAt &&
			this.audio.readyState < 3
		) {
			if (this.preloadAbort) {
				this.cancelPreloadFetch();
				this.preloadUrl = "";
				this.preloadRetryAt = performance.now() + 30000;
			}
			this.waitingSince ||= performance.now();
			this.emitIfChanged("loading");
		}
		if (
			event === "pause" &&
			this.intent &&
			!this.starting &&
			!this.retryAt &&
			!this.audio.ended &&
			this.status === "playing" &&
			this.audio.paused
		) {
			this.audio.muted = true;
			this.emit("blocked");
		}
		this.check();
	}

	private tick(): void {
		this.check();
		const remaining = this.play
			? this.play.startedAt - this.callbacks.now()
			: Number.POSITIVE_INFINITY;
		this.timer = setTimeout(
			() => this.tick(),
			remaining > 0 && remaining < 250 ? Math.max(10, remaining) : 250,
		);
	}

	destroy(): void {
		this.destroyed = true;
		this.cancelPreloadFetch();
		this.stop();
		this.audio.pause();
		this.audio.removeAttribute("src");
		this.audio.load();
		if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
		this.preparedBlob = null;
		clearTimeout(this.timer);
		for (const [event, listener] of this.listeners)
			this.audio.removeEventListener(event, listener);
		document.removeEventListener("visibilitychange", this.resume);
		window.removeEventListener("online", this.resume);
		window.removeEventListener("pageshow", this.resume);
	}
}
