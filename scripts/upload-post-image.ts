import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

/**
 * 上传单张文章图片或封面到 Cloudflare R2
 * 用法:
 *   pnpm upload:img <图片路径> [图片名称]
 * 示例:
 *   pnpm upload:img C:\Users\xxx\Desktop\screenshot.png
 *   pnpm upload:img ./my-photo.jpg banner
 */

const BUCKET_NAME = "lengxi-images";
const DOMAIN = "https://img.lengxiqwq.com";

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		console.log("❌ 请指定要上传的图片路径！");
		console.log("用法示例: pnpm upload:img <图片路径> [可选自定义名称]");
		process.exit(1);
	}

	const inputPath = path.resolve(process.cwd(), args[0]);
	if (!fs.existsSync(inputPath)) {
		console.log(`❌ 找不到指定的文件: ${inputPath}`);
		process.exit(1);
	}

	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");

	const customName = args[1]
		? args[1].replace(/\.[^/.]+$/, "")
		: path.parse(inputPath).name;

	const outputFileName = `${customName}-${Date.now().toString(36)}.webp`;
	const remoteKey = `posts/${year}/${month}/${outputFileName}`;
	const tempOutputPath = path.resolve(process.cwd(), `.temp-${outputFileName}`);

	console.log(`🚀 正在处理图片: ${path.basename(inputPath)}`);

	// 1. Sharp 压缩转码
	await sharp(inputPath)
		.resize({
			width: 1400,
			withoutEnlargement: true,
		})
		.webp({ quality: 80 })
		.toFile(tempOutputPath);

	const stat = fs.statSync(tempOutputPath);
	const sizeKB = (stat.size / 1024).toFixed(1);
	console.log(`   ↳ 已压缩为 WebP (${sizeKB} KB)`);

	// 2. 上传到 R2
	console.log(`   ↳ 正在上传至 Cloudflare R2: ${remoteKey} ...`);
	try {
		execSync(
			`npx wrangler r2 object put "${BUCKET_NAME}/${remoteKey}" --file "${tempOutputPath}" --content-type "image/webp" --remote`,
			{ stdio: "pipe" },
		);
		const publicUrl = `${DOMAIN}/${remoteKey}`;
		console.log("\n✅ 上传成功！");
		console.log(`🌐 图片直链: ${publicUrl}`);
		console.log(`📝 Markdown 引用: ![](${publicUrl})`);

		// 自动写入剪贴板（Windows）
		try {
			execSync(`powershell -command "Set-Clipboard -Value '${publicUrl}'"`);
			console.log("📋 直链已自动复制到剪贴板！可以直接 Ctrl+V 粘贴。");
		} catch {}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`❌ 上传失败: ${msg}`);
	} finally {
		try {
			fs.unlinkSync(tempOutputPath);
		} catch {}
	}
}

main().catch(console.error);
