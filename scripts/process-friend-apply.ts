import fs from "node:fs";
import path from "node:path";

interface FriendLinkEntry {
	title: string;
	desc: string;
	siteurl: string;
	imgurl: string;
	checkurl?: string;
}

const issueBody = process.env.ISSUE_BODY || "";
const issueNumber = process.env.ISSUE_NUMBER || "";
const contentRepoDir = process.env.CONTENT_REPO_DIR || ".content-repo";
const githubToken = process.env.GITHUB_TOKEN || "";
const githubRepo = process.env.GITHUB_REPOSITORY || "";
const forceBypass = process.env.FORCE_BYPASS === "true";

const TARGET_DOMAIN = "lengxiqwq.com";

// GitHub REST API 辅助函数
async function githubRequest(
	endpoint: string,
	method = "GET",
	data?: Record<string, unknown>,
) {
	if (!githubToken || !githubRepo) {
		console.log(
			`[mock-github] ${method} ${endpoint}:`,
			JSON.stringify(data || {}),
		);
		return null;
	}

	const url = `https://api.github.com/repos/${githubRepo}${endpoint}`;
	const res = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${githubToken}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "Firefly-Friend-Bot",
			"Content-Type": "application/json",
		},
		body: data ? JSON.stringify(data) : undefined,
	});

	if (!res.ok) {
		const text = await res.text();
		console.error(`GitHub API Error (${res.status} ${endpoint}): ${text}`);
	}
	return res;
}

// 在 Issue 发送回复
async function postComment(comment: string) {
	if (!issueNumber) return;
	await githubRequest(`/issues/${issueNumber}/comments`, "POST", {
		body: comment,
	});
}

// 添加 Issue 标签
async function addLabels(labels: string[]) {
	if (!issueNumber || labels.length === 0) return;
	await githubRequest(`/issues/${issueNumber}/labels`, "POST", {
		labels,
	});
}

// 移除 Issue 标签
async function removeLabel(label: string) {
	if (!issueNumber) return;
	try {
		await githubRequest(
			`/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
			"DELETE",
		);
	} catch {
		// 忽略标签不存在的错误
	}
}

// 关闭 Issue
async function closeIssue() {
	if (!issueNumber) return;
	await githubRequest(`/issues/${issueNumber}`, "PATCH", {
		state: "closed",
	});
}

// 解析 Issue Form markdown 内容
function parseIssueBody(body: string): Partial<FriendLinkEntry> {
	const result: Partial<FriendLinkEntry> = {};

	// 匹配各个段落标题与对应内容
	const fieldRegex = /###\s*([^\r\n]+)\r?\n+([\s\S]*?)(?=(?:\r?\n###\s*|$))/g;
	let match: RegExpExecArray | null;

	while (true) {
		match = fieldRegex.exec(body);
		if (!match) break;

		const fieldName = match[1].trim();
		const rawVal = match[2].trim();

		// 清洗字段值，如果用户填写了 _No response_ 或空则视为空
		const cleanVal =
			rawVal === "_No response_" || rawVal === "无" ? "" : rawVal;

		if (fieldName.includes("站点名称")) {
			result.title = cleanVal;
		} else if (fieldName.includes("站点链接")) {
			result.siteurl = cleanVal;
		} else if (fieldName.includes("头像链接")) {
			result.imgurl = cleanVal;
		} else if (fieldName.includes("站点描述")) {
			result.desc = cleanVal;
		} else if (fieldName.includes("友链所在页面")) {
			result.checkurl = cleanVal;
		}
	}

	return result;
}

// 规范化 URL，去除尾随斜杠
function normalizeUrl(urlStr: string): string {
	try {
		const u = new URL(urlStr.trim());
		let pathname = u.pathname;
		if (pathname.endsWith("/") && pathname !== "/") {
			pathname = pathname.slice(0, -1);
		}
		return `${u.protocol}//${u.host}${pathname === "/" ? "" : pathname}${u.search}`;
	} catch {
		return urlStr.trim();
	}
}

// 校验 URL 有效性
function isValidHttpUrl(string: string) {
	try {
		const url = new URL(string);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch (_) {
		return false;
	}
}

// 站点主页可访问性检测
async function verifySiteReachable(
	siteUrl: string,
): Promise<{ success: boolean; reason?: string }> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 12000);

		const response = await fetch(siteUrl, {
			signal: controller.signal,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 FireflyBot/1.0",
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
			redirect: "follow",
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			return {
				success: false,
				reason: `站点返回 HTTP 状态码: ${response.status} ${response.statusText}`,
			};
		}

		return { success: true };
	} catch (err: unknown) {
		const error = err as Error;
		if (error.name === "AbortError") {
			return { success: false, reason: "访问站点超时（超过 12 秒）" };
		}
		return {
			success: false,
			reason: `站点连接失败: ${error.message || String(error)}`,
		};
	}
}

