import { getSortedPosts } from "@/utils/content-utils";
import { formatDateToYYYYMMDD } from "@/utils/date-utils";
import { processCoverImageSync } from "@/utils/image-utils";
import { getPostUrlBySlug } from "@/utils/url-utils";

export async function GET(): Promise<Response> {
	const posts = await getSortedPosts();

	const allPostsData = posts
		.map((post) => {
			const cover = processCoverImageSync(post.data.image, post.id) || "";
			return {
				id: post.id,
				title: post.data.title,
				description: post.data.description,
				published: post.data.published.getTime(),
				publishedDate: formatDateToYYYYMMDD(post.data.published),
				category: post.data.category || "",
				password: !!post.data.password,
				image: cover,
				url: getPostUrlBySlug(post.id),
			};
		})
		// 日历按纯日期排序，忽略置顶
		.sort((a, b) => b.published - a.published);

	return new Response(JSON.stringify(allPostsData), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}
