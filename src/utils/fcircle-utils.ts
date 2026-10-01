import Parser from "rss-parser";
import { profileConfig, siteConfig } from "../config";
import { getEnabledFriends } from "../config/friendsConfig";
import { getEnabledSubscriptions } from "../config/subscriptionConfig";

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

	// 2. 启用的友链列表（筛选博客分类）
	const friends = getEnabledFriends().map((f) => ({
		title: f.title,
		siteurl: f.siteurl,
		imgurl: f.imgurl,
		feedUrl: f.feedUrl,
		tags: f.tags,
		sourceType: "friend" as const,
	}));

	// 3. 启用的独立订阅列表（不展示在友链页面，但文章动态聚合到朋友圈）
	const subscriptions = getEnabledSubscriptions().map((s) => ({
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

	// 过滤无效日期
	const validItems = items.filter(
		(item) => !Number.isNaN(item.pubDate.getTime()),
	);

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
