import { Hono } from "hono";
import { sign } from "hono/jwt";
import { authMiddleware } from "../middleware/auth";
import type {
	AddFriendPayload,
	AppEnv,
	CommitPostPayload,
	FriendDecisionPayload,
	FriendProbeSinglePayload,
	FriendTargetUrlPayload,
} from "../types";

const admin = new Hono<AppEnv>();

interface LoginRequestBody {
	masterKey?: string;
	password?: string;
	key?: string;
}

/**
 * 辅助函数：将 Base64 安全解码为 UTF-8 字符串
 */
function base64ToUtf8(str: string): string {
	const clean = str.replace(/\s+/g, "");
	const binary = atob(clean);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new TextDecoder().decode(bytes);
}

/**
 * 检查是否为私有、环回或云元数据地址（防 SSRF）
 */
function isPrivateHost(hostname: string): boolean {
	const lower = hostname.toLowerCase().trim();
	if (
		lower === "localhost" ||
		lower.endsWith(".local") ||
		lower.endsWith(".internal") ||
		lower.endsWith(".localdomain")
	) {
		return true;
	}
	if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(lower)) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(lower)) return true;
	if (
		lower === "::1" ||
		lower === "[::1]" ||
		lower.startsWith("fe80:") ||
		lower.startsWith("[fe80:") ||
		lower.startsWith("fc00:") ||
		lower.startsWith("[fc00:") ||
		lower.startsWith("fd00:") ||
		lower.startsWith("[fd00:")
	) {
		return true;
	}
	return false;
}

const DEFAULT_KEYWORDS = [
	"lengxiqwq.com",
	"冷汐的杂货铺",
	"冷曦的小窝",
	"lengxiqwq",
	"lengxi",
	"冷汐",
	"冷曦",
];

interface AuditRecord {
	missingCount?: number;
	failCount?: number;
	protectedCount?: number;
	lastChecked?: string;
	lastStatus?: string;
	lastMessage?: string;
	targetUrl?: string;
	decision?: "whitelisted" | "single" | "quarantined" | "normal" | "pending";
	decisionTime?: string;
}

type FriendsAuditMap = Record<string, AuditRecord>;

async function getGithubAuditFile(
	repo: string,
	token: string,
): Promise<{ sha?: string; data: FriendsAuditMap }> {
	const filePath = "src/constants/friends-audit.json";
	const checkUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
	const res = await fetch(checkUrl, {
		headers: getGithubHeaders(token),
		signal: AbortSignal.timeout(6000),
	});

	if (res.ok) {
		interface GhFileResp {
			sha?: string;
			content?: string;
		}
		const fileData = (await res.json()) as GhFileResp;
		if (fileData.content) {
			try {
				const jsonStr = base64ToUtf8(fileData.content);
				return { sha: fileData.sha, data: JSON.parse(jsonStr) };
			} catch {}
		}
		return { sha: fileData.sha, data: {} };
	}
	return { data: {} };
}

async function saveGithubAuditFile(
	repo: string,
	token: string,
	data: FriendsAuditMap,
	sha: string | undefined,
	message: string,
): Promise<boolean> {
	const filePath = "src/constants/friends-audit.json";
	const putUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
	const contentStr = JSON.stringify(data, null, "\t");

	const commitBody: Record<string, unknown> = {
		message,
		content: utf8ToBase64(contentStr),
	};
	if (sha) {
		commitBody.sha = sha;
	}

	const res = await fetch(putUrl, {
		method: "PUT",
		headers: getGithubHeaders(token),
		body: JSON.stringify(commitBody),
		signal: AbortSignal.timeout(10000),
	});

	return res.ok;
}

/**
 * 辅助函数：将 UTF-8 字符串安全转换为 Base64
 */
function utf8ToBase64(str: string): string {
	const utf8Bytes = new TextEncoder().encode(str);
	let binary = "";
	for (let i = 0; i < utf8Bytes.length; i++) {
		binary += String.fromCharCode(utf8Bytes[i]);
	}
	return btoa(binary);
}

