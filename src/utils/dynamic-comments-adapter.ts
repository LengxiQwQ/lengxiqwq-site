import { formatRelativeTime } from "@/utils/date-utils";
import { fetchWithDedup } from "@/utils/fetch-dedup";
import { cleanCommentContent } from "@/utils/recent-comments-adapter";

export interface DynamicCommentItem {
	id: string;
	nick: string;
	avatar: string;
	contentHtml: string;
	contentText: string;
	time: number;
	relativeTime: string;
	link?: string;
	isAdmin?: boolean;
}

export interface DynamicCommentsResult {
	totalCount: number;
	comments: DynamicCommentItem[];
}

interface WalineRawChildComment {
	objectId?: number | string;
	id?: number | string;
	nick?: string;
	avatar?: string;
	comment?: string;
	orig?: string;
	time?: number;
	createdAt?: string;
	type?: string;
	user_id?: number | null;
	label?: string;
	link?: string;
}

interface WalineRawComment extends WalineRawChildComment {
	children?: WalineRawChildComment[];
}

/**
 * 评论 HTML 安全清洗：
 * 移除恶意脚本与对象，放行安全的文本样式标签与表情包图片
 */
export function sanitizeCommentHtml(rawHtml: string): string {
	if (!rawHtml) return "";
	let html = rawHtml;

	// 1. 移除危险可执行或嵌入标签
	html = html.replace(
		/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
		"",
	);
	html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
	html = html.replace(
		/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
		"",
	);
	html = html.replace(
		/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi,
		"",
	);
	html = html.replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, "");

	// 2. 移除所有 on* 事件属性（如 onerror, onclick）
	html = html.replace(/\s+on[a-z]+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi, "");

	// 3. 拦截 javascript: 伪协议
	html = html.replace(
		/href\s*=\s*(?:['"]javascript:[^'"]*['"]|javascript:[^\s>]+)/gi,
		'href="#"',
	);

	// 4. 外链统一安全属性
	html = html.replace(/<a\b/gi, '<a target="_blank" rel="noopener noreferrer"');

	return html.trim();
}

/**
 * 针对动态详情路径拉取专属评论列表与评论计数
 */
