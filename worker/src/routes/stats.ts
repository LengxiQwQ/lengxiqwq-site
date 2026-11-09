import { Hono } from "hono";
import type {
	AppEnv,
	StatsInsightsData,
	StatsMetricDistribution,
	StatsRealtimeData,
	StatsSummaryData,
	StatsSummaryItem,
	StatsTopPage,
} from "../types";

const stats = new Hono<AppEnv>();

interface ResolvedUmamiContext {
	apiBase: string;
	websiteId: string;
	headers: Record<string, string>;
}

/**
 * 辅助函数：根据 Umami 环境变量智能解析认证信息与 API 请求基址
 * 支持 Umami 官方 API Key 及 Umami Cloud 公开 Share ID (免鉴权)
 */
async function resolveUmamiContext(
	env: AppEnv["Bindings"],
): Promise<ResolvedUmamiContext | null> {
	const defaultWebsiteId =
		env.UMAMI_WEBSITE_ID || "b5377730-0e6d-4958-81fd-c409f2a5f015";

	// 1. 如果配置了 Share ID / Share Token (如用户提供的 zsrLkowucVHcYU5a)
	const shareInput = env.UMAMI_SHARE_ID || env.UMAMI_SHARE_TOKEN;
	if (shareInput) {
		const shareSlug = shareInput.replace(/^https?:\/\/.*\/share\//i, "").trim();
		const cacheKey = `umami:share_ctx:${shareSlug}`;

		try {
			const cached = await env.KV.get<{ token: string; websiteId: string }>(
				cacheKey,
				"json",
			);
			if (cached?.token) {
				return {
					apiBase: `https://cloud.umami.is/analytics/us/api/websites/${cached.websiteId || defaultWebsiteId}`,
					websiteId: cached.websiteId || defaultWebsiteId,
					headers: {
						Accept: "application/json",
						"User-Agent": "lengxiqwq-api/1.0",
						"x-umami-share-token": cached.token,
						"x-umami-share-context": "1",
					},
				};
			}
		} catch {}

		try {
			const shareRes = await fetch(
				`https://cloud.umami.is/analytics/us/api/share/${shareSlug}`,
				{
					headers: {
						Accept: "application/json",
						"User-Agent": "lengxiqwq-api/1.0",
					},
					signal: AbortSignal.timeout(4000),
				},
			);

			if (shareRes.ok) {
				const shareData = (await shareRes.json()) as {
					token?: string;
					websiteId?: string;
				};
				if (shareData.token) {
					const resolvedWebsiteId = shareData.websiteId || defaultWebsiteId;
					try {
						await env.KV.put(
							cacheKey,
							JSON.stringify({
								token: shareData.token,
								websiteId: resolvedWebsiteId,
							}),
							{ expirationTtl: 12 * 3600 },
						);
					} catch {}

					return {
						apiBase: `https://cloud.umami.is/analytics/us/api/websites/${resolvedWebsiteId}`,
						websiteId: resolvedWebsiteId,
						headers: {
							Accept: "application/json",
							"User-Agent": "lengxiqwq-api/1.0",
							"x-umami-share-token": shareData.token,
							"x-umami-share-context": "1",
						},
					};
				}
			}
		} catch (err) {
			console.warn("[Stats API] Resolve Umami share token failed:", err);
		}
	}

	// 2. 如果配置了官方 API Key
	if (env.UMAMI_API_KEY) {
		const rawBase = (env.UMAMI_API_ENDPOINT || "https://api.umami.is")
			.trim()
			.replace(/\/+$/, "");
		const apiBase = rawBase.endsWith("/v1")
			? `${rawBase}/websites/${defaultWebsiteId}`
			: rawBase.includes("umami.is")
				? `${rawBase}/v1/websites/${defaultWebsiteId}`
				: `${rawBase}/api/websites/${defaultWebsiteId}`;

		return {
			apiBase,
			websiteId: defaultWebsiteId,
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": "lengxiqwq-api/1.0",
				Authorization: `Bearer ${env.UMAMI_API_KEY}`,
				"x-umami-api-key": env.UMAMI_API_KEY,
			},
		};
	}

	return null;
}

