import type { CurrentPlayback } from "./chatTypes";
import { recordMusicEvent } from "./musicTrace";

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

export interface LocalAudioDiagnostic {
	uid: string;
	revision: number;
	status: AudioStatus;
	transport?: "direct" | "proxy";
}

const SYNC_TOLERANCE_SEC = 2.5;
const SEEK_COOLDOWN_MS = 3000;

interface Callbacks {
	now: () => number;
	status: (
		status: AudioStatus,
		intent: boolean,
		diagnostic: LocalAudioDiagnostic | null,
	) => void;
	error: (uid: string, revision: number) => void;
	ended: (uid: string) => void;
	duration: (uid: string, duration: number) => void;
}

export class RoomAudioPlayer {
	private play: CurrentPlayback | null = null;
	private intent = false;
	private status: AudioStatus = "idle";
	private generation = 0;
	private reportedDuration = 0;
	private readonly events = new AbortController();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private waitingTimer: ReturnType<typeof setTimeout> | undefined;
	private lastSeek = Number.NEGATIVE_INFINITY;
	private isSeekingInternal = false;

	constructor(
		private readonly audio: HTMLAudioElement,
		private readonly callbacks: Callbacks,
	) {
		const options = { signal: this.events.signal };

		const reportDuration = () => {
			const play = this.play;
			if (
				!this.active ||
				!play ||
				!Number.isFinite(audio.duration) ||
				audio.duration <= 0 ||
				audio.duration === this.reportedDuration
			)
				return;
			this.reportedDuration = audio.duration;
			this.callbacks.duration(play.uid, audio.duration);
		};

		audio.addEventListener(
			"loadedmetadata",
			() => {
				if (!this.active) return;
				reportDuration();
				this.align(true);
			},
			options,
		);

		audio.addEventListener("durationchange", reportDuration, options);

		audio.addEventListener(
			"playing",
			() => {
				if (!this.active || audio.paused) return;
				clearTimeout(this.waitingTimer);
				this.waitingTimer = undefined;
				reportDuration();
				this.openOutput();
			},
			options,
		);

		audio.addEventListener(
			"seeked",
			() => {
				this.isSeekingInternal = false;
				if (!this.active || audio.paused) return;
				this.openOutput();
			},
			options,
		);

		audio.addEventListener(
			"seeking",
			() => {
				this.isSeekingInternal = true;
			},
			options,
		);

		audio.addEventListener(
			"timeupdate",
			() => {
				if (!this.active || audio.paused) return;
				clearTimeout(this.waitingTimer);
				this.waitingTimer = undefined;
				if (this.status !== "playing") {
					this.openOutput();
				} else {
					this.align(false);
				}
			},
			options,
		);

		audio.addEventListener(
			"waiting",
			() => {
				if (!this.active || audio.ended || this.isSeekingInternal) return;
				clearTimeout(this.waitingTimer);
				this.waitingTimer = setTimeout(() => {
					if (this.active && !audio.ended && this.status !== "loading") {
						this.update("loading");
					}
				}, 400);
			},
			options,
		);

		audio.addEventListener(
			"ended",
			() => {
				const play = this.play;
				if (this.active && play && audio.ended) {
					this.callbacks.ended(play.uid);
				}
			},
			options,
		);

		audio.addEventListener(
			"error",
			() => {
				if (!this.active) return;
				const play = this.play;
				if (!play) return;
				clearTimeout(this.waitingTimer);
				this.waitingTimer = undefined;
				const proxy = play.track.proxyUrl;
				if (proxy && proxy !== audio.getAttribute("src")) {
					this.start(proxy);
					return;
				}
				this.update("error");
				this.callbacks.error(play.uid, play.sourceRevision ?? 0);
			},
			options,
		);

		const resume = () => {
			if (
				document.hidden ||
				!this.active ||
				this.status === "blocked" ||
				this.status === "error"
			)
				return;
			if (audio.paused && !audio.ended) {
				this.start(audio.getAttribute("src") || undefined);
			} else {
				this.openOutput();
				this.align(false);
			}
		};

		document.addEventListener("visibilitychange", resume, options);
		window.addEventListener("pageshow", resume, options);
		window.addEventListener("online", resume, options);
	}

	get position(): number {
		const pos = this.audio.currentTime;
		return Number.isFinite(pos) && pos >= 0 ? pos : 0;
	}

	private get active(): boolean {
		return (
			this.intent &&
			!!this.play &&
			this.play.phase !== "transitioning" &&
			this.callbacks.now() >= this.play.startedAt
		);
	}

	private update(status: AudioStatus) {
		this.status = status;
		const play = this.play;
		const source = status === "idle" ? null : this.audio.getAttribute("src");
		const transport =
			source && source === play?.track.proxyUrl
				? "proxy"
				: source && source === (play?.track.directUrl || play?.track.streamUrl)
					? "direct"
					: undefined;
		this.callbacks.status(
			status,
			this.intent,
			play
				? {
						uid: play.uid,
						revision: play.sourceRevision ?? 0,
						status,
						transport,
					}
				: null,
		);
	}

