import { recordMusicEvent } from "./musicTrace";
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

export function correctionForDrift(drift: number): {
	seek: boolean;
	rate: number;
} {
	if (Math.abs(drift) >= PLAYBACK_DRIFT_SEEK_SEC) {
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
	private preloadRetryAt = 0;
	private awaitingStart = false;
	private followMuted = false;
	private staged: CurrentPlayback | null = null;
	private standby: HTMLAudioElement | null = null;
	private standbyUrl = "";
	private standbyRevision = 0;
	private loadSerial = 0;
	private promoted = false;
	private requiresOriginalElement = false;
	private firstProgress = false;
	private recoverDrift = false;
	private groupStart = false;
	private gesturePreroll = false;
	private standbyReady = () => {
		if (this.standby && this.standbyUrl) this.trace("next-canplay", { ready: this.standby.readyState, bufferedTo: this.bufferedTo(this.standby) });
	};
	private bufferedTo(el: HTMLAudioElement): number {
		const ranges = el.buffered;
		for (let i = 0; i < ranges.length; i++) {
			if (ranges.start(i) <= el.currentTime + 0.05 && ranges.end(i) >= el.currentTime)
				return ranges.end(i);
		}
		return el.currentTime;
	}
	private prepareStandby(next: CurrentPlayback): void {
		if (!this.audio.ownerDocument || this.requiresOriginalElement) return;
		if (
			this.standbyUrl === next.track.streamUrl &&
			this.standbyRevision === (next.sourceRevision ?? 0)
		)
			return;
		if (!this.standby)
			this.standby = this.audio.ownerDocument.createElement("audio");
		const el = this.standby;
		el.removeEventListener("canplay", this.standbyReady);
		el.addEventListener("canplay", this.standbyReady, { once: true });
		el.preload = "auto";
		el.muted = true;
		el.setAttribute("playsinline", "");
		this.standbyUrl = next.track.streamUrl;
		this.standbyRevision = next.sourceRevision ?? 0;
		el.src = this.buildStreamSrc(
			this.standbyUrl,
			this.standbyRevision,
			"next" + ++this.loadSerial,
		);
		el.load();
		this.trace("prepare-next", { next: next.uid });
	}
	private clearStandby(): void {
		this.standby?.removeEventListener("canplay", this.standbyReady);
		if (this.standby?.hasAttribute("src")) {
			this.standby.pause();
			this.standby.removeAttribute("src");
			this.standby.load();
		}
		this.standbyUrl = "";
	}
	get position(): number {
		return this.audio.currentTime;
	}
	private swapElements(): void {
		const next = this.standby;
		if (!next) return;
		next.removeEventListener("canplay", this.standbyReady);
		this.audio.muted = true;
		this.audio.pause();
		for (const [event, listener] of this.listeners) {
			this.audio.removeEventListener(event, listener);
			next.addEventListener(event, listener);
		}
		this.standby = this.audio;
		this.audio = next;
		this.clearStandby();
	}
	private trace(
		event: string,
		detail: Record<string, string | number | boolean> = {},
	) {
		recordMusicEvent(event, this.play?.uid, {
			clock: Math.round(this.callbacks.now()),
			position: this.audio.currentTime,
			bufferedTo: this.bufferedTo(this.audio),
			paused: this.audio.paused,
			seeking: this.audio.seeking,
			ready: this.audio.readyState,
			muted: this.audio.muted,
			...detail,
		});
	}
	private bufferEnd = 0;
	private desiredPreload: CurrentPlayback | null = null;
	private listeners: [string, EventListener][] = [];

	private resume = () => {
		if (document.hidden || !this.intent || this.status === "blocked") return;
		this.recoverDrift = true;
		this.progressAt = performance.now();
		if (this.waitingSince) this.waitingSince = this.progressAt;
		if (this.status === "error") this.listen();
		else this.check();
	};

	constructor(
		private audio: HTMLAudioElement,
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
		if (status !== this.status) this.trace(status);
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
		// Prepare the next native media element while the old element remains audible.
		if (
			play &&
			this.play &&
			play.uid !== this.play.uid &&
			(this.intent || this.followMuted) &&
			!this.audio.paused &&
			play.phase === "scheduled" &&
			play.startedAt > this.callbacks.now() &&
			this.audio.ownerDocument &&
			!this.requiresOriginalElement
		) {
			if (this.staged?.uid !== play.uid)
				this.trace("handoff-scheduled", {
					next: play.uid,
					deadline: play.startedAt,
				});
			this.staged = play;
			this.prepareStandby(play);
			return;
		}
		this.staged = null;

		const key = play
			? `${play.uid}:${play.sourceRevision ?? 0}:${play.track.streamUrl}`
			: "";
		const previous = this.play;
		this.play = play;
		if (key === this.key) {
			this.check();
			return;
		}
		this.groupStart =
			!!previous &&
			previous.uid !== play?.uid &&
			this.intent &&
			!!play &&
			Math.abs(this.callbacks.now() - play.startedAt) < 2000;
		this.firstProgress = this.gesturePreroll = this.recoverDrift = false;
		const promote =
			!!play &&
			!!this.standby &&
			this.standbyUrl === play.track.streamUrl &&
			this.standbyRevision === (play.sourceRevision ?? 0) &&
			!this.standby.error;
		this.trace("track", {
			deadline: play?.startedAt ?? 0,
			groupStart: this.groupStart,
			prepared: promote,
			ready: promote ? this.standby!.readyState : 0,
		});
		this.promoted = promote;
		if (promote) this.swapElements();
		else this.clearStandby();
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
		if (!promote) this.audio.pause();
		this.audio.playbackRate = 1;
		if (!play?.track.streamUrl) {
			this.activeSrc = "";
			this.audio.muted = true;
			this.audio.removeAttribute("src");
			this.audio.load();
			this.emit("idle");
			return;
		}
		this.activeSrc = this.buildStreamSrc(
			play.track.streamUrl,
			play.sourceRevision ?? 0,
		);
		if (promote) {
			this.activeSrc = this.audio.getAttribute("src") || this.activeSrc;
			this.trace("reuse-native-buffer");
		} else {
			this.audio.src = this.activeSrc;
			this.trace("load-track");
			this.audio.load();
		}
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

	preloadNext(play: CurrentPlayback | null): void {
		if (this.staged) {
			this.desiredPreload = play;
			return;
		}
		if (this.desiredPreload?.track.streamUrl !== play?.track.streamUrl) {
			this.preloadRetryAt = 0;
			if (this.standbyUrl !== play?.track.streamUrl) this.clearStandby();
		}
		this.desiredPreload = play;
		if (!play) {
			this.clearStandby();
			return;
		}
		this.maybeRunPreload();
	}

	private maybeRunPreload(): void {
		if (this.staged || performance.now() < this.preloadRetryAt) return;
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
		if (!url || url === this.standbyUrl || url === this.play.track.streamUrl) {
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
		// WebKit can report HAVE_ENOUGH_DATA with an empty TimeRanges during playback.
		const unreportedBuffer =
			!ranges?.length &&
			this.audio.readyState === 4 &&
			!!this.audio.ownerDocument;
		if (bufferedAhead < 10 && !fullyBuffered && !unreportedBuffer) return;

		if (this.desiredPreload) this.prepareStandby(this.desiredPreload);
	}

	listen(): void {
		this.trace("listen-click");
		this.groupStart = false;
		this.intent = true;
		this.followMuted = false;
		if (this.starting && !this.audio.paused && !this.audio.error) return;
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
		if (this.audio.error) {
			this.trace("load-media-error");
			this.audio.load();
		}
		this.start(true); // Synchronous play() retains the explicit user gesture on Safari.
	}

	stop(): void {
		this.trace("stop");
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
		const epoch = this.epoch;
		void this.audio.play().catch((error: unknown) => {
			if (this.epoch !== epoch) return;
			this.followMuted = false;
			this.trace("muted-play-rejected", {
				reason: error instanceof Error ? error.name : "unknown",
			});
		});
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
			const needsSeek =
				Math.abs(drift) >
				(this.groupStart && !this.initialSeeks ? 1.5 : threshold);
			if (
				this.groupStart &&
				needsSeek &&
				this.initialSeeks === 0 &&
				!this.starting
			)
				this.trace("missed-opening");
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
				this.trace("seek-initial", { target });
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

		if (this.recoverDrift && correctionForDrift(drift).seek) {
			if (mono - this.lastSeek < SEEK_COOLDOWN_MS) return;
			if (!this.isTargetSeekable(target)) return;
			try {
				this.trace("seek-recovery", { target });
				this.audio.currentTime = target;
				this.lastSeek = mono;
			} catch {
				return;
			}
		}
		this.recoverDrift = false;
	}

	private start(gesture = false): void {
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
			isScheduledFuture ||
			(needsInitialSeek &&
				!this.initialAligned &&
				!(gesture && this.audio.readyState >= 1));
		this.emit(
			isScheduledFuture ? "preparing" : this.retries ? "recovering" : "loading",
		);
		try {
			this.gesturePreroll = gesture && isScheduledFuture;
			this.trace("play-call", { gesture });
			void this.audio.play().then(
				() => {
					if (epoch !== this.epoch || this.destroyed) return;
					this.starting = false;
					this.trace("play-resolved");
					this.check();
				},
				(error: unknown) => {
					if (epoch !== this.epoch || this.destroyed) return;
					this.starting = false;
					this.trace("play-rejected", {
						reason: error instanceof Error ? error.name : "unknown",
					});
					if (
						error instanceof DOMException &&
						error.name === "NotAllowedError"
					) {
						if (this.promoted && this.standby && !gesture) {
							this.promoted = false;
							this.requiresOriginalElement = true;
							this.swapElements();
							this.activeSrc = this.buildStreamSrc(
								this.play!.track.streamUrl,
								this.play!.sourceRevision,
								"resume" + ++this.loadSerial,
							);
							this.audio.src = this.activeSrc;
							this.trace("retry-authorized-element");
							this.audio.load();
							this.start();
							return;
						}
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
		this.trace("recovery-needed", { mediaError: this.audio.error?.code ?? 0, waitMs: Math.round(performance.now() - this.progressAt) });
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
		if (this.staged && this.callbacks.now() >= this.staged.startedAt) {
			const next = this.staged;
			this.staged = null;
			this.setTrack(next);
			return;
		}

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
		if (
			this.retryAt &&
			!this.audio.error &&
			!this.audio.paused &&
			!this.audio.seeking &&
			this.audio.readyState >= 3 &&
			this.audio.currentTime > this.lastProgress + 0.05
		) {
			this.retryAt = this.waitingSince = 0;
			this.progressAt = mono;
			this.trace("recovered-in-place");
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
				this.trace("reload", { attempt: this.retries });
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
			if (this.gesturePreroll && !audio.seeking && !this.starting) {
				this.gesturePreroll = false;
				if (audio.currentTime - this.expected() > 0.15) {
					this.trace("seek-preroll", { target: this.expected() });
					audio.currentTime = this.expected();
					return;
				}
			}
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
			if (
				!this.firstProgress &&
				this.status === "playing" &&
				!audio.muted &&
				!audio.seeking
			) {
				this.firstProgress = true;
				this.trace("first-unmuted-progress");
			}
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
		if (
			["error", "pause", "waiting", "stalled", "seeked", "playing"].includes(
				event,
			)
		)
			this.trace("media-" + event);
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
			if (this.standbyUrl) {
				if (!this.staged) this.clearStandby();
				this.preloadRetryAt = performance.now() + 30000;
			}
			this.recoverDrift = true;
			this.waitingSince ||= performance.now();
			this.emitIfChanged("loading");
		}
		if (
			event === "pause" &&
			this.intent &&
			!this.starting &&
			!this.retryAt &&
			!this.audio.ended &&
			(this.status === "playing" || this.status === "loading") &&
			this.audio.paused
		) {
			this.audio.muted = true;
			this.emit("blocked");
		}
		this.check();
	}

	private tick(): void {
		this.check();
		const next = this.staged ?? this.play;
		const remaining = next
			? next.startedAt - this.callbacks.now()
			: Number.POSITIVE_INFINITY;
		this.timer = setTimeout(
			() => this.tick(),
			remaining > 0 && remaining < 250 ? Math.max(10, remaining) : 250,
		);
	}

	destroy(): void {
		this.destroyed = true;
		this.staged = null;
		this.clearStandby();
		this.stop();
		this.audio.pause();
		this.audio.removeAttribute("src");
		this.audio.load();
		clearTimeout(this.timer);
		for (const [event, listener] of this.listeners)
			this.audio.removeEventListener(event, listener);
		document.removeEventListener("visibilitychange", this.resume);
		window.removeEventListener("online", this.resume);
		window.removeEventListener("pageshow", this.resume);
	}
}