/**
 * GET /api/stats/realtime
 * 实时在线访客数查询
 * KV 缓存策略：15 秒强缓存，降低高频访问对上游或内存的冲击
 */
stats.get("/realtime", async (c) => {
	const cacheKey = "stats:realtime";
	const forceRefresh =
		c.req.query("refresh") === "1" || c.req.query("refresh") === "true";

	// 1. 读取 KV 缓存
	if (!forceRefresh) {
		try {
			const cached = await c.env.KV.get<StatsRealtimeData>(cacheKey, "json");
			if (cached && typeof cached.activeUsers === "number") {
				return c.json({
					code: 200,
					data: cached,
					fromCache: true,
				});
			}
		} catch (err) {
			console.warn("[Stats API] KV get error (realtime):", err);
		}
	}

	// 2. 尝试从 Umami API 获取真实在线人数
	const umamiCtx = await resolveUmamiContext(c.env);

	if (umamiCtx) {
		try {
			const res = await fetch(`${umamiCtx.apiBase}/active`, {
				headers: umamiCtx.headers,
				signal: AbortSignal.timeout(4000),
			});

			if (res.ok) {
				interface UmamiActiveResponse {
					x?: number;
					visitors?: number;
					activeUsers?: number;
				}
				const data = (await res.json()) as UmamiActiveResponse;
				const activeCount = data.visitors ?? data.x ?? data.activeUsers ?? 0;

				const result: StatsRealtimeData = {
					activeUsers: Math.max(0, activeCount),
					timestamp: Date.now(),
					source: "umami",
				};

				// 写入 KV 缓存 15 秒
				try {
					await c.env.KV.put(cacheKey, JSON.stringify(result), {
						expirationTtl: 15,
					});
				} catch {}

				return c.json({
					code: 200,
					data: result,
					fromCache: false,
				});
			}
		} catch (err) {
			console.warn("[Stats API] Umami active probe failed:", err);
		}
	}

	// 3. 容灾与本地模拟探针：根据北京时间小时段产生合理波动的访客拟真数
	const now = new Date();
	const bjHour = (now.getUTCHours() + 8) % 24;

	let baseVisitors = 3;
	if (bjHour >= 1 && bjHour < 7) {
		baseVisitors = 2; // 深夜与清晨
	} else if (bjHour >= 7 && bjHour < 12) {
		baseVisitors = 6; // 上午活跃
	} else if (bjHour >= 12 && bjHour < 14) {
		baseVisitors = 8; // 午间高峰
	} else if (bjHour >= 14 && bjHour < 19) {
		baseVisitors = 7; // 下午平稳
	} else {
		baseVisitors = 11; // 晚间黄金阅读期
	}

	// 15 秒周期确定性抖动，避免数字瞬间抽搐
	const windowSeed = Math.floor(now.getTime() / 15000);
	const jitter = (windowSeed % 5) - 2;
	const simulatedActive = Math.max(1, baseVisitors + jitter);

	const fallbackData: StatsRealtimeData = {
		activeUsers: simulatedActive,
		timestamp: Date.now(),
		source: "simulated",
	};

	try {
		await c.env.KV.put(cacheKey, JSON.stringify(fallbackData), {
			expirationTtl: 15,
		});
	} catch {}

	return c.json({
		code: 200,
		data: fallbackData,
		fromCache: false,
	});
});

/**
 * GET /api/stats/summary
 * 30 天 PV/UV 趋势及指标概览
 * KV 缓存策略：30 分钟 (1800 秒)
 */
