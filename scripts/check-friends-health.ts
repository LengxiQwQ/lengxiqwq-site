import fs from "node:fs";
import path from "node:path";

// ---------- 类型定义 ----------
interface FriendHealthRecord {
	failCount: number;
	lastChecked: string; // ISO 时间戳
	lastError?: string;
}

type HealthData = Record<string, FriendHealthRecord>;

interface FriendLinkEntry {
	title: string;
	siteurl: string;
	enabled: boolean;
}

// ---------- 配置 ----------
const HEALTH_FILE = path.resolve("src/constants/friends-health.json");
const TIMEOUT_MS = 12_000;

// 伪装浏览器请求头，避免被防爬策略误拦
const BROWSER_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
	"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
	"sec-ch-ua":
		'"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
	"sec-ch-ua-mobile": "?0",
	"sec-ch-ua-platform": '"Windows"',
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
	"Cache-Control": "max-age=0",
};

// ---------- 探测函数 ----------
async function checkUrl(
	url: string,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
		const res = await fetch(url, {
			signal: controller.signal,
			headers: BROWSER_HEADERS,
			redirect: "follow",
		});
		clearTimeout(timeoutId);
		if (!res.ok) {
			return { ok: false, error: `HTTP ${res.status} ${res.statusText}` };
		}
		return { ok: true };
	} catch (err: unknown) {
		const e = err as Error;
		if (e.name === "AbortError") {
			return { ok: false, error: `超时 (>${TIMEOUT_MS / 1000}s)` };
		}
		return { ok: false, error: e.message || String(e) };
	}
}

// ---------- 主函数 ----------
async function run() {
	console.log("[friends-health] 开始友链健康检测...");

	// 读取当前已同步好的 friendsConfig（纯文本解析，避免 TS import 兼容问题）
	const configPath = path.resolve("src/config/friendsConfig.ts");
	if (!fs.existsSync(configPath)) {
		console.log("[friends-health] 未找到 friendsConfig.ts，跳过检测");
		return;
	}

	const configContent = fs.readFileSync(configPath, "utf-8");

	// 从 TS 源码中提取友链条目（解析 siteurl、title、enabled）
	const entries: FriendLinkEntry[] = [];
	const entryRegex =
		/\{[^{}]*?title:\s*"([^"]*)"[^{}]*?siteurl:\s*"([^"]*)"[^{}]*?enabled:\s*(true|false)[^{}]*?\}/g;
	let match: RegExpExecArray | null;
	while (true) {
		match = entryRegex.exec(configContent);
		if (!match) break;
		entries.push({
			title: match[1],
			siteurl: match[2],
			enabled: match[3] === "true",
		});
	}

	// 只检测 enabled 的友链
	const enabledFriends = entries.filter((f) => f.enabled);

	if (enabledFriends.length === 0) {
		console.log("[friends-health] 没有启用的友链需要检测");
		return;
	}

	// 读取历史状态
	let healthData: HealthData = {};
	if (fs.existsSync(HEALTH_FILE)) {
		try {
			healthData = JSON.parse(fs.readFileSync(HEALTH_FILE, "utf-8"));
		} catch {
			console.warn(
				"[friends-health] 无法解析历史状态文件，将重新初始化",
			);
			healthData = {};
		}
	}

	// 逐个探测
	console.log(
		`[friends-health] 共 ${enabledFriends.length} 个启用的友链需要检测`,
	);

	for (const friend of enabledFriends) {
		const url = friend.siteurl;
		const result = await checkUrl(url);
		const prev = healthData[url] || { failCount: 0, lastChecked: "" };

		if (result.ok) {
			if (prev.failCount > 0) {
				console.log(
					`[friends-health] ✅ ${friend.title} (${url}) 恢复正常（之前连续失败 ${prev.failCount} 次）`,
				);
			} else {
				console.log(
					`[friends-health] ✅ ${friend.title} (${url})`,
				);
			}
			healthData[url] = {
				failCount: 0,
				lastChecked: new Date().toISOString(),
			};
		} else {
			const newCount = prev.failCount + 1;
			console.log(
				`[friends-health] ❌ ${friend.title} (${url}) - 连续失败 #${newCount}: ${result.error}`,
			);
			healthData[url] = {
				failCount: newCount,
				lastChecked: new Date().toISOString(),
				lastError: result.error,
			};
		}
	}

	// 清理不再存在于配置中的旧记录
	const currentUrls = new Set(enabledFriends.map((f) => f.siteurl));
	for (const url of Object.keys(healthData)) {
		if (!currentUrls.has(url)) {
			delete healthData[url];
		}
	}

	// 确保目录存在
	const dir = path.dirname(HEALTH_FILE);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	// 写入状态文件
	fs.writeFileSync(
		HEALTH_FILE,
		JSON.stringify(healthData, null, "\t"),
		"utf-8",
	);

	// 汇总报告
	const quarantined = Object.entries(healthData).filter(
		([, v]) => v.failCount >= 3,
	);
	const failing = Object.entries(healthData).filter(
		([, v]) => v.failCount > 0 && v.failCount < 3,
	);

	if (failing.length > 0) {
		console.log(
			`\n[friends-health] ⚠️ 以下 ${failing.length} 个友链出现异常（尚未达到隔离阈值）:`,
		);
		for (const [url, data] of failing) {
			console.log(
				`  - ${url} (连续失败 ${data.failCount}/3 次, 最后错误: ${data.lastError})`,
			);
		}
	}

	if (quarantined.length > 0) {
		console.log(
			`\n[friends-health] 🚫 以下 ${quarantined.length} 个友链已被隔离（连续失败 ≥3 次）:`,
		);
		for (const [url, data] of quarantined) {
			console.log(
				`  - ${url} (连续失败 ${data.failCount} 次, 最后错误: ${data.lastError})`,
			);
		}
	}

	if (quarantined.length === 0 && failing.length === 0) {
		console.log("\n[friends-health] 🎉 所有友链均正常！");
	}

	console.log("[friends-health] 友链健康检测完成");
}

run().catch((err) => {
	console.error("[friends-health] 检测过程中发生错误:", err);
	// 不阻断构建流程，仅警告
	process.exit(0);
});
