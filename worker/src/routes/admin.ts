import { Hono } from "hono";
import { sign } from "hono/jwt";
import { authMiddleware } from "../middleware/auth";
import type { AppEnv, CommitPostPayload } from "../types";

const admin = new Hono<AppEnv>();

interface LoginRequestBody {
	masterKey?: string;
	password?: string;
	key?: string;
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

export default admin;
