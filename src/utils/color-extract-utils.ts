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
 * 健壮地等待图片加载与解码完成，防止 Promise 永远挂起
 */
async function waitForImage(img: HTMLImageElement): Promise<boolean> {
	// 1. 如果已经完成加载且已有尺寸，直接返回成功
	if (img.complete && img.naturalWidth > 0) {
		return true;
	}

	// 2. 尝试使用现代浏览器支持的 img.decode()
	try {
		if (typeof img.decode === "function") {
			await img.decode();
			if (img.naturalWidth > 0) return true;
		}
	} catch {
		// decode 失败（或正在加载中）降级到事件监听
	}

	// 3. 再次检查，避免在 decode 尝试期间图片已就绪
	if (img.complete && img.naturalWidth > 0) {
		return true;
	}

	// 4. 若仍未完成，监听 load/error，并设置 1500ms 超时保护，确保绝不挂起
	return new Promise<boolean>((resolve) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const done = () => {
			if (timer) clearTimeout(timer);
			img.removeEventListener("load", done);
			img.removeEventListener("error", done);
			resolve(img.naturalWidth > 0);
		};

		img.addEventListener("load", done, { once: true });
		img.addEventListener("error", done, { once: true });
		timer = setTimeout(done, 1500);
	});
}

/**
 * 从 HTMLImageElement 中提取最具代表性的主色调色相 Hue (0 ~ 360)
 */
export async function extractDominantHue(
	img: HTMLImageElement,
): Promise<number> {
	const ready = await waitForImage(img);
	if (!ready || !img.naturalWidth || !img.naturalHeight) {
		return getHue();
	}

	// 横屏（桌面端）：裁剪掉上下各 30%，取中间 40% 的视野核心大横条
	// 竖屏（移动端）：裁剪掉上下各 15%，取中间 70% 的核心视野
	const isLandscape = img.naturalWidth >= img.naturalHeight;
	const yStartRatio = isLandscape ? 0.3 : 0.15;
	const yEndRatio = isLandscape ? 0.7 : 0.85;

	const sx = 0;
	const sy = img.naturalHeight * yStartRatio;
	const sw = img.naturalWidth;
	const sh = img.naturalHeight * (yEndRatio - yStartRatio);

	// 离屏 Canvas，降采样为 64x64 以兼顾极快分析速度与色彩准确性
	const sampleSize = 64;
	const canvas = document.createElement("canvas");
	canvas.width = sampleSize;
	canvas.height = sampleSize;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });

	if (!ctx) return getHue();

	try {
		ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sampleSize, sampleSize);
		const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize).data;

		// 将 360° 分为 72 个区间（每区 5°，提升精准度）
		const binCount = 72;
		const binWeights = new Float64Array(binCount);
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

			const binIndex = Math.min(Math.floor(h / 5), binCount - 1);
			binWeights[binIndex] += weight;
			validPixelCount++;
		}

		if (validPixelCount === 0) {
			return getHue();
		}

		// 环形滑动窗口（±15°，即 ±3 个 bin）：解决 0°/360° 红粉交界断裂及相邻色相聚集问题
		const windowSize = 3;
		let maxScore = -1;
		let bestHue = 0;

		for (let i = 0; i < binCount; i++) {
			let score = 0;
			let weightedHueDiffSum = 0;
			let totalW = 0;

			for (let offset = -windowSize; offset <= windowSize; offset++) {
				const binIdx = (i + offset + binCount) % binCount;
				const w = binWeights[binIdx];
				score += w;

				const binCenterHue = binIdx * 5 + 2.5;
				const centerHue = i * 5 + 2.5;
				const diff = ((binCenterHue - centerHue + 540) % 360) - 180;
				weightedHueDiffSum += diff * w;
				totalW += w;
			}

			if (score > maxScore) {
				maxScore = score;
				const centerHue = i * 5 + 2.5;
				const avgOffset = totalW > 0 ? weightedHueDiffSum / totalW : 0;
				bestHue = (centerHue + avgOffset + 360) % 360;
			}
		}

		return Math.round(bestHue);
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
 * 获取当前页面中处于激活/可见状态的壁纸 <img> 元素
 */
