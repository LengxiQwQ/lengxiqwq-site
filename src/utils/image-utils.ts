import fs from "node:fs";
import path from "node:path";
import { coverImageConfig } from "../config/coverImageConfig";
import { siteConfig } from "../config/siteConfig";
import coversManifestData from "../constants/covers-manifest.json";
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
 * 规范化字符串键名，用于跨格式（Astro ID、文件名、标题、Slug）精确匹配文章
 */
function normalizeKey(str: string): string {
	return String(str || "")
		.toLowerCase()
		.replace(/\.(md|mdx|markdown)$/i, "")
		.replace(/[^a-z0-9\u4e00-\u9fa5]/gu, "");
}

/**
 * 基于 Mulberry32 的确定性伪随机数发生器
 */
function mulberry32(initialSeed: number) {
	let state = initialSeed;
	return () => {
		state += 0x6d2b79f5;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * 带种子的 Fisher-Yates 确定性数组洗牌
 */
function seededShuffle<T>(array: T[], seedNum: number): T[] {
	const copy = [...array];
	const rng = mulberry32(seedNum);
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const temp = copy[i];
		copy[i] = copy[j];
		copy[j] = temp;
	}
	return copy;
}

interface PostMetaSummary {
	rawId: string;
	title: string;
	published: number;
	image?: string;
}

let cachedAllocationMap: Map<string, string> | null = null;

/**
 * 扫描文章目录，获取所有文章元信息（用于全局防碰撞唯一随机图分配）
 */
function scanAllPostsSummary(): PostMetaSummary[] {
	const postsDirCandidates = [
		path.resolve(process.cwd(), "src/content/posts"),
		path.resolve(process.cwd(), "../lengxiqwq-site-content/content/posts"),
		path.resolve(process.cwd(), "content/posts"),
	];

	let postsDir = "";
	for (const candidate of postsDirCandidates) {
		if (fs.existsSync(candidate)) {
			postsDir = candidate;
			break;
		}
	}
	if (!postsDir) return [];

	const results: PostMetaSummary[] = [];
	try {
		const entries = fs.readdirSync(postsDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith(".md") && !entry.name.endsWith(".mdx")) continue;
			const fullPath = path.join(postsDir, entry.name);
			const rawContent = fs.readFileSync(fullPath, "utf8");
			const rawId = entry.name.replace(/\.(md|mdx)$/, "");

			// 提取 frontmatter
			const titleMatch = rawContent.match(/^title:\s*"?(.*?)"?$/m);
			const title = titleMatch ? titleMatch[1].trim() : rawId;

			const pubMatch = rawContent.match(/^published:\s*"?(.*?)"?$/m);
			const published = pubMatch ? new Date(pubMatch[1].trim()).getTime() : 0;

			const imgMatch = rawContent.match(/^image:\s*"?(.*?)"?$/m);
			const image = imgMatch ? imgMatch[1].trim() : undefined;

			results.push({ rawId, title, published, image });
		}
	} catch {
		return [];
	}

	return results;
}

/**
 * 全局防碰撞分配器：
 * 将全站所有文章按发布日期确定性排序，依次从已洗牌的随机图库中分配独占图片。
 * 彻底杜绝多篇文章“撞图”、重复使用同一张随机封面的问题。
 */
