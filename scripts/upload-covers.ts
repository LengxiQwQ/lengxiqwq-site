import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import sharp from "sharp";

/**
 * 递归扫描并批量压缩、上传博客分类封面图到 Cloudflare R2
 *
 * 核心特性：
 * 1. 完整保留分类子文件夹结构与原始文件名（转为 .webp 并清理 URL 特殊空格）
 * 2. 自动等比缩放至最大宽度 1200 像素，质量 80%，极大缩减体积
 * 3. 自动生成分类清单 covers-manifest.json（支持全库随机、分类随机与单图指定）
 * 4. 自动同步更新主代码仓、内容仓与 R2 远程端
 */

const BUCKET_NAME = "lengxi-images";
const DOMAIN = "https://img.lengxiqwq.com";
const INPUT_DIR = path.resolve(process.cwd(), "temp-covers");
const OUTPUT_TEMP_DIR = path.resolve(process.cwd(), ".temp-processed-covers");
const MANIFEST_LOCAL_PATH = path.resolve(
	process.cwd(),
	"src/constants/covers-manifest.json",
);
const CONTENT_MANIFEST_PATH = path.resolve(
	process.cwd(),
	"../lengxiqwq-site-content/config/covers-manifest.json",
);

interface ImageItem {
	category: string;
	originalName: string;
	cleanBaseName: string;
	webpName: string;
	sourcePath: string;
	remoteKey: string;
	publicUrl: string;
}

function scanImages(dir: string, currentCategory = ""): ImageItem[] {
	const allowedExtensions = [".png", ".jpg", ".jpeg", ".webp", ".avif"];
	const results: ImageItem[] = [];

	if (!fs.existsSync(dir)) return results;

	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const subCategory = currentCategory
				? `${currentCategory}/${entry.name}`
				: entry.name;
			results.push(...scanImages(fullPath, subCategory));
		} else {
			const ext = path.extname(entry.name).toLowerCase();
			if (allowedExtensions.includes(ext)) {
				const categoryName = currentCategory || "default";
				const parsed = path.parse(entry.name);
				// 清理文件名中可能导致 URL 编码问题的首尾空格与多余空格
				const cleanBase = parsed.name.trim().replace(/\s+/g, "-");
				const webpName = `${cleanBase}.webp`;
				const remoteKey = `covers/${categoryName}/${webpName}`;
				// 编码中文与特殊字符
				const encodedKey = remoteKey
					.split("/")
					.map((seg) => encodeURIComponent(seg))
					.join("/");
				const publicUrl = `${DOMAIN}/${encodedKey}`;

				results.push({
					category: categoryName,
					originalName: entry.name,
					cleanBaseName: cleanBase,
					webpName,
					sourcePath: fullPath,
					remoteKey,
					publicUrl,
				});
			}
		}
	}

	return results;
}

