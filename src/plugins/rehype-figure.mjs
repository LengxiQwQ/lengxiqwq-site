import fs from "node:fs";
import path from "node:path";
import { h } from "hastscript";
import sharp from "sharp";
import { visit } from "unist-util-visit";
import { shouldAddNoReferrer } from "../utils/image-utils.ts";

/** 内存缓存图片尺寸，避免同一张图片在构建时被重复读取 */
const dimensionCache = new Map();

/**
 * 探测本地图片的原始像素宽高
 * @param {string} src
 * @returns {Promise<{width: number, height: number} | null>}
 */
async function getImageDimensions(src) {
	if (!src || typeof src !== "string") return null;

	// 跳过外链图片、数据 URI 或矢量 SVG
	if (
		src.startsWith("http://") ||
		src.startsWith("https://") ||
		src.startsWith("//") ||
		src.startsWith("data:") ||
		src.endsWith(".svg")
	) {
		return null;
	}

	if (dimensionCache.has(src)) {
		return dimensionCache.get(src);
	}

	const cleanSrc = src.split("?")[0].split("#")[0];

	// 候选物理路径列表（优先 public 目录）
	const candidates = [
		path.join(process.cwd(), "public", cleanSrc.replace(/^\/+/, "")),
		path.join(process.cwd(), cleanSrc.replace(/^\/+/, "")),
		path.join(process.cwd(), "src", cleanSrc.replace(/^\/+/, "")),
	];

	let filePath = null;
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			filePath = candidate;
			break;
		}
	}

	if (!filePath) {
		dimensionCache.set(src, null);
		return null;
	}

	try {
		const metadata = await sharp(filePath).metadata();
		if (metadata.width && metadata.height) {
			const res = { width: metadata.width, height: metadata.height };
			dimensionCache.set(src, res);
			return res;
		}
	} catch (_) {}

	dimensionCache.set(src, null);
	return null;
}

/**
 * 将带有 alt 文本的图片转换为包含 figcaption 的 figure 元素的 rehype 插件，
 * 并在 SSR 构建期为图片自动注入真实的 width/height 与 aspect-ratio 样式，彻底消除正文排版回流（CLS）。
 *
 * @returns {Function} A transformer function for the rehype plugin
 */
export default function rehypeFigure() {
	return async (tree) => {
		const tasks = [];

		visit(tree, "element", (node, index, parent) => {
			// 只处理 img 元素
			if (node.tagName !== "img") {
				return;
			}

			// 跳过已由其它插件接管渲染的图片（例如 plantuml）
			const classRaw = node.properties?.className;
			const classNames = Array.isArray(classRaw)
				? classRaw
				: typeof classRaw === "string"
					? classRaw.split(/\s+/)
					: [];
			if (classNames.includes("plantuml-image")) {
				return;
			}

			const imgProps = { ...node.properties };

			// 添加 referrerpolicy（如果需要）解决 403 问题
			if (imgProps.src && shouldAddNoReferrer(imgProps.src)) {
				imgProps.referrerpolicy = "no-referrer";
			}

			imgProps.loading = imgProps.loading || "lazy";
			imgProps.decoding = imgProps.decoding || "async";

			const alt = imgProps.alt;

			tasks.push(
				(async () => {
					if (imgProps.src) {
						const dimensions = await getImageDimensions(imgProps.src);
						if (dimensions) {
							imgProps.width = dimensions.width;
							imgProps.height = dimensions.height;
							const styleStr = imgProps.style ? `${imgProps.style}; ` : "";
							imgProps.style = `${styleStr}aspect-ratio: ${dimensions.width} / ${dimensions.height};`;
						}
					}

					// 如果没有 alt 属性或 alt 为空字符串，则只更新属性并保持原样
					if (!alt || alt.trim() === "") {
						node.properties = imgProps;
						return;
					}

					// 创建 figure 元素，包含处理后的 img 和居中的 figcaption
					const figure = h("figure", [
						h("img", {
							...imgProps,
						}),
						h("figcaption", alt),
					]);

					// 居中显示
					const centerFigure = h("center", figure);

					// 替换当前的 img 节点为 figure 节点
					if (parent && typeof index === "number") {
						parent.children[index] = centerFigure;
					}
				})(),
			);
		});

		if (tasks.length > 0) {
			await Promise.all(tasks);
		}
	};
}
