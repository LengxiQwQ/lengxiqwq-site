import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import type {
	AppEnv,
	Bindings,
	FcirclePost,
	FcircleStats,
	FeedSource,
} from "../types";

const fcircle = new Hono<AppEnv>();

/**
 * 朋友圈黑名单/排除域名列表（如发布未来穿越文章恶意置顶的站点）
 */
const FCIRCLE_BLOCKED_DOMAINS = ["benlao.top"];

/**
 * 默认预设订阅与友链源（在 KV 未配置定制源时作为基准抓取列表）
 */
export const DEFAULT_FEED_SOURCES: FeedSource[] = [
	{
		name: "夏夜流萤",
		siteUrl: "https://blog.cuteleaf.cn",
		feedUrl: "https://blog.cuteleaf.cn/rss.xml",
		avatar:
			"https://weavatar.com/avatar/d252655d40d6874417a720bad0a6c5f77f8f6a1fd2f882f8f338402dc37e4190?s=640",
		sourceType: "friend",
	},
	{
		name: "阮一峰的网络日志",
		siteUrl: "https://www.ruanyifeng.com/blog/",
		feedUrl: "https://www.ruanyifeng.com/blog/atom.xml",
		avatar: "https://www.ruanyifeng.com/favicon.ico",
		sourceType: "subscription",
	},
	{
		name: "冷夕",
		siteUrl: "https://lengxiqwq.com",
		feedUrl: "https://lengxiqwq.com/atom.xml",
		avatar: "https://img.lengxiqwq.com/avatar.webp",
		sourceType: "self",
	},
];

/**
 * KV 存储中暂无数据时的模拟初始数据生成器（动态获取当前时间戳）
 */
export function getMockFcirclePosts(): FcirclePost[] {
	const now = Date.now();
	return [
		{
			id: "fc_mock_1",
			friendName: "夏夜流萤",
			friendAvatar:
				"https://weavatar.com/avatar/d252655d40d6874417a720bad0a6c5f77f8f6a1fd2f882f8f338402dc37e4190?s=640",
			friendUrl: "https://blog.cuteleaf.cn",
			title: "欢迎来到夏夜流萤的博客世界",
			link: "https://blog.cuteleaf.cn",
			pubDate: new Date(now - 3600 * 1000 * 2).toISOString(),
			excerpt:
				"飞萤之火自无梦的长夜亮起，绽放在终竟的明天。记录生活与技术的点点滴滴。",
			sourceType: "friend",
		},
		{
			id: "fc_mock_2",
			friendName: "阮一峰",
			friendAvatar: "https://www.ruanyifeng.com/favicon.ico",
			friendUrl: "https://www.ruanyifeng.com/blog/",
			title: "科技爱好者周刊：技术前沿与开源项目精选",
			link: "https://www.ruanyifeng.com/blog/2026/weekly.html",
			pubDate: new Date(now - 3600 * 1000 * 8).toISOString(),
			excerpt: "记录每周值得分享的科技内容、开源项目和个人随笔思考。",
			sourceType: "subscription",
		},
		{
			id: "fc_mock_3",
			friendName: "冷夕",
			friendAvatar: "https://img.lengxiqwq.com/avatar.webp",
			friendUrl: "https://lengxiqwq.com",
			title: "博客系统云原生架构升级与解耦实录",
			link: "https://lengxiqwq.com/posts/cloud-native-migration",
			pubDate: new Date(now - 3600 * 1000 * 24).toISOString(),
			excerpt:
				"将传统静态博客与 Cloudflare Workers 微服务、D1、KV、R2 深度结合，打造极速体验。",
			sourceType: "self",
		},
	];
}

export function getMockFcircleStats(): FcircleStats {
	const now = Date.now();
	return {
		friendCount: 32,
		activeCount: 18,
		todayCount: 2,
		updatedAt: now - 3600 * 1000 * 2,
		totalFriends: 32,
		activeFriends: 18,
		todayUpdates: 2,
		lastUpdated: now - 3600 * 1000 * 2,
	};
}

// ==================== 轻量 RSS / Atom / JSON Feed 解析引擎 ====================

