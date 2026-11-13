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

const DYNAMIC_COMMENTS_CACHE_TTL_MS = 5 * 60 * 1000;
const dynamicCommentsCache = new Map<
	string,
	{ result: DynamicCommentsResult; expiresAt: number }
>();
let pendingBatchCountPromise: Promise<void> | null = null;

function normalizeCommentPath(rawPath: string): string {
	return rawPath.endsWith("/") && rawPath.length > 1
		? rawPath.slice(0, -1)
		: rawPath;
}

function getDynamicCacheKey(
	type: string,
	serverUrl: string,
	normalizedPath: string,
): string {
	return `${type}:${serverUrl.replace(/\/+$/, "")}:${normalizedPath}`;
}

/**
 * 批量预检一组动态的 Waline 评论数：
 * 仅发 1 次请求，将评论数为 0 的动态直接写入缓存，避免每张卡片单独请求评论列表
 */
export async function prefetchWalineDynamicCommentCounts(
	serverUrl: string,
	rawPaths: string[],
): Promise<void> {
	const baseUrl = serverUrl.replace(/\/+$/, "");
	if (!baseUrl || rawPaths.length === 0) return;

	const now = Date.now();
	const uncachedPaths: string[] = [];
	const seen = new Set<string>();
	for (const raw of rawPaths) {
		const normalized = normalizeCommentPath(raw);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		const cached = dynamicCommentsCache.get(
			getDynamicCacheKey("waline", baseUrl, normalized),
		);
		if (!cached || cached.expiresAt <= now) {
			uncachedPaths.push(normalized);
		}
	}
	if (uncachedPaths.length === 0) return;

	const task = (async () => {
		const CHUNK_SIZE = 30;
		for (let i = 0; i < uncachedPaths.length; i += CHUNK_SIZE) {
			const chunk = uncachedPaths.slice(i, i + CHUNK_SIZE);
			const params = chunk
				.map((p) => `path=${encodeURIComponent(p)}`)
				.join("&");
			const url = `${baseUrl}/api/comment?type=count&${params}`;
			try {
				const res = await fetchWithDedup<{ errno?: number; data?: number[] }>(
					url,
				);
				if (res && Array.isArray(res.data)) {
					const expiresAt = Date.now() + DYNAMIC_COMMENTS_CACHE_TTL_MS;
					for (let j = 0; j < chunk.length; j++) {
						if (res.data[j] === 0) {
							dynamicCommentsCache.set(
								getDynamicCacheKey("waline", baseUrl, chunk[j]),
								{
									result: { totalCount: 0, comments: [] },
									expiresAt,
								},
							);
						}
					}
				}
			} catch {
				// Ignore prefetch failures; individual cards fall back gracefully
			}
		}
	})();

	pendingBatchCountPromise = task.finally(() => {
		if (pendingBatchCountPromise === task) {
			pendingBatchCountPromise = null;
		}
	});
	return pendingBatchCountPromise;
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
	const normalizedPath = normalizeCommentPath(rawPath);
	const cacheKey = getDynamicCacheKey(type, serverUrl, normalizedPath);

	if (pendingBatchCountPromise) {
		await pendingBatchCountPromise.catch(() => {});
	}

	const cached = dynamicCommentsCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.result;
	}

	// 1. Waline
	if (type === "waline") {
		const baseUrl = serverUrl.replace(/\/+$/, "");
		const commentsUrl = `${baseUrl}/api/comment?path=${encodeURIComponent(
			normalizedPath,
		)}&pageSize=${pageSize}&page=1`;

		try {
			const commentsRes = await fetchWithDedup<{
				errno?: number;
				data?: { data?: WalineRawComment[]; count?: number };
			}>(commentsUrl);

			const rawList = commentsRes?.data?.data || [];
			const exactTotal = commentsRes?.data?.count || 0;

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

			const result: DynamicCommentsResult = {
				totalCount: Math.max(exactTotal, comments.length),
				comments,
			};
			dynamicCommentsCache.set(cacheKey, {
				result,
				expiresAt: Date.now() + DYNAMIC_COMMENTS_CACHE_TTL_MS,
			});
			return result;
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