/**
 * 辅助函数：构建 GitHub API 统一请求头
 */
function getGithubHeaders(token?: string): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"Content-Type": "application/json",
		"User-Agent":
			"lengxiqwq-api/1.0 (Cloudflare Workers; +https://lengxiqwq.com)",
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

/**
 * POST /api/admin/login
 * 管理员暗号登录
 */
admin.post("/login", async (c) => {
	const body: LoginRequestBody = await c.req
		.json<LoginRequestBody>()
		.catch(() => ({}) as LoginRequestBody);
	const candidateKey = body.masterKey || body.password || body.key;
	const masterKey = c.env.MASTER_KEY;

	if (!masterKey) {
		return c.json(
			{
				code: 500,
				error:
					"Server misconfiguration: MASTER_KEY is not configured in worker environment",
			},
			500,
		);
	}

	if (!candidateKey || candidateKey !== masterKey) {
		return c.json(
			{
				code: 401,
				error: "Authentication failed: Invalid Master Key",
			},
			401,
		);
	}

	const jwtSecret = c.env.JWT_SECRET || masterKey;
	const expiresInSeconds = 90 * 24 * 60 * 60; // 90 天超长持久化有效期
	const currentTimestamp = Math.floor(Date.now() / 1000);
	const expiresAt = currentTimestamp + expiresInSeconds;

	const payload = {
		sub: "admin",
		role: "admin",
		iat: currentTimestamp,
		exp: expiresAt,
	};

	const token = await sign(payload, jwtSecret);

	return c.json({
		code: 200,
		message: "Login successful",
		data: {
			token,
			expiresIn: expiresInSeconds,
			expiresAt: expiresAt * 1000,
		},
	});
});

/**
 * POST /api/admin/commit-post
 * 受保护接口：自动生成标准 YAML Frontmatter 并向 GitHub 内容仓 (lengxiqwq-site-content) 提交 Markdown 文章
 */