// 头像图片链接可访问性检测
async function verifyAvatarReachable(
	imgUrl: string,
): Promise<{ success: boolean; reason?: string }> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000);

		const response = await fetch(imgUrl, {
			method: "GET",
			signal: controller.signal,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 FireflyBot/1.0",
				Accept:
					"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
			},
			redirect: "follow",
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			return {
				success: false,
				reason: `头像链接返回 HTTP 状态码: ${response.status} ${response.statusText}`,
			};
		}

		return { success: true };
	} catch (err: unknown) {
		const error = err as Error;
		if (error.name === "AbortError") {
			return { success: false, reason: "加载头像图片超时（超过 10 秒）" };
		}
		return {
			success: false,
			reason: `头像图片加载失败: ${error.message || String(error)}`,
		};
	}
}

// 反向链接网页抓取与检测
async function verifyBacklink(
	checkUrl: string,
): Promise<{ success: boolean; reason?: string }> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 15000);

		const response = await fetch(checkUrl, {
			signal: controller.signal,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 FireflyBot/1.0",
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
			redirect: "follow",
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			return {
				success: false,
				reason: `访问页面时返回 HTTP 状态码: ${response.status} ${response.statusText}`,
			};
		}

		const html = await response.text();
		const hasTarget = html.toLowerCase().includes(TARGET_DOMAIN);

		if (!hasTarget) {
			return {
				success: false,
				reason: `在页面内容中未找到本站域名（\`${TARGET_DOMAIN}\`）`,
			};
		}

		return { success: true };
	} catch (err: unknown) {
		const error = err as Error;
		if (error.name === "AbortError") {
			return { success: false, reason: "访问该页面超时（超过 15 秒）" };
		}
		return {
			success: false,
			reason: `请求失败: ${error.message || String(error)}`,
		};
	}
}