async function main() {
	console.log("==================================================");
	console.log("🚀 Cloudflare R2 博客分类封面图批量优化与上传工具");
	console.log("==================================================\n");

	if (!fs.existsSync(INPUT_DIR)) {
		fs.mkdirSync(INPUT_DIR, { recursive: true });
		console.log(`📁 已为你创建图片输入文件夹: ${INPUT_DIR}`);
		console.log(
			"👉 请将你的分类文件夹及图片放入该文件夹中，然后重新运行此命令！",
		);
		return;
	}

	const images = scanImages(INPUT_DIR);

	if (images.length === 0) {
		console.log(`⚠️  文件夹 ${INPUT_DIR} 中没有找到支持的图片文件！`);
		return;
	}

	// 统计分类
	const categoryMap: Record<string, string[]> = {};
	for (const img of images) {
		if (!categoryMap[img.category]) {
			categoryMap[img.category] = [];
		}
		categoryMap[img.category].push(img.publicUrl);
	}

	const categoryNames = Object.keys(categoryMap);
	console.log(
		`📸 共扫描到 ${images.length} 张图片，包含 ${categoryNames.length} 个分类：`,
	);
	for (const cat of categoryNames) {
		console.log(`   📂 [${cat}]: ${categoryMap[cat].length} 张图片`);
	}
	console.log(
		"\n⚡ 开始批量压缩（最宽 1200px + WebP）并上传至 Cloudflare R2...\n",
	);

	if (!fs.existsSync(OUTPUT_TEMP_DIR)) {
		fs.mkdirSync(OUTPUT_TEMP_DIR, { recursive: true });
	}

	let totalOriginalBytes = 0;
	let totalCompressedBytes = 0;
	let successCount = 0;

	for (let i = 0; i < images.length; i++) {
		const item = images[i];
		const index = i + 1;
		const tempFile = path.join(OUTPUT_TEMP_DIR, `temp-${index}.webp`);
		const originalStat = fs.statSync(item.sourcePath);
		totalOriginalBytes += originalStat.size;

		console.log(
			`[${index}/${images.length}] 处理 [${item.category}] ${item.originalName}`,
		);

		// 1. Sharp 压缩裁切
		await sharp(item.sourcePath)
			.resize({
				width: 1200,
				withoutEnlargement: true,
			})
			.webp({ quality: 80 })
			.toFile(tempFile);

		const compStat = fs.statSync(tempFile);
		totalCompressedBytes += compStat.size;
		const origKB = (originalStat.size / 1024).toFixed(1);
		const compKB = (compStat.size / 1024).toFixed(1);
		const ratio = (
			((originalStat.size - compStat.size) / originalStat.size) *
			100
		).toFixed(1);

		console.log(`      ↳ 压缩: ${origKB} KB ➔ ${compKB} KB (缩减 ${ratio}%)`);

		// 2. 上传至 R2
		console.log(`      ↳ 上传: ${item.remoteKey} ...`);
		try {
			execSync(
				`npx wrangler r2 object put "${BUCKET_NAME}/${item.remoteKey}" --file "${tempFile}" --content-type "image/webp" --remote`,
				{ stdio: "pipe" },
			);
			successCount++;
			console.log(`      ✅ 上传成功`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`      ❌ 上传失败: ${msg}`);
		} finally {
			try {
				fs.unlinkSync(tempFile);
			} catch {}
		}
	}

	// 清理临时目录
	try {
		fs.rmSync(OUTPUT_TEMP_DIR, { recursive: true, force: true });
	} catch {}

	// 3. 构建并保存 Manifest 清单
	const manifest = {
		updatedAt: new Date().toISOString(),
		total: successCount,
		categories: categoryMap,
		all: images.map((x) => x.publicUrl),
	};

	const manifestJson = JSON.stringify(manifest, null, 2);

	// 写入本地主代码仓
	const manifestDir = path.dirname(MANIFEST_LOCAL_PATH);
	if (!fs.existsSync(manifestDir))
		fs.mkdirSync(manifestDir, { recursive: true });
	fs.writeFileSync(MANIFEST_LOCAL_PATH, manifestJson, "utf8");
	console.log(`\n📄 已保存清单至主仓库: ${MANIFEST_LOCAL_PATH}`);

	// 写入内容仓
	if (fs.existsSync(path.dirname(CONTENT_MANIFEST_PATH))) {
		fs.writeFileSync(CONTENT_MANIFEST_PATH, manifestJson, "utf8");
		console.log(`📄 已保存清单至内容仓: ${CONTENT_MANIFEST_PATH}`);
	}

	// 上传清单到 R2
	const tempManifestPath = path.resolve(process.cwd(), ".temp-manifest.json");
	fs.writeFileSync(tempManifestPath, manifestJson, "utf8");
	try {
		execSync(
			`npx wrangler r2 object put "${BUCKET_NAME}/covers/manifest.json" --file "${tempManifestPath}" --content-type "application/json" --remote`,
			{ stdio: "pipe" },
		);
		console.log(`🌐 已上传清单至 R2: ${DOMAIN}/covers/manifest.json`);
	} catch {
	} finally {
		try {
			fs.unlinkSync(tempManifestPath);
		} catch {}
	}

	const totalOrigMB = (totalOriginalBytes / 1024 / 1024).toFixed(2);
	const totalCompMB = (totalCompressedBytes / 1024 / 1024).toFixed(2);
	const totalSavedRatio = (
		((totalOriginalBytes - totalCompressedBytes) / totalOriginalBytes) *
		100
	).toFixed(1);

	console.log("\n==================================================");
	console.log("🎉 全部处理与上传完毕！");
	console.log(
		`📊 原始总大小: ${totalOrigMB} MB ➔ 压缩后: ${totalCompMB} MB (总计节省 ${totalSavedRatio}% 流量！)`,
	);
	console.log(`✅ 成功上传: ${successCount} / ${images.length} 张`);
	console.log("==================================================\n");
}

main().catch(console.error);