export function getActiveWallpaperImg(): HTMLImageElement | null {
	if (typeof document === "undefined") return null;
	const active =
		(window as unknown as { __currentWallpaperImg?: HTMLImageElement })
			.__currentWallpaperImg ||
		document.querySelector("#banner-images-container .slide-item.active img") ||
		document.querySelector("#banner-images-container .banner-image-slot img") ||
		document.querySelector("#dev-wallpaper-overlay-img") ||
		document.querySelector("#wallpaper-wrapper img");
	return active instanceof HTMLImageElement ? active : null;
}

/**
 * 提取并应用当前壁纸的主题色
 */
export async function applyCurrentWallpaperHue(smooth = false): Promise<void> {
	if (!getFollowWallpaperHue()) return;
	const img = getActiveWallpaperImg();
	if (img) {
		await handleWallpaperChange(img, smooth);
	}
}

/**
 * 全局初始化壁纸色调跟随监听器
 */
export function initWallpaperHueFollower(): void {
	if (typeof window === "undefined") return;

	// 1. 监听壁纸切换自定义事件
	window.addEventListener("wallpaperChange", ((
		e: CustomEvent<{ img: HTMLImageElement; smooth?: boolean }>,
	) => {
		if (e.detail?.img) {
			handleWallpaperChange(e.detail.img, e.detail.smooth !== false);
		}
	}) as EventListener);

	// 2. 监听跟随模式启用事件（当用户在设置面板重新开启时，立即提取当前壁纸颜色）
	window.addEventListener("followWallpaperHueChange", ((
		e: CustomEvent<{ enable: boolean }>,
	) => {
		if (e.detail?.enable) {
			applyCurrentWallpaperHue(true);
		}
	}) as EventListener);

	// 3. 监听 Swup 切页 / Astro 页面换入事件
	document.addEventListener("astro:page-load", () => {
		applyCurrentWallpaperHue(false);
	});
	document.addEventListener("swup:content:replace", () => {
		applyCurrentWallpaperHue(false);
	});

	// 4. 首屏立即执行一次自适应提取
	if (getFollowWallpaperHue()) {
		const img = getActiveWallpaperImg();
		if (img) {
			applyCurrentWallpaperHue(false);
		} else {
			// 若当前图片节点尚未挂载进 DOM，使用 MutationObserver 监听首个壁纸节点的插入
			const wrapper = document.getElementById("wallpaper-wrapper");
			if (wrapper) {
				const observer = new MutationObserver(() => {
					const found = getActiveWallpaperImg();
					if (found) {
						observer.disconnect();
						applyCurrentWallpaperHue(false);
					}
				});
				observer.observe(wrapper, { childList: true, subtree: true });
				setTimeout(() => observer.disconnect(), 3000);
			}
		}
	}
}

/**
 * 从壁纸图片顶部区域提取感知亮度，并返回 header 文字应该使用的明暗主题：
 * - 'dark': 壁纸顶部偏亮，header 文字使用黑色（深色）
 * - 'light': 壁纸顶部偏暗，header 文字使用白色（浅色）
 */
export async function extractHeaderThemeFromWallpaper(
	img: HTMLImageElement,
	dimOpacity = 0.2,
): Promise<"light" | "dark"> {
	const ready = await waitForImage(img);
	if (!ready || !img.naturalWidth || !img.naturalHeight) {
		return document.documentElement.classList.contains("dark")
			? "light"
			: "dark";
	}

	// 只采样壁纸顶部 20% 的高度（这是 Header / Navbar 覆盖的区域）
	const sw = img.naturalWidth;
	const sh = Math.max(1, Math.floor(img.naturalHeight * 0.2));
	const sx = 0;
	const sy = 0;

	const sampleWidth = 64;
	const sampleHeight = 32;
	const canvas = document.createElement("canvas");
	canvas.width = sampleWidth;
	canvas.height = sampleHeight;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) {
		return document.documentElement.classList.contains("dark")
			? "light"
			: "dark";
	}

	try {
		ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sampleWidth, sampleHeight);
		const data = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;

		let totalLuminance = 0;
		let count = 0;

		for (let i = 0; i < data.length; i += 4) {
			const a = data[i + 3];
			if (a < 64) continue; // 忽略高透明像素

			const r = data[i] / 255;
			const g = data[i + 1] / 255;
			const b = data[i + 2] / 255;

			// WCAG 2.0 相对感知亮度公式
			const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			totalLuminance += lum;
			count++;
		}

		if (count === 0) {
			return document.documentElement.classList.contains("dark")
				? "light"
				: "dark";
		}

		const avgLuminance = totalLuminance / count;
		// 考虑黑色暗化层 dimOpacity (例如 0.2 的暗化层使最终背景亮度乘以 0.8)
		const effectiveLuminance = avgLuminance * (1 - dimOpacity);

		// 亮度阈值：更倾向于使用白色文字（light）。
		// 提高阈值至 0.60：只有当壁纸顶部极其浅亮（> 0.60）时才切换为黑色文字（dark），
		// 只要壁纸稍微有点暗、有点黑或处于普通中等明度，均稳定使用白色文字（light）。
		const HEADER_THEME_LUMINANCE_THRESHOLD = 0.6;
		return effectiveLuminance > HEADER_THEME_LUMINANCE_THRESHOLD
			? "dark"
			: "light";
	} catch (e) {
		console.warn(
			"[color-extract] Failed to extract header theme from wallpaper:",
			e,
		);
		return document.documentElement.classList.contains("dark")
			? "light"
			: "dark";
	}
}

