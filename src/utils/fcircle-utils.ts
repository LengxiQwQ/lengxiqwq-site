import Parser from "rss-parser";
import { profileConfig, siteConfig } from "../config";
import { getEnabledFriends } from "../config/friendsConfig";
import { getEnabledSubscriptions } from "../config/subscriptionConfig";
import {
	getFcircleDatePresentation,
	getFcircleRelativeDays,
} from "./fcircle-date-utils";

export interface FcircleItem {
	friendName: string;
	friendAvatar: string;
	friendUrl: string;
	title: string;
	link: string;
	pubDate: Date;
	excerpt?: string;
	sourceType?: "self" | "friend" | "subscription";
	tags?: string[];
}

interface FeedEntry {
	title: string;
	link: string;
	pubDate: Date;
	excerpt?: string;
}

const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

/**
 * 朋友圈黑名单/排除域名列表
 * 即使在友链配置中添加了该站点，也绝不抓取或展示其文章（如发布未来穿越文章恶意置顶的站点）
 */
const FCIRCLE_BLOCKED_DOMAINS = ["benlao.top"];

function isFcircleBlockedUrl(url?: string): boolean {
	if (!url) return false;
	const lower = url.toLowerCase();
	return FCIRCLE_BLOCKED_DOMAINS.some((domain) => lower.includes(domain));
}

/**
 * 通用 Feed 解析函数：支持 RSS 2.0 / 1.0、Atom 以及 JSON Feed
 */
async function fetchAndParseFeed(
	url: string,
	parser: Parser,
): Promise<FeedEntry[]> {
	// 1. 优先使用 rss-parser 解析 XML 格式（RSS / Atom）
	try {
		const feed = await parser.parseURL(url);
		const entries: FeedEntry[] = [];
		for (const item of feed.items) {
			const dateStr = item.pubDate || item.date || item.updated;
			if (item.title && item.link && dateStr) {
				const pubDate = new Date(dateStr);
				if (!Number.isNaN(pubDate.getTime())) {
					entries.push({
						title: item.title.trim(),
						link: item.link.trim(),
						pubDate,
						excerpt: item.contentSnippet
							? item.contentSnippet.substring(0, 150)
							: undefined,
					});
				}
			}
		}
		if (entries.length > 0) return entries;
	} catch {
		// rss-parser 失败，继续尝试兜底 JSON Feed 或直接 fetch
	}

	// 2. 兜底尝试 JSON Feed 格式
	try {
		const res = await fetch(url, {
			headers: {
				"User-Agent": BROWSER_UA,
				Accept:
					"application/feed+json, application/json, application/xml, text/xml, */*",
			},
			signal: AbortSignal.timeout(6000),
		});

		if (res.ok) {
			const text = await res.text();
			if (text.trim().startsWith("{")) {
				const json = JSON.parse(text);
				if (Array.isArray(json.items)) {
					const entries: FeedEntry[] = [];
					for (const item of json.items) {
						const link = item.url || item.id;
						const dateStr = item.date_published || item.date_modified;
						if (item.title && link && dateStr) {
							const pubDate = new Date(dateStr);
							if (!Number.isNaN(pubDate.getTime())) {
								entries.push({
									title: item.title.trim(),
									link: link.trim(),
									pubDate,
									excerpt: item.summary
										? String(item.summary).substring(0, 150)
										: undefined,
								});
							}
						}
					}
					return entries;
				}
			}
		}
	} catch {
		// 忽略错误
	}

	return [];
}

