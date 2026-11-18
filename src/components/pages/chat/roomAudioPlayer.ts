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

const DRIFT_DEADBAND_SEC = 0.15;
const DRIFT_GENTLE_MAX_SEC = 0.65;
const DRIFT_HARD_SEEK_SEC = 2.5;
const MIN_BUFFER_FOR_ACCEL_SEC = 1.8;
const BUFFERED_SEEK_COOLDOWN_MS = 3000;
const NETWORK_SEEK_COOLDOWN_MS = 8000;
const FORCE_SEEK_COOLDOWN_MS = 1800;
const RATE_CHANGE_COOLDOWN_MS = 1000;
const PRELOAD_SAFE_BUFFER_SEC = 8;

export function correctionForDrift(
	drift: number,
	bufferedHeadroom: number = Number.POSITIVE_INFINITY,
): {
	seek: boolean;
	rate: number;
} {
	const abs = Math.abs(drift);
	if (abs >= DRIFT_HARD_SEEK_SEC) return { seek: true, rate: 1 };
	if (abs <= DRIFT_DEADBAND_SEC) return { seek: false, rate: 1 };
	// Never accelerate playback when local buffer is running low on a weak connection.
	if (drift > 0 && bufferedHeadroom < MIN_BUFFER_FOR_ACCEL_SEC) {
		return { seek: false, rate: 1 };
	}
	const step = abs <= DRIFT_GENTLE_MAX_SEC ? 0.02 : 0.035;
	return {
		seek: false,
		rate: Number((1 + Math.sign(drift) * step).toFixed(3)),
	};
}

interface Callbacks {
	now: () => number;
	status: (status: AudioStatus, intent: boolean) => void;
	ready: (uid: string, revision: number) => void;
	error: (uid: string, revision: number) => void;
	ended: (uid: string) => void;
	duration: (uid: string, duration: number) => void;
}

