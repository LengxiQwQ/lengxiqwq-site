import fs from "node:fs";
import path from "node:path";
import type { APIRoute } from "astro";
import { friendsConfig } from "@/config/friendsConfig";
import type {
	FriendAuditRecord,
	FriendsAuditData,
} from "@/types/friendsConfig";

export const prerender = false;

function cleanLastMessage(msg?: string): string {
	if (!msg) return "";
	const clean = msg
		.replace(/\s*\((?:https?:\/\/[^\s)]+|\/[^\s)]*)\)\s*$/, "")
		.trim();
	if (clean.includes("成功匹配关键词")) {
		return "已匹配反向链接";
	}
	return clean;
}

/**
 * GET /api/friendsAudit.json
 * 一站式返回全站友链列表、最新健康度/双向巡检数据与指标统计
 * 供管理控制台审查面板、单站重测与实时裁决使用
 */
export const GET: APIRoute = async () => {
	const AUDIT_FILE = path.resolve("src/constants/friends-audit.json");
	let auditData: FriendsAuditData = {};
	if (fs.existsSync(AUDIT_FILE)) {
		try {
			auditData = JSON.parse(fs.readFileSync(AUDIT_FILE, "utf-8"));
		} catch {
			auditData = {};
		}
	}

	// 仅提取真正的友情链接（排除站长自建站点与导航工具类站点）
	const blogFriends = (friendsConfig || []).filter(
		(f) => !f.siteurl.includes("lengxiqwq.com") && !f.tags?.includes("导航"),
	);

	// 组合友链数据与审计状态
	const items = blogFriends.map((friend) => {
		const record: FriendAuditRecord = auditData[friend.siteurl] || {
			missingCount: 0,
			failCount: 0,
			lastChecked: "",
			lastStatus: "found",
			decision: friend.whitelist ? "whitelisted" : "normal",
		};

		const decision =
			record.decision || (friend.whitelist ? "whitelisted" : "normal");
		const isWhitelisted =
			decision === "whitelisted" || Boolean(friend.whitelist);
		const isQuarantined =
			!isWhitelisted &&
			(decision === "quarantined" || (record.failCount || 0) >= 3);
		const isSingle =
			!isWhitelisted &&
			!isQuarantined &&
			(decision === "single" || (record.missingCount || 0) >= 3);
		const isNormal = !isWhitelisted && !isQuarantined && !isSingle;
		const category = isWhitelisted
			? "whitelisted"
			: isQuarantined
				? "quarantined"
				: isSingle
					? "single"
					: "normal";

		return {
			title: friend.title,
			desc: friend.desc || "",
			siteurl: friend.siteurl,
			imgurl: friend.imgurl || "",
			tags: friend.tags || ["博客"],
			whitelist: Boolean(friend.whitelist),
			targetUrl:
				friend.friendPageUrl?.trim() || record.targetUrl || friend.siteurl,
			audit: {
				...record,
				decision,
				cleanMessage: cleanLastMessage(record.lastMessage),
			},
			category,
		};
	});

	const totalCount = items.length;
	const whitelistedCount = items.filter(
		(i) => i.category === "whitelisted",
	).length;
	const quarantinedCount = items.filter(
		(i) => i.category === "quarantined",
	).length;
	const singleCount = items.filter((i) => i.category === "single").length;
	const normalCount = items.filter((i) => i.category === "normal").length;

	const latestCheckedTimestamp = items.reduce((max, item) => {
		const t = item.audit.lastChecked
			? new Date(item.audit.lastChecked).getTime()
			: 0;
		return t > max ? t : max;
	}, 0);

	const latestCheckedText =
		latestCheckedTimestamp > 0
			? new Date(latestCheckedTimestamp).toLocaleString("zh-CN", {
					hour12: false,
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
				})
			: "";

	return new Response(
		JSON.stringify({
			code: 200,
			summary: {
				total: totalCount,
				normal: normalCount,
				single: singleCount,
				quarantined: quarantinedCount,
				whitelisted: whitelistedCount,
				latestCheckedTimestamp,
				latestCheckedText,
			},
			items,
		}),
		{
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "no-store, max-age=0",
			},
		},
	);
};
