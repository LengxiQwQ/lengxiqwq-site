import { Hono } from "hono";
import type { AppEnv, GithubRepoData } from "../types";

const github = new Hono<AppEnv>();

github.get("/repo", async (c) => {
	const name = c.req.query("name")?.trim();
	if (!name || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(name)) {
		return c.json(
			{
				code: 400,
				error: "Invalid repository name format. Expected 'owner/repo'.",
			},
			400,
		);
	}

	const cacheKey = `github:repo:${name.toLowerCase()}`;

	// 1. 优先读取 KV 缓存 (TTL 2小时)
	try {
		const cached = await c.env.KV.get<GithubRepoData>(cacheKey, "json");
		if (cached) {
			return c.json(
				{
					code: 200,
					data: cached,
					fromCache: true,
				},
				200,
				{
					"Cache-Control": "public, max-age=3600, s-maxage=7200",
				},
			);
		}
	} catch (err) {
		console.warn("[GitHub Proxy] KV get error:", err);
	}

	// 2. 缓存未命中，带 Token 向 GitHub 官方 REST API 发起请求
	const headers: Record<string, string> = {
		"User-Agent":
			"lengxiqwq-api/1.0 (Cloudflare Workers; +https://lengxiqwq.com)",
		Accept: "application/vnd.github+json",
	};

	if (c.env.GITHUB_TOKEN) {
		headers.Authorization = `Bearer ${c.env.GITHUB_TOKEN}`;
	}

	try {
		const res = await fetch(`https://api.github.com/repos/${name}`, {
			headers,
			signal: AbortSignal.timeout(5000),
		});

		if (!res.ok) {
			const errText = await res.text();
			return c.json(
				{
					code: res.status,
					error: `GitHub API responded with status ${res.status}: ${res.statusText}`,
					details: errText,
				},
				res.status >= 400 && res.status <= 599
					? (res.status as 400 | 404 | 500)
					: 500,
			);
		}

		interface RawGitHubRepo {
			name?: string;
			full_name?: string;
			description?: string;
			stargazers_count?: number;
			forks_count?: number;
			forks?: number;
			language?: string;
			license?: { spdx_id?: string; name?: string } | null;
			owner?: { avatar_url?: string };
			updated_at?: string;
		}

		const raw = (await res.json()) as RawGitHubRepo;
		const extracted: GithubRepoData = {
			name: raw.full_name || raw.name || name,
			description: raw.description || "",
			stars: raw.stargazers_count ?? 0,
			stargazers_count: raw.stargazers_count ?? 0,
			forks: raw.forks_count ?? raw.forks ?? 0,
			language: raw.language || null,
			license: raw.license?.spdx_id || raw.license?.name || null,
			avatarUrl: raw.owner?.avatar_url || "",
			owner: {
				avatar_url: raw.owner?.avatar_url || "",
			},
			updatedAt: raw.updated_at || new Date().toISOString(),
		};

		// 3. 异步写入 KV 缓存（过期时间 2 小时 = 7200 秒）
		try {
			await c.env.KV.put(cacheKey, JSON.stringify(extracted), {
				expirationTtl: 7200,
			});
		} catch (err) {
			console.warn("[GitHub Proxy] KV put error:", err);
		}

		return c.json(
			{
				code: 200,
				data: extracted,
				fromCache: false,
			},
			200,
			{
				"Cache-Control": "public, max-age=3600, s-maxage=7200",
			},
		);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json(
			{
				code: 502,
				error: `Failed to fetch repository data from GitHub: ${message}`,
			},
			502,
		);
	}
});

export default github;
