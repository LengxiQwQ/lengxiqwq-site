import Parser from "rss-parser";
import { getEnabledFriends } from "../config/friendsConfig";

export interface FcircleItem {
	friendName: string;
	friendAvatar: string;
	friendUrl: string;
	title: string;
	link: string;
	pubDate: Date;
}

export async function getFcircleItems(): Promise<FcircleItem[]> {
	const parser = new Parser({
		timeout: 5000,
		customFields: {
			item: ["pubDate", "date", "updated"],
		},
	});
	const friends = getEnabledFriends();
	const items: FcircleItem[] = [];

	const promises = friends.map(async (friend) => {
		const base = friend.siteurl.replace(/\/+$/, "");
		const urlsToTry = friend.feedUrl
			? [friend.feedUrl]
			: [
					`${base}/atom.xml`,
					`${base}/rss.xml`,
					`${base}/feed/`,
					`${base}/feed.xml`,
				];

		for (const url of urlsToTry) {
			try {
				const feed = await parser.parseURL(url);
				for (const item of feed.items) {
					const dateStr = item.pubDate || item.date || item.updated;
					if (item.title && item.link && dateStr) {
						items.push({
							friendName: friend.title,
							friendAvatar: friend.imgurl,
							friendUrl: friend.siteurl,
							title: item.title,
							link: item.link,
							pubDate: new Date(dateStr),
						});
					}
				}
				// 成功抓取后跳出尝试循环
				return;
			} catch (e) {
				// 如果是用户指定的特定URL失败，或者所有猜测的URL都失败了，才输出警告
				if (url === friend.feedUrl || url === urlsToTry[urlsToTry.length - 1]) {
					console.warn(
						`[Fcircle] Failed to fetch RSS for ${friend.title} (${url})`,
					);
				}
			}
		}
	});

	await Promise.allSettled(promises);

	// Sort by date descending
	items.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

	// Filter out invalid dates
	const validItems = items.filter((item) => !Number.isNaN(item.pubDate.getTime()));

	// Limit to recent 100 to avoid huge pages
	return validItems.slice(0, 100);
}
