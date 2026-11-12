type FancyboxType = typeof import("@fancyapps/ui").Fancybox;

let cachedCssUrls: string[] = [];
let cachedFancyboxPromise: Promise<FancyboxType> | null = null;
let loadedFancyboxRef: FancyboxType | null = null;
let swupCleanupBound = false;
let openSeq = 0;

function bindSwupCleanupOnce(): void {
	if (swupCleanupBound || typeof document === "undefined") return;
	swupCleanupBound = true;
	document.addEventListener("swup:visit:start", () => {
		openSeq += 1;
		if (loadedFancyboxRef) {
			try {
				loadedFancyboxRef.destroy();
			} catch {
				// Ignore cleanup errors on route transition
			}
		}
	});
}

function waitForStylesheet(link: HTMLLinkElement): Promise<void> {
	return new Promise((resolve) => {
		if (link.sheet) {
			resolve();
			return;
		}
		const timer = window.setTimeout(resolve, 1500);
		const done = () => {
			window.clearTimeout(timer);
			resolve();
		};
		link.addEventListener("load", done, { once: true });
		link.addEventListener("error", done, { once: true });
	});
}

async function ensureFancyboxStyles(): Promise<void> {
	if (typeof document === "undefined") return;
	if (cachedCssUrls.length === 0) {
		const [fancyboxCss, customCss] = await Promise.all([
			import("@fancyapps/ui/dist/fancybox/fancybox.css?url"),
			import("@/styles/fancybox-custom.css?url"),
		]);
		cachedCssUrls = [fancyboxCss.default, customCss.default].filter(
			(u): u is string => typeof u === "string" && u.length > 0,
		);
	}
	const pendingLoads: Promise<void>[] = [];
	for (const url of cachedCssUrls) {
		if (!document.head.querySelector(`link[href="${url}"]`)) {
			const link = document.createElement("link");
			link.rel = "stylesheet";
			link.href = url;
			pendingLoads.push(waitForStylesheet(link));
			document.head.appendChild(link);
		}
	}
	if (pendingLoads.length > 0) {
		await Promise.all(pendingLoads);
	}
}

async function importFancyboxWithDevFallback(): Promise<FancyboxType> {
	try {
		const mod = await import("@fancyapps/ui");
		if (mod?.Fancybox) return mod.Fancybox;
	} catch (primaryErr) {
		// Vite dev server may return 504 (Outdated Optimize Dep) for @fancyapps/ui;
		// fall back directly to the ESM entrypoint beside the resolved fancybox.css URL.
		const cssUrl = cachedCssUrls.find((u) => u.includes("fancybox.css"));
		if (import.meta.env.DEV && cssUrl) {
			const esmUrl = cssUrl.replace(/fancybox\.css(?:\?.*)?$/, "index.js");
			const mod = (await import(/* @vite-ignore */ esmUrl)) as {
				Fancybox?: FancyboxType;
			};
			if (mod?.Fancybox) return mod.Fancybox;
		}
		throw primaryErr;
	}
	throw new Error("Fancybox module unavailable");
}

async function loadFancybox(): Promise<FancyboxType> {
	if (!cachedFancyboxPromise) {
		cachedFancyboxPromise = importFancyboxWithDevFallback()
			.then((fb) => {
				const plugins = (fb as { Plugins?: { Hash?: unknown } }).Plugins;
				if (plugins?.Hash) {
					delete plugins.Hash;
				}
				loadedFancyboxRef = fb;
				return fb;
			})
			.catch((err) => {
				cachedFancyboxPromise = null;
				throw err;
			});
	}
	return cachedFancyboxPromise;
}

/**
 * Open the site's built-in Fancybox lightbox for chatroom images,
 * grouping all rendered chat images in DOM order for prev/next navigation.
 */
export async function openChatImageLightbox(
	targetUrl: string,
	triggerEl?: HTMLElement | null,
): Promise<void> {
	if (typeof document === "undefined" || !targetUrl) return;
	bindSwupCleanupOnce();
	const currentSeq = ++openSeq;

	try {
		await ensureFancyboxStyles();
		const Fancybox = await loadFancybox();
		if (currentSeq !== openSeq) return;

		const scope = document.getElementById("chat-page") ?? document;
		const nodes = Array.from(
			scope.querySelectorAll<HTMLElement>("[data-chat-image]"),
		);

		const slides: Array<{
			src: string;
			type: "image";
			triggerEl?: HTMLElement;
			thumbEl?: HTMLImageElement;
		}> = [];
		let startIndex = -1;

		for (const el of nodes) {
			const src = el.getAttribute("data-chat-image") || "";
			if (!src) continue;
			const imgEl = el.querySelector("img") ?? undefined;
			if (triggerEl && el === triggerEl) {
				startIndex = slides.length;
			}
			slides.push({
				src,
				type: "image",
				triggerEl: el,
				thumbEl: imgEl,
			});
		}

		if (startIndex < 0) {
			startIndex = slides.findIndex((s) => s.src === targetUrl);
		}
		if (slides.length === 0) {
			slides.push({
				src: targetUrl,
				type: "image",
				triggerEl: triggerEl ?? undefined,
			});
			startIndex = 0;
		} else if (startIndex < 0) {
			startIndex = 0;
		}

		Fancybox.show(slides, {
			startIndex,
			Hash: false,
			closeExisting: true,
			Thumbs: {
				autoStart: true,
				minCount: 3,
			},
			Toolbar: {
				display: {
					left: ["infobar"],
					middle: [
						"zoomIn",
						"zoomOut",
						"toggle1to1",
						"rotateCCW",
						"rotateCW",
						"flipX",
						"flipY",
					],
					right: ["slideshow", "thumbs", "close"],
				},
			},
			dragToClose: true,
			fitToView: true,
			preload: 1,
			infinite: true,
			Panzoom: {
				maxScale: 2,
				minScale: 1,
			},
			on: {
				destroy: (fb: { getContainer?: () => HTMLElement | null }) => {
					try {
						const container = fb.getContainer?.();
						if (container) {
							container.querySelectorAll("img").forEach((img) => {
								img.src = "";
							});
						}
					} catch {
						// Ignore cleanup failure
					}
				},
			},
		} as Parameters<typeof Fancybox.show>[1]);
	} catch {
		if (currentSeq === openSeq) {
			window.open(targetUrl, "_blank", "noopener,noreferrer");
		}
	}
}
