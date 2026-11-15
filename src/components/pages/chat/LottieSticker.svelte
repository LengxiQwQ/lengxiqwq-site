<script module lang="ts">
interface LottieAnimation {
	play: () => void;
	pause: () => void;
	destroy: () => void;
	addEventListener: (name: string, cb: () => void) => void;
}

interface LottiePlayer {
	loadAnimation: (params: {
		container: HTMLElement;
		renderer: "svg" | "canvas" | "html";
		loop: boolean;
		autoplay: boolean;
		path: string;
	}) => LottieAnimation;
}

const LOTTIE_CDNS = [
	"https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js",
	"https://unpkg.com/lottie-web@5.12.2/build/player/lottie.min.js",
];

let lottieLoaderPromise: Promise<LottiePlayer> | null = null;

function getWindowLottie(): LottiePlayer | undefined {
	const w = window as unknown as {
		lottie?: LottiePlayer;
		bodymovin?: LottiePlayer;
	};
	return w.lottie || w.bodymovin;
}

function loadScript(src: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const existing = document.querySelector<HTMLScriptElement>(
			`script[data-lottie-src="${src}"]`,
		);
		if (existing) {
			if (existing.dataset.loaded === "1") {
				resolve();
				return;
			}
			existing.addEventListener("load", () => resolve(), { once: true });
			existing.addEventListener(
				"error",
				() => reject(new Error(`Failed to load ${src}`)),
				{ once: true },
			);
			return;
		}
		const script = document.createElement("script");
		script.src = src;
		script.async = true;
		script.dataset.lottieSrc = src;
		script.onload = () => {
			script.dataset.loaded = "1";
			resolve();
		};
		script.onerror = () => {
			script.remove();
			reject(new Error(`Failed to load ${src}`));
		};
		document.head.appendChild(script);
	});
}

function ensureLottieLibrary(): Promise<LottiePlayer> {
	if (typeof window === "undefined") {
		return Promise.reject(new Error("Lottie unavailable on server"));
	}
	const ready = getWindowLottie();
	if (ready) {
		return Promise.resolve(ready);
	}
	if (!lottieLoaderPromise) {
		lottieLoaderPromise = (async () => {
			let lastErr: unknown;
			for (const url of LOTTIE_CDNS) {
				try {
					await loadScript(url);
					const lib = getWindowLottie();
					if (lib) return lib;
				} catch (err) {
					lastErr = err;
				}
			}
			lottieLoaderPromise = null;
			throw lastErr instanceof Error
				? lastErr
				: new Error("Failed to load lottie-web");
		})();
	}
	return lottieLoaderPromise;
}
</script>

<script lang="ts">
import { normalizeServerUrl } from "./chatClient";

interface Props {
	name: string;
	alt?: string;
	className?: string;
	chatServerUrl?: string;
}

const DEFAULT_SERVER_URL = "https://chat-server.lengxiqwq.com";

let {
	name,
	alt = "",
	className = "chat-sticker",
	chatServerUrl = DEFAULT_SERVER_URL,
}: Props = $props();

let containerEl = $state<HTMLDivElement | null>(null);
let isVisible = false;
let hasEnteredViewport = $state(false);
let failed = $state(false);
let activeAnim: LottieAnimation | null = null;

const displayAlt = $derived(alt || name);
const lottiePath = $derived.by(() => {
	const base = normalizeServerUrl(chatServerUrl) || DEFAULT_SERVER_URL;
	return `${base}/api/lottie/${encodeURIComponent(name.toLowerCase())}.json`;
});

$effect(() => {
	const el = containerEl;
	if (!el || typeof IntersectionObserver === "undefined") {
		hasEnteredViewport = true;
		isVisible = true;
		activeAnim?.play();
		return;
	}
	const observer = new IntersectionObserver(
		(entries) => {
			const entry = entries[0];
			if (!entry) return;
			isVisible = entry.isIntersecting;
			if (entry.isIntersecting) {
				hasEnteredViewport = true;
				activeAnim?.play();
			} else {
				activeAnim?.pause();
			}
		},
		{ rootMargin: "120px" },
	);
	observer.observe(el);
	return () => {
		observer.disconnect();
	};
});

$effect(() => {
	const el = containerEl;
	const jsonUrl = lottiePath;
	if (!el || !hasEnteredViewport || !name) return;

	let disposed = false;
	let anim: LottieAnimation | null = null;
	failed = false;

	void ensureLottieLibrary()
		.then((lottie) => {
			if (disposed || !el) return;
			el.replaceChildren();
			anim = lottie.loadAnimation({
				container: el,
				renderer: "svg",
				loop: true,
				autoplay: isVisible,
				path: jsonUrl,
			});
			activeAnim = anim;
			anim.addEventListener("data_failed", () => {
				if (!disposed) {
					failed = true;
				}
			});
		})
		.catch(() => {
			if (!disposed) {
				failed = true;
			}
		});

	return () => {
		disposed = true;
		if (activeAnim === anim) {
			activeAnim = null;
		}
		if (anim) {
			anim.destroy();
			anim = null;
		}
	};
});
</script>

{#if failed}
	<span class="inline-flex items-center justify-center text-xs opacity-75 px-1" role="img" aria-label={displayAlt} title={displayAlt}>
		[{displayAlt}]
	</span>
{:else}
	<div
		bind:this={containerEl}
		class={className}
		role="img"
		aria-label={displayAlt}
		title={displayAlt}
	></div>
{/if}