export async function fetchDynamicComments(
	type: string,
	serverUrl: string,
	rawPath: string,
	authorName?: string,
	pageSize = 50,
): Promise<DynamicCommentsResult> {
	if (!type || type === "none" || !serverUrl || !rawPath) {
		return { totalCount: 0, comments: [] };
	}

	// 统一去掉末尾斜杠，与 Waline / Twikoo / Artalk 注册路径对齐
	const normalizedPath =
		rawPath.endsWith("/") && rawPath.length > 1
			? rawPath.slice(0, -1)
			: rawPath;

	// 1. Waline
	if (type === "waline") {
		const baseUrl = serverUrl.replace(/\/+$/, "");
		const commentsUrl = `${baseUrl}/api/comment?path=${encodeURIComponent(
			normalizedPath,
		)}&pageSize=${pageSize}&page=1`;
		const countUrl = `${baseUrl}/api/comment?type=count&path=${encodeURIComponent(
			normalizedPath,
		)}`;

		try {
			const [commentsRes, countRes] = await Promise.all([
				fetchWithDedup<{
					errno?: number;
					data?: { data?: WalineRawComment[]; count?: number };
				}>(commentsUrl).catch(() => null),
				fetchWithDedup<{ errno?: number; data?: number[] }>(countUrl).catch(
					() => null,
				),
			]);

			const rawList = commentsRes?.data?.data || [];
			const exactTotal =
				Array.isArray(countRes?.data) && typeof countRes.data[0] === "number"
					? countRes.data[0]
					: commentsRes?.data?.count || 0;

			const comments: DynamicCommentItem[] = [];

			for (const item of rawList) {
				const isItemAdmin =
					item.type === "administrator" ||
					item.user_id === 1 ||
					item.label === "站长" ||
					(Boolean(authorName) && item.nick?.trim() === authorName?.trim());

				const commentHtml = item.comment || item.orig || "";
				const itemTime = Number(
					item.time ||
						(item.createdAt ? new Date(item.createdAt).getTime() : Date.now()),
				);

				comments.push({
					id: String(item.objectId ?? item.id ?? ""),
					nick: item.nick || "匿名访客",
					avatar: item.avatar || "",
					contentHtml: sanitizeCommentHtml(commentHtml),
					contentText: cleanCommentContent(commentHtml),
					time: itemTime,
					relativeTime: formatRelativeTime(itemTime),
					link: item.link || undefined,
					isAdmin: isItemAdmin,
				});

				// 子回复处理
				if (Array.isArray(item.children)) {
					for (const child of item.children) {
						const isChildAdmin =
							child.type === "administrator" ||
							child.user_id === 1 ||
							child.label === "站长" ||
							(Boolean(authorName) &&
								child.nick?.trim() === authorName?.trim());

						const childHtml = child.comment || child.orig || "";
						const childTime = Number(
							child.time ||
								(child.createdAt
									? new Date(child.createdAt).getTime()
									: Date.now()),
						);

						comments.push({
							id: String(child.objectId ?? child.id ?? ""),
							nick: child.nick || "匿名访客",
							avatar: child.avatar || "",
							contentHtml: sanitizeCommentHtml(childHtml),
							contentText: cleanCommentContent(childHtml),
							time: childTime,
							relativeTime: formatRelativeTime(childTime),
							link: child.link || undefined,
							isAdmin: isChildAdmin,
						});
					}
				}
			}

			return {
				totalCount: Math.max(exactTotal, comments.length),
				comments,
			};
		} catch (e) {
			console.warn("[Dynamic Comments] Failed to fetch Waline comments:", e);
		}
	}

	// 2. Twikoo
	if (type === "twikoo") {
		try {
			const res = await fetch(serverUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					event: "GET_COMMENTS",
					url: normalizedPath,
					pageSize,
				}),
			}).then((r) => r.json());

			if (Array.isArray(res?.data)) {
				const comments: DynamicCommentItem[] = res.data.map(
					(item: {
						id?: string;
						nick?: string;
						avatar?: string;
						comment?: string;
						created?: number;
						link?: string;
						isMaster?: boolean;
					}) => {
						const itemTime = Number(item.created || Date.now());
						return {
							id: String(item.id || ""),
							nick: item.nick || "匿名访客",
							avatar: item.avatar || "",
							contentHtml: sanitizeCommentHtml(item.comment || ""),
							contentText: cleanCommentContent(item.comment || ""),
							time: itemTime,
							relativeTime: formatRelativeTime(itemTime),
							link: item.link || undefined,
							isAdmin:
								Boolean(item.isMaster) ||
								(Boolean(authorName) &&
									item.nick?.trim() === authorName?.trim()),
						};
					},
				);

				return {
					totalCount: Number(res.count || comments.length),
					comments,
				};
			}
		} catch (e) {
			console.warn("[Dynamic Comments] Failed to fetch Twikoo comments:", e);
		}
	}

	// 3. Artalk
	if (type === "artalk") {
		try {
			const baseUrl = serverUrl.replace(/\/+$/, "");
			const apiUrl = `${baseUrl}/api/v2/comments?page_key=${encodeURIComponent(
				normalizedPath,
			)}&limit=${pageSize}`;
			const res = await fetchWithDedup<{
				data?: Array<{
					id?: number | string;
					nick?: string;
					avatar?: string;
					content_marked?: string;
					content?: string;
					date?: string;
					link?: string;
					badge_type?: string;
				}>;
				count?: number;
			}>(apiUrl);

			if (Array.isArray(res?.data)) {
				const comments: DynamicCommentItem[] = res.data.map((item) => {
					const itemTime = item.date
						? new Date(item.date).getTime()
						: Date.now();
					const rawContent = item.content_marked || item.content || "";
					return {
						id: String(item.id || ""),
						nick: item.nick || "匿名访客",
						avatar: item.avatar || "",
						contentHtml: sanitizeCommentHtml(rawContent),
						contentText: cleanCommentContent(rawContent),
						time: itemTime,
						relativeTime: formatRelativeTime(itemTime),
						link: item.link || undefined,
						isAdmin:
							item.badge_type === "admin" ||
							(Boolean(authorName) && item.nick?.trim() === authorName?.trim()),
					};
				});

				return {
					totalCount: Number(res.count || comments.length),
					comments,
				};
			}
		} catch (e) {
			console.warn("[Dynamic Comments] Failed to fetch Artalk comments:", e);
		}
	}

	return { totalCount: 0, comments: [] };
}
