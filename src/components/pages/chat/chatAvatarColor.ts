/**
 * 头像主色相提取与持久化缓存工具（OKLCH 色彩空间）
 * 通过 36 桶色相直方图投票选出主色相，避免 RGB 全局平均造成的灰褐色坍缩。
 * 仅输出语义化色相角度与单色/彩色标识，具体明暗适配由 CSS oklch() 统一接管。
 */

export type AvatarRingTone = "color" | "mono";

export interface AvatarColorResult {
	tone: AvatarRingTone;
	hue: number; // 0..359 in OKLCH hue space
}

const MAX_CACHE_SIZE = 240;
const STORAGE_KEY = "chat:avatar-ring-colors:v1";
const SAMPLE_SIZE = 32;
const HUE_BUCKET_COUNT = 36;

const avatarColorCache = new Map<string, AvatarColorResult>();
const inFlightCallbacks = new Map<
	string,
	Set<(res: AvatarColorResult) => void>
>();
const failedProxyUrls = new Set<string>();
const MONO_FALLBACK: AvatarColorResult = { tone: "mono", hue: 0 };

let storageHydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function srgbToLinear(channel: number): number {
	const x = channel / 255;
	return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/**
 * 将 sRGB 转换为 OKLCH 及 OKLab 分量
 * 返回: [L, C, H, a, b]
 */
function srgbToOklch(
	r: number,
	g: number,
	b: number,
): [number, number, number, number, number] {
	const lr = srgbToLinear(r);
	const lg = srgbToLinear(g);
	const lb = srgbToLinear(b);

	const l_ = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
	const m_ = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
	const s_ = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

	const lCubed = Math.cbrt(l_);
	const mCubed = Math.cbrt(m_);
	const sCubed = Math.cbrt(s_);

	const L =
		0.2104542553 * lCubed + 0.793617785 * mCubed - 0.0040720468 * sCubed;
	const a =
		1.9779984951 * lCubed - 2.428592205 * mCubed + 0.4505937099 * sCubed;
	const bLab =
		0.0259040371 * lCubed + 0.7827717662 * mCubed - 0.808675766 * sCubed;

	const C = Math.hypot(a, bLab);
	const H = ((Math.atan2(bLab, a) * 180) / Math.PI + 360) % 360;

	return [L, C, H, a, bLab];
}

function hydrateCacheOnce(): void {
	if (storageHydrated || typeof window === "undefined") return;
	storageHydrated = true;
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return;
		for (const entry of parsed) {
			if (!Array.isArray(entry) || entry.length !== 3) continue;
			const [key, tone, hue] = entry;
			if (
				typeof key === "string" &&
				(tone === "color" || tone === "mono") &&
				typeof hue === "number" &&
				Number.isFinite(hue)
			) {
				if (avatarColorCache.size >= MAX_CACHE_SIZE) {
					const oldestKey = avatarColorCache.keys().next().value;
					if (oldestKey !== undefined) avatarColorCache.delete(oldestKey);
				}
				avatarColorCache.set(key, {
					tone,
					hue: ((Math.round(hue) % 360) + 360) % 360,
				});
			}
		}
	} catch {
		// ignore localStorage read/parse failures
	}
}

function schedulePersist(): void {
	if (typeof window === "undefined") return;
	if (persistTimer !== null) {
		clearTimeout(persistTimer);
	}
	persistTimer = setTimeout(() => {
		persistTimer = null;
		try {
			const entries: Array<[string, AvatarRingTone, number]> = [];
			for (const [key, val] of avatarColorCache.entries()) {
				entries.push([key, val.tone, val.hue]);
			}
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
		} catch {
			// ignore quota / storage errors
		}
	}, 300);
}

function cacheColor(key: string, result: AvatarColorResult): void {
	if (!key) return;
	hydrateCacheOnce();
	if (avatarColorCache.has(key)) {
		avatarColorCache.delete(key);
	} else if (avatarColorCache.size >= MAX_CACHE_SIZE) {
		const oldestKey = avatarColorCache.keys().next().value;
		if (oldestKey !== undefined) {
			avatarColorCache.delete(oldestKey);
		}
	}
	avatarColorCache.set(key, result);
	schedulePersist();
}

/**
 * 查询缓存中的头像颜色
 */
export function getCachedAvatarColor(key: string): AvatarColorResult | null {
	if (!key) return null;
	hydrateCacheOnce();
	const hit = avatarColorCache.get(key);
	if (!hit) return null;
	// Refresh LRU position
	avatarColorCache.delete(key);
	avatarColorCache.set(key, hit);
	return hit;
}

function createSampleContext(): CanvasRenderingContext2D | null {
	if (typeof document === "undefined") return null;
	const canvas = document.createElement("canvas");
	canvas.width = SAMPLE_SIZE;
	canvas.height = SAMPLE_SIZE;
	return canvas.getContext("2d", { willReadFrequently: true });
}

/**
 * 在 OKLCH 空间内进行 36 桶色相直方图投票，提取清晰纯正的主色相
 */
