import fs from "node:fs";
import path from "node:path";

interface StickerCategories {
	name: string;
	prefix: string;
	type: string;
	icon: string;
	description?: string;
	groups: {
		text: string[];
		animated: string[];
		static: string[];
	};
}

interface StickerManifest {
	name: string;
	prefix: string;
	type: string;
	icon: string;
	items: string[];
}

function resolveStickerDirs(stickerPack = "miku") {
	const localContentDir = path.resolve("../lengxiqwq-site-content");
	const contentPackDir = fs.existsSync(localContentDir)
		? path.join(localContentDir, "public/assets/stickers", stickerPack)
		: null;
	const mainPackDir = path.resolve("public/assets/stickers", stickerPack);

	return { contentPackDir, mainPackDir };
}

export function syncAndSortStickers(stickerPack = "miku"): void {
	const { contentPackDir, mainPackDir } = resolveStickerDirs(stickerPack);
	const targetDir =
		contentPackDir && fs.existsSync(contentPackDir)
			? contentPackDir
			: mainPackDir;

	const categoriesPath = path.join(targetDir, "categories.json");
	if (!fs.existsSync(categoriesPath)) {
		console.error(`[sticker:sort] ❌ 未找到分类规则文件: ${categoriesPath}`);
		process.exit(1);
	}

	const categories = JSON.parse(
		fs.readFileSync(categoriesPath, "utf-8"),
	) as StickerCategories;
	const prefix = categories.prefix || `${stickerPack}_`;
	const ext = categories.type || "webp";

	const textItems = categories.groups?.text || [];
	const animatedItems = categories.groups?.animated || [];
	const staticItems = categories.groups?.static || [];

	const sortedItems = [...textItems, ...animatedItems, ...staticItems];

	// 1. 检查所有登记在案的图片文件是否存在
	const missing: string[] = [];
	for (const item of sortedItems) {
		const filename = `${prefix}${item}.${ext}`;
		if (!fs.existsSync(path.join(targetDir, filename))) {
			missing.push(filename);
		}
	}

	if (missing.length > 0) {
		console.warn(
			"[sticker:sort] ⚠️ 以下登记在 categories.json 的文件在目录中未找到:",
		);
		for (const m of missing) {
			console.warn(`  - ${m}`);
		}
	}

	// 2. 检查目录中是否存在未登记在 categories.json 的新表情
	const allFiles = fs.readdirSync(targetDir);
	const unlisted: string[] = [];
	const listedSet = new Set(sortedItems);

	for (const f of allFiles) {
		if (f.startsWith(prefix) && f.endsWith(`.${ext}`)) {
			const itemCode = f.slice(prefix.length, -`.${ext}`.length);
			if (!listedSet.has(itemCode)) {
				unlisted.push(itemCode);
			}
		}
	}

	if (unlisted.length > 0) {
		console.warn(
			"[sticker:sort] 💡 发现未登记到 categories.json 的新表情文件:",
		);
		for (const u of unlisted) {
			console.warn(`  - ${prefix}${u}.${ext}`);
		}
		console.warn(
			"  请将其加入 categories.json 的对应分组（text / animated / static）中后重新运行。\n",
		);
	}

	// 3. 构建标准 info.json
	const manifest: StickerManifest = {
		name: categories.name,
		prefix: categories.prefix,
		type: categories.type,
		icon: categories.icon || sortedItems[0] || "",
		items: sortedItems,
	};

	const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;

	// 4. 写入目标目录（内容仓与主代码仓）
	const writeTargets = [mainPackDir];
	if (contentPackDir && fs.existsSync(contentPackDir)) {
		writeTargets.push(contentPackDir);
	}

	for (const dir of writeTargets) {
		const infoPath = path.join(dir, "info.json");
		fs.writeFileSync(infoPath, manifestContent, "utf-8");

		// 同步 categories.json
		const catPath = path.join(dir, "categories.json");
		fs.writeFileSync(
			catPath,
			`${JSON.stringify(categories, null, 2)}\n`,
			"utf-8",
		);
		console.log(`[sticker:sort] ✅ 已更新并排序: ${infoPath}`);
	}

	console.log(`\n🎉 贴纸包 [${categories.name}] 排序完成！`);
	console.log(`  - 带文字表情: ${textItems.length} 个`);
	console.log(`  - 纯动态表情: ${animatedItems.length} 个`);
	console.log(`  - 普通静态表情: ${staticItems.length} 个`);
	console.log(`  - 贴纸总计: ${sortedItems.length} 个`);
}

// CLI 直接运行入口
const args = process.argv.slice(2);
const packName = args.find((a) => !a.startsWith("-")) || "miku";
syncAndSortStickers(packName);
