import { getFollowWallpaperHue, getHue, setHue } from "./setting-utils";

/**
 * 将 RGB 转换为 HSL
 * r, g, b 范围: [0, 255]
 * 返回: h in [0, 360), s in [0, 1], l in [0, 1]
 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;

	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const delta = max - min;

	let h = 0;
	let s = 0;
	const l = (max + min) / 2;

	if (delta !== 0) {
		s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);

		if (max === rn) {
			h = (gn - bn) / delta + (gn < bn ? 6 : 0);
		} else if (max === gn) {
			h = (bn - rn) / delta + 2;
		} else {
			h = (rn - gn) / delta + 4;
		}
		h = Math.round(h * 60);
	}

	return [h, s, l];
}

/**
 * 从 HTMLImageElement 中提取最具代表性的主色调色相 Hue (0 ~ 360)
 */
export async function extractDominantHue(
	img: HTMLImageElement,
): Promise<number> {
	// 等待图片加载完成
	if (!img.complete || img.naturalWidth === 0) {
		await new Promise<void>((resolve) => {
			const onLoad = () => {
				img.removeEventListener("load", onLoad);
				img.removeEventListener("error", onLoad);
				resolve();
			};
			img.addEventListener("load", onLoad, { once: true });
			img.addEventListener("error", onLoad, { once: true });
		});
	}

	if (!img.naturalWidth || !img.naturalHeight) {
		return getHue();
	}

	// 离屏 Canvas，降采样为 64x64 以兼顾极快分析速度与色彩准确性
	const sampleSize = 64;
	const canvas = document.createElement("canvas");
	canvas.width = sampleSize;
	canvas.height = sampleSize;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });

	if (!ctx) return getHue();

	try {
		ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
		const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize).data;

		// 将 360° 分为 36 个区间（每区 10°）
		const binCount = 36;
		const binWeights = new Float64Array(binCount);
		const binHueSums = new Float64Array(binCount);
		let validPixelCount = 0;

		for (let i = 0; i < imageData.length; i += 4) {
			const a = imageData[i + 3];
			if (a < 128) continue; // 过滤高透明像素

			const r = imageData[i];
			const g = imageData[i + 1];
			const b = imageData[i + 2];

			const [h, s, l] = rgbToHsl(r, g, b);

			// 过滤掉暗部黑杂色、高光亮白杂色以及低饱和灰色
			if (l < 0.15 || l > 0.92 || s < 0.18) {
				continue;
			}

			// 权重计算：高饱和度、适中明度（钟形分布）赋予更高主色权重
			const lightnessWeight = 1 - Math.abs(l - 0.5) * 2;
			const weight = s * lightnessWeight;

			const binIndex = Math.min(Math.floor(h / 10), binCount - 1);
			binWeights[binIndex] += weight;
			binHueSums[binIndex] += h * weight;
			validPixelCount++;
		}

		if (validPixelCount === 0) {
			return getHue();
		}

		// 寻找最高权重的色相区间
		let maxWeight = -1;
		let bestBin = 0;
		for (let b = 0; b < binCount; b++) {
			if (binWeights[b] > maxWeight) {
				maxWeight = binWeights[b];
				bestBin = b;
			}
		}

		if (binWeights[bestBin] > 0) {
			return Math.round(binHueSums[bestBin] / binWeights[bestBin]);
		}
		return getHue();
	} catch (e) {
		// 跨域或读取失败兜底
		console.warn("[color-extract] Failed to extract hue from image:", e);
		return getHue();
	}
}

let activeHueAnimationId: number | null = null;

/**
 * 沿最短角度平滑过渡 CSS 变量 --hue (0 ~ 360)
 */
export function animateHue(targetHue: number, duration = 700): void {
	if (typeof window === "undefined" || typeof document === "undefined") return;

	if (activeHueAnimationId !== null) {
		cancelAnimationFrame(activeHueAnimationId);
		activeHueAnimationId = null;
	}

	const currentHue = getHue();
	// 计算最短圆周角距离：例如 350° 到 10° 只需要 +20°，而不是 -340°
	const diff = ((targetHue - currentHue + 540) % 360) - 180;

	if (Math.abs(diff) < 1) {
		setHue(targetHue);
		window.dispatchEvent(
			new CustomEvent("hueChange", { detail: { hue: targetHue } }),
		);
		return;
	}

	const startTime = performance.now();

	function step(currentTime: number) {
		const elapsed = currentTime - startTime;
		const progress = Math.min(elapsed / duration, 1);

		// ease-out-cubic
		const ease = 1 - (1 - progress) ** 3;
		let interpolated = (currentHue + diff * ease) % 360;
		if (interpolated < 0) interpolated += 360;

		const currentVal = Math.round(interpolated);
		setHue(currentVal);
		window.dispatchEvent(
			new CustomEvent("hueChange", { detail: { hue: currentVal } }),
		);

		if (progress < 1) {
			activeHueAnimationId = requestAnimationFrame(step);
		} else {
			setHue(targetHue);
			window.dispatchEvent(
				new CustomEvent("hueChange", { detail: { hue: targetHue } }),
			);
			activeHueAnimationId = null;
		}
	}

	activeHueAnimationId = requestAnimationFrame(step);
}

/**
 * 处理壁纸切换时的色彩自适应
 */
export async function handleWallpaperChange(
	img: HTMLImageElement | null,
	smooth = true,
): Promise<void> {
	if (!img) return;
	if (!getFollowWallpaperHue()) return;

	const targetHue = await extractDominantHue(img);
	if (smooth) {
		animateHue(targetHue);
	} else {
		setHue(targetHue);
		window.dispatchEvent(
			new CustomEvent("hueChange", { detail: { hue: targetHue } }),
		);
	}
}

/**
 * 全局初始化壁纸色调跟随监听器
 */
export function initWallpaperHueFollower(): void {
	if (typeof window === "undefined") return;

	// 监听壁纸切换自定义事件
	window.addEventListener("wallpaperChange", ((
		e: CustomEvent<{ img: HTMLImageElement; smooth?: boolean }>,
	) => {
		if (e.detail?.img) {
			handleWallpaperChange(e.detail.img, e.detail.smooth !== false);
		}
	}) as EventListener);

	// 监听跟随模式启用事件（当用户在设置面板重新开启时，立即提取当前壁纸颜色）
	window.addEventListener("followWallpaperHueChange", ((
		e: CustomEvent<{ enable: boolean }>,
	) => {
		if (e.detail?.enable) {
			// 查找当前活跃的壁纸 img
			const activeSlide =
				document.querySelector(
					"#banner-images-container .slide-item.active img",
				) ||
				document.querySelector("#dev-wallpaper-overlay-img") ||
				document.querySelector("#wallpaper-wrapper img");
			if (activeSlide instanceof HTMLImageElement) {
				handleWallpaperChange(activeSlide, true);
			}
		}
	}) as EventListener);
}
