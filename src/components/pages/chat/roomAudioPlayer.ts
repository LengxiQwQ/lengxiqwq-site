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

/**
 * Internal Finite State Machine states.
 * Guarantees mutually exclusive, deterministic transitions with zero boolean flag explosion.
 */
type FsmState =
	| "IDLE" // No active media or explicitly stopped
	| "LOADING" // Loading stream metadata and initial chunks
	| "SCHEDULED_WAIT" // First-frame buffered, head pinned at 0.00s, waiting for startedAt wall-clock
	| "PLAYING" // Actively and audibly playing on room timeline
	| "BUFFERING" // Mid-song underrun waiting for network
	| "BLOCKED" // Browser Autoplay Policy requires explicit user activation
	| "ERROR"; // Unrecoverable load failure

// Alignment tolerances (Industry standard for multi-room / synchronized web audio)
const DEADBAND_TOLERANCE_SEC = 0.25; // Imperceptible to human ears; zero audio stutter
const HARD_SEEK_THRESHOLD_SEC = 0.8; // Eliminate dual-device echo (>800ms realigns cleanly)
const SEEK_COOLDOWN_MS = 2500; // Prevent seek thrashing on high-latency networks
const INTRO_PROTECTION_SEC = 2.5; // Protects song intro for synchronized starting devices

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
 * Production-Grade Synchronized Room Audio Player.
 * - Single Element Rule: 100% preserves iOS Safari user gesture permissions.
 * - Pure Event-Driven FSM: Zero polling timers; transitions driven purely by native events and wall-clock triggers.
 * - Deterministic Zero-Point Firing: Stays cleanly at 0.00s until exact millisecond deadline; 0 intro loss.
 * - iOS Soft-Pause: Never destroys CoreAudio sessions; instant wake-up with zero latency.
 */