async function run() {
	console.log(`[friend-apply] 开始处理友链申请 Issue #${issueNumber}`);

	if (!issueBody) {
		console.error("未获取到 Issue 内容");
		process.exit(1);
	}

	const parsed = parseIssueBody(issueBody);

	// 必填项检查
	if (
		!parsed.title ||
		!parsed.siteurl ||
		!parsed.imgurl ||
		!parsed.desc ||
		!parsed.checkurl
	) {
		const missingFields: string[] = [];
		if (!parsed.title) missingFields.push("站点名称");
		if (!parsed.siteurl) missingFields.push("站点链接");
		if (!parsed.imgurl) missingFields.push("头像链接");
		if (!parsed.desc) missingFields.push("站点描述");
		if (!parsed.checkurl) missingFields.push("友链所在页面");

		const msg = `⚠️ **申请信息不完整**\n\n缺少以下必填字段：${missingFields.map((f) => `\`${f}\``).join("、")}。\n请编辑 Issue 补充完整后重试。`;
		await postComment(msg);
		await addLabels(["invalid-format"]);
		console.log(msg);
		return;
	}

	const title = parsed.title.trim();
	const siteurl = parsed.siteurl.trim();
	const imgurl = parsed.imgurl.trim();
	const desc = parsed.desc.trim();
	const checkurl = parsed.checkurl.trim();

	// URL 格式校验
	if (!isValidHttpUrl(siteurl)) {
		const msg = `⚠️ **站点链接格式不正确**\n\n您填写的站点链接 \`${siteurl}\` 不是合法的 http/https 网址，请检查后重新编辑。`;
		await postComment(msg);
		await addLabels(["invalid-format"]);
		console.log(msg);
		return;
	}

	if (!isValidHttpUrl(imgurl)) {
		const msg = `⚠️ **头像链接格式不正确**\n\n您填写的头像链接 \`${imgurl}\` 不是合法的 http/https 网址，请检查后重新编辑。`;
		await postComment(msg);
		await addLabels(["invalid-format"]);
		console.log(msg);
		return;
	}

	if (!isValidHttpUrl(checkurl)) {
		const msg = `⚠️ **友链所在页面格式不正确**\n\n您填写的检测页面链接 \`${checkurl}\` 不是合法的 http/https 网址，请检查后重新编辑。`;
		await postComment(msg);
		await addLabels(["invalid-format"]);
		console.log(msg);
		return;
	}

	// 检查内容仓中的 friendsConfig.ts 是否存在
	const configFile = path.resolve(contentRepoDir, "config/friendsConfig.ts");
	if (!fs.existsSync(configFile)) {
		console.error(`未在指定路径找到配置文件: ${configFile}`);
		process.exit(1);
	}

	const configContent = fs.readFileSync(configFile, "utf-8");

	// 查重：检查是否已存在相同域名或链接
	const normalizedNewSiteUrl = normalizeUrl(siteurl);
	if (
		configContent.includes(siteurl) ||
		configContent.includes(normalizedNewSiteUrl)
	) {
		const msg = `ℹ️ **站点已在友链中**\n\n检测到您的站点（\`${siteurl}\`）已经存在于本站友链列表中。如有信息更新需要，请在 Issue 中说明并由博主人工维护。`;
		await postComment(msg);
		await addLabels(["duplicate"]);
		await closeIssue();
		console.log(msg);
		return;
	}

	// 连通性与反向链接审核
	if (forceBypass) {
		console.log(
			"[friend-apply] 检测到 bypass-check 标签，跳过连通性与反向链接验证",
		);
	} else {
		// 1. 站点主页存活连通性检测
		console.log(`[friend-apply] 开始探测站点主页连通性: ${siteurl}`);
		const siteCheck = await verifySiteReachable(siteurl);
		if (!siteCheck.success) {
			const msg = `⚠️ **站点主页无法正常访问**\n\n机器人尝试访问您的网站主页（\`${siteurl}\`）失败：${siteCheck.reason}。\n\n请确保站点已正常上线、网络可以公开访问后再提交申请。如果您使用了特殊防爬保护或地区限制，请联系博主添加 \`bypass-check\` 标签进行人工放行。\n\n排查解决后，可**重新编辑 Issue 或在下方回复任意内容**，系统将自动重新检测。`;
			await postComment(msg);
			await addLabels(["check-failed"]);
			console.log(`[friend-apply] 站点存活检测失败: ${siteCheck.reason}`);
			return;
		}
		console.log("[friend-apply] 站点主页连通性良好！");

		// 2. 头像图片链接连通性检测
		console.log(`[friend-apply] 开始探测头像图片连通性: ${imgurl}`);
		const avatarCheck = await verifyAvatarReachable(imgurl);
		if (!avatarCheck.success) {
			const msg = `⚠️ **站点头像无法正常加载**\n\n机器人尝试加载您的头像图片（\`${imgurl}\`）失败：${avatarCheck.reason}。\n\n请检查头像链接是否填写正确、是否支持公网外链访问。修改后可**重新编辑 Issue 或在下方回复任意内容**重新检测。`;
			await postComment(msg);
			await addLabels(["check-failed"]);
			console.log(`[friend-apply] 头像存活检测失败: ${avatarCheck.reason}`);
			return;
		}
		console.log("[friend-apply] 头像图片加载正常！");

		// 3. 反向链接爬虫审核
		console.log(`[friend-apply] 开始对反向链接进行爬虫验证: ${checkurl}`);
		const checkResult = await verifyBacklink(checkurl);

		if (!checkResult.success) {
			const msg = `⚠️ **友链检测未通过**\n\n${checkResult.reason}。\n\n**建议排查步骤**：\n1. 确认已将本站添加至您的网站（本站域名：\`${TARGET_DOMAIN}\`）；\n2. 若友链存放在子页面（如 \`/friends\`），请确保在申请表单中准确填写「友链所在页面」；\n3. 若站点为 SPA 动态渲染架构或启用了高防防爬验证，可联系博主添加 \`bypass-check\` 标签以人工跳过检测。\n\n修改或添加完毕后，可直接**重新编辑 Issue 或在下方回复任意内容**，系统将自动重新触发检测。`;
			await postComment(msg);
			await addLabels(["check-failed"]);
			console.log(`[friend-apply] 验证失败: ${checkResult.reason}`);
			return;
		}
		console.log("[friend-apply] 反向链接验证成功！");
	}

	// 写入配置
	const newEntry = `\t{\n\t\ttitle: ${JSON.stringify(title)},\n\t\tdesc: ${JSON.stringify(desc)},\n\t\tsiteurl: ${JSON.stringify(siteurl)},\n\t\timgurl: ${JSON.stringify(imgurl)},\n\t\tweight: 1,\n\t\tenabled: true,\n\t},`;

	let updatedContent = "";
	const targetPattern =
		/export const friendsConfig: FriendLink\[\] = \[([\s\S]*?)\];/;

	if (targetPattern.test(configContent)) {
		updatedContent = configContent.replace(targetPattern, (_match, inner) => {
			const trimmedInner = inner.trim();
			if (!trimmedInner) {
				return `export const friendsConfig: FriendLink[] = [\n${newEntry}\n];`;
			}
			return `export const friendsConfig: FriendLink[] = [\n${newEntry}\n\t${trimmedInner}\n];`;
		});
	} else {
		console.error(
			"未能匹配到 friendsConfig 数组定义，请检查 friendsConfig.ts 格式",
		);
		process.exit(1);
	}

	fs.writeFileSync(configFile, updatedContent, "utf-8");
	console.log(`[friend-apply] 成功将友链写入: ${configFile}`);

	// 成功互动反馈
	const successMsg = `🎉 **友链审核通过！**\n\n已成功自动录入本站友链配置：\n- **站点名称**：${title}\n- **站点链接**：${siteurl}\n- **站点描述**：${desc}\n- **头像链接**：${imgurl}\n\n更改已自动推送至内容仓，构建部署已触发。稍后即可在 [冷汐的杂货铺 - 友情链接](https://lengxiqwq.com/friends/) 查看到您的站点！欢迎常来互访交流～ ✨`;

	await postComment(successMsg);
	await removeLabel("check-failed");
	await removeLabel("invalid-format");
	await addLabels(["friend-added"]);
	await closeIssue();

	console.log("[friend-apply] 处理完成！");
}

run().catch(async (err) => {
	console.error("[friend-apply] 处理过程中发生异常:", err);
	if (issueNumber) {
		try {
			await postComment(
				`❌ **自动处理出错**\n\n在自动处理友链时出现异常：\`${(err as Error).message || String(err)}\`，请等待博主人工处理。`,
			);
		} catch {
			// 忽略回复失败
		}
	}
	process.exit(1);
});
