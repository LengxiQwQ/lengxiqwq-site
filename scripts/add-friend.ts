import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

interface FriendEntry {
	title: string;
	siteurl: string;
	desc: string;
	imgurl: string;
	tags?: string[];
}

// 尝试从单段多行文本中解析友链字段
function tryParsePastedText(text: string): Partial<FriendEntry> | null {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length < 2) return null;

	const result: Partial<FriendEntry> = {};

	for (const line of lines) {
		const match = line.match(/^([^:：]+)[:：]\s*(.*)$/);
		if (match) {
			const key = match[1].trim();
			const val = match[2].trim();
			if (/名称|标题|name|title/i.test(key)) result.title = val;
			else if (/链接|网址|地址|url|site/i.test(key)) result.siteurl = val;
			else if (/头像|avatar|img|icon/i.test(key)) result.imgurl = val;
			else if (/描述|介绍|简介|desc|bio/i.test(key)) result.desc = val;
			else if (/分类|标签|tag/i.test(key))
				result.tags = [val.replace(/[[\]"]/g, "").trim()];
		}
	}

	if (result.title && result.siteurl) {
		if (!result.tags || result.tags.length === 0) {
			result.tags = ["博客"];
		}
		return result;
	}
	return null;
}

// 往指定的 friendsConfig.ts 中插入新友链
function insertFriendToConfig(filePath: string, entry: FriendEntry) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`文件不存在: ${filePath}`);
	}

	const content = fs.readFileSync(filePath, "utf-8");

	// 查重
	if (content.includes(entry.siteurl)) {
		throw new Error(`站点链接已存在于 ${filePath} 中: ${entry.siteurl}`);
	}

	const tags = entry.tags && entry.tags.length > 0 ? entry.tags : ["博客"];
	const newCode = `\t{\n\t\ttitle: ${JSON.stringify(entry.title)},\n\t\tdesc: ${JSON.stringify(entry.desc)},\n\t\tsiteurl: ${JSON.stringify(entry.siteurl)},\n\t\timgurl: ${JSON.stringify(entry.imgurl)},\n\t\ttags: ${JSON.stringify(tags)},\n\t\tweight: 1,\n\t\tenabled: true,\n\t},`;

	const targetPattern =
		/export const friendsConfig: FriendLink\[\] = \[([\s\S]*?)\];/;
	if (!targetPattern.test(content)) {
		throw new Error(
			"未能匹配到 export const friendsConfig: FriendLink[] = [...] 结构",
		);
	}

	const updated = content.replace(targetPattern, (_match, inner) => {
		const trimmed = inner.trim();
		if (!trimmed) {
			return `export const friendsConfig: FriendLink[] = [\n${newCode}\n];`;
		}
		return `export const friendsConfig: FriendLink[] = [\n${newCode}\n\t${trimmed}\n];`;
	});

	fs.writeFileSync(filePath, updated, "utf-8");
}

async function main() {
	console.log("=========================================");
	console.log("    ✨ 冷汐的杂货铺 - 博主快捷添加友链 ✨   ");
	console.log("=========================================\n");

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	let title = "";
	let siteurl = "";
	let desc = "";
	let imgurl = "";
	let tags: string[] = ["博客"];

	// 先提示是否直接粘贴整段文字
	const firstInput = await rl.question(
		"【提示】可直接粘贴整段友链信息（如包含 名称:xxx 链接:xxx），或直接按回车进行分步输入：\n> ",
	);

	const parsed = tryParsePastedText(firstInput);
	if (parsed?.title && parsed.siteurl && parsed.desc && parsed.imgurl) {
		console.log("\n🚀 成功识别粘贴的多行信息：");
		console.log(`- 站点名称: ${parsed.title}`);
		console.log(`- 站点链接: ${parsed.siteurl}`);
		console.log(`- 站点描述: ${parsed.desc}`);
		console.log(`- 头像链接: ${parsed.imgurl}`);
		console.log(`- 分类标签: ${parsed.tags?.join(", ") || "博客"}\n`);

		const confirm = await rl.question("确认使用上述信息添加吗？(Y/n) ");
		if (!confirm || confirm.toLowerCase() === "y") {
			title = parsed.title;
			siteurl = parsed.siteurl;
			desc = parsed.desc;
			imgurl = parsed.imgurl;
			if (parsed.tags && parsed.tags.length > 0) {
				tags = parsed.tags;
			}
		}
	}

	// 若未通过整段粘贴解析，则进入分步交互输入
	if (!title || !siteurl) {
		if (firstInput && !parsed) {
			title = firstInput.trim();
		} else {
			while (!title) {
				title = (await rl.question("1. 请输入站点名称: ")).trim();
			}
		}

		while (!siteurl) {
			siteurl = (
				await rl.question("2. 请输入站点主页链接 (https://...): ")
			).trim();
		}

		while (!desc) {
			desc = (await rl.question("3. 请输入站点描述/介绍: ")).trim();
		}

		while (!imgurl) {
			imgurl = (await rl.question("4. 请输入头像图片链接: ")).trim();
		}

		const tagInput = (
			await rl.question(
				"5. 请输入分类标签 (直接回车默认 [博客]，可选输入 导航 等): ",
			)
		).trim();
		tags = tagInput ? [tagInput] : ["博客"];
	}

	rl.close();

	const entry: FriendEntry = { title, siteurl, desc, imgurl, tags };

	console.log("\n⏳ 正在更新配置文件...");

	// 1. 查找内容仓
	const contentRepoDir = path.resolve("../lengxiqwq-site-content");
	const contentConfigFile = path.join(
		contentRepoDir,
		"config/friendsConfig.ts",
	);

	if (!fs.existsSync(contentConfigFile)) {
		console.error(`❌ 未找到私有内容仓配置文件: ${contentConfigFile}`);
		process.exit(1);
	}

	// 2. 写入内容仓
	insertFriendToConfig(contentConfigFile, entry);
	console.log(`✅ 已写入内容仓: ${contentConfigFile}`);

	// 3. 自动同步到本地开发环境
	console.log("⏳ 正在同步内容到本地工作区...");
	try {
		execSync("npx tsx scripts/sync-content.ts", {
			stdio: "inherit",
			cwd: path.resolve("."),
		});
	} catch {
		// 忽略
	}

	// 4. 执行格式化
	try {
		execSync("npx biome format --write src/config/friendsConfig.ts", {
			stdio: "ignore",
		});
	} catch {
		// 忽略
	}

	// 5. 自动 git commit & push (仅限内容仓)
	const autoPush = !process.argv.includes("--no-push");

	if (autoPush) {
		console.log("\n🚀 正在提交并推送到私有内容仓 (触发全站构建部署)...");
		try {
			execSync("git add config/friendsConfig.ts", { cwd: contentRepoDir });
			execSync('git commit -m "feat: 新增友链"', { cwd: contentRepoDir });
			execSync("git push origin main", { cwd: contentRepoDir });
			console.log("✅ 内容仓已成功推送至远程，部署流程已触发！");
		} catch (err: unknown) {
			console.error(
				"❌ 内容仓推送失败，请手动检查 git 状态:",
				(err as Error).message,
			);
		}
	} else {
		console.log(
			"\n💡 已跳过自动 push (--no-push)。请稍后手动检查并提交内容仓。",
		);
	}

	console.log("\n🎉 大功告成！友链已成功添加：");
	console.log(`   「${title}」-> ${siteurl}\n`);
}

main().catch((err) => {
	console.error("\n❌ 添加友链出错:", err.message);
	process.exit(1);
});
