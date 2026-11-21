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

const SYNC_TOLERANCE_SEC = 1.2;

interface Callbacks {
	now: () => number;
	status: (status: AudioStatus, intent: boolean, diagnostic: LocalAudioDiagnostic | null) => void;
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
	private standby: HTMLAudioElement;
	private next: CurrentPlayback | null = null;
	private readonly events = new AbortController();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private lastSeek = -Infinity;
	private needsResumeSeek = false;

	constructor(
		private audio: HTMLAudioElement,
		private readonly callbacks: Callbacks,
	) {
		const options = { signal: this.events.signal };
		this.standby = audio.ownerDocument.createElement("audio");
		this.standby.preload = "auto";
		const bind = (element: HTMLAudioElement) => {
			const audio = element;
			const on = (event: string, handle: () => void) => {
				element.addEventListener(event, () => {
					if (element === this.audio) handle();
				}, options);
			};
			on("loadedmetadata", () => this.align());
			const reportDuration = () => {
				if (!this.active || !Number.isFinite(audio.duration) || audio.duration <= 0 ||
					audio.duration === this.reportedDuration) return;
				this.reportedDuration = audio.duration;
				this.callbacks.duration(this.play!.uid, audio.duration);
			};
			on("durationchange", reportDuration);
			on("playing", () => {
				if (!this.active || audio.paused) return;
				reportDuration();
				this.openOutput();
			});
			on("seeked", () => this.openOutput());
			on("timeupdate", () => {
				if (audio.muted) this.openOutput();
				else this.align();
			});
			const interrupt = () => {
				if (this.active && !audio.ended) {
					if (!audio.muted) this.needsResumeSeek = true;
					audio.muted = true;
					this.update("loading");
				}
			};
			on("waiting", interrupt);
			on("pause", interrupt);
			on("ended", () => {
				if (this.active && audio.ended) this.callbacks.ended(this.play!.uid);
			});
			on("error", () => {
				if (!this.active || !audio.error) return;
				const play = this.play!;
				const proxy = play.track.proxyUrl;
				if (proxy && proxy !== audio.getAttribute("src")) {
					this.start(proxy);
					return;
				}
				this.update("error");
				this.callbacks.error(play.uid, play.sourceRevision ?? 0);
			});
		};
		bind(audio);
		bind(this.standby);
		const resume = () => {
			if (document.hidden || !this.active || this.status === "blocked" || this.status === "error") return;
			if (this.audio.paused && !this.audio.ended) this.start(this.audio.getAttribute("src") || undefined);
			else if (this.audio.muted) this.openOutput();
			else this.align();
		};
		document.addEventListener("visibilitychange", resume, options);
		window.addEventListener("pageshow", resume, options);
		window.addEventListener("online", resume, options);
	}

	get position(): number {
		return this.audio.currentTime;
	}

	private get active(): boolean {
		return this.intent && !!this.play && this.play.phase !== "transitioning" &&
			this.callbacks.now() >= this.play.startedAt;
	}

	private update(status: AudioStatus) {
		this.status = status;
		const play = this.play;
		const source = status === "idle" ? null : this.audio.getAttribute("src");
		const transport = source && source === play?.track.proxyUrl ? "proxy"
			: source && source === (play?.track.directUrl || play?.track.streamUrl) ? "direct"
			: undefined;
		this.callbacks.status(status, this.intent, play ? {
			uid: play.uid, revision: play.sourceRevision ?? 0, status, transport,
		} : null);
	}

	private openOutput() {
		const audio = this.audio;
		if (!this.active || audio.paused || audio.ended || audio.seeking || audio.readyState < 3) return;
		if (this.needsResumeSeek) this.align();
		if (audio.seeking) return;
		audio.muted = false;
		if (this.status !== "playing") this.update("playing");
	}

