import { getCollection } from "astro:content";
import { createMarkdownProcessor } from "@astrojs/markdown-remark";
import {
	dynamicSearchText,
	dynamicSlug,
	sortDynamics,
} from "@/utils/dynamic-utils";

const markdownImagePattern = /!\[([^\]]*)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)/g;

export async function GET(): Promise<Response> {
	const processor = await createMarkdownProcessor();
	const dynamics = sortDynamics(await getCollection("dynamic"));
	const data = await Promise.all(
		dynamics.map(async (entry) => {
			const images: Array<{
				alt: string;
				src: string;
				title?: string;
				width?: string;
			}> = [];
			const markdown = (entry.body || "").replace(
				markdownImagePattern,
				(_match, alt: string, src: string, title?: string) => {
					let cleanAlt = (alt || "").trim();
					let width: string | undefined;

					// 支持语法：![描述|180](url) 或 ![描述|180px](url) 或 ![描述|表情](url) 或 ![表情](url)
					if (cleanAlt.includes("|")) {
						const [text, spec] = cleanAlt.split("|").map((s) => s.trim());
						cleanAlt = text;
						const lowerSpec = spec.toLowerCase();
						if (
							lowerSpec === "表情" ||
							lowerSpec === "emoji" ||
							lowerSpec === "meme" ||
							lowerSpec === "sticker" ||
							lowerSpec === "sm" ||
							lowerSpec === "small"
						) {
							width = "180px";
						} else if (/^\d+(?:px|rem|%)?$/.test(lowerSpec)) {
							width =
								lowerSpec.endsWith("px") ||
								lowerSpec.endsWith("rem") ||
								lowerSpec.endsWith("%")
									? lowerSpec
									: `${lowerSpec}px`;
						}
					} else if (
						cleanAlt === "表情" ||
						cleanAlt === "emoji" ||
						cleanAlt === "meme" ||
						cleanAlt === "sticker"
					) {
						width = "180px";
					}

					images.push({
						alt: cleanAlt,
						src,
						...(title ? { title } : {}),
						...(width ? { width } : {}),
					});
					return "";
				},
			);
			const rendered = await processor.render(markdown);

			return {
				id: dynamicSlug(entry.id),
				published: entry.data.published.getTime(),
				html: rendered.code,
				images,
				searchText: dynamicSearchText(entry),
				pinned: entry.data.pinned || false,
				location: entry.data.location.trim(),
				tags: entry.data.tags || [],
			};
		}),
	);

	return new Response(JSON.stringify(data), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}
