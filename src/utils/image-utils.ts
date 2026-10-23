import coversManifestData from "../constants/covers-manifest.json";
import { coverImageConfig } from "../config/coverImageConfig";
import { siteConfig } from "../config/siteConfig";
import type { ImageFormat } from "../types/config";

interface CoversManifest {
	updatedAt?: string;
	total?: number;
	categories?: Record<string, string[]>;
	all?: string[];
}

const coversManifest = coversManifestData as CoversManifest;
const { randomCoverImage } = coverImageConfig;

/**
 * 根据seed生成确定性hash值
 * 结合配置中的 version 版本号，改动 version 即可给全站文章整体轮换一组全新随机图
 */
function getSeedHash(seed?: string): number {
	if (!seed) return 0;
	const version = randomCoverImage.version ?? 1;
	const saltedSeed = `v${version}_${seed}`;
	return Math.abs(
		saltedSeed.split("").reduce((acc, char) => {
			return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
		}, 0),
	);
}

/**
 * 解析用户在文章中指定的分类随机名称（如果存在）
 * 支持语法: "api:二次元美少女", "category:二次元美少女", 或直接写分类文件夹名 "二次元美少女"
 */
function getRequestedCategory(image: string | undefined): string | null {
	if (!image || image === "none" || image === "api") return null;
	const trimmed = image.trim();
	const categories = coversManifest?.categories || {};

	if (trimmed.startsWith("api:")) {
		const cat = trimmed.slice(4).trim();
		if (categories[cat] && categories[cat].length > 0) return cat;
	}
	if (trimmed.startsWith("category:")) {
		const cat = trimmed.slice(9).trim();
		if (categories[cat] && categories[cat].length > 0) return cat;
	}
	// 如果直接写了已有的分类名
	if (categories[trimmed] && categories[trimmed].length > 0) {
		return trimmed;
	}
	return null;
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
 * 1. 显式指定 image: "api" 或分类随机（如 "api:二次元美少女"）
 * 2. 文章未设置 image（或为空），且全局开启了随机封面图功能（且未显式指定 "none"）
 */
function isRandomCoverImage(image: string | undefined): boolean {
	if (image === "none") {
		return false;
	}
	if (image === "api" || getRequestedCategory(image) !== null) {
		return true;
	}
	if (!image || image.trim() === "") {
		return Boolean(
			(coversManifest?.all && coversManifest.all.length > 0) ||
				(randomCoverImage.enable &&
					randomCoverImage.apis &&
					randomCoverImage.apis.length > 0),
		);
	}
	return false;
}

/**
 * 为 API URL 转换为固定确定性直链（或添加 seed 参数）
 * 彻底解决动态 302 随机图接口每次刷新都随机变图的问题
 * - 支持自建图床模板: 如 https://img.lengxiqwq.com/covers/{index}.webp 或 https://img.lengxiqwq.com/covers?total=20
 * - t.alcy.cc/pc: 350 ~ 550（精选二次元高颜值美少女横屏 WebP 直链）
 * - t.alcy.cc/moe: 1 ~ 107（精选萌系 WebP 直链）
 */
function resolveDeterministicApiUrl(apiUrl: string, hash: number): string {
	// 1. 支持包含 {index} 占位符的自建模板直链，例如: https://img.lengxiqwq.com/covers/{index}.webp?total=20
	if (apiUrl.includes("{index}")) {
		try {
			const parsed = new URL(
				apiUrl.startsWith("http") ? apiUrl : `https://${apiUrl}`,
			);
			const total = Number.parseInt(
				parsed.searchParams.get("total") || "20",
				10,
			);
			const index = (hash % Math.max(1, total)) + 1;
			parsed.searchParams.delete("total");
			return decodeURIComponent(parsed.toString()).replace(
				"{index}",
				String(index),
			);
		} catch {
			return apiUrl.replace("{index}", String((hash % 20) + 1));
		}
	}

	// 2. 支持自建 Cloudflare 图床 covers 路径: 如 https://img.lengxiqwq.com/covers 或 https://img.lengxiqwq.com/covers?total=20
	if (apiUrl.includes("img.lengxiqwq.com/covers")) {
		try {
			const parsed = new URL(
				apiUrl.startsWith("http") ? apiUrl : `https://${apiUrl}`,
			);
			const total = Number.parseInt(
				parsed.searchParams.get("total") || "20",
				10,
			);
			const index = (hash % Math.max(1, total)) + 1;
			const cleanBase = apiUrl.split("?")[0].replace(/\/+$/, "");
			return `${cleanBase}/${index}.webp`;
		} catch {
			const index = (hash % 20) + 1;
			return `https://img.lengxiqwq.com/covers/${index}.webp`;
		}
	}

	// 3. 兼容原有第三方接口
	if (apiUrl.includes("t.alcy.cc/pc")) {
		const index = 350 + (hash % 201);
		return `https://t.alcy.cc/pic/pc/${index}.webp`;
	}
	if (apiUrl.includes("t.alcy.cc/moe")) {
		const index = (hash % 107) + 1;
		return `https://t.alcy.cc/pic/moe/${index}.webp`;
	}
	return appendSeedParam(apiUrl, hash);
}

/**
 * 处理文章封面图
 * 优先级：
 * 1. image === "none" -> 不显示封面
 * 2. image 指定了分类随机（如 "api:二次元美少女" 或 "二次元美少女"）-> 从该分类中根据文章 hash 固定分配一张
 * 3. image 指定了具体图片直链或本地路径 -> 直接使用该图
 * 4. 全局全库随机（image 为空或 "api"）-> 优先从自建图库全量列表（61张）中根据文章 hash 固定分配一张
 * 5. 兜底回退到第三方 API
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

	const hash = getSeedHash(seed);

	// 1. 检查是否请求了特定分类随机
	const requestedCategory = getRequestedCategory(image);
	if (requestedCategory && coversManifest?.categories) {
		const categoryList = coversManifest.categories[requestedCategory];
		if (categoryList && categoryList.length > 0) {
			return categoryList[hash % categoryList.length];
		}
	}

	// 2. 如果指定了具体图片（非随机指令），直接使用
	if (image && image !== "api") {
		return image;
	}

	// 3. 全局全库随机：优先使用自建 Cloudflare 图库
	if (coversManifest?.all && coversManifest.all.length > 0) {
		return coversManifest.all[hash % coversManifest.all.length];
	}

	if (
		!isRandomCoverImage(image) ||
		!randomCoverImage.apis ||
		randomCoverImage.apis.length === 0
	) {
		return "";
	}

	// 始终使用首选API对应的确定性直链，失败时由客户端按顺序尝试后续API
	return resolveDeterministicApiUrl(randomCoverImage.apis[0], hash);
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
	if (image === "none") {
		return [];
	}

	const hash = getSeedHash(seed);
	const requestedCategory = getRequestedCategory(image);

	// 若请求分类随机，备选为该分类其他图
	if (requestedCategory && coversManifest?.categories) {
		const list = coversManifest.categories[requestedCategory];
		if (list && list.length > 0) {
			const p1 = list[hash % list.length];
			const p2 = list[(hash + 1) % list.length];
			return [p1, p2].filter(Boolean);
		}
	}

	if (image && image !== "api") {
		return [image];
	}

	// 全量自建图库备选列表
	if (coversManifest?.all && coversManifest.all.length > 0) {
		const p1 = coversManifest.all[hash % coversManifest.all.length];
		const p2 = coversManifest.all[(hash + 1) % coversManifest.all.length];
		return [p1, p2].filter(Boolean);
	}

	if (
		!isRandomCoverImage(image) ||
		!randomCoverImage.enable ||
		!randomCoverImage.apis
	) {
		return [];
	}

	return randomCoverImage.apis.map((api, index) => {
		if (index === 0) {
			return resolveDeterministicApiUrl(api, hash);
		}
		return appendSeedParam(api, hash);
	});
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
