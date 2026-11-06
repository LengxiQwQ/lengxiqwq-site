import fs from "node:fs";
import path from "node:path";
import type {
	FriendAuditCheckStatus,
	FriendAuditDecision,
	FriendAuditRecord,
	FriendLink,
	FriendsAuditData,
} from "../src/types/friendsConfig";

// ---------- 配置常量 ----------
const AUDIT_FILE = path.resolve("src/constants/friends-audit.json");
const TIMEOUT_MS = 7_000; // 优化至 6 秒，包容国内慢速主机和冷启动 API
const MAX_CONCURRENCY = 6; // 并发探测数

// 匹配本站的核心关键词（包含站名、网址及各种常用称谓）
export const DEFAULT_KEYWORDS: string[] = [
	"lengxiqwq.com",
	"冷汐的杂货铺",
	"冷曦的小窝",
	"lengxiqwq",
	"lengxi",
	"冷汐",
	"冷曦",
];

// 检查是否为私有、环回或云元数据地址（防 SSRF）
export function isPrivateOrLocalHost(hostname: string): boolean {
	const lower = hostname.toLowerCase().trim();
	if (
		lower === "localhost" ||
		lower.endsWith(".local") ||
		lower.endsWith(".internal") ||
		lower.endsWith(".localdomain")
	) {
		return true;
	}
	// 匹配私有 IPv4 段与环回地址 (127.*, 10.*, 192.168.*, 169.254.*, 0.*)
	if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(lower)) return true;
	// 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
	if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(lower)) return true;
	// 匹配 IPv6 环回与链路本地 (::1, fe80::, fc00::, fd00::)
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

// 深度模拟桌面现代 Chrome 133 浏览器完整请求头（包含 Client Hints 与 Fetch Metadata），最大程度避免被 WAF 误杀拦截
const BROWSER_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
	"Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
	Accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
	"sec-ch-ua":
		'"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
	"sec-ch-ua-mobile": "?0",
	"sec-ch-ua-platform": '"Windows"',
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
	Priority: "u=0, i",
	"Cache-Control": "max-age=0",
};

// 精准识别 Cloudflare 5 秒盾与人机验证挑战页面（排查误报，绝不误杀正常长网页）
function checkIsWafChallenge(html: string): boolean {
	// 真正的反爬验证页面体积极小（通常 < 35KB），数百 KB 的正常博客正文绝不属于拦截页
	if (html.length > 35000) return false;
	const lower = html.toLowerCase();
	return (
		lower.includes("<title>just a moment...</title>") ||
		lower.includes("<title>attention required! | cloudflare</title>") ||
		lower.includes("<title>security check</title>") ||
		lower.includes("cf-browser-verification") ||
		lower.includes('id="challenge-running"') ||
		lower.includes('id="challenge-form"') ||
		lower.includes('class="cf-error-overview"') ||
		(html.length < 500 &&
			(lower.includes("cloudflare") || lower.includes("captcha")))
	);
}

