import fs from "node:fs";
import path from "node:path";
import { backgroundWallpaper } from "../config";

export type BackgroundImages = {
	desktop: string[];
	mobile: string[];
	isMultiple: boolean;
};

// 将单个值或数组统一为数组
const toArray = (src: string | string[] | undefined): string[] => {
	if (!src) return [];
	if (Array.isArray(src)) return src;
	return [src];
};

// 自动扫描壁纸目录（仅扫描 desktop 与 mobile，backup 纯备份绝不包含）
const scanWallpaperDir = (subDir: "desktop" | "mobile"): string[] => {
	try {
		const dirPath = path.resolve("public/wallpapers", subDir);
		if (!fs.existsSync(dirPath)) return [];
		const files = fs.readdirSync(dirPath);
		const validExts = new Set([".webp", ".png", ".jpg", ".jpeg", ".avif"]);
		return files
			.filter((f) => validExts.has(path.extname(f).toLowerCase()))
			.map((f) => `/wallpapers/${subDir}/${f}`);
	} catch {
		return [];
	}
};

// 背景图片处理工具函数
// 返回所有配置的图片（用于构建时渲染所有图片）
export const getBackgroundImages = (): BackgroundImages => {
	const autoDesktop = scanWallpaperDir("desktop");
	const autoMobile = scanWallpaperDir("mobile");

	let desktopImages = autoDesktop.length > 0 ? autoDesktop : [];
	let mobileImages = autoMobile.length > 0 ? autoMobile : [];

	// 若目录扫描为空，回退到 backgroundWallpaper.ts 配置文件中的手动指定项
	if (desktopImages.length === 0 || mobileImages.length === 0) {
		const bgSrc = backgroundWallpaper.src;
		if (
			typeof bgSrc === "object" &&
			bgSrc !== null &&
			!Array.isArray(bgSrc) &&
			("desktop" in bgSrc || "mobile" in bgSrc)
		) {
			const srcObj = bgSrc as {
				desktop?: string | string[];
				mobile?: string | string[];
			};
			if (desktopImages.length === 0) desktopImages = toArray(srcObj.desktop);
			if (mobileImages.length === 0) mobileImages = toArray(srcObj.mobile);
		} else {
			const images = toArray(bgSrc as string | string[]);
			if (desktopImages.length === 0) desktopImages = images;
			if (mobileImages.length === 0) mobileImages = images;
		}
	}

	return {
		desktop: desktopImages.length > 0 ? desktopImages : mobileImages,
		mobile: mobileImages.length > 0 ? mobileImages : desktopImages,
		isMultiple: desktopImages.length > 1 || mobileImages.length > 1,
	};
};

// 类型守卫函数
export const isBannerSrcObject = (
	src:
		| string
		| string[]
		| { desktop?: string | string[]; mobile?: string | string[] },
): src is { desktop?: string | string[]; mobile?: string | string[] } => {
	return (
		typeof src === "object" &&
		src !== null &&
		!Array.isArray(src) &&
		("desktop" in src || "mobile" in src)
	);
};

// 获取默认背景图片（返回第一张，用于 SEO 等场景）
export const getDefaultBackground = (): string => {
	const images = getBackgroundImages();
	return images.desktop[0] || images.mobile[0] || "";
};

// 检查是否为首页
export const isHomePage = (pathname: string): boolean => {
	// 获取 base URL
	const baseUrl = import.meta.env.BASE_URL || "/";
	const baseUrlNoSlash = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

	if (pathname === baseUrl) return true;
	if (pathname === baseUrlNoSlash) return true;
	if (pathname === "/") return true;

	return false;
};

// 获取横幅偏移量
export const getBannerOffset = (position = "center"): string => {
	const bannerOffsetByPosition = {
		top: "100vh",
		center: "50vh",
		bottom: "0",
	};
	return (
		bannerOffsetByPosition[position as keyof typeof bannerOffsetByPosition] ||
		"50vh"
	);
};
