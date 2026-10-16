import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

interface SponsorItem {
	name: string;
	avatar?: string;
	amount: string;
	date: string;
	message?: string;
}

/**
 * 寻找目标配置文件路径（支持双仓库架构与 CI 环境）
 */
function resolveConfigFile(): {
	configFile: string;
	isContentRepo: boolean;
	contentRepoDir: string;
} {
	const envDir = process.env.CONTENT_REPO_DIR;
	if (envDir && fs.existsSync(envDir)) {
		return {
			configFile: path.resolve(envDir, "config/sponsorConfig.ts"),
			isContentRepo: true,
			contentRepoDir: path.resolve(envDir),
		};
	}

	const ciContentRepo = path.resolve(".content-repo");
	if (fs.existsSync(ciContentRepo)) {
		return {
			configFile: path.resolve(ciContentRepo, "config/sponsorConfig.ts"),
			isContentRepo: true,
			contentRepoDir: ciContentRepo,
		};
	}

	const sibling = path.resolve("../lengxiqwq-site-content");
	if (fs.existsSync(sibling)) {
		return {
			configFile: path.resolve(sibling, "config/sponsorConfig.ts"),
			isContentRepo: true,
			contentRepoDir: sibling,
		};
	}

	// 回退至当前仓库（仅本地测试或无独立内容仓时）
	return {
		configFile: path.resolve("src/config/sponsorConfig.ts"),
		isContentRepo: false,
		contentRepoDir: path.resolve("."),
	};
}

/**
 * 获取当前时间的东八区 ISO 格式时间字符串 (YYYY-MM-DDTHH:mm:ss)
 */
function getNowIsoString(): string {
	const now = new Date();
	const formatter = new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	const parts = formatter.formatToParts(now);
	const getPart = (type: string) =>
		parts.find((p) => p.type === type)?.value || "00";
	return `${getPart("year")}-${getPart("month")}-${getPart("day")}T${getPart("hour")}:${getPart("minute")}:${getPart("second")}`;
}

/**
 * 规范化日期时间
 */
function normalizeDate(rawDate?: string): string {
	const trimmed = (rawDate || "").trim();
	if (!trimmed) {
		return getNowIsoString();
	}

	// 纯日期格式 YYYY-MM-DD，补齐时分秒
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		return `${trimmed}T12:00:00`;
	}

	// 支持带空格格式转换 (如 "2026-10-16 15:30:00")
	const candidate = trimmed.replace(" ", "T");
	const parsed = new Date(candidate);
	if (Number.isNaN(parsed.getTime())) {
		console.warn(`⚠️ 日期格式未能标准识别 ("${trimmed}")，将保留输入原文本`);
		return trimmed;
	}

	return candidate;
}

/**
 * 规范化打赏金额
 */
function normalizeAmount(rawAmount: string): string {
	const trimmed = (rawAmount || "").trim();
	if (!trimmed) {
		throw new Error("打赏金额为必填项，不可为空！");
	}

	// 纯数字或纯小数自动补齐人民币符号 ¥
	if (/^\d+(\.\d+)?$/.test(trimmed)) {
		return `¥${trimmed}`;
	}

	return trimmed;
}

/**
 * 规范化头像链接
 */
function normalizeAvatar(rawAvatar?: string): string | undefined {
	const trimmed = (rawAvatar || "").trim();
	if (!trimmed) return undefined;

	if (
		trimmed.startsWith("http://") ||
		trimmed.startsWith("https://") ||
		trimmed.startsWith("/") ||
		trimmed.startsWith("data:")
	) {
		return trimmed;
	}

	if (trimmed.startsWith("//")) {
		return `https:${trimmed}`;
	}

	if (trimmed.includes(".")) {
		return `https://${trimmed}`;
	}

	return trimmed;
}

/**
 * 将打赏记录安全写入 sponsorConfig.ts 中的 sponsors 数组头部
 */