export async function getFcircleItems(): Promise<FcircleItem[]> {
	const parser = new Parser({
		timeout: 6000,
		headers: {
			"User-Agent": BROWSER_UA,
			Accept:
				"application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
		},
		customFields: {
			item: ["pubDate", "date", "updated"],
		},
	});

	// 1. 本站自身
	const myAvatar =
		profileConfig.avatarUrl ||
		(profileConfig.avatar?.startsWith("http")
			? profileConfig.avatar
			: `${siteConfig.site_url.replace(/\/$/, "")}${profileConfig.avatar?.startsWith("/") ? "" : "/"}${profileConfig.avatar || "avatar.webp"}`);

	const selfFriend = {
		title: siteConfig.title,
		siteurl: siteConfig.site_url,
		imgurl: myAvatar,
		feedUrl: `${siteConfig.site_url.replace(/\/$/, "")}/rss.xml`,
		tags: ["博客"],
		sourceType: "self" as const,
	};

	// 2. 启用的友链列表（筛选博客分类，并排除禁用朋友圈或处于黑名单的站点）
	const friends = getEnabledFriends()
		.filter(
			(f) =>
				f.fcircle !== false &&
				!isFcircleBlockedUrl(f.siteurl) &&
				!isFcircleBlockedUrl(f.feedUrl),
		)
		.map((f) => ({
			title: f.title,
			siteurl: f.siteurl,
			imgurl: f.imgurl,
			feedUrl: f.feedUrl,
			tags: f.tags,
			sourceType: "friend" as const,
		}));

	// 3. 启用的独立订阅列表（不展示在友链页面，但文章动态聚合到朋友圈）
	const subscriptions = getEnabledSubscriptions()
		.filter(
			(s) => !isFcircleBlockedUrl(s.siteurl) && !isFcircleBlockedUrl(s.feedUrl),
		)
		.map((s) => ({
			title: s.title,
			siteurl: s.siteurl || s.feedUrl,
			imgurl:
				s.imgurl ||
				(s.siteurl
					? `${s.siteurl.replace(/\/$/, "")}/favicon.ico`
					: "/favicon/favicon.ico"),
			feedUrl: s.feedUrl,
			tags: s.tags && s.tags.length > 0 ? s.tags : ["订阅"],
			sourceType: "subscription" as const,
		}));

	const allSources = [selfFriend, ...friends, ...subscriptions];
	const items: FcircleItem[] = [];

	const promises = allSources.map(async (source) => {
		// 再次确保黑名单域名绝对不会发起网络请求
		if (
			isFcircleBlockedUrl(source.siteurl) ||
			isFcircleBlockedUrl(source.feedUrl)
		) {
			return;
		}

		// 若为友链，严格只在“博客”分类中抓取朋友圈动态，排除导航、工具等其他分类
		if (source.sourceType === "friend") {
			const isBlog = source.tags?.some(
				(tag) => tag.includes("博客") || tag.toLowerCase().includes("blog"),
			);
			if (!isBlog) return;
		}

		const cleanFeedUrl = source.feedUrl?.trim();
		const base = source.siteurl.replace(/\/+$/, "");
		const urlsToTry = cleanFeedUrl
			? [cleanFeedUrl]
			: [
					`${base}/atom.xml`,
					`${base}/rss.xml`,
					`${base}/feed/`,
					`${base}/feed.xml`,
				];

		for (const url of urlsToTry) {
			try {
				const entries = await fetchAndParseFeed(url, parser);
				if (entries.length > 0) {
					for (const entry of entries) {
						items.push({
							friendName: source.title,
							friendAvatar: source.imgurl,
							friendUrl: source.siteurl,
							title: entry.title,
							link: entry.link,
							pubDate: entry.pubDate,
							excerpt: entry.excerpt,
							sourceType: source.sourceType,
							tags: source.tags,
						});
					}
					// 成功抓取后跳出尝试循环
					return;
				}
			} catch {
				// 发生异常时继续尝试下一个备选地址
			}

			// 如果是用户指定的特定URL失败，或者所有猜测的URL都失败了，输出警告
			if (url === source.feedUrl || url === urlsToTry[urlsToTry.length - 1]) {
				console.warn(
					`[Fcircle] Failed to fetch feed for ${source.title} (${url})`,
				);
			}
		}
	});

	await Promise.allSettled(promises);

	// 按时间倒序排序
	items.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

	// 过滤无效日期、未来时间（拦截2053年等时空穿越异常文章置顶）以及黑名单链接
	const MAX_FUTURE_BUFFER_MS = 10 * 60 * 1000; // 允许10分钟时钟偏差
	const currentTimestamp = Date.now();
	const validItems = items.filter((item) => {
		const time = item.pubDate.getTime();
		if (Number.isNaN(time)) return false;
		// 拦截发布时间处于未来的文章，防止时间错误或恶意未来时间霸占置顶
		if (time > currentTimestamp + MAX_FUTURE_BUFFER_MS) {
			console.warn(
				`[Fcircle] Filtered out future-dated post: "${item.title}" (${item.link}) dated ${item.pubDate.toISOString()}`,
			);
			return false;
		}
		// 拦截黑名单站点的文章链接与博客地址
		if (isFcircleBlockedUrl(item.link) || isFcircleBlockedUrl(item.friendUrl)) {
			return false;
		}
		return true;
	});

	// 根据文章链接去重，防止相同文章重复显示
	const seenLinks = new Set<string>();
	const uniqueItems: FcircleItem[] = [];
	for (const item of validItems) {
		const normLink = item.link.replace(/\/+$/, "").toLowerCase();
		if (!seenLinks.has(normLink)) {
			seenLinks.add(normLink);
			uniqueItems.push(item);
		}
	}

	// 限制最多 100 篇最新动态
	return uniqueItems.slice(0, 100);
}