function decodeHtmlEntities(str: string): string {
	return str
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, dec) => {
			const num = Number(dec);
			return Number.isFinite(num) ? String.fromCharCode(num) : "";
		})
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
			const num = Number.parseInt(hex, 16);
			return Number.isFinite(num) ? String.fromCharCode(num) : "";
		});
}

function stripHtml(html: string): string {
	return decodeHtmlEntities(
		html
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim(),
	);
}

function extractTagContent(xml: string, tag: string): string | null {
	const cdataRegex = new RegExp(
		`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`,
		"i",
	);
	const cdataMatch = xml.match(cdataRegex);
	if (cdataMatch?.[1]) {
		return cdataMatch[1].trim();
	}

	const tagRegex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
	const match = xml.match(tagRegex);
	if (match?.[1]) {
		return decodeHtmlEntities(match[1].trim());
	}
	return null;
}

function extractAtomLink(xml: string): string | null {
	const altMatch =
		xml.match(
			/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["'][^>]*\/?>/i,
		) ||
		xml.match(
			/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']alternate["'][^>]*\/?>/i,
		);
	if (altMatch?.[1]) {
		return altMatch[1].trim();
	}

	const hrefMatch = xml.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i);
	if (hrefMatch?.[1]) {
		return hrefMatch[1].trim();
	}

	return extractTagContent(xml, "link");
}

function generatePostId(link: string): string {
	let hash = 0;
	for (let i = 0; i < link.length; i++) {
		hash = ((hash << 5) - hash + link.charCodeAt(i)) | 0;
	}
	return `fc_${Math.abs(hash).toString(36)}`;
}

function isBlockedUrl(url?: string): boolean {
	if (!url) return false;
	const lower = url.toLowerCase();
	return FCIRCLE_BLOCKED_DOMAINS.some((domain) => lower.includes(domain));
}

function isSafeUrl(url?: string): boolean {
	if (!url || isBlockedUrl(url)) return false;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return false;
		}
		const host = parsed.hostname.toLowerCase();
		if (
			host === "localhost" ||
			host.endsWith(".localhost") ||
			host === "127.0.0.1" ||
			host === "0.0.0.0" ||
			host === "::1"
		) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

interface ParsedEntry {
	title: string;
	link: string;
	pubDate: Date;
	excerpt?: string;
}

function parseFeedXml(rawText: string): ParsedEntry[] {
	const trimmed = rawText.trim();
	if (!trimmed) return [];

	// 1. JSON Feed 尝试
	if (trimmed.startsWith("{")) {
		try {
			const json = JSON.parse(trimmed);
			if (Array.isArray(json.items)) {
				const entries: ParsedEntry[] = [];
				for (const item of json.items) {
					const link = item.url || item.id;
					const dateStr = item.date_published || item.date_modified;
					if (item.title && link && dateStr && isSafeUrl(link)) {
						const date = new Date(dateStr);
						if (!Number.isNaN(date.getTime())) {
							entries.push({
								title: String(item.title).trim(),
								link: String(link).trim(),
								pubDate: date,
								excerpt: item.summary
									? stripHtml(String(item.summary)).slice(0, 150)
									: undefined,
							});
						}
					}
				}
				if (entries.length > 0) return entries;
			}
		} catch {
			// 非 JSON，回退至 XML 解析
		}
	}

	// 2. XML (RSS 2.0 / Atom) 正则提取
	const entries: ParsedEntry[] = [];

	// 匹配 RSS <item> 节点
	const itemMatches = trimmed.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
	for (const itemXml of itemMatches) {
		const title = extractTagContent(itemXml, "title");
		const link = extractTagContent(itemXml, "link");
		const dateStr =
			extractTagContent(itemXml, "pubDate") ||
			extractTagContent(itemXml, "dc:date") ||
			extractTagContent(itemXml, "date");
		const desc =
			extractTagContent(itemXml, "description") ||
			extractTagContent(itemXml, "content:encoded");

		if (title && link && dateStr && isSafeUrl(link)) {
			const date = new Date(dateStr);
			if (!Number.isNaN(date.getTime())) {
				entries.push({
					title: stripHtml(title),
					link: link.trim(),
					pubDate: date,
					excerpt: desc ? stripHtml(desc).slice(0, 150) : undefined,
				});
			}
		}
	}

	// 若无 RSS item，尝试 Atom <entry> 节点
	if (entries.length === 0) {
		const entryMatches = trimmed.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
		for (const entryXml of entryMatches) {
			const title = extractTagContent(entryXml, "title");
			const link = extractAtomLink(entryXml);
			const dateStr =
				extractTagContent(entryXml, "updated") ||
				extractTagContent(entryXml, "published") ||
				extractTagContent(entryXml, "dc:date");
			const desc =
				extractTagContent(entryXml, "summary") ||
				extractTagContent(entryXml, "content");

			if (title && link && dateStr && isSafeUrl(link)) {
				const date = new Date(dateStr);
				if (!Number.isNaN(date.getTime())) {
					entries.push({
						title: stripHtml(title),
						link: link.trim(),
						pubDate: date,
						excerpt: desc ? stripHtml(desc).slice(0, 150) : undefined,
					});
				}
			}
		}
	}

	return entries;
}

