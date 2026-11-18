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

export function correctionForDrift(drift: number): {
	seek: boolean;
	rate: number;
} {
	if (Math.abs(drift) >= 1) return { seek: true, rate: 1 };
	if (Math.abs(drift) <= 0.12) return { seek: false, rate: 1 };
	return {
		seek: false,
		rate: 1 + Math.sign(drift) * Math.min(0.02, Math.abs(drift) * 0.04),
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
		this.readySent = this.reported = this.durationSent = this.endedSent = false;
		this.lastSeek = Number.NEGATIVE_INFINITY;
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
		const connection = (
			navigator as Navigator & {
				connection?: { saveData?: boolean; effectiveType?: string };
			}
		).connection;
		const url =
			this.intent &&
			!connection?.saveData &&
			!/^(slow-)?2g$/.test(connection?.effectiveType ?? "")
				? (play?.track.streamUrl ?? "")
				: "";
		if (url === this.preloadUrl) return;
		this.preloadUrl = url;
		if (this.preload) {
			this.preload.removeAttribute("src");
			this.preload.load();
		}
		if (!url) return;
		this.preload ??= new Audio();
		this.preload.preload = "auto";
		this.preload.muted = true;
		this.preload.src = url;
		this.preload.load();
	}
	listen(): void {
		this.intent = true;
		this.lastSeek = Number.NEGATIVE_INFINITY;
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
	private align(force = false): void {
		if (!this.play || this.audio.readyState < 1 || this.audio.seeking) return;
		const duration = this.audio.duration;
		const target = Math.min(
			this.expected(),
			Number.isFinite(duration)
				? Math.max(0, duration - 0.1)
				: Number.POSITIVE_INFINITY,
		);
		const drift = target - this.audio.currentTime;
		const correction = correctionForDrift(drift);
		if ((force && Math.abs(drift) > 0.12) || correction.seek) {
			// A slow seek must finish and become audible before another correction. Otherwise
			// every seeked event chases a newer target and can keep a weak device silent forever.
			if (performance.now() - this.lastSeek < 1800) return;
			// Setting currentTime requests a Range when not buffered. Don't silently stay out of sync.
			try {
				this.audio.currentTime = target;
				this.lastSeek = performance.now();
			} catch {
				return;
			}
			this.audio.playbackRate = 1;
		} else this.audio.playbackRate = correction.rate;
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
		// Before the common start, the SAME authorized element runs muted. At start it seeks
		// to the buffered beginning and unmutes; a timer never has to unlock a new element.
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
			audio.buffered.start(0) <= 0.1 &&
			audio.buffered.end(0) >= 1
		) {
			this.readySent = true;
			this.callbacks.ready(this.play.uid, this.play.sourceRevision ?? 0);
		}
		if (this.scheduled()) {
			audio.muted = true;
			this.emitIfChanged("preparing");
		} else if (audio.readyState >= 3 && !audio.paused) {
			this.align(audio.muted);
			if (!audio.seeking) {
				audio.muted = false;
				this.waitingSince = 0;
				this.emitIfChanged("playing");
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
			remaining > 0 && remaining < 250 ? Math.max(10, remaining) : 250,
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
