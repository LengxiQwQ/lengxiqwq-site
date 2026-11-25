import type { APIRoute } from "astro";
import { friendsConfig, getHealthyFriends } from "@/config/friendsConfig";

export const prerender = true;

/**
 * GET /api/friends.json
 * 返回健康且已启用的友链公开信息，严格按配置文件添加顺序（时间顺序）排序，供聊天室分享面板选取。
 * 绝不输出 email 等私密或巡检字段。
 */
export const GET: APIRoute = async () => {
	const configOrderMap = new Map(
		(friendsConfig || []).map((item, idx) => [item.siteurl, idx]),
	);

	const healthy = getHealthyFriends()
		.slice()
		.sort((a, b) => {
			const pinnedA = Boolean(a.pinned || a.weight >= 99);
			const pinnedB = Boolean(b.pinned || b.weight >= 99);
			if (pinnedA !== pinnedB) return pinnedA ? -1 : 1;
			const orderA = configOrderMap.get(a.siteurl) ?? Number.MAX_SAFE_INTEGER;
			const orderB = configOrderMap.get(b.siteurl) ?? Number.MAX_SAFE_INTEGER;
			return orderA - orderB;
		});

	const data = healthy.map((friend, idx) => ({
		id: friend.siteurl || `friend-${idx}`,
		title: friend.title || "",
		desc: friend.desc || "",
		siteurl: friend.siteurl || "",
		imgurl: friend.imgurl || "",
		tags: Array.isArray(friend.tags) ? friend.tags : [],
		pinned: Boolean(friend.pinned || friend.weight >= 99),
		order: configOrderMap.get(friend.siteurl) ?? idx,
	}));

	return new Response(JSON.stringify(data), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
};