/**
 * 抓取单个 Feed 并解析其内容（5s 超时）
 */
async function fetchSourceFeed(source: FeedSource): Promise<FcirclePost[]> {
	if (!isSafeUrl(source.feedUrl)) return [];

	try {
		const res = await fetch(source.feedUrl, {
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 (lengxiqwq-fcircle-bot)",
				Accept:
					"application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, */*",
			},
			signal: AbortSignal.timeout(5000),
		});

		if (!res.ok) return [];
		const rawText = await res.text();
		const parsed = parseFeedXml(rawText);

		return parsed.map((entry) => ({
			id: generatePostId(entry.link),
			friendName: source.name,
			friendAvatar: source.avatar,
			friendUrl: source.siteUrl,
			title: entry.title,
			link: entry.link,
			pubDate: entry.pubDate.toISOString(),
			excerpt: entry.excerpt,
			sourceType: source.sourceType || "friend",
		}));
	} catch {
		return [];
	}
}

/**
 * 全量同步朋友圈数据引擎（供 Cron 定时任务与手动 POST /api/fcircle/sync 复用）
 */
export async function syncFcircle(
	env: Bindings,
	customSources?: FeedSource[],
): Promise<{
	posts: FcirclePost[];
	stats: FcircleStats;
	updatedAt: number;
}> {
	let sources = customSources;
	if (!sources || sources.length === 0) {
		try {
			const kvSources = await env.KV.get<FeedSource[]>(
				"fcircle:sources",
				"json",
			);
			if (kvSources && Array.isArray(kvSources) && kvSources.length > 0) {
				sources = kvSources;
			}
		} catch {}
	}
	if (!sources || sources.length === 0) {
		sources = DEFAULT_FEED_SOURCES;
	}

	// 5 路并发池抓取各源
	const allPosts: FcirclePost[] = [];
	const chunkSize = 5;
	for (let i = 0; i < sources.length; i += chunkSize) {
		const chunk = sources.slice(i, i + chunkSize);
		const chunkResults = await Promise.all(
			chunk.map((s) => fetchSourceFeed(s)),
		);
		for (const posts of chunkResults) {
			allPosts.push(...posts);
		}
	}

	// 排序与清洗：过滤黑名单、未来穿越文章（允许 10 分钟时钟误差）
	const MAX_FUTURE_BUFFER_MS = 10 * 60 * 1000;
	const now = Date.now();
	const validPosts = allPosts.filter((post) => {
		if (isBlockedUrl(post.link) || isBlockedUrl(post.friendUrl)) return false;
		const time = new Date(post.pubDate).getTime();
		if (Number.isNaN(time)) return false;
		if (time > now + MAX_FUTURE_BUFFER_MS) return false;
		return true;
	});

	// 按时间倒序排序
	validPosts.sort(
		(a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime(),
	);

	// 去重（按规范化链接）
	const seen = new Set<string>();
	const uniquePosts: FcirclePost[] = [];
	for (const post of validPosts) {
		const norm = post.link.trim().toLowerCase().replace(/\/+$/, "");
		if (!seen.has(norm)) {
			seen.add(norm);
			uniquePosts.push(post);
		}
	}

	// 保留最新 150 篇
	const finalPosts = uniquePosts.slice(0, 150);

	// 统计指标
	const ONE_DAY_MS = 24 * 60 * 60 * 1000;
	const activeSites = new Set<string>();
	let todayCount = 0;

	for (const post of finalPosts) {
		const postTime = new Date(post.pubDate).getTime();
		if (now - postTime < ONE_DAY_MS) {
			todayCount++;
		}
		if (now - postTime < 30 * ONE_DAY_MS) {
			activeSites.add(post.friendUrl || post.friendName);
		}
	}

	const stats: FcircleStats = {
		friendCount: sources.length,
		activeCount: activeSites.size,
		todayCount,
		updatedAt: now,
		totalFriends: sources.length,
		activeFriends: activeSites.size,
		todayUpdates: todayCount,
		lastUpdated: now,
	};

	// 存入 KV
	try {
		await env.KV.put("fcircle:posts", JSON.stringify(finalPosts));
		await env.KV.put("fcircle:stats", JSON.stringify(stats));
		await env.KV.put("fcircle:updated_at", String(now));
	} catch (err) {
		console.warn("[Fcircle Sync] KV save error:", err);
	}

	return {
		posts: finalPosts,
		stats,
		updatedAt: now,
	};
}

// ==================== REST 路由接口 ====================

/**
 * GET /api/fcircle/posts?page=1&limit=20
 * 分页读取朋友圈文章
 */
fcircle.get("/posts", async (c) => {
	const page = Math.max(
		1,
		Number.parseInt(c.req.query("page") || "1", 10) || 1,
	);
	const limit = Math.min(
		100,
		Math.max(1, Number.parseInt(c.req.query("limit") || "20", 10) || 20),
	);

	let posts: FcirclePost[] | null = null;
	try {
		posts = await c.env.KV.get<FcirclePost[]>("fcircle:posts", "json");
	} catch (err) {
		console.warn("[Fcircle API] KV get posts error:", err);
	}

	if (!posts || !Array.isArray(posts) || posts.length === 0) {
		posts = getMockFcirclePosts();
	}

	const total = posts.length;
	const startIndex = (page - 1) * limit;
	const items = posts.slice(startIndex, startIndex + limit);
	const totalPages = Math.ceil(total / limit) || 1;
	const hasMore = page < totalPages;

	return c.json({
		code: 200,
		data: {
			items,
			total,
			page,
			limit,
			totalPages,
			hasMore,
		},
	});
});

/**
 * GET /api/fcircle/stats
 * 读取朋友圈概览统计
 */
fcircle.get("/stats", async (c) => {
	let stats: FcircleStats | null = null;
	try {
		stats = await c.env.KV.get<FcircleStats>("fcircle:stats", "json");
	} catch (err) {
		console.warn("[Fcircle API] KV get stats error:", err);
	}

	if (!stats) {
		stats = getMockFcircleStats();
	}

	return c.json({
		code: 200,
		data: stats,
	});
});

/**
 * POST /api/fcircle/sync
 * 受保护接口（authMiddleware）：手动一键触发全网抓取并更新 KV
 */
fcircle.post("/sync", authMiddleware, async (c) => {
	let customSources: FeedSource[] | undefined;
	try {
		const body = await c.req.json();
		if (Array.isArray(body?.sources)) {
			customSources = body.sources;
			// 若传入了定制源列表，顺带持久化保存到 KV
			await c.env.KV.put("fcircle:sources", JSON.stringify(customSources));
		}
	} catch {}

	try {
		const result = await syncFcircle(c.env, customSources);
		return c.json({
			code: 200,
			message: "Fcircle sync completed successfully",
			data: {
				total: result.posts.length,
				stats: result.stats,
				updatedAt: result.updatedAt,
			},
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json(
			{
				code: 500,
				error: `Fcircle sync failed: ${message}`,
			},
			500,
		);
	}
});

export default fcircle;