stats.get("/summary", async (c) => {
	const cacheKey = "stats:summary";
	const forceRefresh =
		c.req.query("refresh") === "1" || c.req.query("refresh") === "true";

	// 1. 读取 KV 缓存
	if (!forceRefresh) {
		try {
			const cached = await c.env.KV.get<StatsSummaryData>(cacheKey, "json");
			if (cached && Array.isArray(cached.chart)) {
				return c.json({
					code: 200,
					data: cached,
					fromCache: true,
				});
			}
		} catch (err) {
			console.warn("[Stats API] KV get error (summary):", err);
		}
	}

	// 2. 尝试从 Umami API 获取 30 天统计与走势
	const umamiCtx = await resolveUmamiContext(c.env);

	if (umamiCtx) {
		try {
			const endAt = Date.now();
			const startAt = endAt - 30 * 24 * 60 * 60 * 1000;

			const [statsRes, pageviewsRes] = await Promise.all([
				fetch(`${umamiCtx.apiBase}/stats?startAt=${startAt}&endAt=${endAt}`, {
					headers: umamiCtx.headers,
					signal: AbortSignal.timeout(5000),
				}),
				fetch(
					`${umamiCtx.apiBase}/pageviews?startAt=${startAt}&endAt=${endAt}&unit=day`,
					{
						headers: umamiCtx.headers,
						signal: AbortSignal.timeout(5000),
					},
				),
			]);

			if (statsRes.ok && pageviewsRes.ok) {
				const statsData = (await statsRes.json()) as Record<string, unknown>;
				const pvData = (await pageviewsRes.json()) as {
					pageviews?: Array<{ x?: string; t?: string; y?: number }>;
					sessions?: Array<{ x?: string; t?: string; y?: number }>;
				};

				const pvList = pvData.pageviews || [];
				const uvList = pvData.sessions || [];

				const chart: StatsSummaryItem[] = pvList.map((item, idx) => {
					const dateStr =
						(item.t || item.x || "").split("T")[0] || `Day ${idx + 1}`;
					const uvItem = uvList[idx];
					return {
						date: dateStr,
						pv: item.y || 0,
						uv: uvItem?.y || Math.round((item.y || 0) * 0.4),
					};
				});

				const extractVal = (val: unknown): number => {
					if (typeof val === "number") return val;
					if (val && typeof val === "object" && "value" in val) {
						return Number((val as { value: unknown }).value) || 0;
					}
					return 0;
				};

				const totalPv = extractVal(statsData.pageviews);
				const totalUv = extractVal(statsData.visitors);
				const bounces = extractVal(statsData.bounces);
				const bounceRate =
					totalUv > 0 ? Number(((bounces / totalUv) * 100).toFixed(1)) : 36.5;
				const totalTime = extractVal(statsData.totaltime);
				const avgVisitDuration =
					totalPv > 0 ? Math.round(totalTime / totalPv) : 145;

				const summaryResult: StatsSummaryData = {
					totalPv,
					totalUv,
					totalViews: totalPv,
					uniqueVisitors: totalUv,
					bounceRate,
					avgVisitDuration,
					chart,
					source: "umami",
				};

				try {
					await c.env.KV.put(cacheKey, JSON.stringify(summaryResult), {
						expirationTtl: 1800,
					});
				} catch {}

				return c.json({
					code: 200,
					data: summaryResult,
					fromCache: false,
				});
			}
		} catch (err) {
			console.warn("[Stats API] Umami summary fetch failed:", err);
		}
	}

	// 3. 容灾拟真生成 30 天 PV/UV 走势曲线
	const chart: StatsSummaryItem[] = [];
	const today = new Date();
	let totalPvSum = 0;
	let totalUvSum = 0;

	for (let i = 29; i >= 0; i--) {
		const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
		const dateStr = d.toISOString().split("T")[0];

		// 基于正弦波与平滑随机种子的真实访客曲线生成
		const dayOfWeek = d.getDay();
		const weekendBonus = dayOfWeek === 0 || dayOfWeek === 6 ? 60 : 0;
		const cycle = Math.sin((30 - i) * 0.3) * 80;
		const pseudoNoise = ((30 - i) * 31) % 45;

		const pv = Math.max(
			120,
			Math.round(260 + cycle + weekendBonus + pseudoNoise),
		);
		const uv = Math.max(
			35,
			Math.round(pv * (0.34 + (((30 - i) * 7) % 12) / 100)),
		);

		totalPvSum += pv;
		totalUvSum += uv;

		chart.push({
			date: dateStr,
			pv,
			uv,
		});
	}

	const fallbackSummary: StatsSummaryData = {
		totalPv: totalPvSum,
		totalUv: totalUvSum,
		totalViews: totalPvSum,
		uniqueVisitors: totalUvSum,
		bounceRate: 37.8,
		avgVisitDuration: 152,
		chart,
		source: "simulated",
	};

	try {
		await c.env.KV.put(cacheKey, JSON.stringify(fallbackSummary), {
			expirationTtl: 1800,
		});
	} catch {}

	return c.json({
		code: 200,
		data: fallbackSummary,
		fromCache: false,
	});
});

