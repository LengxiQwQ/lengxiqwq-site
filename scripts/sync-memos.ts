/**
 * Memos 云端动态同步与本地化归档脚本
 *
 * 核心机制：
 * 1. 自动连接 Memos API 获取指定用户的公开动态；
 * 2. 自动下载照片附件，使用 Sharp 执行 EXIF 纠偏、等比缩放（最大1600px）并转码为高质量 WebP（压缩体积 95%+）；
 * 3. 将动态生成为标准 Markdown 文件（包含本地图片路径与时间戳），持久化存入 content/dynamic/；
 * 4. 支持增量同步、更新比对（云端编辑后同步修改）以及删除同步（云端删除后本地同步移除）；
 * 5. 安全防护：严格根据 memosId 识别，无 memosId 的原生本地动态（如开店宣言）永不被篡改或删除！
 */

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import sharp from "sharp";
import { dynamicConfig } from "../src/config/dynamicConfig.ts";

interface MemoResource {
	name: string;
	filename: string;
	type: string;
	externalLink?: string;
}

interface Memo {
	name: string;
	state: string;
	creator: string;
	createTime: string;
	updateTime: string;
	content: string;
	visibility: string;
	pinned?: boolean;
	resources?: MemoResource[];
	attachments?: MemoResource[];
	location?: { placeholder?: string };
}

interface MemosApiResponse {
	memos: Memo[];
	nextPageToken?: string;
}

// 1. 解析目标内容仓路径
let contentDir = process.env.CONTENT_DIR;
const args = process.argv.slice(2);
const dirArgIndex = args.indexOf("--content-dir");
if (dirArgIndex !== -1 && args[dirArgIndex + 1]) {
	contentDir = args[dirArgIndex + 1];
}

if (!contentDir) {
	const localSiblingContent = path.resolve("../lengxiqwq-site-content");
	if (fs.existsSync(localSiblingContent)) {
		contentDir = localSiblingContent;
	} else {
		console.error(
			"[sync-memos] 错误：未找到内容仓路径，请设置 CONTENT_DIR 或 --content-dir 参数。",
		);
		process.exit(1);
	}
}

const resolvedContentDir = path.resolve(contentDir);
const dynamicDir = path.join(resolvedContentDir, "content/dynamic");
const imageOutputDir = path.join(
	resolvedContentDir,
	"public/assets/images/dynamic",
);

fs.mkdirSync(dynamicDir, { recursive: true });
fs.mkdirSync(imageOutputDir, { recursive: true });

// 2. 获取 Memos 实例配置
const memosApiUrl =
	process.env.MEMOS_API_URL ||
	dynamicConfig.memos?.apiUrl ||
	"https://funpyfry.sealoshzh.site";
const memosParent =
	process.env.MEMOS_PARENT || dynamicConfig.memos?.parent || "users/1";

if (!memosApiUrl) {
	console.error("[sync-memos] 错误：未配置 memos.apiUrl，无法同步。");
	process.exit(1);
}

/**
 * 生成时间戳文件名 YYYY-MM-DD-HHmmss
 */
function formatFilenameTime(isoString: string): string {
	const date = new Date(isoString);
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	const parts = formatter.formatToParts(date).reduce(
		(acc, part) => {
			if (part.type !== "literal") acc[part.type] = part.value;
			return acc;
		},
		{} as Record<string, string>,
	);

	return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}

/**
 * 下载图片并使用 Sharp 进行 HEIC/JPEG 转 WebP 及等比高保真压缩
 */
async function processAndSaveImage(
	imageUrl: string,
	outputFilePath: string,
): Promise<boolean> {
	try {
		const res = await fetch(imageUrl);
		if (!res.ok) {
			console.warn(`[sync-memos] 下载图片失败 (${res.status}): ${imageUrl}`);
			return false;
		}
		const arrayBuf = await res.arrayBuffer();
		const buffer = Buffer.from(arrayBuf);

		// 使用 Sharp 进行全套优化：
		// 1. .rotate() 根据 EXIF 自动纠正手机拍摄方向；
		// 2. .resize() 限制最大边长 1600px（视网膜屏极致细腻，体积暴降 95%）；
		// 3. .webp({ quality: 82 }) 转换为现代 WebP 格式。
		const optimizedBuffer = await sharp(buffer)
			.rotate()
			.resize({
				width: 1600,
				height: 1600,
				fit: "inside",
				withoutEnlargement: true,
			})
			.webp({ quality: 82 })
			.toBuffer();

		fs.writeFileSync(outputFilePath, optimizedBuffer);
		return true;
	} catch (error) {
		console.error(`[sync-memos] 优化图片失败 [${imageUrl}]:`, error);
		return false;
	}
}

