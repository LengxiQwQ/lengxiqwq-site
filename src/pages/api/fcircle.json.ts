import type { APIRoute } from "astro";
import { formatDateToYYYYMMDD } from "@/utils/date-utils";
import { getFcircleItems } from "@/utils/fcircle-utils";

export const prerender = true;

interface FcircleApiItem {
	id: string;
	friendName: string;
	friendAvatar: string;
	friendUrl: string;
	title: string;
	link: string;
	pubDate: number;
	publishedDate: string;
	excerpt: string;
	sourceType: "friend" | "subscription";
	tags: string[];
}

const DEV_CACHE_TTL_MS = 5 * 60 * 1000;
let devCachedItems: FcircleApiItem[] | null = null;
let devCachedAt = 0;
let devInflight: Promise<FcircleApiItem[]> | null = null;

async function loadFriendCirclePosts(): Promise<FcircleApiItem[]> {
	if (
		import.meta.env.DEV &&
		devCachedItems &&
		Date.now() - devCachedAt < DEV_CACHE_TTL_MS
	) {
		return devCachedItems;
	}
	if (import.meta.env.DEV && devInflight) {
		return devInflight;
	}

	const task = (async () => {
		const rawItems = await getFcircleItems();
		const mapped: FcircleApiItem[] = rawItems
			.filter((item) => item.sourceType !== "self" && Boolean(item.link))
			.map((item, idx) => {
				const ts = item.pubDate instanceof Date ? item.pubDate.getTime() : 0;
				return {
					id: item.link || `${item.friendUrl}-${item.title}-${idx}`,
					friendName: item.friendName || "友链博主",
					friendAvatar: item.friendAvatar || "",
					friendUrl: item.friendUrl || "",
					title: item.title || "未命名文章",
					link: item.link,
					pubDate: Number.isFinite(ts) ? ts : 0,
					publishedDate:
						item.pubDate instanceof Date &&
						!Number.isNaN(item.pubDate.getTime())
							? formatDateToYYYYMMDD(item.pubDate)
							: "",
					excerpt: item.excerpt || "",
					sourceType: (item.sourceType === "subscription"
						? "subscription"
						: "friend") as "friend" | "subscription",
					tags: Array.isArray(item.tags) ? item.tags : [],
				};
			})
			.sort((a, b) => b.pubDate - a.pubDate);

		if (import.meta.env.DEV) {
			devCachedItems = mapped;
			devCachedAt = Date.now();
		}
		return mapped;
	})().finally(() => {
		if (devInflight === task) devInflight = null;
	});

	if (import.meta.env.DEV) {
		devInflight = task;
	}
	return task;
}

/**
 * GET /api/fcircle.json
 * 返回友链朋友圈聚合文章（排除博主自身文章，保留友链与订阅源最新文章），供聊天室分享面板选取。
 */
export const GET: APIRoute = async () => {
	const data = await loadFriendCirclePosts();
	return new Response(JSON.stringify(data), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
};