// 剥离 HTML 中常见干扰区域（如评论区、留言板、申请表单），防止评论留言或表单草稿误判为正向友链
function pruneHtmlNoise(html: string): string {
	return html
		.replace(
			/<(?:div|section|aside)[^>]+(?:id|class)=["'][^"']*(?:waline|twikoo|vcomments?|comments?|comment-list|artalk|disqus_thread|giscus|gitalk|liuyan)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section|aside)>/gi,
			"",
		)
		.replace(/<form[^>]*>[\s\S]*?<\/form>/gi, "")
		.replace(/<textarea[^>]*>[\s\S]*?<\/textarea>/gi, "");
}

// 通用友链实体审核与生命周期校验器（通用型判定：过滤待审核申请、被拒绝、已封禁、草稿或隐藏的数据）
function isApprovedFriendItem(
	item: Record<string, unknown> | null | undefined,
): boolean {
	if (!item || typeof item !== "object") return true;

	// 1. 显式隐藏与可见性布尔标记（涵盖主流 CMS 命名习惯）
	if (
		item.hide === true ||
		item.hidden === true ||
		item.visible === false ||
		item.is_visible === false ||
		item.enabled === false ||
		item.is_enabled === false ||
		item.active === false ||
		item.is_active === false ||
		item.published === false ||
		item.is_published === false ||
		item.approved === false ||
		item.is_approved === false ||
		item.deleted === true ||
		item.is_deleted === true ||
		item.trash === true
	) {
		return false;
	}

	// 2. 状态枚举（包含 Mix Space、Halo、WordPress、Typecho、Ghost 等系统的 state / status）
	const stateVal =
		item.state ??
		item.status ??
		item.audit ??
		item.audit_status ??
		item.auditStatus;

	if (typeof stateVal === "number") {
		// Mix Space 规范: 0 = Pass(通过), 1 = Audit(待审核申请), 2 = Outdate, 3 = Banned, 4 = Reject
		// 当对象包含 Mix Space 特征 (如包含 type 属性且为数字)
		if ("type" in item && typeof item.type === "number") {
			if (stateVal !== 0) return false;
		}
		// 通用负数状态码通常表示禁用或草稿
		if (stateVal < 0) return false;
	}

	if (typeof stateVal === "string") {
		const lower = stateVal.toLowerCase().trim();
		// 通用未生效/待审核/已拒绝/封禁/草稿关键字正则（任何博客系统通用适用）
		if (
			/^(pending|audit|review|unapproved|wait|waiting|applied|applying|rejected?|refused|banned|draft|trash|inactive|deleted|disabled|hidden|hide)$/i.test(
				lower,
			)
		) {
			return false;
		}
	}

	return true;
}

// ---------- 站点存活与头像检测函数（供全站爬虫与 Issue 申请共享） ----------
export async function verifySiteReachable(
	siteUrl: string,
): Promise<{ success: boolean; reason?: string }> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 12000);

		const response = await fetch(siteUrl, {
			signal: controller.signal,
			headers: {
				...BROWSER_HEADERS,
				Accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
			},
			redirect: "follow",
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			// 若遭遇 403 / 429 / 503 等机房/WAF 拦截，尝试通过只读代理验证站点是否真实可访问
			if ([403, 429, 503].includes(response.status)) {
				try {
					const jinaRes = await fetch(`https://r.jina.ai/${siteUrl}`, {
						signal: AbortSignal.timeout(8000),
						headers: {
							"User-Agent": BROWSER_HEADERS["User-Agent"],
							Accept: "text/plain",
						},
					});
					if (jinaRes.ok) {
						return { success: true };
					}
				} catch {}
			}

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

export async function verifyAvatarReachable(
	imgUrl: string,
	siteUrl?: string,
): Promise<{ success: boolean; reason?: string }> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000);

		const response = await fetch(imgUrl, {
			method: "GET",
			signal: controller.signal,
			headers: {
				...BROWSER_HEADERS,
				"Sec-Fetch-Dest": "image",
				"Sec-Fetch-Mode": "no-cors",
				Accept:
					"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
			},
			redirect: "follow",
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			// 1. 防盗链重试：附带站点主页作为 Referer
			if (siteUrl && response.status === 403) {
				try {
					const retryRes = await fetch(imgUrl, {
						method: "GET",
						signal: AbortSignal.timeout(6000),
						headers: {
							...BROWSER_HEADERS,
							Referer: siteUrl,
							"Sec-Fetch-Dest": "image",
							"Sec-Fetch-Mode": "no-cors",
							Accept:
								"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
						},
						redirect: "follow",
					});
					if (retryRes.ok) {
						return { success: true };
					}
				} catch {}
			}

			// 2. 若头像同域且主站受 Cloudflare/WAF 403 保护，避免因 CI 机房 IP 误杀阻断
			try {
				const imgHost = new URL(imgUrl).hostname;
				const siteHost = siteUrl ? new URL(siteUrl).hostname : "";
				if (
					siteHost &&
					(imgHost === siteHost || imgHost.endsWith(`.${siteHost}`))
				) {
					if ([403, 429, 503].includes(response.status)) {
						return { success: true };
					}
				}
			} catch {}

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

// ---------- 单 URL 探测结果接口 ----------
export interface FetchResult {
	status: FriendAuditCheckStatus;
	message: string;
	statusCode?: number;
	htmlSnippet?: string;
	html?: string;
}

// 关键词匹配辅助函数（同时检测原始文本与 URL 解码后的文本）
function matchKeywordsInContent(
	text: string,
	keywords: string[],
): string | undefined {
	const lower = text.toLowerCase();
	let decoded = lower;
	try {
		decoded = decodeURIComponent(lower);
	} catch {}
	return keywords.find(
		(kw) =>
			lower.includes(kw.toLowerCase()) || decoded.includes(kw.toLowerCase()),
	);
}

export async function probeUrl(
	url: string,
	keywords: string[],
): Promise<FetchResult> {
	try {
		const parsedUrl = new URL(url);
		if (isPrivateOrLocalHost(parsedUrl.hostname)) {
			return {
				status: "error",
				statusCode: 400,
				message: `已安全拦截非公网或内网私有地址 (${parsedUrl.hostname})`,
			};
		}

		const res = await fetch(url, {
			signal: AbortSignal.timeout(TIMEOUT_MS),
			headers: BROWSER_HEADERS,
			redirect: "follow",
		});

		const statusCode = res.status;

		// 2. 处理常见防御拦截状态码（403, 429, 503 等）：优先使用只读渲染代理（r.jina.ai）穿透 WAF / 数据中心 IP 阻断
		if ([403, 429, 503].includes(statusCode)) {
			try {
				const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
					signal: AbortSignal.timeout(TIMEOUT_MS),
					headers: {
						"User-Agent": BROWSER_HEADERS["User-Agent"],
						Accept: "text/plain",
					},
				});
				if (jinaRes.ok) {
					const jinaText = await jinaRes.text();
					const jinaMatched = matchKeywordsInContent(jinaText, keywords);
					if (jinaMatched) {
						return {
							status: "found",
							statusCode: 200,
							html: jinaText,
							message: `成功通过只读代理穿透 WAF 匹配关键词: "${jinaMatched}" (${url})`,
						};
					}
				}
			} catch {}

			return {
				status: "protected",
				statusCode,
				message: `HTTP ${statusCode} 防御性拦截/限流 (反爬阻断)`,
			};
		}

		// 读取页面 HTML 正文（严格限制最大 2MB，防止恶意慢速流/超大文件导致内存 OOM）
		let html = "";
		if (res.body) {
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let bytesRead = 0;
			const MAX_BYTES = 2 * 1024 * 1024; // 2MB
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				bytesRead += value.length;
				html += decoder.decode(value, { stream: true });
				if (bytesRead >= MAX_BYTES) {
					reader.cancel();
					break;
				}
			}
			html += decoder.decode();
		} else {
			html = await res.text();
		}
		const lowerHtml = html.toLowerCase();

		// 1. 处理 404 Not Found（排除 Nginx 将 SPA 单页应用误配置为 error_page 404 /index.html 的特殊场景）
		if (statusCode === 404) {
			const isSpaFallback =
				lowerHtml.includes('<div id="app">') ||
				lowerHtml.includes('<div id="root">') ||
				lowerHtml.includes('id="__next"') ||
				lowerHtml.includes('<div id="__nuxt">') ||
				lowerHtml.includes('type="module"');

			if (!isSpaFallback) {
				return {
					status: "404",
					statusCode: 404,
					message: `HTTP 404 Not Found (${url})`,
				};
			}
			// 若为 SPA 单页应用且返回了前端外壳 HTML，继续往下执行动态数据接口与关键词深度检索！
		}

		// 3. 处理其他非 200 HTTP 错误（非 404）
		if (!res.ok && statusCode !== 404) {
			return {
				status: "error",
				statusCode,
				message: `HTTP ${statusCode} ${res.statusText}`,
			};
		}

		// 4. 识别软拦截（HTTP 200 但实际为 Cloudflare 盾或人机验证 HTML）
		const isWafPage = checkIsWafChallenge(html);

		if (isWafPage) {
			try {
				const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
					signal: AbortSignal.timeout(TIMEOUT_MS),
					headers: {
						"User-Agent": BROWSER_HEADERS["User-Agent"],
						Accept: "text/plain",
					},
				});
				if (jinaRes.ok) {
					const jinaText = await jinaRes.text();
					const jinaMatched = matchKeywordsInContent(jinaText, keywords);
					if (jinaMatched) {
						return {
							status: "found",
							statusCode: 200,
							html: jinaText,
							message: `成功通过只读代理穿透 WAF 匹配关键词: "${jinaMatched}" (${url})`,
						};
					}
				}
			} catch {}

			return {
				status: "protected",
				statusCode,
				message: "命中防爬/WAF验证页面特征 (反爬阻断)",
			};
		}

		// 5. 第一轮直接匹配：当前页面 HTML（剥离评论留言区与申请表单，确保只检测正文正式友链）
		const cleanHtml = pruneHtmlNoise(html);
		const directMatch = matchKeywordsInContent(cleanHtml, keywords);
		if (directMatch) {
			return {
				status: "found",
				statusCode,
				html,
				message: `成功匹配关键词: "${directMatch}" (${url})`,
			};
		}

		// 6. 第二轮智能深度探测：处理 SPA 客户端渲染（动态 JSON/API）与分页友链
		try {
			const parsed = new URL(url);
			const origin = parsed.origin;

			// A. 探测动态友链 API 数据接口 (如 xnmoe.com 的 /api/links 或 fuhao574 的 /friends.json)
			const dynamicApis = new Set<string>();

			// 从 HTML 中抓取潜在的链接/友链 JSON、跨域 API 地址（如 benlao.top 的 data-blog-api）
			const dataApiMatch = html.match(/data-[a-z-]*api=["']([^"']+)["']/i);
			if (dataApiMatch) {
				const apiBase = dataApiMatch[1].trim();
				dynamicApis.add(`${apiBase}/api/friends`);
				dynamicApis.add(`${apiBase}/api/links`);
				dynamicApis.add(`${apiBase}/friends`);
				dynamicApis.add(`${apiBase}/links`);
			}

			// 从页面 script 脚本中提取 fetch(...) 请求的动态数据源（如 cuizi.top 的 youlian.json）
			const scriptFetchMatches = html.match(/fetch\(\s*['"`]([^'"`]+)['"`]/gi);
			if (scriptFetchMatches) {
				for (const m of scriptFetchMatches) {
					const urlPart = m
						.replace(/^fetch\(\s*['"`]/, "")
						.replace(/['"`]$/, "");
					if (
						urlPart.endsWith(".json") ||
						urlPart.includes("api") ||
						urlPart.includes("youlian") ||
						urlPart.includes("friend") ||
						urlPart.includes("link")
					) {
						try {
							dynamicApis.add(new URL(urlPart, url).href);
						} catch {}
					}
				}
			}

			const apiMatches = html.match(
				/(?:\/api\/[^"'`\s>]+|(?:\/[^"'`\s>]+)?(?:links?|friends?|youlian|yl)[^"'`\s>]*\.json)/gi,
			);
			if (apiMatches) {
				for (const m of apiMatches) {
					try {
						dynamicApis.add(new URL(m, url).href);
					} catch {}
				}
			}

			// 从 HTML 中抓取绝对 API 域名路径 (如 Mix Space 的 https://mix-space.hoshiroko.com/api/v2)
			const fullApiMatches = html.match(
				/https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?::\d+)?(?:\/api(?:(?:\/v\d+)?|\/[^"'`\s\\>]+)?)/gi,
			);
			if (fullApiMatches) {
				for (const m of fullApiMatches) {
					try {
						const clean = m.replace(/\\+$/, "").trim();
						// 只请求正式已发布的友链列表，严禁探测内部未经审核的申请数据表
						dynamicApis.add(`${clean}/links`);
						dynamicApis.add(`${clean}/links/all`);
						dynamicApis.add(`${clean}/links?state=0`);
						dynamicApis.add(`${clean}/friends`);
						dynamicApis.add(`${clean}/friends/all`);
					} catch {}
				}
			}

			// Mix Space / 常见第三方独立博客公开前端数据接口 (只探测 /links、/links/all 等已过审正式接口)
			const domainParts = parsed.hostname.split(".");
			if (domainParts.length >= 2) {
				const rootDomain = domainParts.slice(-2).join(".");
				dynamicApis.add(`https://mix-space.${rootDomain}/api/v2/links`);
				dynamicApis.add(`https://mix-space.${rootDomain}/api/v2/links/all`);
				dynamicApis.add(`https://mix-space.${rootDomain}/api/v2/links?state=0`);
				dynamicApis.add(`https://api.${rootDomain}/api/v2/links`);
				dynamicApis.add(`https://api.${rootDomain}/api/v2/links/all`);
				dynamicApis.add(`https://api.${rootDomain}/api/v2/links?state=0`);
			}

			// 补充常见的博客系统动态友链接口
			dynamicApis.add(`${origin}/api/x/get_friends/?cat=0`);
			dynamicApis.add(`${origin}/api/x/get_friends/?cat=1`);
			dynamicApis.add(`${origin}/api/x/get_friends/?cat=2`);
			dynamicApis.add(`${origin}/api/x/get_friends/`);
			dynamicApis.add(`${origin}/api-common/friend-link`);
			dynamicApis.add(`${origin}/api/friend-link`);
			dynamicApis.add(`${origin}/api/friend-links`);
			dynamicApis.add(`${origin}/api/friends`);
			dynamicApis.add(`${origin}/api/links`);
			dynamicApis.add(`${origin}/api/youlian`);
			dynamicApis.add(`${origin}/friends.json`);
			dynamicApis.add(`${origin}/links.json`);
			dynamicApis.add(`${origin}/youlian.json`);

			for (const apiUrl of dynamicApis) {
				if (apiUrl === url) continue;
				try {
					const apiRes = await fetch(apiUrl, {
						signal: AbortSignal.timeout(3500),
						headers: BROWSER_HEADERS,
					});
					if (apiRes.ok) {
						const apiText = await apiRes.text();
						let apiMatched: string | undefined;

						try {
							const json = JSON.parse(apiText);
							const items = Array.isArray(json)
								? json
								: Array.isArray(json?.data)
									? json.data
									: Array.isArray(json?.links)
										? json.links
										: Array.isArray(json?.friends)
											? json.friends
											: null;

							if (items) {
								// 列表型 JSON：仅在正式已发布（过滤待审核申请、被拒绝、已封禁等草稿数据）的项目中匹配
								for (const item of items) {
									if (!isApprovedFriendItem(item)) continue;
									const m = matchKeywordsInContent(
										JSON.stringify(item),
										keywords,
									);
									if (m) {
										apiMatched = m;
										break;
									}
								}
							} else {
								apiMatched = matchKeywordsInContent(apiText, keywords);
							}
						} catch {
							// 非 JSON 文本回退到普通内容匹配
							apiMatched = matchKeywordsInContent(apiText, keywords);
						}

						if (apiMatched) {
							return {
								status: "found",
								statusCode: 200,
								html: apiText,
								message: `在动态数据接口 (${apiUrl}) 成功匹配关键词: "${apiMatched}"`,
							};
						}
					}
				} catch {}
			}

			// B. 探测分页友链（针对一页只放几个、需要翻到第 2、3 页的友链）
			const paginationUrls = new Set<string>();
			const linkMatches = html.matchAll(
				/<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi,
			);
			for (const match of linkMatches) {
				const href = match[1];
				const linkText = match[2].trim();
				if (
					/(?:page|p)[=/]\d+|\/page\/\d+/i.test(href) ||
					/^[2-4]$|下一页|Next/i.test(linkText)
				) {
					try {
						const resolved = new URL(href, url).href;
						if (resolved.startsWith(origin) && resolved !== url) {
							paginationUrls.add(resolved);
						}
					} catch {}
				}
			}

			let checkedPages = 0;
			for (const pageUrl of paginationUrls) {
				if (checkedPages >= 2) break;
				checkedPages++;
				try {
					const pageRes = await fetch(pageUrl, {
						signal: AbortSignal.timeout(4000),
						headers: BROWSER_HEADERS,
					});
					if (pageRes.ok) {
						const pageHtml = await pageRes.text();
						const pageMatched = matchKeywordsInContent(pageHtml, keywords);
						if (pageMatched) {
							return {
								status: "found",
								statusCode: 200,
								html: pageHtml,
								message: `在分页友链 (${pageUrl}) 成功匹配关键词: "${pageMatched}"`,
							};
						}
					}
				} catch {}
			}
		} catch {}

		// 页面响应正常、深度动态/分页探测后均无关键词
		if (statusCode === 404) {
			return {
				status: "missing",
				statusCode: 404,
				html,
				message: `SPA单页应用(Nginx返回404但带有前端外壳)，已穿透后端API探测，未检索到本站链接 (${url})`,
			};
		}

		return {
			status: "missing",
			statusCode,
			html,
			message: `页面响应正常，经静态正文、动态接口及分页检索均未找到本站关键词 (${url})`,
		};
	} catch (err: unknown) {
		const e = err as Error;
		if (e.name === "AbortError" || e.name === "TimeoutError") {
			return {
				status: "error",
				message: `请求超时 (>${TIMEOUT_MS / 1000}s, 服务器未响应或网络延迟高)`,
			};
		}
		return {
			status: "error",
			message: e.message || String(e),
		};
	}
}

