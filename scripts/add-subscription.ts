import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import Parser from "rss-parser";

interface SubscriptionEntry {
	title: string;
	feedUrl: string;
	siteurl?: string;
	imgurl?: string;
	desc?: string;
	tags?: string[];
	enabled?: boolean;
}

interface DiscoveredFeed {
	feedUrl: string;
	title: string;
	siteurl: string;
	imgurl?: string;
	desc?: string;
	itemCount: number;
	format: "RSS" | "Atom" | "JSON Feed";
}

const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const BROWSER_HEADERS = {
	"User-Agent": BROWSER_UA,
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml,application/atom+xml,application/feed+json,application/json,*/*;q=0.8",
	"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

const parser = new Parser({
	timeout: 8000,
	headers: {
		"User-Agent": BROWSER_UA,
		Accept:
			"application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
	},
	customFields: {
		item: ["pubDate", "date", "updated"],
	},
});

/**
 * 规范化 URL 并处理相对路径
 */
function resolveUrl(relativeOrAbsolute: string, baseUrl: string): string {
	try {
		return new URL(relativeOrAbsolute, baseUrl).toString();
	} catch {
		return relativeOrAbsolute;
	}
}

/**
 * 尝试直接解析 Feed (RSS/Atom/JSON Feed)
 */
async function tryParseFeedDirectly(
	feedUrl: string,
	fallbackSiteUrl?: string,
): Promise<DiscoveredFeed | null> {
	// 1. 优先尝试 rss-parser 解析 XML (RSS 2.0 / 1.0 或 Atom)
	try {
		const parsed = await parser.parseURL(feedUrl);
		if (parsed && (parsed.title || parsed.items?.length > 0)) {
			let format: "RSS" | "Atom" = "RSS";
			// 简单的 Atom 格式特征识别
			if (
				parsed.feedUrl?.includes("atom") ||
				feedUrl.includes("atom") ||
				(parsed as Record<string, unknown>).xmlns?.toString().includes("Atom")
			) {
				format = "Atom";
			}

			const siteurl =
				parsed.link && parsed.link.startsWith("http")
					? parsed.link
					: fallbackSiteUrl || new URL(feedUrl).origin;

			let imgurl = parsed.image?.url;
			if (!imgurl && (parsed as Record<string, unknown>).icon) {
				imgurl = String((parsed as Record<string, unknown>).icon);
			}

			return {
				feedUrl,
				title: parsed.title?.trim() || new URL(siteurl).hostname,
				siteurl,
				imgurl,
				desc: parsed.description?.trim(),
				itemCount: parsed.items?.length || 0,
				format,
			};
		}
	} catch {
		// 继续尝试 JSON Feed
	}

	// 2. 尝试 JSON Feed
	try {
		const res = await fetch(feedUrl, {
			headers: BROWSER_HEADERS,
			signal: AbortSignal.timeout(8000),
		});
		if (res.ok) {
			const text = await res.text();
			if (text.trim().startsWith("{")) {
				const json = JSON.parse(text);
				if (Array.isArray(json.items) || json.version?.includes("jsonfeed")) {
					const siteurl =
						json.home_page_url || fallbackSiteUrl || new URL(feedUrl).origin;
					return {
						feedUrl,
						title: json.title || new URL(siteurl).hostname,
						siteurl,
						imgurl: json.icon || json.favicon,
						desc: json.description,
						itemCount: json.items?.length || 0,
						format: "JSON Feed",
					};
				}
			}
		}
	} catch {
		// 忽略
	}

	return null;
}

/**
 * 从 HTML 页面中嗅探 <link rel="alternate"> 订阅标签
 */
function extractFeedLinksFromHtml(html: string, baseUrl: string): string[] {
	const links: string[] = [];
	const linkTagRegex = /<link\s+[^>]*rel=["']alternate["'][^>]*>/gi;
	let match: RegExpExecArray | null;

	while (true) {
		match = linkTagRegex.exec(html);
		if (!match) break;
		const tag = match[0];
		const typeMatch = tag.match(/type=["']([^"']+)["']/i);
		const hrefMatch = tag.match(/href=["']([^"']+)["']/i);

		if (hrefMatch && hrefMatch[1]) {
			const type = typeMatch ? typeMatch[1].toLowerCase() : "";
			if (
				type.includes("rss") ||
				type.includes("atom") ||
				type.includes("feed") ||
				type.includes("xml") ||
				type.includes("json") ||
				hrefMatch[1].endsWith(".xml") ||
				hrefMatch[1].endsWith(".json")
			) {
				const resolved = resolveUrl(hrefMatch[1], baseUrl);
				if (!links.includes(resolved)) {
					links.push(resolved);
				}
			}
		}
	}

	return links;
}

/**
 * 从 HTML 页面提取图标 (favicon / apple-touch-icon) 和站点标题
 */
function extractMetadataFromHtml(
	html: string,
	baseUrl: string,
): { title?: string; favicon?: string } {
	let title: string | undefined;
	let favicon: string | undefined;

	const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
	if (titleMatch?.[1]) {
		title = titleMatch[1].trim();
	}

	const iconMatch = html.match(
		/<link\s+[^>]*rel=["'](?:shortcut )?icon|apple-touch-icon["'][^>]*>/gi,
	);
	if (iconMatch) {
		for (const tag of iconMatch) {
			const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
			if (hrefMatch?.[1]) {
				favicon = resolveUrl(hrefMatch[1], baseUrl);
				break;
			}
		}
	}

	return { title, favicon };
}

/**
 * 智能 Feed 嗅探与识别全流程
 */
async function autoDiscoverFeed(inputUrl: string): Promise<DiscoveredFeed> {
	let targetUrl = inputUrl.trim();
	if (!/^https?:\/\//i.test(targetUrl)) {
		targetUrl = `https://${targetUrl}`;
	}

	console.log(`🔍 [嗅探引擎] 正在分析输入链接: ${targetUrl}`);

	// 阶段 1: 直接作为 Feed 解析
	const directFeed = await tryParseFeedDirectly(targetUrl);
	if (directFeed && directFeed.itemCount > 0) {
		console.log(
			`✨ [嗅探引擎] 直接识别成功！协议格式: ${directFeed.format}，包含 ${directFeed.itemCount} 篇文章`,
		);
		return directFeed;
	}

	// 阶段 2: 作为普通网页获取，嗅探 HTML 中的 Feed Link 与元数据
	console.log(
		"🌐 [嗅探引擎] 未直接匹配 Feed，正在抓取网页 HTML 查找订阅标签...",
	);
	let html = "";
	let finalUrl = targetUrl;
	let htmlMeta: { title?: string; favicon?: string } = {};

	try {
		const res = await fetch(targetUrl, {
			headers: BROWSER_HEADERS,
			signal: AbortSignal.timeout(10000),
			redirect: "follow",
		});
		if (res.ok) {
			finalUrl = res.url || targetUrl;
			html = await res.text();
			htmlMeta = extractMetadataFromHtml(html, finalUrl);
		}
	} catch (e) {
		console.warn(`⚠️ [嗅探引擎] 网页抓取受阻: ${(e as Error).message}`);
	}

	if (html) {
		const discoveredLinks = extractFeedLinksFromHtml(html, finalUrl);
		if (discoveredLinks.length > 0) {
			console.log(
				`📑 [嗅探引擎] 从页面 HTML 嗅探到 ${discoveredLinks.length} 个潜在订阅源:`,
				discoveredLinks,
			);
			for (const link of discoveredLinks) {
				const feed = await tryParseFeedDirectly(link, finalUrl);
				if (feed) {
					console.log(
						`🎉 [嗅探引擎] 成功匹配订阅源: ${link} (${feed.format}，共 ${feed.itemCount} 篇动态)`,
					);
					if (!feed.imgurl && htmlMeta.favicon) feed.imgurl = htmlMeta.favicon;
					if (!feed.title && htmlMeta.title) feed.title = htmlMeta.title;
					return feed;
				}
			}
		}
	}

	// 阶段 3: 常见后缀路径盲猜 Fallback
	console.log("⚡ [嗅探引擎] 页面未声明订阅标签，开始盲猜常见 Feed 路径...");
	const urlObj = new URL(finalUrl);
	const origin = urlObj.origin;

	const guessPaths = [
		`${finalUrl.replace(/\/+$/, "")}/atom.xml`,
		`${finalUrl.replace(/\/+$/, "")}/rss.xml`,
		`${finalUrl.replace(/\/+$/, "")}/feed/`,
		`${finalUrl.replace(/\/+$/, "")}/feed.xml`,
		`${finalUrl.replace(/\/+$/, "")}/index.xml`,
		`${finalUrl.replace(/\/+$/, "")}/feed`,
		`${origin}/atom.xml`,
		`${origin}/rss.xml`,
		`${origin}/feed/`,
		`${origin}/feed.xml`,
		`${origin}/index.xml`,
	];

	const uniqueGuessPaths = Array.from(new Set(guessPaths));
	for (const guessUrl of uniqueGuessPaths) {
		try {
			const feed = await tryParseFeedDirectly(guessUrl, finalUrl);
			if (feed && feed.itemCount > 0) {
				console.log(
					`🎯 [嗅探引擎] 成功探测到隐藏 Feed: ${guessUrl} (${feed.format}，共 ${feed.itemCount} 篇动态)`,
				);
				if (!feed.imgurl && htmlMeta.favicon) feed.imgurl = htmlMeta.favicon;
				if (!feed.title && htmlMeta.title) feed.title = htmlMeta.title;
				return feed;
			}
		} catch {
			// 继续盲猜
		}
	}

	// 若直接解析虽无 items 但至少是合法 feed
	if (directFeed) {
		return directFeed;
	}

	throw new Error(
		`未能从该地址（${targetUrl}）识别到有效的 RSS、Atom 或 JSON Feed 订阅源。请检查链接是否正确或提供具体的 Feed 地址。`,
	);
}

/**
 * 往 subscriptionConfig.ts 中插入新订阅源
 */
function insertSubscriptionToConfig(
	filePath: string,
	entry: SubscriptionEntry,
) {
	if (!fs.existsSync(filePath)) {
		throw new Error(`配置文件不存在: ${filePath}`);
	}

	const content = fs.readFileSync(filePath, "utf-8");

	// 查重
	if (content.includes(entry.feedUrl)) {
		throw new Error(`订阅地址已存在于配置文件中: ${entry.feedUrl}`);
	}

	const tags = entry.tags && entry.tags.length > 0 ? entry.tags : ["订阅"];
	const newCode = `\t{\n\t\ttitle: ${JSON.stringify(entry.title)},\n\t\tsiteurl: ${JSON.stringify(entry.siteurl || "")},\n\t\tfeedUrl: ${JSON.stringify(entry.feedUrl)},\n\t\timgurl: ${JSON.stringify(entry.imgurl || "")},\n\t\tdesc: ${JSON.stringify(entry.desc || "")},\n\t\ttags: ${JSON.stringify(tags)},\n\t\tenabled: true,\n\t},`;

	const targetPattern =
		/export const subscriptionConfig: FeedSubscription\[\] = \[([\s\S]*?)\];/;
	if (!targetPattern.test(content)) {
		throw new Error(
			"未能匹配到 export const subscriptionConfig: FeedSubscription[] = [...] 结构",
		);
	}

	const updated = content.replace(targetPattern, (_match, inner) => {
		const trimmed = inner.trim();
		if (!trimmed) {
			return `export const subscriptionConfig: FeedSubscription[] = [\n${newCode}\n];`;
		}
		return `export const subscriptionConfig: FeedSubscription[] = [\n\t${trimmed}\n${newCode}\n];`;
	});

	fs.writeFileSync(filePath, updated, "utf-8");
}

/**
 * 寻找内容仓目标配置文件路径
 */
function resolveConfigFile(): {
	configFile: string;
	isContentRepo: boolean;
	contentRepoDir: string;
} {
	const envDir = process.env.CONTENT_REPO_DIR;
	if (envDir && fs.existsSync(envDir)) {
		return {
			configFile: path.resolve(envDir, "config/subscriptionConfig.ts"),
			isContentRepo: true,
			contentRepoDir: path.resolve(envDir),
		};
	}

	const sibling = path.resolve("../lengxiqwq-site-content");
	if (fs.existsSync(sibling)) {
		return {
			configFile: path.resolve(sibling, "config/subscriptionConfig.ts"),
			isContentRepo: true,
			contentRepoDir: sibling,
		};
	}

	const ciContentRepo = path.resolve(".content-repo");
	if (fs.existsSync(ciContentRepo)) {
		return {
			configFile: path.resolve(ciContentRepo, "config/subscriptionConfig.ts"),
			isContentRepo: true,
			contentRepoDir: ciContentRepo,
		};
	}

	// 回退至当前仓库（仅本地测试或无独立内容仓时）
	return {
		configFile: path.resolve("src/config/subscriptionConfig.ts"),
		isContentRepo: false,
		contentRepoDir: path.resolve("."),
	};
}

async function main() {
	const isCi =
		process.argv.includes("--ci") || process.env.CI === "true" || false;

	console.log("=========================================");
	console.log("   📡 独立订阅源智能识别与录入系统 📡   ");
	console.log("=========================================\n");

	let inputFeedUrl = process.env.INPUT_FEED_URL || "";
	const inputTitle = process.env.INPUT_TITLE || "";
	const inputAvatar = process.env.INPUT_AVATAR || "";
	const inputDesc = process.env.INPUT_DESC || "";
	const inputTags = process.env.INPUT_TAGS || "";

	// 支持命令行直接传参：pnpm add-feed <url>
	if (!inputFeedUrl && process.argv[2] && !process.argv[2].startsWith("-")) {
		inputFeedUrl = process.argv[2];
	}

	// 交互式输入模式
	if (!isCi && !inputFeedUrl) {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		while (!inputFeedUrl) {
			inputFeedUrl = (
				await rl.question(
					"🔗 请输入订阅链接或博客主页 (系统全自动识别 RSS/Atom/JSON): ",
				)
			).trim();
		}

		rl.close();
	}

	if (!inputFeedUrl) {
		console.error("❌ 错误: 未提供订阅地址或主页 URL");
		process.exit(1);
	}

	// 执行自动嗅探与识别
	const discovered = await autoDiscoverFeed(inputFeedUrl);

	// 允许用户覆盖提取到的信息
	const finalTitle = inputTitle.trim() || discovered.title;
	const finalSiteUrl = discovered.siteurl;
	const finalFeedUrl = discovered.feedUrl;
	const finalImgUrl =
		inputAvatar.trim() ||
		discovered.imgurl ||
		`${finalSiteUrl.replace(/\/$/, "")}/favicon.ico`;
	const finalDesc = inputDesc.trim() || discovered.desc || "";
	const tags = inputTags
		? inputTags
				.split(/[,，]/)
				.map((t) => t.trim())
				.filter(Boolean)
		: ["订阅"];

	console.log("\n📋 识别结果汇总：");
	console.log(`- 站点/源名称: ${finalTitle}`);
	console.log(`- 订阅源地址: ${finalFeedUrl}`);
	console.log(`- 站点主页:   ${finalSiteUrl}`);
	console.log(`- 协议格式:   ${discovered.format}`);
	console.log(`- 图标/头像:  ${finalImgUrl}`);
	console.log(`- 简介描述:   ${finalDesc || "(无)"}`);
	console.log(`- 分类标签:   ${tags.join(", ")}`);
	console.log(`- 最新动态数: ${discovered.itemCount} 篇\n`);

	const entry: SubscriptionEntry = {
		title: finalTitle,
		siteurl: finalSiteUrl,
		feedUrl: finalFeedUrl,
		imgurl: finalImgUrl,
		desc: finalDesc,
		tags,
		enabled: true,
	};

	const { configFile, isContentRepo, contentRepoDir } = resolveConfigFile();

	// 若配置文件不存在，先从模板创建
	if (!fs.existsSync(configFile)) {
		console.log(`📄 正在初始化配置文件: ${configFile}`);
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(
			configFile,
			`import type { FeedSubscription } from "../types/subscriptionConfig";\n\nexport const subscriptionConfig: FeedSubscription[] = [\n];\n\nexport const getEnabledSubscriptions = (): FeedSubscription[] => {\n\treturn subscriptionConfig.filter((sub) => sub.enabled !== false);\n};\n`,
			"utf-8",
		);
	}

	// 写入配置
	insertSubscriptionToConfig(configFile, entry);
	console.log(`✅ 成功将订阅源写入: ${configFile}`);

	// 同步到本地（若是双仓库模式）
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

	// 格式化代码
	try {
		execSync(`npx biome format --write "${configFile}"`, { stdio: "ignore" });
	} catch {
		// 忽略
	}

	// 本地非 CI 环境下自动 commit & push 内容仓
	if (isContentRepo && !isCi && !process.argv.includes("--no-push")) {
		console.log("\n🚀 正在提交并推送到私有内容仓...");
		try {
			execSync("git add config/subscriptionConfig.ts", { cwd: contentRepoDir });
			execSync(
				`git commit -m "feat: 新增订阅源 - ${finalTitle.replace(/"/g, "")}"`,
				{ cwd: contentRepoDir },
			);
			execSync("git push origin main", { cwd: contentRepoDir });
			console.log("✅ 内容仓已推送，全站构建部署已触发！");
		} catch (err: unknown) {
			console.warn(
				"⚠️ 内容仓推送跳过或失败 (可稍后手动推送):",
				(err as Error).message,
			);
		}
	}

	console.log("\n🎉 大功告成！订阅源已成功添加：");
	console.log(
		`   「${finalTitle}」(${discovered.format}) -> ${finalFeedUrl}\n`,
	);
}

main().catch((err) => {
	console.error("\n❌ 添加订阅源失败:", err.message);
	process.exit(1);
});