/** Owns the persistent audio element; UI effects never start competing play promises. */
export class RoomAudioPlayer {
	private play: CurrentPlayback | null = null;
	private key = "";
	private intent = false;
	private status: AudioStatus = "idle";
	private volume = 1;
	private epoch = 0;
	private retries = 0;
	private retryAt = 0;
	private waitingSince = 0;
	private lastSeek = Number.NEGATIVE_INFINITY;
	private lastRateChange = Number.NEGATIVE_INFINITY;
	private initialAligned = false;
	private lastProgress = 0;
	private progressAt = 0;
	private readySent = false;
	private reported = false;
	private durationSent = false;
	private endedSent = false;
	private starting = false;
	private destroyed = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private preload: HTMLAudioElement | null = null;
	private preloadUrl = "";
	private desiredPreload: CurrentPlayback | null = null;
	private listeners: [string, EventListener][] = [];
	private resume = () => {
		if (document.hidden || !this.intent || this.status === "blocked") return;
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
			"progress",
			"playing",
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
	setVolume(volume: number): void {
		this.volume = Math.min(1, Math.max(0, volume));
		this.audio.volume = this.volume;
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
		this.key = key;
		this.epoch++;
		this.starting = false;
		this.retries = 0;
		this.retryAt = 0;
		this.waitingSince = 0;
		this.readySent =
			this.reported =
			this.durationSent =
			this.endedSent =
			this.initialAligned =
				false;
		this.lastSeek = Number.NEGATIVE_INFINITY;
		this.lastRateChange = Number.NEGATIVE_INFINITY;
		this.progressAt = performance.now();
		this.lastProgress = 0;
		this.audio.muted = true;
		this.audio.pause();
		this.audio.playbackRate = 1;
		if (!play?.track.streamUrl) {
			this.audio.removeAttribute("src");
			this.audio.load();
			this.emit("idle");
			return;
		}
		// A repeated song with the same URL must still restart; a source revision must reload.
		this.audio.src = play.track.streamUrl;
		this.audio.load();
		if (this.intent) this.start();
		else this.emit("idle");
	}
	preloadNext(play: CurrentPlayback | null): void {
		this.desiredPreload = play;
		this.maybeRunPreload();
	}
	private maybeRunPreload(): void {
		const connection = (
			navigator as Navigator & {
				connection?: { saveData?: boolean; effectiveType?: string };
			}
		).connection;
		const canPreloadNow =
			this.intent &&
			!connection?.saveData &&
			!/^(slow-)?2g$/.test(connection?.effectiveType ?? "") &&
			(!this.play ||
				(this.status === "playing" &&
					(this.bufferedAhead(this.audio.currentTime) >=
						PRELOAD_SAFE_BUFFER_SEC ||
						this.isFullyBuffered())));
		const url = canPreloadNow
			? (this.desiredPreload?.track.streamUrl ?? "")
			: "";
		if (!url) {
			if (!this.desiredPreload && this.preloadUrl) {
				this.preloadUrl = "";
				if (this.preload) {
					this.preload.removeAttribute("src");
					this.preload.load();
				}
			}
			return;
		}
		if (url === this.preloadUrl || url === this.play?.track.streamUrl) return;
		this.preloadUrl = url;
		if (this.preload) {
			this.preload.removeAttribute("src");
			this.preload.load();
		}
		this.preload ??= new Audio();
		this.preload.preload = "auto";
		this.preload.muted = true;
		this.preload.src = url;
		this.preload.load();
	}
	listen(): void {
		this.intent = true;
		this.lastSeek = Number.NEGATIVE_INFINITY;
		this.lastRateChange = Number.NEGATIVE_INFINITY;
		this.initialAligned = false;
		this.retries = 0;
		this.retryAt = 0;
		this.reported = false;
		this.epoch++;
		this.starting = false;
		if (!this.play) {
			this.emit("idle");
			return;
		}
		if (this.audio.error || this.status === "error") this.audio.load();
		this.start(); // Synchronous play() retains the explicit user gesture on Safari.
	}
	stop(): void {
		this.intent = false;
		this.epoch++;
		this.starting = false;
		this.retryAt = this.waitingSince = 0;
		this.audio.muted = true;
		this.audio.playbackRate = 1;
		this.audio.pause();
		this.preloadNext(null);
		this.emit("idle");
	}
	private scheduled(): boolean {
		return (
			!!this.play &&
			(this.play.phase === "preparing" ||
				this.callbacks.now() < this.play.startedAt)
		);
	}
	private expected(): number {
		return this.play
			? Math.max(0, (this.callbacks.now() - this.play.startedAt) / 1000)
			: 0;
	}
	private bufferedAhead(atTime: number): number {
		const ranges = this.audio.buffered;
		if (!ranges || typeof ranges.length !== "number") return 0;
		for (let i = 0; i < ranges.length; i++) {
			const start = ranges.start(i);
			const end = ranges.end(i);
			if (atTime >= start - 0.25 && atTime <= end + 0.05) {
				return Math.max(0, end - atTime);
			}
		}
		return 0;
	}
	private isFullyBuffered(): boolean {
		const duration = this.audio.duration;
		const ranges = this.audio.buffered;
		if (
			!Number.isFinite(duration) ||
			duration <= 0 ||
			!ranges ||
			!ranges.length
		)
			return false;
		return ranges.end(ranges.length - 1) >= duration - 0.5;
	}
	private setRateSafely(rate: number, mono: number): void {
		const currentRate = this.audio.playbackRate;
		if (Math.abs(currentRate - rate) < 0.005) return;
		if (rate !== 1 && mono - this.lastRateChange < RATE_CHANGE_COOLDOWN_MS)
			return;
		this.audio.playbackRate = rate;
		this.lastRateChange = mono;
	}
	private align(force = false): void {
		if (!this.play || this.audio.readyState < 1 || this.audio.seeking) return;
		const mono = performance.now();
		const duration = this.audio.duration;
		const maxTime = Number.isFinite(duration)
			? Math.max(0, duration - 0.1)
			: Number.POSITIVE_INFINITY;
		const target = Math.min(this.expected(), maxTime);
		const drift = target - this.audio.currentTime;
		const currentHeadroom = this.bufferedAhead(this.audio.currentTime);
		const targetHeadroom = this.bufferedAhead(target);
		const isTargetBuffered =
			targetHeadroom >= 0.8 ||
			(Number.isFinite(duration) &&
				target >= duration - 1 &&
				targetHeadroom > 0);
		const correction = correctionForDrift(drift, currentHeadroom);

		if (force && Math.abs(drift) > DRIFT_DEADBAND_SEC) {
			if (mono - this.lastSeek < FORCE_SEEK_COOLDOWN_MS) return;
			try {
				this.audio.currentTime = target;
				this.lastSeek = mono;
				this.initialAligned = true;
			} catch {
				return;
			}
			this.setRateSafely(1, mono);
			return;
		}

		if (correction.seek) {
			const cooldown = isTargetBuffered
				? BUFFERED_SEEK_COOLDOWN_MS
				: this.initialAligned
					? NETWORK_SEEK_COOLDOWN_MS
					: FORCE_SEEK_COOLDOWN_MS;
			if (mono - this.lastSeek < cooldown) return;

			// Avoid aborting an active progressive stream for moderate unbuffered forward drift;
			// let smooth playbackRate catch up unless drift is extreme or it's the initial join.
			if (
				!isTargetBuffered &&
				this.initialAligned &&
				drift > 0 &&
				drift < 4.8
			) {
				if (currentHeadroom >= MIN_BUFFER_FOR_ACCEL_SEC) {
					this.setRateSafely(1.035, mono);
				} else {
					this.setRateSafely(1, mono);
				}
				return;
			}

			const leadComp = !isTargetBuffered && drift > 1.5 ? 0.18 : 0;
			const seekTarget = Math.min(target + leadComp, maxTime);
			try {
				this.audio.currentTime = seekTarget;
				this.lastSeek = mono;
				this.initialAligned = true;
			} catch {
				return;
			}
			this.setRateSafely(1, mono);
			return;
		}

		this.initialAligned = true;
		this.setRateSafely(correction.rate, mono);
	}
	private start(): void {
		if (this.destroyed || !this.intent || !this.play || this.starting) return;
		const epoch = this.epoch;
		this.starting = true;
		this.waitingSince = performance.now();
		this.progressAt = this.waitingSince;
		this.audio.volume = this.volume;
		this.audio.preservesPitch = true;
		this.audio.muted = this.scheduled();
		if (!this.scheduled()) this.align(true);
		this.emit(
			this.scheduled() ? "preparing" : this.retries ? "recovering" : "loading",
		);
		try {
			void this.audio.play().then(
				() => {
					if (epoch !== this.epoch || this.destroyed) return;
					this.starting = false;
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
					} else this.fail();
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
		if (this.retries < 2) {
			this.retryAt = performance.now() + [750, 2000][this.retries++];
			this.emit("recovering");
		} else {
			this.emit("error");
			// An offline device cannot diagnose the room's source.
			if (!this.reported && navigator.onLine) {
				this.reported = true;
				this.callbacks.error(this.play.uid, this.play.sourceRevision ?? 0);
			}
		}
	}
	private check(): void {
		if (
			!this.play ||
			!this.intent ||
			this.destroyed ||
			this.status === "blocked" ||
			this.status === "error"
		)
			return;
		const mono = performance.now();
		if (this.retryAt) {
			if (mono >= this.retryAt && navigator.onLine) {
				this.retryAt = 0;
				this.epoch++;
				this.starting = false;
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
			audio.buffered.start(0) <= 0.25 &&
			audio.buffered.end(0) >= 0.6
		) {
			this.readySent = true;
			this.callbacks.ready(this.play.uid, this.play.sourceRevision ?? 0);
		}
		if (this.scheduled()) {
			audio.muted = true;
			// Prime-and-Park: keep playhead parked at 0.000s during preparation so that when
			// startedAt arrives, unmuting at 0.000s requires ZERO backward seek.
			if (audio.readyState >= 2 && !audio.seeking && audio.currentTime > 0.06) {
				try {
					audio.currentTime = 0;
				} catch {}
			}
			this.emitIfChanged("preparing");
		} else if (audio.readyState >= 3 && !audio.paused) {
			this.align(audio.muted);
			if (!audio.seeking) {
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
		const timeout = audio.readyState < 1 ? 15_000 : 12_000;
		if (!this.scheduled() && !audio.ended && mono - this.progressAt > timeout)
			this.fail();
		if (
			this.waitingSince &&
			mono - this.waitingSince > timeout &&
			!this.scheduled()
		)
			this.fail();
	}
	private emitIfChanged(status: AudioStatus): void {
		if (this.status !== status) this.emit(status);
	}
	private onEvent(event: string): void {
		if (
			!this.play ||
			this.audio.getAttribute("src") !== this.play.track.streamUrl
		)
			return;
		if (
			this.audio.currentSrc &&
			this.audio.currentSrc !==
				new URL(this.play.track.streamUrl, document.baseURI).href
		)
			return;
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
			!this.retryAt
		) {
			this.waitingSince ||= performance.now();
			this.emitIfChanged("loading");
		}
		// Unexpected OS pauses preserve intent and surface a recovery action; never loop play().
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
			remaining > 0 && remaining < 250 ? Math.max(8, remaining) : 250,
		);
	}
	destroy(): void {
		this.destroyed = true;
		this.stop();
		clearTimeout(this.timer);
		for (const [event, listener] of this.listeners)
			this.audio.removeEventListener(event, listener);
		document.removeEventListener("visibilitychange", this.resume);
		window.removeEventListener("online", this.resume);
		window.removeEventListener("pageshow", this.resume);
	}
}