// 探测带 1 次自动重试（针对偶发网络超时或错误）
export async function probeWithRetry(
	url: string,
	keywords: string[],
): Promise<FetchResult> {
	const first = await probeUrl(url, keywords);
	if (
		first.status === "found" ||
		first.status === "missing" ||
		first.status === "404" ||
		first.status === "protected"
	) {
		return first;
	}
	await new Promise((r) => setTimeout(r, 1200));
	return await probeUrl(url, keywords);
}

// ---------- 固定目标友链页面探测调度器 ----------
export interface SmartProbeResult {
	status: FriendAuditCheckStatus;
	message: string;
	targetUrl: string;
}

export async function smartProbeFriend(
	friend: FriendLink,
	_prevRecord?: FriendAuditRecord,
): Promise<SmartProbeResult> {
	// 严格按固定友链地址探测：优先 friendPageUrl，否则使用 siteurl，不执行任何猜测与爬行
	const targetUrl = friend.friendPageUrl?.trim() || friend.siteurl;

	const res = await probeWithRetry(targetUrl, DEFAULT_KEYWORDS);

	return {
		status: res.status,
		message: res.message,
		targetUrl,
	};
}

// ---------- 并发控制器 ----------
async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let currentIndex = 0;

	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (true) {
				const index = currentIndex++;
				if (index >= items.length) break;
				results[index] = await fn(items[index], index);
			}
		},
	);

	await Promise.all(workers);
	return results;
}