async function run() {
	console.log(`[sync-memos] 开始从 Memos API 同步数据: ${memosApiUrl}`);
	console.log(`[sync-memos] 目标用户 Parent: ${memosParent}`);
	console.log(`[sync-memos] 目标内容仓目录: ${resolvedContentDir}`);

	// 1. 拉取所有动态
	const url = new URL(`${memosApiUrl}/api/v1/memos`);
	url.searchParams.set("pageSize", "1000");
	if (memosParent) {
		url.searchParams.set("parent", memosParent);
	}

	const response = await fetch(url.toString(), {
		headers: { Accept: "application/json" },
	});

	if (!response.ok) {
		throw new Error(
			`请求 Memos API 失败: ${response.status} ${response.statusText}`,
		);
	}

	const data: MemosApiResponse = await response.json();
	const allMemos = data.memos || [];

	// 过滤有效公开动态（状态正常、公开权限、创作者一致）
	const validMemos = allMemos.filter((m) => {
		const isNormal = m.state === "NORMAL";
		const isPublic = m.visibility === "PUBLIC";
		const isCreator = memosParent ? m.creator === memosParent : true;
		return isNormal && isPublic && isCreator;
	});

	console.log(
		`[sync-memos] 从云端检索到 ${validMemos.length} 条有效公开动态。`,
	);

	// 2. 扫描本地现有的 Markdown 动态文件
	const localFiles = fs
		.readdirSync(dynamicDir)
		.filter((f) => f.endsWith(".md"));
	const existingMemosMap = new Map<
		string,
		{
			filePath: string;
			fileName: string;
			data: Record<string, unknown>;
			content: string;
		}
	>();

	for (const fileName of localFiles) {
		const filePath = path.join(dynamicDir, fileName);
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = matter(raw);
		if (parsed.data?.memosId) {
			existingMemosMap.set(parsed.data.memosId, {
				filePath,
				fileName,
				data: parsed.data,
				content: parsed.content,
			});
		} else {
			// 没有 memosId 说明是博主纯本地撰写的历史动态（如开店宣言），绝对保护！
		}
	}

	let createdCount = 0;
	let updatedCount = 0;
	let unchangedCount = 0;
	const activeMemosIds = new Set<string>();

	// 3. 逐条比对与同步
	for (const memo of validMemos) {
		const memoId = memo.name; // 例如 "memos/hT6sbY9chVk6b5h7eeEuC2"
		const shortId = memoId.split("/").pop() || "memo";
		activeMemosIds.add(memoId);

		const resources = memo.resources || memo.attachments || [];
		const imageMarkdownList: string[] = [];

		// 处理该动态关联的所有图片附件
		for (let i = 0; i < resources.length; i++) {
			const resource = resources[i];
			const isImage = resource.type.startsWith("image/");
			if (!isImage) continue;

			const resourceId = resource.name.split("/").pop() || `${shortId}_${i}`;
			const localImageFileName = `${resourceId}.webp`;
			const localImageFullPath = path.join(imageOutputDir, localImageFileName);
			const webPath = `/assets/images/dynamic/${localImageFileName}`;

			// 如果本地不存在此图片，则下载并优化转码
			if (!fs.existsSync(localImageFullPath)) {
				const resourcePath = resource.name.startsWith("resources/")
					? "resources"
					: "attachments";
				const downloadUrl =
					resource.externalLink ||
					`${memosApiUrl}/file/${resourcePath}/${resourceId}/${resource.filename}`;
				console.log(
					`[sync-memos] 📥 正在下载并优化图片: ${resource.filename} -> ${localImageFileName}`,
				);
				const success = await processAndSaveImage(
					downloadUrl,
					localImageFullPath,
				);
				if (success) {
					imageMarkdownList.push(`![${resource.filename}](${webPath})`);
				}
			} else {
				imageMarkdownList.push(`![${resource.filename}](${webPath})`);
			}
		}

		// 组装正文内容
		let finalContent = memo.content.trim();
		if (imageMarkdownList.length > 0) {
			finalContent = `${finalContent}\n\n${imageMarkdownList.join("\n\n")}`;
		}

		const locationStr = memo.location?.placeholder?.trim() || "";

		const frontmatter: Record<string, unknown> = {
			published: new Date(memo.createTime),
			pinned: Boolean(memo.pinned),
			memosId: memoId,
			memosUpdated: memo.updateTime,
		};
		if (locationStr) {
			frontmatter.location = locationStr;
		}

		const newFileContent = matter.stringify(`\n${finalContent}\n`, frontmatter);

		// 判断本地是否已存在
		const existing = existingMemosMap.get(memoId);
		if (existing) {
			// 对比是否有更新
			const isUpdated =
				existing.data.memosUpdated !== memo.updateTime ||
				existing.data.pinned !== Boolean(memo.pinned) ||
				existing.content.trim() !== finalContent.trim();

			if (isUpdated) {
				fs.writeFileSync(existing.filePath, newFileContent, "utf-8");
				console.log(
					`[sync-memos] 🔄 已更新动态: ${existing.fileName} (ID: ${shortId})`,
				);
				updatedCount++;
			} else {
				unchangedCount++;
			}
		} else {
			// 新增动态，生成统一格式的时间戳文件名
			const timePrefix = formatFilenameTime(memo.createTime);
			const newFileName = `${timePrefix}-${shortId}.md`;
			const newFilePath = path.join(dynamicDir, newFileName);

			fs.writeFileSync(newFilePath, newFileContent, "utf-8");
			console.log(
				`[sync-memos] ✨ 已新增动态: ${newFileName} (ID: ${shortId})`,
			);
			createdCount++;
		}
	}

	// 4. 处理云端已被删除的动态（删除同步）
	let deletedCount = 0;
	for (const [memosId, existing] of existingMemosMap.entries()) {
		if (!activeMemosIds.has(memosId)) {
			fs.unlinkSync(existing.filePath);
			console.log(
				`[sync-memos] 🗑️ 云端已删除/隐藏，本地同步清理: ${existing.fileName}`,
			);
			deletedCount++;
		}
	}

	console.log(
		`[sync-memos] 同步完成！新增: ${createdCount}, 更新: ${updatedCount}, 未变动: ${unchangedCount}, 删除: ${deletedCount}`,
	);
}

run().catch((err) => {
	console.error("[sync-memos] 同步执行出错:", err);
	process.exit(1);
});
