import { coverImageConfig } from "../config/coverImageConfig";
import { siteConfig } from "../config/siteConfig";
import type { ImageFormat } from "../types/config";

const { randomCoverImage } = coverImageConfig;

/**
 * 根据seed生成确定性hash值
 */
function getSeedHash(seed?: string): number {
	return seed
		? Math.abs(
				seed.split("").reduce((acc, char) => {
					return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
				}, 0),
			)
		: 0;
}

/**
 * 为API URL添加seed参数，确保每篇文章获取不同图片
 */
function appendSeedParam(apiUrl: string, hash: number): string {
	if (hash === 0) return apiUrl;
	const separator = apiUrl.includes("?") ? "&" : "?";
	return `${apiUrl}${separator}v=${hash}`;
}

/**
 * 判断文章是否应使用随机封面图
 * 1. 显式指定 image: "api"
 * 2. 文章未设置 image（或为空），且全局开启了随机封面图功能（且未显式指定 "none"）
 */
function isRandomCoverImage(image: string | undefined): boolean {
	if (image === "none") {
		return false;
	}
	if (image === "api") {
		return true;
	}
	if (!image || image.trim() === "") {
		return Boolean(
			randomCoverImage.enable &&
				randomCoverImage.apis &&
				randomCoverImage.apis.length > 0,
		);
	}
	return false;
}

/**
 * 处理文章封面图
 * 当image字段为"api"或文章未设置image（且全局开启随机封面）时，返回首选API的URL（带文章专属固定hash）
 * @param image - 文章frontmatter中的image字段值
 * @param seed - 用于生成唯一URL的种子（文章id或slug）
 */
export function processCoverImageSync(
	image: string | undefined,
	seed?: string,
): string {
	if (image === "none") {
		return "";
	}

	if (image && image !== "api") {
		return image;
	}

	if (
		!isRandomCoverImage(image) ||
		!randomCoverImage.apis ||
		randomCoverImage.apis.length === 0
	) {
		return "";
	}

	// 始终使用第一个API，失败时由客户端按顺序尝试后续API
	const hash = getSeedHash(seed);
	return appendSeedParam(randomCoverImage.apis[0], hash);
}

/**
 * 获取所有随机封面图API URL列表（带seed参数）
 * 用于客户端按顺序尝试，第一个成功即使用，全部失败则显示回退图片
 * @param image - 文章frontmatter中的image字段值
 * @param seed - 用于生成唯一URL的种子（文章id或slug）
 */
export function getApiUrlList(
	image: string | undefined,
	seed?: string,
): string[] {
	if (
		!isRandomCoverImage(image) ||
		!randomCoverImage.enable ||
		!randomCoverImage.apis
	) {
		return [];
	}

	const hash = getSeedHash(seed);
	return randomCoverImage.apis.map((api) => appendSeedParam(api, hash));
}

/**
 * 获取图片优化格式配置
 */
export function getImageFormats(): ImageFormat[] {
	const formatConfig = siteConfig.imageOptimization?.formats ?? "both";
	switch (formatConfig) {
		case "avif":
			return ["avif"];
		case "webp":
			return ["webp"];
		default:
			return ["avif", "webp"];
	}
}

/**
 * 获取图片优化质量配置
 */
export function getImageQuality(): number {
	return siteConfig.imageOptimization?.quality ?? 80;
}

/**
 * 获取图片回退格式
 */
export function getFallbackFormat(): "avif" | "webp" {
	const formatConfig = siteConfig.imageOptimization?.formats ?? "both";
	return formatConfig === "avif" ? "avif" : "webp";
}

/**
 * 检查是否需要为图片添加 referrerpolicy="no-referrer" 以解决防盗链 403 问题
 */
export function shouldAddNoReferrer(urlStr: string): boolean {
	if (!urlStr.startsWith("http")) return false;
	const domains = siteConfig.imageOptimization?.noReferrerDomains || [];
	if (domains.length === 0) return false;
	try {
		const hostname = new URL(urlStr).hostname;
		return domains.some((pattern) => {
			// 先完整转义正则元字符，再把用户写的 * 通配符还原为 .*
			const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regexPattern = escaped.replace(/\\\*/g, ".*");
			return new RegExp(`^${regexPattern}$`).test(hostname);
		});
	} catch {
		return false;
	}
}
