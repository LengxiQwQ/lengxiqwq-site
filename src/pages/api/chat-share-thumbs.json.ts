import { getCollection } from "astro:content";
import fs from "node:fs";
import path from "node:path";
import type { APIRoute } from "astro";
import sharp from "sharp";
import { getHealthyFriends } from "@/config/friendsConfig";
import { getSortedPosts } from "@/utils/content-utils";
import { sortDynamics } from "@/utils/dynamic-utils";
import { processCoverImageSync } from "@/utils/image-utils";

export const prerender = true;

const markdownImagePattern = /!\[([^\]]*)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)/;

type ThumbSpec = {
	width: number;
	height: number;
};

function isRasterLocalPath(raw: string): boolean {
	if (!raw?.startsWith("/") || raw.startsWith("//")) return false;
	const pathname = raw.split(/[?#]/)[0].toLowerCase();
	return !pathname.endsWith(".svg") && !pathname.endsWith(".gif");
}

function resolvePublicFile(rawPath: string): string | null {
	const publicRoot = path.resolve("public");
	const clean = rawPath.split(/[?#]/)[0].replace(/^\/+/, "");
	let decoded = clean;
	try {
		decoded = decodeURIComponent(clean);
	} catch {
		// keep raw path segment when decode fails
	}
	const candidate = path.resolve(publicRoot, decoded);
	if (
		!candidate.startsWith(`${publicRoot}${path.sep}`) &&
		candidate !== publicRoot
	) {
		return null;
	}
	if (!fs.existsSync(candidate)) return null;
	try {
		return fs.statSync(candidate).isFile() ? candidate : null;
	} catch {
		return null;
	}
}

async function encodeThumbDataUri(
	filePath: string,
	spec: ThumbSpec,
): Promise<string | null> {
	try {
		const buffer = await sharp(filePath)
			.rotate()
			.resize(spec.width, spec.height, {
				fit: "cover",
				position: "attention",
				withoutEnlargement: true,
			})
			.webp({ quality: 55 })
			.toBuffer();
		return `data:image/webp;base64,${buffer.toString("base64")}`;
	} catch {
		return null;
	}
}

/**
 * GET /api/chat-share-thumbs.json
 * 为聊天室分享面板与卡片的本地图片生成超小 WebP 内联缩略图，避免全分辨率大图加载慢和单步缩放锯齿。
 */
export const GET: APIRoute = async () => {
	const targets = new Map<string, ThumbSpec>();

	const posts = await getSortedPosts();
	for (const post of posts) {
		const cover = processCoverImageSync(post.data.image, post.id) || "";
		if (isRasterLocalPath(cover) && !targets.has(cover)) {
			targets.set(cover, { width: 160, height: 100 });
		}
	}

	const dynamics = sortDynamics(await getCollection("dynamic"));
	for (const entry of dynamics) {
		const match = (entry.body || "").match(markdownImagePattern);
		const firstImage = (match?.[2] || "").trim();
		if (isRasterLocalPath(firstImage) && !targets.has(firstImage)) {
			targets.set(firstImage, { width: 96, height: 96 });
		}
	}

	const friends = getHealthyFriends();
	for (const friend of friends) {
		const avatar = (friend.imgurl || "").trim();
		if (isRasterLocalPath(avatar) && !targets.has(avatar)) {
			targets.set(avatar, { width: 96, height: 96 });
		}
	}

	const thumbs: Record<string, string> = {};
	await Promise.all(
		Array.from(targets.entries()).map(async ([rawPath, spec]) => {
			const filePath = resolvePublicFile(rawPath);
			if (!filePath) return;
			const dataUri = await encodeThumbDataUri(filePath, spec);
			if (dataUri) {
				thumbs[rawPath] = dataUri;
			}
		}),
	);

	return new Response(JSON.stringify(thumbs), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
};