// ---------- 单站点现场探测函数 ----------
export async function probeSingleSite(
	siteUrl: string,
	customTargetUrl?: string,
): Promise<FriendAuditRecord> {
	let auditData: FriendsAuditData = {};
	if (fs.existsSync(AUDIT_FILE)) {
		try {
			auditData = JSON.parse(fs.readFileSync(AUDIT_FILE, "utf-8"));
		} catch {
			auditData = {};
		}
	}

	let friend: FriendLink | undefined;
	try {
		const friendsConfigModule = await import("../src/config/friendsConfig.ts");
		const allFriends = friendsConfigModule.friendsConfig || [];
		friend = allFriends.find(
			(f: FriendLink) =>
				f.siteurl === siteUrl ||
				f.siteurl.replace(/\/+$/, "").toLowerCase() ===
					siteUrl.replace(/\/+$/, "").toLowerCase(),
		);
	} catch {}

	if (!friend) {
		const existingRecord = auditData[siteUrl];
		friend = {
			title: siteUrl,
			siteurl: siteUrl,
			friendPageUrl: customTargetUrl || existingRecord?.targetUrl,
			enabled: true,
		} as FriendLink;
	}

	const prevRecord: FriendAuditRecord = auditData[siteUrl] || {
		missingCount: 0,
		failCount: 0,
		lastChecked: "",
		lastStatus: "found",
		decision: "normal",
	};

	let missingCount = prevRecord.missingCount || 0;
	let failCount = prevRecord.failCount || 0;
	let protectedCount = prevRecord.protectedCount || 0;
	let decision: FriendAuditDecision = prevRecord.decision || "normal";

	let probeRes: SmartProbeResult;
	if (customTargetUrl?.trim()) {
		const target = customTargetUrl.trim();
		const r = await probeWithRetry(target, DEFAULT_KEYWORDS);
		probeRes = {
			status: r.status,
			message: r.message,
			targetUrl: target,
		};
	} else {
		probeRes = await smartProbeFriend(friend, prevRecord);
	}

	const now = new Date().toISOString();

	if (probeRes.status === "found") {
		missingCount = 0;
		failCount = 0;
		protectedCount = 0;
		// 自动自愈：一旦重新检测到友链，自动解除单向/失联隔离，恢复正常
		if (
			decision === "pending" ||
			decision === "single" ||
			decision === "quarantined"
		) {
			decision = "normal";
		}
	} else if (probeRes.status === "protected") {
		protectedCount += 1;
		if (protectedCount >= 3 && decision === "normal") decision = "pending";
	} else if (probeRes.status === "404") {
		failCount += 1;
		if (failCount >= 3 && decision === "normal") decision = "pending";
	} else if (probeRes.status === "missing") {
		failCount = 0; // 成功探测到正文或 SPA 接口，清除 404 故障计数
		missingCount += 1;
		if (missingCount >= 3 && decision === "normal") decision = "pending";
	}

	const updatedRecord: FriendAuditRecord = {
		missingCount,
		failCount,
		protectedCount,
		lastChecked: now,
		lastStatus: probeRes.status,
		lastMessage: probeRes.message,
		targetUrl: probeRes.targetUrl,
		decision,
		decisionTime: prevRecord.decisionTime,
	};

	auditData[siteUrl] = updatedRecord;
	fs.writeFileSync(AUDIT_FILE, JSON.stringify(auditData, null, "\t"), "utf-8");

	// 同步更新 friends-health.json 保持向后兼容
	const healthFilePath = path.resolve("src/constants/friends-health.json");
	try {
		let healthData: Record<
			string,
			{ failCount: number; lastChecked: string; lastError?: string }
		> = {};
		if (fs.existsSync(healthFilePath)) {
			healthData = JSON.parse(fs.readFileSync(healthFilePath, "utf-8"));
		}
		for (const [url, rec] of Object.entries(auditData)) {
			healthData[url] = {
				failCount: rec.failCount || 0,
				lastChecked: rec.lastChecked,
				lastError: rec.failCount > 0 ? rec.lastMessage : undefined,
			};
		}
		fs.writeFileSync(
			healthFilePath,
			JSON.stringify(healthData, null, "\t"),
			"utf-8",
		);
	} catch (e) {
		console.warn("[friends-audit] 同步写入 friends-health.json 失败:", e);
	}
	return updatedRecord;
}