admin.post("/commit-post", authMiddleware, async (c) => {
	const body = await c.req
		.json<CommitPostPayload>()
		.catch(() => ({}) as CommitPostPayload);

	const title = body.title?.trim();
	const rawSlug = body.slug?.trim();
	const content = body.content?.trim();

	if (!title) {
		return c.json({ code: 400, error: "文章标题 (title) 不能为空" }, 400);
	}
	if (!rawSlug) {
		return c.json({ code: 400, error: "文章 Slug 不能为空" }, 400);
	}
	if (!content) {
		return c.json({ code: 400, error: "文章正文内容 (content) 不能为空" }, 400);
	}

	// 规范化 Slug 格式
	const slug = rawSlug
		.toLowerCase()
		.replace(/[^a-z0-9_\-\u4e00-\u9fa5]+/g, "-")
		.replace(/^-+|-+$/g, "");

	if (!slug) {
		return c.json(
			{ code: 400, error: "Slug 格式非法，请使用英文、拼音或连字符" },
			400,
		);
	}

	const now = new Date();
	const publishedDate = now.toISOString().split("T")[0];
	const category = body.category?.trim() || "技术笔记";
	const tags = Array.isArray(body.tags)
		? body.tags.map((t) => t.trim()).filter(Boolean)
		: ["博客"];
	const description = body.excerpt?.trim() || title;
	const cover = body.cover?.trim() || "";
	const isDraft = body.draft === true;
	const isPinned = body.pinned === true;

	// 组装标准 YAML Frontmatter
	const yamlLines = [
		"---",
		`title: ${JSON.stringify(title)}`,
		`published: ${publishedDate}`,
		`description: ${JSON.stringify(description)}`,
		`category: ${JSON.stringify(category)}`,
		`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`,
	];

	if (cover) {
		yamlLines.push(`image: ${JSON.stringify(cover)}`);
	}
	yamlLines.push(`slug: ${JSON.stringify(slug)}`);
	if (isPinned) {
		yamlLines.push("pinned: true");
	}
	if (isDraft) {
		yamlLines.push("draft: true");
	}
	yamlLines.push("---");
	yamlLines.push("");
	yamlLines.push(content);
	yamlLines.push(""); // 保持文件末尾空行

	const finalMarkdown = yamlLines.join("\n");
	const repo = c.env.GITHUB_CONTENT_REPO || "LengxiQwQ/lengxiqwq-site-content";
	const filePath = `content/posts/${slug}.md`;

	// 如果没有配置 GITHUB_TOKEN，提供开发环境友好模拟降级
	if (!c.env.GITHUB_TOKEN) {
		console.warn(
			`[Admin API] GITHUB_TOKEN not configured. Mocking commit for ${filePath}`,
		);
		return c.json({
			code: 200,
			message: `[本地模拟] 文章《${title}》生成成功！(当前 Worker 环境未配置 GITHUB_TOKEN)`,
			data: {
				repo,
				path: filePath,
				slug,
				simulated: true,
				frontmatter: {
					title,
					published: publishedDate,
					description,
					category,
					tags,
					cover,
					draft: isDraft,
				},
			},
		});
	}

	try {
		// 1. 检查目标仓库中文件是否已存在（以获取已有的 sha）
		const checkUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
		let existingSha: string | undefined;

		const checkRes = await fetch(checkUrl, {
			headers: getGithubHeaders(c.env.GITHUB_TOKEN),
			signal: AbortSignal.timeout(6000),
		});

		if (checkRes.ok) {
			interface GhContentResp {
				sha?: string;
			}
			const existingData = (await checkRes.json()) as GhContentResp;
			existingSha = existingData.sha;
		} else if (checkRes.status !== 404) {
			const errText = await checkRes.text();
			return c.json(
				{
					code: checkRes.status,
					error: `查询 GitHub 仓库文件状态失败: ${errText}`,
				},
				502,
			);
		}

		// 2. 发起 PUT 请求创建或更新文件
		const isUpdate = Boolean(existingSha);
		const commitMessage = isUpdate
			? `docs(posts): 更新文章 《${title}》 [skip ci]`
			: `docs(posts): 撰写文章 《${title}》 [skip ci]`;

		const commitBody: Record<string, unknown> = {
			message: commitMessage,
			content: utf8ToBase64(finalMarkdown),
		};
		if (existingSha) {
			commitBody.sha = existingSha;
		}

		const putRes = await fetch(checkUrl, {
			method: "PUT",
			headers: getGithubHeaders(c.env.GITHUB_TOKEN),
			body: JSON.stringify(commitBody),
			signal: AbortSignal.timeout(10000),
		});

		if (!putRes.ok) {
			const errText = await putRes.text();
			return c.json(
				{
					code: putRes.status,
					error: `GitHub Commit 提交失败: ${errText}`,
				},
				502,
			);
		}

		interface GhPutResp {
			content?: { html_url?: string; path?: string };
			commit?: { sha?: string; html_url?: string };
		}
		const putData = (await putRes.json()) as GhPutResp;

		return c.json({
			code: 200,
			message: `🎉 文章《${title}》已成功${isUpdate ? "更新" : "创建"}并推送至 GitHub 内容仓！`,
			data: {
				repo,
				path: filePath,
				slug,
				action: isUpdate ? "update" : "create",
				commitSha: putData.commit?.sha,
				commitUrl: putData.commit?.html_url,
				fileUrl: putData.content?.html_url,
			},
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json(
			{
				code: 500,
				error: `调用 GitHub API 异常: ${message}`,
			},
			500,
		);
	}
});

/**
 * POST /api/admin/trigger-friend-check
 * 受保护接口：一键触发主代码仓的 check-friends.yml Workflow Dispatch
 */
admin.post("/trigger-friend-check", authMiddleware, async (c) => {
	const repo = c.env.GITHUB_MAIN_REPO || "LengxiQwQ/lengxiqwq-site";
	const workflow = "check-friends.yml";

	if (!c.env.GITHUB_TOKEN) {
		console.warn(
			"[Admin API] GITHUB_TOKEN not configured. Mocking friend check workflow dispatch.",
		);
		return c.json({
			code: 200,
			message: "[本地模拟] 已成功模拟触发友链巡检工作流 (未配置 GITHUB_TOKEN)",
			data: {
				repo,
				workflow,
				simulated: true,
			},
		});
	}

	try {
		const dispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;
		const res = await fetch(dispatchUrl, {
			method: "POST",
			headers: getGithubHeaders(c.env.GITHUB_TOKEN),
			body: JSON.stringify({ ref: "main" }),
			signal: AbortSignal.timeout(6000),
		});

		if (res.status === 204 || res.ok) {
			return c.json({
				code: 200,
				message: "🚀 已成功向 GitHub 调度触发全网友链巡检工作流！",
				data: {
					repo,
					workflow,
					ref: "main",
				},
			});
		}

		const errText = await res.text();
		return c.json(
			{
				code: res.status,
				error: `触发 GitHub Actions 工作流失败: ${errText}`,
			},
			502,
		);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json(
			{
				code: 500,
				error: `请求 GitHub Actions 调度接口失败: ${message}`,
			},
			500,
		);
	}
});

/**
 * GET /api/admin/posts
 * 获取博客已有文章列表与完整正文（供控制台文章选择器与修改面板调用）
 */
admin.get("/posts", async (c) => {
	const configuredOrigins = (c.env.CORS_ORIGIN || "http://localhost:4321")
		.split(",")
		.map((o) => o.trim())
		.filter(Boolean);
	const targetOrigin =
		configuredOrigins.find(
			(o) =>
				o.startsWith("http://localhost:") || o.startsWith("http://127.0.0.1:"),
		) ||
		configuredOrigins[0] ||
		"http://localhost:4321";

	try {
		const siteUrl = `${targetOrigin.replace(/\/+$/, "")}/api/postContent.json`;
		const res = await fetch(siteUrl, {
			signal: AbortSignal.timeout(5000),
		});
		if (res.ok) {
			const json = await res.json();
			return c.json(json);
		}
	} catch (err) {
		console.warn(
			"[Admin API] Failed to fetch /api/postContent.json from site origin:",
			err,
		);
	}

	return c.json({
		code: 200,
		total: 0,
		data: [],
	});
});

/**
 * GET /api/admin/friends
 * 获取全站友链列表与健康巡检审计状态
 */
admin.get("/friends", async (c) => {
	const configuredOrigins = (c.env.CORS_ORIGIN || "http://localhost:4321")
		.split(",")
		.map((o) => o.trim())
		.filter(Boolean);
	const targetOrigin =
		configuredOrigins.find(
			(o) =>
				o.startsWith("http://localhost:") || o.startsWith("http://127.0.0.1:"),
		) ||
		configuredOrigins[0] ||
		"http://localhost:4321";

	try {
		const siteUrl = `${targetOrigin.replace(/\/+$/, "")}/api/friendsAudit.json`;
		const res = await fetch(siteUrl, {
			signal: AbortSignal.timeout(5000),
		});
		if (res.ok) {
			const json = await res.json();
			return c.json(json);
		}
	} catch (err) {
		console.warn(
			"[Admin API] Failed to fetch /api/friendsAudit.json from site origin:",
			err,
		);
	}

	return c.json({
		code: 200,
		summary: {
			total: 0,
			normal: 0,
			single: 0,
			quarantined: 0,
			whitelisted: 0,
			latestCheckedTimestamp: 0,
			latestCheckedText: "",
		},
		items: [],
	});
});

/**
 * POST /api/admin/friends/decision
 * 受保护接口：对特定友链进行裁决（白名单/单向/失联/自动模式）并持久化至 GitHub 仓库
 */
admin.post("/friends/decision", authMiddleware, async (c) => {
	const body = await c.req
		.json<FriendDecisionPayload>()
		.catch(() => ({}) as FriendDecisionPayload);
	const siteurl = body.siteurl?.trim();
	const decision = body.decision;

	if (!siteurl || !decision) {
		return c.json({ code: 400, error: "Missing siteurl or decision" }, 400);
	}

	const repo = c.env.GITHUB_MAIN_REPO || "LengxiQwQ/lengxiqwq-site";
	if (!c.env.GITHUB_TOKEN) {
		return c.json({
			code: 200,
			message: `[本地模拟] 站点 ${siteurl} 裁决已更新为 ${decision} (未配置 GITHUB_TOKEN)`,
			data: { siteurl, decision },
		});
	}

	try {
		const { sha, data: auditData } = await getGithubAuditFile(
			repo,
			c.env.GITHUB_TOKEN,
		);
		const prev = auditData[siteurl] || {
			missingCount: 0,
			failCount: 0,
			lastChecked: new Date().toISOString(),
			lastStatus: "found",
			decision: "normal",
		};

		auditData[siteurl] = {
			...prev,
			decision,
			decisionTime: new Date().toISOString(),
		};

		if (decision === "whitelisted") {
			auditData[siteurl].missingCount = 0;
			auditData[siteurl].failCount = 0;
			auditData[siteurl].protectedCount = 0;
		}

		const success = await saveGithubAuditFile(
			repo,
			c.env.GITHUB_TOKEN,
			auditData,
			sha,
			`chore(friends): update decision for ${siteurl} to ${decision} [skip ci]`,
		);

		if (!success) {
			return c.json({ code: 502, error: "保存至 GitHub 仓库失败" }, 502);
		}

		return c.json({
			code: 200,
			message: `已成功将站点 ${siteurl} 裁决更新为: ${decision}`,
			data: { siteurl, decision, record: auditData[siteurl] },
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return c.json({ code: 500, error: `更新裁决异常: ${msg}` }, 500);
	}
});

/**
 * POST /api/admin/friends/target-url
 * 受保护接口：更新/指定特定站点的专属友链探测页面地址并持久化
 */
admin.post("/friends/target-url", authMiddleware, async (c) => {
	const body = await c.req
		.json<FriendTargetUrlPayload>()
		.catch(() => ({}) as FriendTargetUrlPayload);
	const siteurl = body.siteurl?.trim();
	const targetUrl = body.targetUrl?.trim();

	if (!siteurl || !targetUrl) {
		return c.json({ code: 400, error: "Missing siteurl or targetUrl" }, 400);
	}

	const repo = c.env.GITHUB_MAIN_REPO || "LengxiQwQ/lengxiqwq-site";
	if (!c.env.GITHUB_TOKEN) {
		return c.json({
			code: 200,
			message: `[本地模拟] 站点 ${siteurl} 友链地址已更新为 ${targetUrl}`,
			data: { siteurl, targetUrl },
		});
	}

	try {
		const { sha, data: auditData } = await getGithubAuditFile(
			repo,
			c.env.GITHUB_TOKEN,
		);
		const prev = auditData[siteurl] || {
			missingCount: 0,
			failCount: 0,
			lastChecked: new Date().toISOString(),
			lastStatus: "found",
			decision: "normal",
		};

		auditData[siteurl] = {
			...prev,
			targetUrl,
		};

		const success = await saveGithubAuditFile(
			repo,
			c.env.GITHUB_TOKEN,
			auditData,
			sha,
			`chore(friends): update targetUrl for ${siteurl} [skip ci]`,
		);

		if (!success) {
			return c.json({ code: 502, error: "保存至 GitHub 仓库失败" }, 502);
		}

		return c.json({
			code: 200,
			message: `已成功保存站点 ${siteurl} 的专属友链地址`,
			data: { siteurl, targetUrl },
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return c.json({ code: 500, error: `保存友链地址异常: ${msg}` }, 500);
	}
});

/**
 * POST /api/admin/friends/probe-single
 * 受保护接口：单站现场实时反查重测与自愈状态写入
 */
admin.post("/friends/probe-single", authMiddleware, async (c) => {
	const body = await c.req
		.json<FriendProbeSinglePayload>()
		.catch(() => ({}) as FriendProbeSinglePayload);
	const siteurl = body.siteurl?.trim();
	const targetUrl = (body.targetUrl?.trim() || siteurl) as string;

	if (!siteurl) {
		return c.json({ code: 400, error: "Missing siteurl" }, 400);
	}

	try {
		const parsedUrl = new URL(targetUrl);
		if (isPrivateHost(parsedUrl.hostname)) {
			return c.json(
				{ code: 400, error: "禁止探测本地/私有内网地址 (防SSRF)" },
				400,
			);
		}
	} catch {
		return c.json({ code: 400, error: "非法目标 URL 格式" }, 400);
	}

	let status: "found" | "missing" | "404" | "protected" = "missing";
	let lastMessage = "";

	const browserHeaders = {
		"User-Agent":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
		"Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	};

	try {
		let html = "";
		let httpStatus = 200;

		try {
			const res = await fetch(targetUrl, {
				headers: browserHeaders,
				signal: AbortSignal.timeout(8000),
				redirect: "follow",
			});
			httpStatus = res.status;
			if (res.ok) {
				html = await res.text();
			}
		} catch (fetchErr: unknown) {
			const msg =
				fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
			httpStatus = 599;
			lastMessage = `连接异常: ${msg}`;
		}

		if (
			httpStatus === 403 ||
			httpStatus === 503 ||
			(html &&
				html.length < 35000 &&
				(html.toLowerCase().includes("just a moment...") ||
					html.toLowerCase().includes("cf-browser-verification")))
		) {
			try {
				const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
					headers: { Accept: "text/plain" },
					signal: AbortSignal.timeout(8000),
				});
				if (jinaRes.ok) {
					html = await jinaRes.text();
					httpStatus = 200;
				} else {
					status = "protected";
					lastMessage = "遇 WAF 盾阻断且 Jina 穿透未通过";
				}
			} catch {
				status = "protected";
				lastMessage = "遇 WAF 盾阻断";
			}
		}

		if (httpStatus >= 400 && httpStatus !== 403) {
			status = "404";
			lastMessage = `HTTP ${httpStatus} 无法访问`;
		} else if (html) {
			const lowerHtml = html.toLowerCase();
			let matchedKeyword = "";
			for (const kw of DEFAULT_KEYWORDS) {
				if (lowerHtml.includes(kw.toLowerCase())) {
					matchedKeyword = kw;
					break;
				}
			}

			if (matchedKeyword) {
				status = "found";
				lastMessage = `成功匹配关键词: "${matchedKeyword}" (${targetUrl})`;
			} else if (status !== "protected") {
				status = "missing";
				lastMessage = `页面正常但未匹配到本站友链关键词 (${targetUrl})`;
			}
		}
	} catch (e: unknown) {
		status = "404";
		lastMessage = e instanceof Error ? e.message : String(e);
	}

	const repo = c.env.GITHUB_MAIN_REPO || "LengxiQwQ/lengxiqwq-site";
	let updatedRecord: AuditRecord = {
		missingCount: status === "missing" ? 1 : 0,
		failCount: status === "404" ? 1 : 0,
		protectedCount: status === "protected" ? 1 : 0,
		lastChecked: new Date().toISOString(),
		lastStatus: status,
		lastMessage,
		targetUrl,
		decision: "normal",
	};

	if (c.env.GITHUB_TOKEN) {
		try {
			const { sha, data: auditData } = await getGithubAuditFile(
				repo,
				c.env.GITHUB_TOKEN,
			);
			const prev = auditData[siteurl] || {
				missingCount: 0,
				failCount: 0,
				protectedCount: 0,
				decision: "normal",
			};

			let missingCount = prev.missingCount || 0;
			let failCount = prev.failCount || 0;
			let protectedCount = prev.protectedCount || 0;
			let decision = prev.decision || "normal";

			if (status === "found") {
				missingCount = 0;
				failCount = 0;
				protectedCount = 0;
				if (
					decision === "pending" ||
					decision === "single" ||
					decision === "quarantined"
				) {
					decision = "normal"; // 自动自愈
				}
			} else if (status === "protected") {
				protectedCount += 1;
				if (protectedCount >= 3 && decision === "normal") decision = "pending";
			} else if (status === "404") {
				failCount += 1;
				if (failCount >= 3 && decision === "normal") decision = "pending";
			} else if (status === "missing") {
				failCount = 0;
				missingCount += 1;
				if (missingCount >= 3 && decision === "normal") decision = "pending";
			}

			updatedRecord = {
				missingCount,
				failCount,
				protectedCount,
				lastChecked: new Date().toISOString(),
				lastStatus: status,
				lastMessage,
				targetUrl,
				decision,
				decisionTime: prev.decisionTime,
			};

			auditData[siteurl] = updatedRecord;

			await saveGithubAuditFile(
				repo,
				c.env.GITHUB_TOKEN,
				auditData,
				sha,
				`chore(friends): probe ${siteurl} -> ${status} [skip ci]`,
			);
		} catch (ghErr) {
			console.warn(
				"[Admin API] Failed to commit probe record to GitHub:",
				ghErr,
			);
		}
	}

	return c.json({
		code: 200,
		message:
			status === "found"
				? "🎉 重测成功：已匹配到反向链接！"
				: `重测完成：${lastMessage}`,
		data: {
			siteurl,
			targetUrl,
			status,
			record: updatedRecord,
		},
	});
});

/**
 * POST /api/admin/friends/add
 * 受保护接口：在移动端/Web端直接向 GitHub 内容仓 (lengxiqwq-site-content) 添加新友链
 */
admin.post("/friends/add", authMiddleware, async (c) => {
	const body = await c.req
		.json<AddFriendPayload>()
		.catch(() => ({}) as AddFriendPayload);

	const title = body.title?.trim();
	const siteurl = body.siteurl?.trim();
	const desc = body.desc?.trim() || "";
	const imgurl = body.imgurl?.trim() || "";
	const tags =
		Array.isArray(body.tags) && body.tags.length > 0 ? body.tags : ["博客"];
	const friendPageUrl = body.friendPageUrl?.trim() || "";

	if (!title) {
		return c.json({ code: 400, error: "友链名称 (title) 不能为空" }, 400);
	}
	if (!siteurl) {
		return c.json({ code: 400, error: "站点链接 (siteurl) 不能为空" }, 400);
	}

	const contentRepo =
		c.env.GITHUB_CONTENT_REPO || "LengxiQwQ/lengxiqwq-site-content";
	const mainRepo = c.env.GITHUB_MAIN_REPO || "LengxiQwQ/lengxiqwq-site";

	if (!c.env.GITHUB_TOKEN) {
		return c.json({
			code: 200,
			message: `[本地模拟] 友链《${title}》已成功添加！(未配置 GITHUB_TOKEN)`,
			data: { title, siteurl, desc, imgurl, tags, friendPageUrl },
		});
	}

	const filePath = "config/friendsConfig.ts";
	const checkUrl = `https://api.github.com/repos/${contentRepo}/contents/${filePath}`;

	try {
		const res = await fetch(checkUrl, {
			headers: getGithubHeaders(c.env.GITHUB_TOKEN),
			signal: AbortSignal.timeout(6000),
		});

		if (!res.ok) {
			const errText = await res.text();
			return c.json(
				{
					code: res.status,
					error: `获取内容仓 friendsConfig.ts 失败: ${errText}`,
				},
				502,
			);
		}

		interface GhFileResp {
			sha?: string;
			content?: string;
		}
		const fileData = (await res.json()) as GhFileResp;
		if (!fileData.content) {
			return c.json({ code: 500, error: "friendsConfig.ts 内容为空" }, 500);
		}

		const contentStr = base64ToUtf8(fileData.content);
		if (contentStr.includes(siteurl)) {
			return c.json(
				{ code: 400, error: `站点链接已存在于配置中: ${siteurl}` },
				400,
			);
		}

		const newEntryCode = `\t{\n\t\ttitle: ${JSON.stringify(title)},\n\t\tdesc: ${JSON.stringify(desc)},\n\t\tsiteurl: ${JSON.stringify(siteurl)},\n\t\tfriendPageUrl: ${JSON.stringify(friendPageUrl)},\n\t\tfeedUrl: "",\n\t\timgurl: ${JSON.stringify(imgurl)},\n\t\tscreenshot: "",\n\t\temail: "",\n\t\ttags: [${tags.map((t) => JSON.stringify(t)).join(", ")}],\n\t\tweight: 1,\n\t\tenabled: true,\n\t},`;

		const targetPattern =
			/export const friendsConfig: FriendLink\[\] = \[([\s\S]*?)\];/;
		if (!targetPattern.test(contentStr)) {
			return c.json(
				{
					code: 500,
					error:
						"未能匹配到 export const friendsConfig: FriendLink[] = [...] 结构",
				},
				500,
			);
		}

		const updatedContent = contentStr.replace(targetPattern, (_m, inner) => {
			const trimmed = inner.trim();
			if (!trimmed) {
				return `export const friendsConfig: FriendLink[] = [\n${newEntryCode}\n];`;
			}
			return `export const friendsConfig: FriendLink[] = [\n\t${trimmed}\n${newEntryCode}\n];`;
		});

		const putRes = await fetch(checkUrl, {
			method: "PUT",
			headers: getGithubHeaders(c.env.GITHUB_TOKEN),
			body: JSON.stringify({
				message: `docs(friends): 添加友链 《${title}》 [skip ci]`,
				content: utf8ToBase64(updatedContent),
				sha: fileData.sha,
			}),
			signal: AbortSignal.timeout(10000),
		});

		if (!putRes.ok) {
			const errText = await putRes.text();
			return c.json(
				{ code: putRes.status, error: `提交到内容仓失败: ${errText}` },
				502,
			);
		}

		try {
			const { sha: auditSha, data: auditData } = await getGithubAuditFile(
				mainRepo,
				c.env.GITHUB_TOKEN,
			);
			auditData[siteurl] = {
				missingCount: 0,
				failCount: 0,
				protectedCount: 0,
				lastChecked: new Date().toISOString(),
				lastStatus: "found",
				lastMessage: "站长在控制台手动添加",
				targetUrl: friendPageUrl || siteurl,
				decision: "normal",
			};
			await saveGithubAuditFile(
				mainRepo,
				c.env.GITHUB_TOKEN,
				auditData,
				auditSha,
				`chore(friends): init audit record for new friend ${siteurl} [skip ci]`,
			);
		} catch (auditErr) {
			console.warn(
				"[Admin API] Failed to init audit record in main repo:",
				auditErr,
			);
		}

		return c.json({
			code: 200,
			message: `🎉 友链《${title}》已成功添加到 GitHub 内容仓！`,
			data: { title, siteurl, desc, imgurl, tags, friendPageUrl },
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return c.json({ code: 500, error: `添加友链异常: ${msg}` }, 500);
	}
});

export default admin;