export interface FcircleDateGroup {
	dateKey: string;
	displayDate: string;
	subLabel?: string;
	relativeDays: number;
	items: FcircleItem[];
}

export interface FcircleStats {
	todayCount: number;
	weekCount: number;
	totalCount: number;
	siteCount: number;
}

/**
 * 将朋友圈文章按站点时区的自然日聚类为时间线分组。
 * 服务端构建与浏览器端都使用同一套时区算法，避免部署环境的 UTC 时区影响结果。
 */
export function groupFcircleByDate(
	items: FcircleItem[],
	now: Date = new Date(),
	timeZone: string = siteConfig.timezone || "UTC",
): FcircleDateGroup[] {
	const groupsMap = new Map<string, FcircleDateGroup>();

	for (const item of items) {
		const dateInfo = getFcircleDatePresentation(item.pubDate, now, timeZone);

		if (!groupsMap.has(dateInfo.dateKey)) {
			groupsMap.set(dateInfo.dateKey, {
				dateKey: dateInfo.dateKey,
				displayDate: dateInfo.displayDate,
				subLabel: dateInfo.subLabel,
				relativeDays: dateInfo.relativeDays,
				items: [],
			});
		}

		groupsMap.get(dateInfo.dateKey)?.items.push(item);
	}

	return Array.from(groupsMap.values());
}

/**
 * 计算朋友圈动态核心统计指标。
 * “今日”和“近 7 天”均按站点时区的自然日计算，避免 DST 与构建机时区造成偏移。
 */
export function getFcircleStats(
	items: FcircleItem[],
	now: Date = new Date(),
	timeZone: string = siteConfig.timezone || "UTC",
): FcircleStats {
	let todayCount = 0;
	let weekCount = 0;
	const sites = new Set<string>();

	for (const item of items) {
		const relativeDays = getFcircleRelativeDays(item.pubDate, now, timeZone);
		if (relativeDays === 0) {
			todayCount++;
		}
		if (relativeDays >= 0 && relativeDays <= 6) {
			weekCount++;
		}
		sites.add(item.friendUrl || item.friendName);
	}

	return {
		todayCount,
		weekCount,
		totalCount: items.length,
		siteCount: sites.size,
	};
}

export {
	formatFcircleDate,
	formatFcircleTime,
	getFcircleDateKey,
	getFcircleDatePresentation,
	getFcircleRelativeDays,
} from "./fcircle-date-utils";