function buildUniqueAllocationMap(): Map<string, string> {
	const map = new Map<string, string>();
	const allManifestCovers = coversManifest?.all || [];
	if (allManifestCovers.length === 0) return map;

	const posts = scanAllPostsSummary();
	if (posts.length === 0) return map;

	// 按发布日期升序排序，日期相同按文件名排序。
	// 这样新发布的文章永远排在队列末尾，老文章的封面永远保持稳定不漂移！
	posts.sort((a, b) => {
		if (a.published !== b.published) return a.published - b.published;
		return a.rawId.localeCompare(b.rawId);
	});

	// 找出所有显式使用的自定义封面，避免随机图与之撞车
	const claimed = new Set<string>();
	for (const p of posts) {
		if (
			p.image &&
			p.image !== "api" &&
			p.image !== "none" &&
			!p.image.startsWith("api:") &&
			!p.image.startsWith("category:")
		) {
			claimed.add(p.image);
		}
	}

	const versionNum = Number(randomCoverImage.version ?? 1) || 1;
	// 采用带版本种子的洗牌算法，改动 version 即可统一整体换一批全新随机图
	const shuffledCovers = seededShuffle(allManifestCovers, versionNum * 9973);
	const availableCovers = shuffledCovers.filter((c) => !claimed.has(c));
	const fallbackPool =
		availableCovers.length > 0 ? availableCovers : shuffledCovers;

	// 分类随机池
	const categoryShuffled: Record<string, string[]> = {};
	if (coversManifest?.categories) {
		for (const [catName, catList] of Object.entries(
			coversManifest.categories,
		)) {
			categoryShuffled[catName] = seededShuffle(
				catList,
				(versionNum + 7) * 9973,
			);
		}
	}
	const categoryCounters: Record<string, number> = {};

	let globalIndex = 0;
	for (const p of posts) {
		let assignedCover = "";
		if (p.image === "none") {
			assignedCover = "";
		} else if (
			p.image &&
			p.image !== "api" &&
			!p.image.startsWith("api:") &&
			!p.image.startsWith("category:")
		) {
			assignedCover = p.image;
		} else {
			const cat = getRequestedCategory(p.image);
			if (cat && categoryShuffled[cat]?.length > 0) {
				const counter = categoryCounters[cat] ?? 0;
				const pool = categoryShuffled[cat];
				assignedCover = pool[counter % pool.length];
				categoryCounters[cat] = counter + 1;
			} else {
				assignedCover = fallbackPool[globalIndex % fallbackPool.length];
				globalIndex++;
			}
		}

		if (assignedCover) {
			map.set(normalizeKey(p.rawId), assignedCover);
			map.set(normalizeKey(p.title), assignedCover);
		}
	}

	return map;
}

/**
 * 从全局唯一分配表中获取文章的独占封面图
 */
function getUniqueAllocatedCover(seed?: string): string | null {
	if (!seed) return null;
	if (!cachedAllocationMap) {
		cachedAllocationMap = buildUniqueAllocationMap();
	}
	return cachedAllocationMap.get(normalizeKey(seed)) || null;
}

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
 */
function resolveDeterministicApiUrl(apiUrl: string, hash: number): string {
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
 * 2. image 指定了具体图片直链或本地路径 -> 直接使用该图
 * 3. 优先使用【全局防碰撞唯一分配器】，从自建图库中为该文章分配独占不重复的封面
 * 4. 兜底回退到哈希计算或第三方 API
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

	// 1. 如果指定了具体图片（非随机指令），直接使用
	if (image && image !== "api" && getRequestedCategory(image) === null) {
		return image;
	}

	// 2. 核心：优先从全局防碰撞分配表中获取零重复封面
	const uniqueAllocated = getUniqueAllocatedCover(seed);
	if (uniqueAllocated) {
		return uniqueAllocated;
	}

	const hash = getSeedHash(seed);

	// 3. 检查是否请求了特定分类随机兜底
	const requestedCategory = getRequestedCategory(image);
	if (requestedCategory && coversManifest?.categories) {
		const categoryList = coversManifest.categories[requestedCategory];
		if (categoryList && categoryList.length > 0) {
			return categoryList[hash % categoryList.length];
		}
	}

	// 4. 全局全库随机兜底
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

	// 5. 始终使用首选API对应的确定性直链，失败时由客户端按顺序尝试后续API
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

	if (image && image !== "api" && getRequestedCategory(image) === null) {
		return [image];
	}

	const primaryUrl = processCoverImageSync(image, seed);
	const hash = getSeedHash(seed);

	// 全量自建图库备选列表：主图为防碰撞独占图，备用为偏移量图
	if (coversManifest?.all && coversManifest.all.length > 0) {
		const fallback = coversManifest.all[(hash + 1) % coversManifest.all.length];
		return [primaryUrl, fallback].filter(Boolean);
	}

	if (
		!isRandomCoverImage(image) ||
		!randomCoverImage.enable ||
		!randomCoverImage.apis
	) {
		return primaryUrl ? [primaryUrl] : [];
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
			const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regexPattern = escaped.replace(/\\\*/g, ".*");
			return new RegExp(`^${regexPattern}$`).test(hostname);
		});
	} catch {
		return false;
	}
}