	private align() {
		const audio = this.audio;
		if (!this.active || audio.readyState < 1 || audio.seeking || audio.ended) return;
		const elapsed = (this.callbacks.now() - this.play!.startedAt) / 1000;
		const target = Number.isFinite(audio.duration) ? Math.min(elapsed, audio.duration) : elapsed;
		const now = performance.now();
		if (!this.needsResumeSeek &&
			(Math.abs(audio.currentTime - target) <= SYNC_TOLERANCE_SEC || now - this.lastSeek < 1200)) return;
		this.needsResumeSeek = false;
		if (audio.currentTime === target) return;
		audio.muted = true;
		this.lastSeek = now;
		audio.currentTime = target;
		recordMusicEvent("realign-seek", this.play!.uid, { target });
	}

	preloadNext(next: CurrentPlayback | null): void {
		this.next = next;
		const url = this.intent && next && (next.track.streamUrl || next.track.proxyUrl);
		if (url && this.standby.getAttribute("src") === url) return;
		if (url) {
			this.standby.preload = "auto";
			this.standby.src = url;
			this.standby.load();
		} else if (this.standby.hasAttribute("src")) {
			this.standby.removeAttribute("src");
			this.standby.load();
		}
	}

	private release() {
		clearTimeout(this.timer);
		this.generation++;
		this.audio.muted = true;
		if (this.audio.hasAttribute("src")) {
			this.audio.pause();
			this.audio.removeAttribute("src");
			this.audio.load();
		}
	}

	private start(source?: string) {
		const play = this.play;
		if (!play || !this.intent) return;
		clearTimeout(this.timer);
		const generation = ++this.generation;
		if (!this.active) {
			this.audio.muted = true;
			this.update("preparing");
			if (play.phase !== "transitioning") {
				const url = source || play.track.streamUrl || play.track.proxyUrl;
				if (url && this.audio.getAttribute("src") !== url) {
					this.audio.preload = "auto";
					this.audio.src = url;
					this.audio.load();
				}
				this.timer = setTimeout(() => this.start(source), Math.max(0, play.startedAt - this.callbacks.now()));
			}
			return;
		}
		const url = source || play.track.streamUrl || play.track.proxyUrl;
		if (!url) {
			this.update("error");
			return;
		}
		this.audio.muted = true;
		if (this.audio.getAttribute("src") !== url) this.audio.src = url;
		else if (this.audio.error) this.audio.load();
		this.update("loading");
		this.align();
		void this.audio.play().then(() => {
			if (generation === this.generation) this.openOutput();
		}).catch((error: DOMException) => {
			if (generation !== this.generation || error.name === "AbortError" || this.audio.error) return;
			this.update(error.name === "NotAllowedError" ? "blocked" : "error");
		});
	}

	setTrack(play: CurrentPlayback | null): void {
		const previous = this.play;
		this.play = play;
		if (previous?.uid === play?.uid && previous?.sourceRevision === play?.sourceRevision &&
			previous?.track.streamUrl === play?.track.streamUrl && previous?.track.proxyUrl === play?.track.proxyUrl &&
			previous?.startedAt === play?.startedAt && (previous?.phase === "transitioning") === (play?.phase === "transitioning")) return;
		this.lastSeek = -Infinity;
		this.reportedDuration = 0;
		this.needsResumeSeek = false;
		this.release();
		if (play && this.intent) {
			const url = play.track.streamUrl || play.track.proxyUrl;
			if (url && this.standby.getAttribute("src") === url && !this.standby.error) {
				[this.audio, this.standby] = [this.standby, this.audio];
				this.audio.volume = this.standby.volume;
			}
			this.start();
		} else this.update("idle");
	}

	listen(): void {
		this.intent = true;
		this.preloadNext(this.next);
		if (this.active && !this.audio.paused && this.status === "playing") return;
		this.needsResumeSeek = true;
		if (this.play) this.start(this.audio.getAttribute("src") || undefined);
		else this.update("idle");
	}

	stop(): void {
		this.intent = false;
		this.needsResumeSeek = false;
		this.audio.muted = true;
		clearTimeout(this.timer);
		this.generation++;
		this.preloadNext(this.next);
		this.update("idle");
	}

	setVolume(volume: number): void {
		this.audio.volume = Math.min(1, Math.max(0, volume));
	}

	destroy(): void {
		this.events.abort();
		this.stop();
		this.release();
	}
}