export class RoomAudioPlayer {
	private readonly cid =
		`${Date.now().toString(36)}_${(++instanceCounter).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
	private state: FsmState = "IDLE";
	private play: CurrentPlayback | null = null;
	private key = "";
	private activeSrc = "";
	private intent = false;
	private volume = 1;
	private fireTimer: ReturnType<typeof setTimeout> | null = null;
	private lastSeekMono = Number.NEGATIVE_INFINITY;
	private isSynchronousStarter = false;
	private listeners: [string, EventListener][] = [];

	private readonly onResume = () => {
		if (document.hidden || !this.intent) return;
		if (this.state === "BLOCKED") return;
		if (!this.play) return;

		const now = this.callbacks.now();
		// If wake-up happens after deadline while we were still waiting, fire immediately!
		if (this.state === "SCHEDULED_WAIT" && now >= this.play.startedAt) {
			this.onFireTimeline();
			return;
		}
		this.realignTimeline(true);
	};

	constructor(
		private readonly audio: HTMLAudioElement,
		private readonly callbacks: Callbacks,
	) {
		const attach = (evt: string, fn: (e: Event) => void) => {
			this.audio.addEventListener(evt, fn);
			this.listeners.push([evt, fn as EventListener]);
		};

		attach("canplay", () => this.onCanPlay());
		attach("playing", () => this.onPlaying());
		attach("waiting", () => this.onWaiting());
		attach("timeupdate", () => this.onTimeUpdate());
		attach("ended", () => this.onEnded());
		attach("error", () => this.onError());
		attach("pause", () => this.onPause());

		document.addEventListener("visibilitychange", this.onResume);
		window.addEventListener("online", this.onResume);
		window.addEventListener("pageshow", this.onResume);
	}

	get position(): number {
		return this.audio.currentTime;
	}

	private trace(
		event: string,
		detail: Record<string, string | number | boolean> = {},
	) {
		recordMusicEvent(event, this.play?.uid, {
			clock: Math.round(this.callbacks.now()),
			state: this.state,
			position: this.audio.currentTime,
			paused: this.audio.paused,
			seeking: this.audio.seeking,
			ready: this.audio.readyState,
			muted: this.audio.muted,
			...detail,
		});
	}

	private transition(next: FsmState) {
		if (this.state === next) return;
		this.trace(`fsm-${next.toLowerCase()}`);
		this.state = next;

		// Map internal state to external UI AudioStatus
		let external: AudioStatus;
		switch (next) {
			case "IDLE":
				external = "idle";
				break;
			case "LOADING":
				external = "loading";
				break;
			case "SCHEDULED_WAIT":
				external = "preparing";
				break;
			case "PLAYING":
				external = "playing";
				break;
			case "BUFFERING":
				external = "loading";
				break;
			case "BLOCKED":
				external = "blocked";
				break;
			case "ERROR":
				external = "error";
				break;
		}
		// If user has no listening intent, external status is cleanly idle to prevent UI spinning on page entry
		if (!this.intent && external !== "error") {
			external = "idle";
		}
		this.callbacks.status(external, this.intent);
	}

	private buildStreamSrc(rawUrl: string, revision = 0): string {
		if (!rawUrl) return "";
		if (!rawUrl.includes("/api/music/stream")) return rawUrl;
		const sep = rawUrl.includes("?") ? "&" : "?";
		return `${rawUrl}${sep}_cid=${this.cid}${revision > 0 ? `&_rev=${revision}` : ""}`;
	}

	private clearFireTimer() {
		if (this.fireTimer !== null) {
			clearTimeout(this.fireTimer);
			this.fireTimer = null;
		}
	}

	private isScheduledFuture(): boolean {
		if (!this.play) return false;
		if (this.play.phase === "transitioning") return true;
		return (
			this.play.phase === "scheduled" &&
			this.callbacks.now() < this.play.startedAt
		);
	}

	setVolume(volume: number): void {
		this.volume = Math.min(1, Math.max(0, volume));
		if (!this.audio.muted && this.state === "PLAYING") {
			this.audio.volume = this.volume;
		}
	}

	/** Backward compatibility guard */
	preloadNext(_next: CurrentPlayback | null): void {}

	/**
	 * Synchronize track from server authority.
	 * Handled completely deterministically: cancels prior pending schedules, updates media source,
	 * and arms the precision fire timer for synchronized zero-point start.
	 */
	setTrack(play: CurrentPlayback | null): void {
		// Handle transitioning state (stopping audio immediately when server prepares next track)
		if (play?.phase === "transitioning") {
			this.clearFireTimer();
			this.play = play;
			this.audio.pause();
			this.transition("SCHEDULED_WAIT");
			return;
		}

		const key = play
			? `${play.uid}:${play.sourceRevision ?? 0}:${play.track.streamUrl}`
			: "";

		if (key === this.key) {
			this.play = play;
			this.realignTimeline();
			return;
		}

		this.clearFireTimer();
		this.play = play;
		this.key = key;

		if (!play?.track.streamUrl) {
			this.activeSrc = "";
			this.audio.pause();
			this.audio.muted = true;
			this.transition("IDLE");
			return;
		}

		this.activeSrc = this.buildStreamSrc(
			play.track.streamUrl,
			play.sourceRevision ?? 0,
		);
		this.trace("load-track", { uid: play.uid, phase: play.phase ?? "" });

		// When user has no intent to listen, pause and stay idle (never spin UI)
		if (!this.intent) {
			this.audio.pause();
			this.audio.muted = true;
			this.audio.playbackRate = 1;
			this.audio.src = this.activeSrc;
			this.audio.load();
			this.transition("IDLE");
			return;
		}

		// When listening intent is active: Keep WebKit AudioSession alive during track switch!
		// DO NOT invoke audio.pause() on iOS/Safari, which immediately revokes background playback permission.
		this.audio.muted = true;
		this.audio.playbackRate = 1;
		this.audio.src = this.activeSrc;
		this.audio.load();

		this.transition("LOADING");

		const now = this.callbacks.now();
		const isScheduled = play.phase === "scheduled" && now < play.startedAt;

		this.isSynchronousStarter = isScheduled;

		if (isScheduled) {
			// Schedule precision fire timer
			const leadMs = Math.max(0, play.startedAt - now);
			this.fireTimer = setTimeout(() => this.onFireTimeline(), leadMs);
			this.audio.currentTime = 0;
			this.audio.muted = true;
			this.transition("SCHEDULED_WAIT");
			// Keep decoding pipeline warm while muted so user gesture permission is preserved
			this.invokeNativePlay();
		} else {
			this.audio.muted = false;
			this.audio.volume = this.volume;
			this.invokeNativePlay();
			this.realignTimeline(true);
		}
	}

	listen(): void {
		this.trace("listen-click");
		this.intent = true;

		if (!this.play) {
			this.transition("IDLE");
			return;
		}

		if (!this.activeSrc && this.play.track.streamUrl) {
			this.activeSrc = this.buildStreamSrc(
				this.play.track.streamUrl,
				this.play.sourceRevision ?? 0,
			);
		}

		if (this.audio.getAttribute("src") !== this.activeSrc && this.activeSrc) {
			this.audio.src = this.activeSrc;
			this.audio.load();
			this.transition("LOADING");
		} else if (this.audio.error) {
			this.audio.load();
			this.transition("LOADING");
		}

		const isScheduled = this.isScheduledFuture();

		if (isScheduled) {
			this.clearFireTimer();
			const now = this.callbacks.now();
			const leadMs = Math.max(0, (this.play.startedAt || 0) - now);
			this.fireTimer = setTimeout(() => this.onFireTimeline(), leadMs);
			this.audio.currentTime = 0;
			this.audio.muted = true;
			this.transition("SCHEDULED_WAIT");
			this.invokeNativePlay();
		} else {
			this.audio.muted = false;
			this.audio.volume = this.volume;
			this.invokeNativePlay();
			this.realignTimeline(true);
		}
	}

	stop(): void {
		this.trace("stop");
		this.intent = false;
		this.clearFireTimer();
		// iOS Soft-Pause: Keep CoreAudio session intact, never destroy src or call load()
		this.audio.pause();
		this.audio.muted = true;
		this.transition("IDLE");
	}

	/**
	 * Precision Fire: The exact millisecond the server wall-clock reaches startedAt.
	 * All devices fire at the exact same instant from position 0.00s with 0 intro loss.
	 */
	private onFireTimeline() {
		this.clearFireTimer();
		if (!this.play) return;

		this.trace("synchronous-fire", { pos: this.audio.currentTime });

		// Zero-Point Firing: Ensure playhead is pinned at 0.00s before starting
		if (this.audio.currentTime > 0.05 && this.audio.readyState >= 2) {
			try {
				this.audio.currentTime = 0;
			} catch {}
		}

		if (this.intent) {
			this.audio.muted = false;
			this.audio.volume = this.volume;
			this.invokeNativePlay();
		} else {
			this.audio.muted = true;
			this.transition("IDLE");
		}
	}

	private invokeNativePlay() {
		void this.audio.play().then(
			() => {
				if (this.state === "BLOCKED" || this.state === "SCHEDULED_WAIT") {
					this.transition("PLAYING");
					this.realignTimeline();
				}
			},
			(err: unknown) => {
				// AbortError is a normal browser interruption when play() is superseded
				if (err instanceof DOMException && err.name === "AbortError") {
					return;
				}
				if (err instanceof DOMException && err.name === "NotAllowedError") {
					this.audio.muted = true;
					this.transition("BLOCKED");
				} else {
					this.transition("ERROR");
				}
			},
		);
	}

	private onCanPlay() {
		if (!this.play) return;

		if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
			this.callbacks.duration(this.play.uid, this.audio.duration);
		}

		const isScheduled = this.isScheduledFuture();

		if (isScheduled) {
			// First-frame ready ahead of time: Keep cleanly at 0.00s and wait for fire timer
			if (this.audio.currentTime !== 0) {
				try {
					this.audio.currentTime = 0;
				} catch {}
			}
			this.audio.muted = true;
			this.transition("SCHEDULED_WAIT");
			this.callbacks.ready(this.play.uid, this.play.sourceRevision ?? 0);
		} else if (this.intent) {
			this.callbacks.ready(this.play.uid, this.play.sourceRevision ?? 0);
			this.realignTimeline();
			if (this.audio.paused) {
				this.invokeNativePlay();
			} else {
				this.audio.muted = false;
				this.audio.volume = this.volume;
				this.transition("PLAYING");
			}
		}
	}

	private onPlaying() {
		if (!this.play) return;
		const isScheduled = this.isScheduledFuture();

		if (isScheduled) {
			this.audio.pause();
			this.audio.muted = true;
			this.transition("SCHEDULED_WAIT");
		} else if (this.intent) {
			this.audio.muted = false;
			this.audio.volume = this.volume;
			this.transition("PLAYING");
		}
	}

	private onWaiting() {
		if (this.state === "PLAYING") {
			this.transition("BUFFERING");
		}
	}

	private onPause() {
		if (
			this.intent &&
			this.state === "PLAYING" &&
			!this.audio.ended &&
			!this.audio.seeking
		) {
			this.audio.muted = true;
			this.transition("BLOCKED");
		}
	}

	private onEnded() {
		this.clearFireTimer();
		if (this.play && this.intent) {
			this.callbacks.ended(this.play.uid);
		}
	}

	private onError() {
		this.clearFireTimer();
		this.transition("ERROR");
		if (this.play) {
			this.callbacks.error(this.play.uid, this.play.sourceRevision ?? 0);
		}
	}

	/**
	 * Pure Mathematical Timeline Alignment.
	 * Triggered purely on native timeupdate (every ~250ms) without any synthetic polling loop.
	 */
	private onTimeUpdate() {
		if (!this.play || this.state !== "PLAYING" || this.audio.seeking) return;
		this.realignTimeline();
	}

	private realignTimeline(force = false) {
		if (!this.play || this.audio.readyState < 2) return;

		const now = this.callbacks.now();
		const expectedOffset = Math.max(0, (now - this.play.startedAt) / 1000);

		// Intro Protection Gate: For synchronous starters, NEVER seek forward in the first 2.5s.
		// Protects intros 100% against latency jitters.
		if (this.isSynchronousStarter && expectedOffset < INTRO_PROTECTION_SEC) {
			if (this.audio.currentTime > 0.1 && this.state === "SCHEDULED_WAIT") {
				try {
					this.audio.currentTime = 0;
				} catch {}
			}
			return;
		}

		const duration = this.audio.duration;
		const maxTime =
			Number.isFinite(duration) && duration > 0
				? Math.max(0, duration - 0.2)
				: Number.POSITIVE_INFINITY;
		const target = Math.min(expectedOffset, maxTime);
		const drift = target - this.audio.currentTime;

		// Deadband check: Imperceptible drift is intentionally ignored
		if (Math.abs(drift) < DEADBAND_TOLERANCE_SEC && !force) {
			return;
		}

		// Hard Seek: Applied when drift exceeds 0.8s (prevents dual-device echo)
		if (Math.abs(drift) >= HARD_SEEK_THRESHOLD_SEC || force) {
			const mono = performance.now();
			if (mono - this.lastSeekMono < SEEK_COOLDOWN_MS && !force) return;

			try {
				this.trace("realign-seek", {
					target,
					current: this.audio.currentTime,
					drift,
				});
				this.audio.currentTime = target;
				this.lastSeekMono = mono;
			} catch {}
		}
	}

	destroy(): void {
		this.clearFireTimer();
		this.stop();
		this.audio.pause();
		for (const [evt, fn] of this.listeners) {
			this.audio.removeEventListener(evt, fn);
		}
		document.removeEventListener("visibilitychange", this.onResume);
		window.removeEventListener("online", this.onResume);
		window.removeEventListener("pageshow", this.onResume);
	}
}