	private openOutput() {
		const audio = this.audio;
		if (!this.active || audio.paused || audio.ended) return;
		if (audio.muted) {
			audio.muted = false;
		}
		if (this.status !== "playing") {
			this.update("playing");
		}
	}

	private align(force = false) {
		const audio = this.audio;
		const play = this.play;
		if (
			!this.active ||
			!play ||
			audio.readyState < 1 ||
			audio.seeking ||
			audio.ended ||
			this.isSeekingInternal
		)
			return;
		const elapsed = (this.callbacks.now() - play.startedAt) / 1000;
		const target =
			Number.isFinite(audio.duration) && audio.duration > 0
				? Math.min(elapsed, audio.duration)
				: elapsed;
		if (target < 0) return;
		const now = performance.now();
		const diff = Math.abs(audio.currentTime - target);
		if (
			!force &&
			(diff <= SYNC_TOLERANCE_SEC || now - this.lastSeek < SEEK_COOLDOWN_MS)
		)
			return;
		if (diff < 0.25) return;
		this.lastSeek = now;
		this.isSeekingInternal = true;
		try {
			audio.currentTime = target;
			recordMusicEvent("realign-seek", play.uid, { target, diff });
		} catch {
			this.isSeekingInternal = false;
		}
	}

	preloadNext(_next: CurrentPlayback | null): void {
		// Single DOM audio element avoids iOS WebKit audio session drop & untrusted gesture errors.
	}

	private release() {
		clearTimeout(this.timer);
		clearTimeout(this.waitingTimer);
		this.waitingTimer = undefined;
		this.generation++;
		this.isSeekingInternal = false;
		// Keep src without calling removeAttribute/load to preserve iOS user gesture token
		if (this.audio.hasAttribute("src")) {
			try {
				this.audio.pause();
			} catch {}
		}
	}

	private start(source?: string) {
		const play = this.play;
		if (!play || !this.intent) return;
		clearTimeout(this.timer);
		clearTimeout(this.waitingTimer);
		this.waitingTimer = undefined;
		const generation = ++this.generation;

		if (!this.active) {
			this.update("preparing");
			if (play.phase !== "transitioning") {
				const url = source || play.track.streamUrl || play.track.proxyUrl;
				if (url && this.audio.getAttribute("src") !== url) {
					this.audio.src = url;
				}
				this.timer = setTimeout(
					() => this.start(source),
					Math.max(0, play.startedAt - this.callbacks.now()),
				);
			}
			return;
		}

		const url = source || play.track.streamUrl || play.track.proxyUrl;
		if (!url) {
			this.update("error");
			return;
		}

		if (this.audio.getAttribute("src") !== url) {
			this.audio.src = url;
		}

		this.update("loading");

		if (this.audio.readyState >= 1) {
			this.align(true);
		}

		void this.audio
			.play()
			.then(() => {
				if (generation === this.generation) {
					this.openOutput();
				}
			})
			.catch((error: DOMException) => {
				if (generation !== this.generation || error.name === "AbortError")
					return;
				if (this.audio.error) {
					const proxy = play.track.proxyUrl;
					if (proxy && proxy !== this.audio.getAttribute("src")) {
						this.start(proxy);
						return;
					}
					this.update("error");
					this.callbacks.error(play.uid, play.sourceRevision ?? 0);
					return;
				}
				this.update(error.name === "NotAllowedError" ? "blocked" : "error");
			});
	}

	setTrack(play: CurrentPlayback | null): void {
		const previous = this.play;
		this.play = play;
		if (
			previous?.uid === play?.uid &&
			previous?.sourceRevision === play?.sourceRevision &&
			previous?.track.streamUrl === play?.track.streamUrl &&
			previous?.track.proxyUrl === play?.track.proxyUrl &&
			previous?.startedAt === play?.startedAt &&
			(previous?.phase === "transitioning") ===
				(play?.phase === "transitioning")
		)
			return;
		this.lastSeek = Number.NEGATIVE_INFINITY;
		this.reportedDuration = 0;
		this.isSeekingInternal = false;
		this.release();
		if (play && this.intent) {
			this.start();
		} else {
			this.update("idle");
		}
	}

	listen(): void {
		this.intent = true;
		if (this.active && !this.audio.paused && this.status === "playing") return;
		if (this.play) {
			this.start(this.audio.getAttribute("src") || undefined);
		} else {
			this.update("idle");
		}
	}

	stop(): void {
		this.intent = false;
		clearTimeout(this.timer);
		clearTimeout(this.waitingTimer);
		this.waitingTimer = undefined;
		this.generation++;
		this.isSeekingInternal = false;
		try {
			this.audio.pause();
		} catch {}
		this.update("idle");
	}

	setVolume(volume: number): void {
		try {
			this.audio.volume = Math.min(1, Math.max(0, volume));
		} catch {}
	}

	destroy(): void {
		this.events.abort();
		this.stop();
		this.release();
	}
}