export interface FullAuditSummary {
	total: number;
	normal: number;
	pending: number;
	single: number;
	quarantined: number;
	whitelisted: number;
	pendingList: Array<{ url: string; targetUrl: string; reason: string }>;
}

// ---------- 全站巡检综合主函数 ----------
export async function runFullAudit(
	options: { silent?: boolean } = {},
): Promise<FullAuditSummary> {
	if (!options.silent) {
		console.log("[friends-audit] 正在启动友链双向性与健康度智能综合巡检...");
	}

	// 1. 动态加载当前启用的友链配置
	let friendsConfigModule: { friendsConfig: Array<FriendLink> };
	try {
		friendsConfigModule = await import("../src/config/friendsConfig.ts");
	} catch (e) {
		console.error("[friends-audit] 无法加载 friendsConfig.ts:", e);
		throw e;
	}

	const allFriends = friendsConfigModule.friendsConfig || [];
	// 只对启用的博客类友链进行检测，排除站长本人的卡片与导航工具类站点
	const testableFriends = allFriends.filter(
		(f) =>
			f.enabled &&
			!f.siteurl.includes("lengxiqwq.com") &&
			!f.tags?.includes("导航") &&
			!f.whitelist,
	);

	if (!options.silent) {
		console.log(
			`[friends-audit] 配置中共有 ${allFriends.length} 个友链，其中 ${testableFriends.length} 个博客类需参与巡检`,
		);
	}

	// 2. 读取现有审计记录
	let auditData: FriendsAuditData = {};
	if (fs.existsSync(AUDIT_FILE)) {
		try {
			auditData = JSON.parse(fs.readFileSync(AUDIT_FILE, "utf-8"));
		} catch {
			auditData = {};
		}
	}

	// 3. 逐个并发执行智能多路径探测
	await mapConcurrent(testableFriends, MAX_CONCURRENCY, async (friend) => {
		const siteUrl = friend.siteurl;

		const prevRecord: FriendAuditRecord = auditData[siteUrl] || {
			missingCount: 0,
			failCount: 0,
			lastChecked: "",
			lastStatus: "found",
			decision: "normal",
		};

		// 若站长已手工加入白名单，直接跳过检测并保持 whitelisted
		if (friend.whitelist || prevRecord.decision === "whitelisted") {
			auditData[siteUrl] = {
				...prevRecord,
				decision: "whitelisted",
				lastChecked: new Date().toISOString(),
				lastStatus: "found",
				lastMessage: "站长白名单免检",
			};
			return;
		}

		const probeRes = await smartProbeFriend(friend, prevRecord);
		if (!options.silent) {
			const tag =
				probeRes.status === "found"
					? "✅"
					: probeRes.status === "protected"
						? "🛡️"
						: probeRes.status === "404"
							? "❌"
							: "⚠️";
			console.log(
				`[friends-audit] ${tag} [${probeRes.status.toUpperCase()}] ${friend.title} -> ${probeRes.targetUrl}`,
			);
		}
		const now = new Date().toISOString();

		let missingCount = prevRecord.missingCount || 0;
		let failCount = prevRecord.failCount || 0;
		let protectedCount = prevRecord.protectedCount || 0;
		let decision: FriendAuditDecision = prevRecord.decision || "normal";

		if (probeRes.status === "found") {
			missingCount = 0;
			failCount = 0;
			protectedCount = 0;
			// 自动自愈：一旦重新检测到友链，自动解除单向/失联隔离，恢复正常
			if (
				decision === "pending" ||
				decision === "single" ||
				decision === "quarantined"
			) {
				decision = "normal";
			}
		} else if (probeRes.status === "protected") {
			protectedCount += 1;
			if (protectedCount >= 3 && decision === "normal") decision = "pending";
		} else if (probeRes.status === "404") {
			failCount += 1;
			if (failCount >= 3 && decision === "normal") decision = "pending";
		} else if (probeRes.status === "missing") {
			failCount = 0; // 成功探测到正文或 SPA 接口，清除 404 故障计数
			missingCount += 1;
			if (missingCount >= 3 && decision === "normal") decision = "pending";
		}

		auditData[siteUrl] = {
			missingCount,
			failCount,
			protectedCount,
			lastChecked: now,
			lastStatus: probeRes.status,
			lastMessage: probeRes.message,
			targetUrl: probeRes.targetUrl,
			decision,
			decisionTime: prevRecord.decisionTime,
		};
	});

	// 4. 清理已在配置文件中被移除或属于导航类的无效记录（仅当友链总数正常时执行，防止未同步内容仓误清空历史数据）
	if (testableFriends.length >= 5) {
		const validUrls = new Set(testableFriends.map((f) => f.siteurl));
		for (const url of Object.keys(auditData)) {
			if (!validUrls.has(url)) {
				delete auditData[url];
			}
		}
	} else {
		console.warn(
			`[friends-audit] ⚠️ 检测到的友链数量偏少 (${testableFriends.length} 个)，已自动跳过历史审计清理以保护数据完整性。`,
		);
	}

	// 5. 写入状态文件
	const dir = path.dirname(AUDIT_FILE);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(AUDIT_FILE, JSON.stringify(auditData, null, "\t"), "utf-8");

	// 同步更新 friends-health.json 保持向后兼容
	const healthFilePath = path.resolve("src/constants/friends-health.json");
	try {
		let healthData: Record<
			string,
			{ failCount: number; lastChecked: string; lastError?: string }
		> = {};
		if (fs.existsSync(healthFilePath)) {
			healthData = JSON.parse(fs.readFileSync(healthFilePath, "utf-8"));
		}
		for (const [url, rec] of Object.entries(auditData)) {
			healthData[url] = {
				failCount: rec.failCount || 0,
				lastChecked: rec.lastChecked,
				lastError: rec.failCount > 0 ? rec.lastMessage : undefined,
			};
		}
		fs.writeFileSync(
			healthFilePath,
			JSON.stringify(healthData, null, "\t"),
			"utf-8",
		);
	} catch (e) {
		console.warn("[friends-audit] 同步写入 friends-health.json 失败:", e);
	}

	// 6. 生成汇总统计
	const pendingList = Object.entries(auditData).filter(
		([, r]) => r.decision === "pending",
	);
	const singleList = Object.entries(auditData).filter(
		([, r]) => r.decision === "single",
	);
	const quarantinedList = Object.entries(auditData).filter(
		([, r]) => r.decision === "quarantined",
	);
	const whitelistedList = Object.entries(auditData).filter(
		([, r]) => r.decision === "whitelisted",
	);
	const normalCount =
		testableFriends.length -
		pendingList.length -
		singleList.length -
		quarantinedList.length;

	const summary = {
		total: testableFriends.length,
		normal: normalCount,
		pending: pendingList.length,
		single: singleList.length,
		quarantined: quarantinedList.length,
		whitelisted: whitelistedList.length,
		pendingList: pendingList.map(([url, rec]) => ({
			url,
			targetUrl: rec.targetUrl || url,
			reason:
				rec.failCount >= 3
					? `连续 ${rec.failCount} 次 404 失效`
					: `连续 ${rec.missingCount} 次未检测到关键词`,
		})),
	};

	if (!options.silent) {
		console.log("\n================ [巡检汇总报告] ================");
		console.log(`📊 总检测博客: ${summary.total}`);
		console.log(`✅ 正常双向友链: ${summary.normal}`);
		console.log(`⚠️ 待站长审查 (连续 ≥3 次异常): ${summary.pending}`);
		console.log(`🏷️ 已确认为单向: ${summary.single}`);
		console.log(`🚫 已确认为失联: ${summary.quarantined}`);
		console.log(`🛡️ 免检白名单: ${summary.whitelisted}`);
		console.log("================================================\n");
	}

	return summary;
}

// CLI 直接执行入口（支持全站巡检或单站现场重测）
const isDirectRun =
	process.argv[1] &&
	(process.argv[1].endsWith("check-friends-reciprocal.ts") ||
		process.argv[1].endsWith("check-friends-reciprocal.js"));

if (isDirectRun) {
	const siteIdx = process.argv.indexOf("--site");
	if (siteIdx !== -1 && process.argv[siteIdx + 1]) {
		const siteUrl = process.argv[siteIdx + 1];
		const targetIdx = process.argv.indexOf("--target");
		const targetUrl =
			targetIdx !== -1 ? process.argv[targetIdx + 1] : undefined;
		probeSingleSite(siteUrl, targetUrl)
			.then((rec) => {
				console.log(JSON.stringify(rec));
				process.exit(0);
			})
			.catch((err) => {
				console.error("[friends-audit] 单站探测异常:", err);
				process.exit(1);
			});
	} else {
		runFullAudit()
			.then(() => process.exit(0))
			.catch((err) => {
				console.error("[friends-audit] 巡检过程遭遇未捕获异常:", err);
				process.exit(0);
			});
	}
}