/**
 * 提取并应用当前壁纸下 Header 的明暗主题
 */
export async function applyHeaderThemeFromWallpaper(
	img?: HTMLImageElement | null,
): Promise<void> {
	if (typeof document === "undefined") return;

	const navbar = document.getElementById("navbar");
	if (!navbar) return;

	// 如果壁纸模式是 none，则移除属性，恢复跟随网站常规主题
	const wallpaperMode = document.documentElement.getAttribute(
		"data-wallpaper-mode",
	);
	if (wallpaperMode === "none") {
		navbar.removeAttribute("data-header-theme");
		return;
	}

	const targetImg = img || getActiveWallpaperImg();
	if (!targetImg) return;

	const dimContainer = document.getElementById("banner-dim-container");
	let dimOpacity = 0.2;
	const dimOverlay = dimContainer?.querySelector(
		".banner-dim-overlay",
	) as HTMLElement | null;
	if (dimOverlay) {
		const bg = dimOverlay.style.background || "";
		const match = bg.match(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([\d.]+)\s*\)/);
		if (match) dimOpacity = Number.parseFloat(match[1]);
	}

	const theme = await extractHeaderThemeFromWallpaper(targetImg, dimOpacity);
	navbar.setAttribute("data-header-theme", theme);
	window.dispatchEvent(
		new CustomEvent("headerThemeChange", { detail: { theme } }),
	);
}

/**
 * 全局初始化 Header 文本颜色主题跟随壁纸亮度的监听器
 */
export function initHeaderThemeFollower(): void {
	if (typeof window === "undefined") return;

	// 1. 监听壁纸切换自定义事件
	window.addEventListener("wallpaperChange", ((
		e: CustomEvent<{ img: HTMLImageElement; smooth?: boolean }>,
	) => {
		if (e.detail?.img) {
			applyHeaderThemeFromWallpaper(e.detail.img);
		}
	}) as EventListener);

	// 2. 监听壁纸模式改变
	window.addEventListener("wallpaperModeChange", ((
		e: CustomEvent<{ mode: string }>,
	) => {
		if (e.detail?.mode === "none") {
			document.getElementById("navbar")?.removeAttribute("data-header-theme");
		} else {
			applyHeaderThemeFromWallpaper();
		}
	}) as EventListener);

	// 3. 监听 Swup 切页 / Astro 页面换入事件
	document.addEventListener("astro:page-load", () => {
		applyHeaderThemeFromWallpaper();
	});
	document.addEventListener("swup:content:replace", () => {
		applyHeaderThemeFromWallpaper();
	});

	// 4. 首屏立即执行一次自适应提取
	const img = getActiveWallpaperImg();
	if (img) {
		applyHeaderThemeFromWallpaper(img);
	} else {
		// 若当前图片节点尚未挂载进 DOM，使用 MutationObserver 监听首个壁纸节点的插入
		const wrapper = document.getElementById("wallpaper-wrapper");
		if (wrapper) {
			const observer = new MutationObserver(() => {
				const found = getActiveWallpaperImg();
				if (found) {
					observer.disconnect();
					applyHeaderThemeFromWallpaper(found);
				}
			});
			observer.observe(wrapper, { childList: true, subtree: true });
			setTimeout(() => observer.disconnect(), 3000);
		}
	}
}