function analyzePixels(data: Uint8ClampedArray): AvatarColorResult {
	const bucketA = new Float64Array(HUE_BUCKET_COUNT);
	const bucketB = new Float64Array(HUE_BUCKET_COUNT);
	const bucketScores = new Float64Array(HUE_BUCKET_COUNT);

	let coloredPixels = 0;
	const radiusSq = 15.5 * 15.5;

	for (let y = 0; y < SAMPLE_SIZE; y++) {
		const dy = y - 15.5;
		for (let x = 0; x < SAMPLE_SIZE; x++) {
			const dx = x - 15.5;
			if (dx * dx + dy * dy > radiusSq) continue;

			const idx = (y * SAMPLE_SIZE + x) * 4;
			if (data[idx + 3] < 128) continue;

			const [L, C, H, a, bLab] = srgbToOklch(
				data[idx],
				data[idx + 1],
				data[idx + 2],
			);

			if (L < 0.14 || L > 0.95) continue;
			if (C < 0.035) continue;

			coloredPixels++;
			const weight =
				(0.25 + Math.min(C, 0.25) * 4) *
				Math.max(0.15, 1 - Math.abs(L - 0.58) * 1.1);

			const bucket = Math.floor(H / 10) % HUE_BUCKET_COUNT;
			bucketA[bucket] += a * weight;
			bucketB[bucket] += bLab * weight;

			const prevBucket = (bucket + HUE_BUCKET_COUNT - 1) % HUE_BUCKET_COUNT;
			const nextBucket = (bucket + 1) % HUE_BUCKET_COUNT;
			bucketScores[bucket] += weight;
			bucketScores[prevBucket] += weight * 0.25;
			bucketScores[nextBucket] += weight * 0.25;
		}
	}

	let bestIdx = 0;
	let bestScore = 0;
	for (let i = 0; i < HUE_BUCKET_COUNT; i++) {
		if (bucketScores[i] > bestScore) {
			bestScore = bucketScores[i];
			bestIdx = i;
		}
	}

	if (coloredPixels < 18 || bestScore <= 0) {
		return { tone: "mono", hue: 0 };
	}

	const prevIdx = (bestIdx + HUE_BUCKET_COUNT - 1) % HUE_BUCKET_COUNT;
	const nextIdx = (bestIdx + 1) % HUE_BUCKET_COUNT;
	const sumA = bucketA[prevIdx] + bucketA[bestIdx] + bucketA[nextIdx];
	const sumB = bucketB[prevIdx] + bucketB[bestIdx] + bucketB[nextIdx];

	if (sumA === 0 && sumB === 0) {
		return { tone: "mono", hue: 0 };
	}

	const hue = ((Math.atan2(sumB, sumA) * 180) / Math.PI + 360) % 360;
	return {
		tone: "color",
		hue: Math.round(hue) % 360,
	};
}

function notifyInFlight(url: string, result: AvatarColorResult): void {
	const callbacks = inFlightCallbacks.get(url);
	inFlightCallbacks.delete(url);
	if (!callbacks) return;
	for (const cb of callbacks) {
		cb(result);
	}
}

/**
 * 仅在本地 Canvas 因跨域 SecurityError 受污染时，尝试轻量级缩略图采样
 */
function fetchExternalAvatarColor(
	url: string,
	cacheKey: string,
	onUpdate?: (res: AvatarColorResult) => void,
): void {
	if (!url || typeof window === "undefined") return;
	if (url.startsWith("blob:") || url.startsWith("data:")) {
		onUpdate?.(MONO_FALLBACK);
		return;
	}
	if (failedProxyUrls.has(url)) {
		onUpdate?.(MONO_FALLBACK);
		return;
	}
	const existing = inFlightCallbacks.get(url);
	if (existing) {
		if (onUpdate) existing.add(onUpdate);
		return;
	}

	const callbacks = new Set<(res: AvatarColorResult) => void>();
	if (onUpdate) callbacks.add(onUpdate);
	inFlightCallbacks.set(url, callbacks);

	const proxyUrl = `https://wsrv.nl/?url=${encodeURIComponent(url)}&w=32&h=32&output=webp`;
	const offscreen = new Image();
	offscreen.crossOrigin = "anonymous";
	offscreen.onload = () => {
		try {
			const ctx = createSampleContext();
			if (!ctx) {
				notifyInFlight(url, MONO_FALLBACK);
				return;
			}
			ctx.drawImage(offscreen, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
			const data = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
			const result = analyzePixels(data);
			cacheColor(cacheKey, result);
			notifyInFlight(url, result);
		} catch {
			failedProxyUrls.add(url);
			notifyInFlight(url, MONO_FALLBACK);
		}
	};
	offscreen.onerror = () => {
		failedProxyUrls.add(url);
		notifyInFlight(url, MONO_FALLBACK);
	};
	offscreen.src = proxyUrl;
}

/**
 * 从已加载的 HTMLImageElement 提取头像主色相；绝不返回随机假色
 */
export function extractAvatarColor(
	img: HTMLImageElement,
	cacheKey: string,
	onUpdate?: (res: AvatarColorResult) => void,
): AvatarColorResult | null {
	if (!cacheKey) return null;
	const cached = getCachedAvatarColor(cacheKey);
	if (cached) return cached;

	if (!img?.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) {
		return null;
	}

	const ctx = createSampleContext();
	if (!ctx) return null;

	try {
		ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
		const imageData = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
		const result = analyzePixels(imageData);
		cacheColor(cacheKey, result);
		return result;
	} catch {
		if (cacheKey.startsWith("http://") || cacheKey.startsWith("https://")) {
			fetchExternalAvatarColor(cacheKey, cacheKey, onUpdate);
			return null;
		}
		return MONO_FALLBACK;
	}
}
