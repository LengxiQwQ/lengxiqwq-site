/**
 * Cloudflare Worker D1 动态说说适配器
 * 负责从 Worker 实时拉取说说记录并转换为前台 DynamicFeed 所需的标准结构
 */
import { Marked } from "marked";
import { getWorkerApiUrl } from "./api-config";

export interface DynamicImage {
	alt: string;
	src: string;
	title?: string;
	width?: string;
}

export interface DynamicData {
	id: string;
	published: number;
	html: string;
	images: DynamicImage[];
	searchText: string;
	pinned?: boolean;
	location?: string;
}

interface WorkerMomentItem {
	id: string;
	content: string;
	images: string[];
	pinned: boolean;
	location: string | null;
	createdAt: number;
	updatedAt: number;
}

interface WorkerDynamicListResponse {
	code: number;
	message?: string;
	data?: {
		total: number;
		page: number;
		limit: number;
		items: WorkerMomentItem[];
	};
}

/**
 * 专用的 marked 渲染实例
 * 启用 GFM 与单换行换行；超链接在新标签页安全打开；图片交给独立画廊渲染，在此置空避免重复
 */
const workerMarked = new Marked({ gfm: true, breaks: true });
workerMarked.use({
	renderer: {
		link({ href, title, tokens }) {
			const text = this.parser.parseInline(tokens);
			const titleAttr = title ? ` title="${title}"` : "";
			return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
		},
		image() {
			return "";
		},
	},
});

/**
 * 从说说正文中提取纯文本用于前台搜索与关键字过滤
 */
function extractPlainText(content: string): string {
	return content
		.replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/<[^>]+>/g, " ")
		.replace(/[#>*_`~[\]()-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * 提取图片列表，结合正文 Markdown 图片语法与 R2 关联的 images 字段并做去重
 */
function extractImages(
	content: string,
	itemImages: string[] = [],
): DynamicImage[] {
	const images: DynamicImage[] = [];
	const seen = new Set<string>();

	// 1. 扫描正文中可能包含的 ![alt](url) 语法
	const mdImgRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
	let match: RegExpExecArray | null = mdImgRegex.exec(content);
	while (match !== null) {
		const alt = match[1] || "image";
		const src = (match[2] || "").trim();
		if (src && !seen.has(src)) {
			seen.add(src);
			images.push({ alt, src });
		}
		match = mdImgRegex.exec(content);
	}

	// 2. 挂载 D1 images 字段保存的 R2 图片 URL
	for (const [index, src] of itemImages.entries()) {
		const cleanSrc = (src || "").trim();
		if (cleanSrc && !seen.has(cleanSrc)) {
			seen.add(cleanSrc);
			images.push({
				alt: `image-${index + 1}`,
				src: cleanSrc,
			});
		}
	}

	return images;
}

/**
 * 从 Worker D1 拉取动态说说列表并转为前台标准结构
 * @param baseUrl 可选自定义 API 基础路径，默认自动探测 Worker API 地址
 */
export async function fetchWorkerDynamics(
	baseUrl?: string,
): Promise<DynamicData[]> {
	const base = baseUrl || getWorkerApiUrl();
	const apiUrl = `${base}/api/dynamic/list?limit=100`;

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 6000);

		const response = await fetch(apiUrl, {
			method: "GET",
			headers: {
				Accept: "application/json",
			},
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			console.warn(
				`[worker-dynamic-adapter] Worker API HTTP ${response.status} from ${apiUrl}`,
			);
			return [];
		}

		const resData = (await response.json()) as WorkerDynamicListResponse;
		if (
			resData.code !== 200 ||
			!resData.data ||
			!Array.isArray(resData.data.items)
		) {
			console.warn(
				"[worker-dynamic-adapter] Unexpected payload structure:",
				resData,
			);
			return [];
		}

		return resData.data.items.map((item) => {
			const html = workerMarked.parse(item.content || "") as string;
			const searchText = extractPlainText(item.content || "").toLowerCase();
			const images = extractImages(item.content || "", item.images || []);

			return {
				id: item.id,
				published: item.createdAt || Date.now(),
				html,
				images,
				searchText,
				pinned: Boolean(item.pinned),
				location: item.location || undefined,
			};
		});
	} catch (error) {
		console.warn(
			"[worker-dynamic-adapter] Network or parse failure, graceful fallback:",
			error,
		);
		return [];
	}
}
