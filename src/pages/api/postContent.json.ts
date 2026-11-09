import type { APIRoute } from "astro";
import { getSortedPosts } from "@/utils/content-utils";
import { formatDateToYYYYMMDD } from "@/utils/date-utils";

/**
 * GET /api/postContent.json
 * 一站式返回全站文章元数据与 Markdown 正文内容
 * 供控制台长文管理、搜索与快速载入编辑使用
 */
export const GET: APIRoute = async () => {
	const posts = await getSortedPosts();

	const list = posts.map((p) => {
		const rawData = p.data as Record<string, unknown>;
		const slug =
			(typeof rawData.slug === "string" && rawData.slug) ||
			p.id
				.replace(/\.[^/.]+$/, "")
				.split("/")
				.pop() ||
			p.id;
		return {
			id: p.id,
			slug,
			title: p.data.title,
			description: p.data.description || "",
			published: p.data.published.getTime(),
			publishedDate: formatDateToYYYYMMDD(p.data.published),
			category: p.data.category || "技术笔记",
			tags: Array.isArray(p.data.tags) ? p.data.tags : [],
			cover: p.data.image || "",
			pinned: Boolean(p.data.pinned),
			draft: Boolean(p.data.draft),
			wordCount: (p.body || "").length,
			content: p.body || "",
		};
	});

	return new Response(
		JSON.stringify({
			code: 200,
			total: list.length,
			data: list,
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