function insertSponsorToConfig(filePath: string, entry: SponsorItem) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`配置文件不存在: ${filePath}`);
	}

	const content = fs.readFileSync(filePath, "utf-8");

	const lines = [
		"\t\t{",
		`\t\t\tname: ${JSON.stringify(entry.name)},`,
		`\t\t\tamount: ${JSON.stringify(entry.amount)},`,
	];
	if (entry.avatar) {
		lines.push(`\t\t\tavatar: ${JSON.stringify(entry.avatar)},`);
	}
	lines.push(`\t\t\tdate: ${JSON.stringify(entry.date)},`);
	if (entry.message) {
		lines.push(`\t\t\tmessage: ${JSON.stringify(entry.message)},`);
	}
	lines.push("\t\t},");
	const newEntryCode = lines.join("\n");

	const match = content.match(/sponsors\s*:\s*\[/);
	if (!match || match.index === undefined) {
		const exportMatch = content.match(
			/export\s+const\s+sponsorConfig\s*:\s*SponsorConfig\s*=\s*\{/,
		);
		if (exportMatch && exportMatch.index !== undefined) {
			const insertIndex = exportMatch.index + exportMatch[0].length;
			const updated = `${content.slice(0, insertIndex)}\n\tsponsors: [\n${newEntryCode}\n\t],${content.slice(insertIndex)}`;
			fs.writeFileSync(filePath, updated, "utf-8");
			return;
		}
		throw new Error(
			"未能匹配到 sponsors 数组或 sponsorConfig 定义，请检查 sponsorConfig.ts 格式",
		);
	}

	const startIndex = match.index + match[0].length;
	let depth = 1;
	let endIndex = -1;
	for (let i = startIndex; i < content.length; i++) {
		if (content[i] === "[") depth++;
		else if (content[i] === "]") {
			depth--;
			if (depth === 0) {
				endIndex = i;
				break;
			}
		}
	}

	if (endIndex === -1) {
		throw new Error("未能找到 sponsors 数组对应的闭合中括号 ']'");
	}

	const inner = content.slice(startIndex, endIndex);
	const trimmedInner = inner.trim();

	let newArrayBody = "";
	if (!trimmedInner) {
		newArrayBody = `\n${newEntryCode}\n\t`;
	} else {
		newArrayBody = `\n${newEntryCode}\n\t\t${trimmedInner}\n\t`;
	}

	const updated =
		content.slice(0, startIndex) + newArrayBody + content.slice(endIndex);
	fs.writeFileSync(filePath, updated, "utf-8");
}

async function main() {
	const isCi =
		process.argv.includes("--ci") || process.env.CI === "true" || false;

	console.log("=========================================");
	console.log("      💖 打赏记录智能录入系统 💖         ");
	console.log("=========================================\n");

	let rawName = process.env.INPUT_NAME;
	let rawAmount = process.env.INPUT_AMOUNT;
	let rawAvatar = process.env.INPUT_AVATAR;
	let rawMessage = process.env.INPUT_MESSAGE;
	let rawDate = process.env.INPUT_DATE;

	// 本地交互式控制台模式
	if (!isCi && !rawAmount?.trim()) {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		try {
			rawName = await rl.question(
				"👤 打赏者昵称（选填，留空则默认为「匿名用户」）: ",
			);
			rawAmount = await rl.question("💰 打赏金额（必填，如 5、¥10、5元 等）: ");
			rawAvatar = await rl.question(
				"🖼️  头像图片链接（选填，公网 URL 或本地路径）: ",
			);
			rawMessage = await rl.question("💬 寄语 / 付款留言（选填）: ");
			rawDate = await rl.question(
				"📅 打赏时间（选填，留空则使用当前北京时间）: ",
			);
		} finally {
			rl.close();
		}
	}

	// 1. 处理打赏者名称（选填，默认“匿名用户”）
	const finalName = (rawName || "").trim() || "匿名用户";

	// 2. 处理打赏金额（必填）
	if (!rawAmount?.trim()) {
		console.error("❌ 错误：打赏金额必填！");
		process.exit(1);
	}
	const finalAmount = normalizeAmount(rawAmount);

	// 3. 处理头像链接（选填）
	const finalAvatar = normalizeAvatar(rawAvatar);

	// 4. 处理留言寄语（选填）
	const finalMessage = (rawMessage || "").trim() || undefined;

	// 5. 处理日期时间（选填，默认当前时间）
	const finalDate = normalizeDate(rawDate);

	const entry: SponsorItem = {
		name: finalName,
		amount: finalAmount,
		avatar: finalAvatar,
		date: finalDate,
		message: finalMessage,
	};

	// 解析目标配置文件路径
	const { configFile, isContentRepo, contentRepoDir } = resolveConfigFile();
	console.log(
		`📁 目标配置文件: ${configFile} (${isContentRepo ? "独立内容仓" : "主代码仓"})`,
	);

	// 写入配置文件
	insertSponsorToConfig(configFile, entry);
	console.log(`✅ 成功将打赏记录写入: ${configFile}`);

	// 格式化配置文件
	try {
		execSync(`npx biome format --write "${configFile}"`, { stdio: "ignore" });
	} catch {
		// 忽略格式化错误
	}

	// 本地双仓库模式下同步物化
	if (isContentRepo && fs.existsSync("scripts/sync-content.ts") && !isCi) {
		console.log("⏳ 正在同步至本地工作区...");
		try {
			execSync("npx tsx scripts/sync-content.ts", {
				stdio: "ignore",
				cwd: path.resolve("."),
			});
		} catch {
			// 忽略
		}
	}

	// 本地非 CI 环境下自动 commit & push 内容仓
	if (isContentRepo && !isCi && !process.argv.includes("--no-push")) {
		console.log("\n🚀 正在提交并推送到私有内容仓...");
		try {
			execSync("git add config/sponsorConfig.ts", { cwd: contentRepoDir });
			execSync(
				`git commit -m "feat: 新增打赏记录 (${finalName.replace(/"/g, "")})"`,
				{ cwd: contentRepoDir },
			);
			execSync("git push origin main", { cwd: contentRepoDir });
			console.log("✅ 内容仓已推送，全站构建部署已自动触发！");
		} catch (err: unknown) {
			console.warn(
				"⚠️ 内容仓推送跳过或失败 (可稍后手动推送):",
				(err as Error).message,
			);
		}
	}

	console.log("\n🎉 大功告成！打赏记录录入详情：");
	console.log(`   - 昵称: ${entry.name}`);
	console.log(`   - 金额: ${entry.amount}`);
	if (entry.avatar) console.log(`   - 头像: ${entry.avatar}`);
	console.log(`   - 时间: ${entry.date}`);
	if (entry.message) console.log(`   - 留言: ${entry.message}`);
	console.log("");
}

main().catch((err) => {
	console.error("\n❌ 添加打赏记录失败:", err.message);
	process.exit(1);
});
