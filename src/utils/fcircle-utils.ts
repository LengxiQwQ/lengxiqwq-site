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
		timeout: 10000,
		customFields: {
			item: ["pubDate", "date", "updated"],
		},
	});
	const friends = getEnabledFriends();
	const items: FcircleItem[] = [];

	const promises = friends.map(async (friend) => {
		if (!friend.feedUrl) return;
		try {
			const feed = await parser.parseURL(friend.feedUrl);
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
		} catch (e) {
			console.warn(`[Fcircle] Failed to fetch RSS for ${friend.title} (${friend.feedUrl}):`, e);
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
