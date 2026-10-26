import type { CommentConfig } from "@/types/commentConfig";
import { fetchWithDedup } from "@/utils/fetch-dedup";

export interface RecentCommentEntry {
	id: string; // 评论唯一标识（用于锚点定位 #${id}）
	nick: string; // 评论者昵称
	avatar: string; // 头像链接
	content: string; // 经过提取过滤的纯文本摘要
	time: number; // 毫秒级时间戳
	url: string; // 评论所在页面相对路径（如 /posts/xxx、/guestbook）
	link?: string; // 评论者个人网站链接（可选）
	isAdmin?: boolean; // 是否博主/管理员
}

interface WalineCommentItem {
	objectId?: number | string;
	id?: number | string;
	nick?: string;
	avatar?: string;
	orig?: string;
	comment?: string;
	time?: number;
	createdAt?: string;
	url?: string;
	link?: string;
	type?: string;
	user_id?: number | null;
	label?: string;
}

interface TwikooCommentItem {
	id?: string;
	nick?: string;
	avatar?: string;
	comment?: string;
	created?: number;
	url?: string;
	link?: string;
	isMaster?: boolean;
}

interface ArtalkCommentItem {
	id?: number | string;
	nick?: string;
	avatar?: string;
	content_marked?: string;
	content?: string;
	date?: string;
	page_key?: string;
	link?: string;
	badge_type?: string;
}

/**
 * 清洗评论内容：过滤 Markdown 语法、HTML 标签、图片、表情包，转化为适合侧边栏预览的纯文本
 */
export function cleanCommentContent(raw: string): string {
	if (!raw) return "";
	let text = raw;

	// 1. 将 markdown 图片 ![alt](url) 替换为 [图片]
	text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "[图片]");

	// 2. 将 HTML img 表情提取为表情名或 [图片]
	text = text.replace(
		/<img[^>]*class="[^"]*wl-emoji[^"]*"[^>]*alt="([^"]*)"[^>]*>/gi,
		"[$1]",
	);
	text = text.replace(
		/<img[^>]*alt="([^"]*)"[^>]*class="[^"]*wl-emoji[^"]*"[^>]*>/gi,
		"[$1]",
	);
	text = text.replace(/<img[^>]*>/gi, "[图片]");

	// 3. 将 markdown 链接 [text](url) 替换为 text
	text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

	// 4. 将代码块转化为 [代码]
	text = text.replace(/```[\s\S]*?```/g, "[代码]");
	text = text.replace(/`([^`]+)`/g, "$1");

	// 5. 去除其他 HTML 标签
	text = text.replace(/<[^>]+>/g, " ");

	// 6. 处理常见 HTML 转义字符
	text = text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");

	// 7. 合并多余换行与空白
	text = text.replace(/\s+/g, " ").trim();

	return text;
}

/**
 * 聚合拉取全站最新的评论列表
 * 默认排除站长/博主本人的评论，只展示访客留言
 */
export async function fetchRecentComments(
	config: CommentConfig,
	limit = 5,
	authorName?: string,
	excludeAdmin = true,
): Promise<RecentCommentEntry[]> {
	if (!config?.type || config.type === "none") {
		return [];
	}

	// 1. Waline 评论系统适配
	if (config.type === "waline" && config.waline?.serverURL) {
		const serverURL = config.waline.serverURL.replace(/\/+$/, "");
		// 若排除站长评论，拉取更大批次以防过滤后条数不足
		const fetchCount = excludeAdmin ? Math.max(limit * 4, 20) : limit;
		const apiUrl = `${serverURL}/api/comment?type=recent&count=${fetchCount}`;
		const res = await fetchWithDedup<{
			errno?: number;
			data?: WalineCommentItem[];
		}>(apiUrl);

		if (!res || !Array.isArray(res.data)) {
			return [];
		}

		const mapped = res.data.map((item) => {
			const rawContent = item.orig || item.comment || "";
			const isAdmin =
				item.type === "administrator" ||
				item.user_id === 1 ||
				item.label === "站长" ||
				(Boolean(authorName) && item.nick?.trim() === authorName?.trim());

			return {
				id: String(item.objectId ?? item.id ?? ""),
				nick: item.nick || "匿名访客",
				avatar: item.avatar || "",
				content: cleanCommentContent(rawContent),
				time: Number(
					item.time ||
						(item.createdAt ? new Date(item.createdAt).getTime() : Date.now()),
				),
				url: item.url || "/",
				link: item.link || undefined,
				isAdmin,
			};
		});

		const filtered = excludeAdmin
			? mapped.filter((item) => !item.isAdmin)
			: mapped;

		return filtered.slice(0, limit);
	}

	// 2. Twikoo 评论系统适配
	if (config.type === "twikoo" && config.twikoo?.envId) {
		try {
			const fetchCount = excludeAdmin ? Math.max(limit * 3, 15) : limit;
			const res = await fetch(config.twikoo.envId, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					event: "GET_RECENT_COMMENTS",
					includeReply: true,
					pageSize: fetchCount,
				}),
			}).then((r) => r.json());

			if (Array.isArray(res?.data)) {
				const mapped = (res.data as TwikooCommentItem[]).map((item) => {
					const isAdmin =
						Boolean(item.isMaster) ||
						(Boolean(authorName) && item.nick?.trim() === authorName?.trim());
					return {
						id: String(item.id || ""),
						nick: item.nick || "匿名访客",
						avatar: item.avatar || "",
						content: cleanCommentContent(item.comment || ""),
						time: Number(item.created || Date.now()),
						url: item.url || "/",
						link: item.link || undefined,
						isAdmin,
					};
				});

				const filtered = excludeAdmin
					? mapped.filter((item) => !item.isAdmin)
					: mapped;

				return filtered.slice(0, limit);
			}
		} catch (e) {
			console.warn("[Twikoo] Failed to fetch recent comments:", e);
		}
	}

	// 3. Artalk 评论系统适配
	if (config.type === "artalk" && config.artalk?.server) {
		try {
			const server = config.artalk.server.replace(/\/+$/, "");
			const fetchCount = excludeAdmin ? Math.max(limit * 3, 15) : limit;
			const apiUrl = `${server}/api/v2/comments?limit=${fetchCount}`;
			const res = await fetchWithDedup<{ data?: ArtalkCommentItem[] }>(apiUrl);

			if (Array.isArray(res?.data)) {
				const mapped = res.data.map((item) => {
					const isAdmin =
						item.badge_type === "admin" ||
						(Boolean(authorName) && item.nick?.trim() === authorName?.trim());
					return {
						id: String(item.id || ""),
						nick: item.nick || "匿名访客",
						avatar: item.avatar || "",
						content: cleanCommentContent(
							item.content_marked || item.content || "",
						),
						time: item.date ? new Date(item.date).getTime() : Date.now(),
						url: item.page_key || "/",
						link: item.link || undefined,
						isAdmin,
					};
				});

				const filtered = excludeAdmin
					? mapped.filter((item) => !item.isAdmin)
					: mapped;

				return filtered.slice(0, limit);
			}
		} catch (e) {
			console.warn("[Artalk] Failed to fetch recent comments:", e);
		}
	}

	return [];
}