/**
 * GET /api/stats/insights
 * 热门文章 Top 10、访客国家与浏览器/OS 画像分布
 * KV 缓存策略：1 小时 (3600 秒)
 */
stats.get("/insights", async (c) => {
	const cacheKey = "stats:insights";
	const forceRefresh =
		c.req.query("refresh") === "1" || c.req.query("refresh") === "true";

	// 1. 读取 KV 缓存
	if (!forceRefresh) {
		try {
			const cached = await c.env.KV.get<StatsInsightsData>(cacheKey, "json");
			if (cached && Array.isArray(cached.topPages)) {
				return c.json({
					code: 200,
					data: cached,
					fromCache: true,
				});
			}
		} catch (err) {
			console.warn("[Stats API] KV get error (insights):", err);
		}
	}

	// 2. 尝试从 Umami API 获取 metrics 洞察
	const umamiCtx = await resolveUmamiContext(c.env);

	if (umamiCtx) {
		try {
			const endAt = Date.now();
			const startAt = endAt - 30 * 24 * 60 * 60 * 1000;

			const [pagesRes, countriesRes, browsersRes, osRes] = await Promise.all([
				fetch(
					`${umamiCtx.apiBase}/metrics?type=path&startAt=${startAt}&endAt=${endAt}&limit=10`,
					{ headers: umamiCtx.headers, signal: AbortSignal.timeout(5000) },
				),
				fetch(
					`${umamiCtx.apiBase}/metrics?type=country&startAt=${startAt}&endAt=${endAt}&limit=8`,
					{ headers: umamiCtx.headers, signal: AbortSignal.timeout(5000) },
				),
				fetch(
					`${umamiCtx.apiBase}/metrics?type=browser&startAt=${startAt}&endAt=${endAt}&limit=6`,
					{ headers: umamiCtx.headers, signal: AbortSignal.timeout(5000) },
				),
				fetch(
					`${umamiCtx.apiBase}/metrics?type=os&startAt=${startAt}&endAt=${endAt}&limit=6`,
					{ headers: umamiCtx.headers, signal: AbortSignal.timeout(5000) },
				),
			]);

			if (pagesRes.ok && countriesRes.ok && browsersRes.ok && osRes.ok) {
				interface UmamiMetricItem {
					x: string;
					y: number;
				}

				const pages = (await pagesRes.json()) as UmamiMetricItem[];
				const countriesRaw = (await countriesRes.json()) as UmamiMetricItem[];
				const browsersRaw = (await browsersRes.json()) as UmamiMetricItem[];
				const osRaw = (await osRes.json()) as UmamiMetricItem[];

				const countryNameMap: Record<string, string> = {
					CN: "中国 (China)",
					MY: "马来西亚 (Malaysia)",
					US: "美国 (United States)",
					JP: "日本 (Japan)",
					HK: "中国香港 (Hong Kong)",
					SG: "新加坡 (Singapore)",
					DE: "德国 (Germany)",
					GB: "英国 (United Kingdom)",
					TW: "中国台湾 (Taiwan)",
					CA: "加拿大 (Canada)",
					AU: "澳大利亚 (Australia)",
					KR: "韩国 (South Korea)",
					FR: "法国 (France)",
					NL: "荷兰 (Netherlands)",
					RU: "俄罗斯 (Russia)",
					IN: "印度 (India)",
					TH: "泰国 (Thailand)",
					VN: "越南 (Vietnam)",
					PH: "菲律宾 (Philippines)",
					ID: "印度尼西亚 (Indonesia)",
				};

				const formatBrowserName = (rawName: string): string => {
					const lower = (rawName || "").toLowerCase();
					if (lower === "edge-chromium" || lower === "edge") return "Edge";
					if (lower === "chrome") return "Chrome";
					if (lower === "firefox") return "Firefox";
					if (lower === "safari") return "Safari";
					if (lower === "ios-webview") return "iOS Webview";
					if (lower === "chromium-webview") return "Android Webview";
					if (lower === "opera") return "Opera";
					return rawName || "Unknown";
				};

				const formatDist = (
					items: UmamiMetricItem[],
					distType: "country" | "browser" | "os",
				): StatsMetricDistribution[] => {
					const sum = items.reduce((acc, curr) => acc + (curr.y || 0), 0) || 1;
					return items.map((i) => {
						const rawStr = (i.x || "").trim();
						let name = rawStr || "Unknown";
						let code: string | undefined;

						if (distType === "country") {
							const upperCode = rawStr.toUpperCase();
							code = upperCode;
							name = countryNameMap[upperCode] || upperCode || "未知地区";
						} else if (distType === "browser") {
							name = formatBrowserName(rawStr);
						}

						return {
							name,
							code,
							visits: i.y || 0,
							percent: Number((((i.y || 0) / sum) * 100).toFixed(1)),
						};
					});
				};

				const formatPageTitle = (path: string): string => {
					if (!path || path === "/" || path === "") return "博客首页 (Home)";
					if (path === "/friends" || path === "/friends/")
						return "友情链接 (Friends)";
					if (path === "/dynamic" || path === "/dynamic/")
						return "即刻说说 (Dynamic)";
					if (path === "/archive" || path === "/archive/")
						return "文章归档 (Archive)";
					if (path === "/guestbook" || path === "/guestbook/")
						return "留言板 (Guestbook)";
					if (path === "/about" || path === "/about/")
						return "关于博主 (About)";
					if (path === "/fcircle" || path === "/fcircle/")
						return "友链朋友圈 (Fcircle)";
					if (path === "/console" || path === "/console/")
						return "管理中台 (Console)";
					if (path.startsWith("/projects/")) {
						const projSlug = path
							.replace(/^\/projects\//, "")
							.replace(/\/$/, "");
						if (!projSlug) return "项目作品 (Projects)";
						return `项目 · ${projSlug}`;
					}
					if (path.startsWith("/posts/")) {
						const slug = path.replace(/^\/posts\//, "").replace(/\/$/, "");
						try {
							return `文章 · ${decodeURIComponent(slug)}`;
						} catch {
							return `文章 · ${slug}`;
						}
					}
					try {
						return decodeURIComponent(path);
					} catch {
						return path;
					}
				};

				const topPages: StatsTopPage[] = pages.map((p) => ({
					path: p.x,
					title: formatPageTitle(p.x),
					views: p.y || 0,
				}));

				const result: StatsInsightsData = {
					topPages,
					countries: formatDist(countriesRaw, "country"),
					browsers: formatDist(browsersRaw, "browser"),
					os: formatDist(osRaw, "os"),
					source: "umami",
				};

				try {
					await c.env.KV.put(cacheKey, JSON.stringify(result), {
						expirationTtl: 3600,
					});
				} catch {}

				return c.json({
					code: 200,
					data: result,
					fromCache: false,
				});
			}
		} catch (err) {
			console.warn("[Stats API] Umami metrics query failed:", err);
		}
	}

	// 3. 容灾拟真生成优雅画像与文章排行榜
	const fallbackTopPages: StatsTopPage[] = [
		{
			path: "/posts/firefly/",
			title: "Firefly 一款清新美观的 Astro 博客主题模板",
			views: 3120,
		},
		{
			path: "/posts/markdown-tutorial/",
			title: "Markdown 进阶排版与组件深度应用教程",
			views: 2480,
		},
		{
			path: "/fcircle/",
			title: "友链朋友圈 - 友邻动态与订阅文章聚合",
			views: 1960,
		},
		{
			path: "/posts/code-examples/",
			title: "全语言代码高亮与交互式复制演示",
			views: 1540,
		},
		{
			path: "/dynamic/",
			title: "动态说说 - 边缘即时发布与生活微记录",
			views: 1380,
		},
		{
			path: "/posts/katex-math-example/",
			title: "KaTeX 数学公式排版与极速渲染体验",
			views: 1120,
		},
		{
			path: "/posts/markdown-mermaid/",
			title: "Mermaid 图表与时序流程图可视化",
			views: 940,
		},
		{
			path: "/projects/",
			title: "个人开源项目与实验作品展厅",
			views: 820,
		},
		{
			path: "/posts/markdown-plantuml/",
			title: "PlantUML 架构建模与状态时序图例",
			views: 710,
		},
		{
			path: "/about/",
			title: "关于博主与全站架构演进记录",
			views: 630,
		},
	];

	const fallbackCountries: StatsMetricDistribution[] = [
		{ name: "中国 (China)", code: "CN", visits: 6840, percent: 69.1 },
		{ name: "美国 (United States)", code: "US", visits: 1280, percent: 12.9 },
		{ name: "日本 (Japan)", code: "JP", visits: 590, percent: 6.0 },
		{ name: "中国香港 (Hong Kong)", code: "HK", visits: 450, percent: 4.5 },
		{ name: "新加坡 (Singapore)", code: "SG", visits: 330, percent: 3.3 },
		{ name: "德国 (Germany)", code: "DE", visits: 240, percent: 2.4 },
		{ name: "其他国家与地区", code: "OTHER", visits: 170, percent: 1.8 },
	];

	const fallbackBrowsers: StatsMetricDistribution[] = [
		{ name: "Chrome", visits: 5690, percent: 57.5 },
		{ name: "Safari", visits: 1820, percent: 18.4 },
		{ name: "Edge", visits: 1240, percent: 12.5 },
		{ name: "Firefox", visits: 720, percent: 7.3 },
		{ name: "其他浏览器", visits: 430, percent: 4.3 },
	];

	const fallbackOs: StatsMetricDistribution[] = [
		{ name: "Windows", visits: 4450, percent: 44.9 },
		{ name: "macOS", visits: 2380, percent: 24.0 },
		{ name: "iOS", visits: 1590, percent: 16.1 },
		{ name: "Android", visits: 1140, percent: 11.5 },
		{ name: "Linux", visits: 340, percent: 3.5 },
	];

	const fallbackInsights: StatsInsightsData = {
		topPages: fallbackTopPages,
		countries: fallbackCountries,
		browsers: fallbackBrowsers,
		os: fallbackOs,
		source: "simulated",
	};

	try {
		await c.env.KV.put(cacheKey, JSON.stringify(fallbackInsights), {
			expirationTtl: 3600,
		});
	} catch {}

	return c.json({
		code: 200,
		data: fallbackInsights,
		fromCache: false,
	});
});

export default stats;
