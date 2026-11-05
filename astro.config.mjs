import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { setMaxListeners } from "node:events";
import cloudflare from "@astrojs/cloudflare";
import { unified } from "@astrojs/markdown-remark";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import svelte from "@astrojs/svelte";
import { pluginCollapsibleSections } from "@expressive-code/plugin-collapsible-sections";
import { pluginLineNumbers } from "@expressive-code/plugin-line-numbers";
import swup from "@swup/astro";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";
import expressiveCode from "astro-expressive-code";
import icon from "astro-icon";
import { pluginLanguageLogo } from "ec-lang-logo"; /* Language Logo */
import { pluginCollapsible } from "expressive-code-collapsible"; /* Collapsible */
import { pluginLanguageBadge } from "expressive-code-language-badge"; /* Language Badge */
import katex from "katex";
import "katex/dist/contrib/mhchem.mjs"; // 加载 mhchem 扩展
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypeCallouts from "rehype-callouts";
import rehypeCodeGroup from "rehype-code-group"; /* Tab 代码块 */
import rehypeComponents from "rehype-components"; /* Render the custom directive content */
import rehypeKatex from "rehype-katex";
import rehypeSlug from "rehype-slug";
import remarkAdmonitionToBlockquoteCallout from "remark-admonition-to-blockquote-callout";
import remarkDirective from "remark-directive"; /* Handle directives */
import remarkMath from "remark-math";
import remarkSectionize from "remark-sectionize";
import {
	commentConfig,
	dynamicConfig,
	expressiveCodeConfig,
	fontConfig,
	fontsList,
	mermaidConfig,
	plantumlConfig,
	siteConfig,
} from "./src/config";
import I18nKey from "./src/i18n/i18nKey";
import { i18n } from "./src/i18n/translation";
import { GithubCardComponent } from "./src/plugins/rehype-component-github-card.mjs";
import { rehypeDiagramPanZoom } from "./src/plugins/rehype-diagram-panzoom.mjs";
import rehypeEmailProtection from "./src/plugins/rehype-email-protection.mjs";
import rehypeExternalLinks from "./src/plugins/rehype-external-links.mjs";
import rehypeFigure from "./src/plugins/rehype-figure.mjs";
import rehypeImageReferrerPolicy from "./src/plugins/rehype-image-referrerpolicy.mjs";
import { rehypeMermaid } from "./src/plugins/rehype-mermaid.mjs";
import { rehypePlantuml } from "./src/plugins/rehype-plantuml.mjs";
import { parseDirectiveNode } from "./src/plugins/remark-directive-rehype.js";
import { remarkExcerpt } from "./src/plugins/remark-excerpt.js";
import { remarkImageGrid } from "./src/plugins/remark-image-grid.js";
import { remarkMermaid } from "./src/plugins/remark-mermaid.js";
import { remarkPlantuml } from "./src/plugins/remark-plantuml.js";
import { remarkReadingTime } from "./src/plugins/remark-reading-time.mjs";
import { remarkWikiLink } from "./src/plugins/remark-wiki-link.js";
import { collectUsedFontCssVars } from "./src/utils/fontHelper";
import { getContentLastmodMap } from "./src/utils/sitemapHelper";

if (process.env.NODE_ENV === "development") {
	setMaxListeners(20);
}

const adapter = process.env.CF_WORKERS
	? cloudflare({
			prerenderEnvironment: "node",
		})
	: undefined;

// Vite 插件：本地开发环境下处理友链审查裁决与自检巡检请求，避免纯静态模式限制
function friendsAuditDevApiPlugin() {
	return {
		name: "vite-plugin-friends-audit-api",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const url = req.url?.split("?")[0];
				if (url !== "/api/friends-audit" && url !== "/api/friends-audit/") {
					return next();
				}
				if (req.method !== "POST") {
					return next();
				}

				// 严格限制仅允许本地来源调用，杜绝第三方恶意网页跨域 CSRF 触发命令
				const origin = req.headers.origin || req.headers.referer;
				if (origin) {
					try {
						const originUrl = new URL(origin);
						const isLocal =
							originUrl.hostname === "localhost" ||
							originUrl.hostname === "127.0.0.1" ||
							originUrl.hostname === "::1";
						if (!isLocal) {
							res.statusCode = 403;
							return res.end(
								JSON.stringify({
									error: "Forbidden: Cross-origin requests not allowed",
								}),
							);
						}
					} catch {
						res.statusCode = 403;
						return res.end(
							JSON.stringify({ error: "Forbidden: Invalid origin" }),
						);
					}
				}

				let bodyStr = "";
				req.on("data", (chunk) => {
					bodyStr += chunk;
				});
				req.on("end", async () => {
					res.setHeader("Content-Type", "application/json");
					try {
						const body = JSON.parse(bodyStr || "{}");
						const { action, siteurl, decision } = body;
						const auditFile = path.resolve("src/constants/friends-audit.json");

						// 1. 全站自检巡检动作：通过子进程安全调用巡检脚本
						if (action === "run-full-check") {
							exec("npx tsx scripts/check-friends-reciprocal.ts", (err) => {
								let auditData = {};
								if (fs.existsSync(auditFile)) {
									try {
										auditData = JSON.parse(fs.readFileSync(auditFile, "utf-8"));
									} catch {}
								}
								const total = Object.keys(auditData).length;
								const pending = Object.values(auditData).filter(
									(r) => r.decision === "pending",
								).length;
								const normal = Object.values(auditData).filter(
									(r) => r.decision === "normal",
								).length;
								res.statusCode = 200;
								return res.end(
									JSON.stringify({
										success: true,
										summary: { total, pending, normal },
									}),
								);
							});
							return;
						}

						// 2. 单站现场重测动作：原生智能多路径现场探测
						if (action === "probe-single") {
							if (!siteurl) {
								res.statusCode = 400;
								return res.end(JSON.stringify({ error: "Missing siteurl" }));
							}
							let auditData = {};
							if (fs.existsSync(auditFile)) {
								try {
									auditData = JSON.parse(fs.readFileSync(auditFile, "utf-8"));
								} catch {}
							}
							const prev = auditData[siteurl] || {
								missingCount: 0,
								failCount: 0,
								protectedCount: 0,
								lastChecked: "",
								lastStatus: "found",
								decision: "normal",
							};

							const keywords = [
								"lengxiqwq.com",
								"冷汐的杂货铺",
								"冷曦的小窝",
								"lengxiqwq",
								"lengxi",
								"冷汐",
								"冷曦",
							];
							const headers = {
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

							// 严格按定死的友链地址探测：优先请求体指定或先前记录的，否则取 siteurl，绝不自动爬取无关页面
							const targetUrl =
								body.targetUrl?.trim() || prev.targetUrl || siteurl;

							let missingCount = prev.missingCount || 0;
							let failCount = prev.failCount || 0;
							let protectedCount = prev.protectedCount || 0;
							let decision = prev.decision || "normal";
							let lastStatus = "found";
							let lastMessage = "";

							const matchInText = (text) => {
								const lower = text.toLowerCase();
								let decoded = lower;
								try {
									decoded = decodeURIComponent(lower);
								} catch {}
								return keywords.find(
									(k) =>
										lower.includes(k.toLowerCase()) ||
										decoded.includes(k.toLowerCase()),
								);
							};

							try {
								const resp = await fetch(targetUrl, {
									signal: AbortSignal.timeout(7000),
									headers,
									redirect: "follow",
								});

								if ([403, 429, 503].includes(resp.status)) {
									lastStatus = "protected";
									protectedCount += 1;
									lastMessage = `HTTP ${resp.status} 防御性拦截/限流 (反爬阻断)`;
									if (protectedCount >= 3 && decision === "normal")
										decision = "pending";
								} else {
									const html = await resp.text();
									const lower = html.toLowerCase();
									const isSpaFallback =
										resp.status === 404 &&
										(lower.includes('<div id="app">') ||
											lower.includes('<div id="root">') ||
											lower.includes('id="__next"') ||
											lower.includes('<div id="__nuxt">') ||
											lower.includes('type="module"'));

									if (resp.status === 404 && !isSpaFallback) {
										lastStatus = "404";
										failCount += 1;
										lastMessage = `HTTP 404 Not Found (${targetUrl})`;
										if (failCount >= 3 && decision === "normal")
											decision = "pending";
									} else if (!resp.ok && resp.status !== 404) {
										lastStatus = "error";
										lastMessage = `HTTP ${resp.status} ${resp.statusText}`;
									} else {
										const isWaf =
											html.length < 35000 &&
											(lower.includes("<title>just a moment...</title>") ||
												lower.includes(
													"<title>attention required! | cloudflare</title>",
												) ||
												lower.includes("<title>security check</title>") ||
												lower.includes("cf-browser-verification") ||
												lower.includes('id="challenge-running"') ||
												lower.includes('id="challenge-form"') ||
												lower.includes('class="cf-error-overview"'));
										if (isWaf) {
											lastStatus = "protected";
											protectedCount += 1;
											lastMessage = "命中防爬/WAF验证特征 (反爬阻断)";
											if (protectedCount >= 3 && decision === "normal")
												decision = "pending";
										} else {
											const matched = matchInText(html);
											if (matched) {
												lastStatus = "found";
												missingCount = 0;
												failCount = 0;
												protectedCount = 0;
												lastMessage = `成功匹配关键词: "${matched}" (${targetUrl})`;
												if (
													decision === "pending" ||
													decision === "single" ||
													decision === "quarantined"
												)
													decision = "normal";
											} else {
												// 针对 SPA 动态渲染与分页二次深度探测
												let foundInExtra = false;
												try {
													const parsed = new URL(targetUrl);
													const origin = parsed.origin;
													const dynamicApis = new Set();
													const dataApiMatch = html.match(
														/data-[a-z-]*api=["']([^"']+)["']/i,
													);
													if (dataApiMatch) {
														const apiBase = dataApiMatch[1].trim();
														dynamicApis.add(`${apiBase}/api/friends`);
														dynamicApis.add(`${apiBase}/api/links`);
														dynamicApis.add(`${apiBase}/friends`);
														dynamicApis.add(`${apiBase}/links`);
													}
													const scriptFetchMatches = html.match(
														/fetch\(\s*['"`]([^'"`]+)['"`]/gi,
													);
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
																	dynamicApis.add(
																		new URL(urlPart, targetUrl).href,
																	);
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
																dynamicApis.add(new URL(m, targetUrl).href);
															} catch {}
														}
													}
													dynamicApis.add(`${origin}/api/x/get_friends/?cat=0`);
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
														if (apiUrl === targetUrl) continue;
														try {
															const apiRes = await fetch(apiUrl, {
																signal: AbortSignal.timeout(3500),
																headers,
															});
															if (apiRes.ok) {
																const apiText = await apiRes.text();
																const apiMatched = matchInText(apiText);
																if (apiMatched) {
																	lastStatus = "found";
																	missingCount = 0;
																	failCount = 0;
																	protectedCount = 0;
																	lastMessage = `在动态数据接口 (${apiUrl}) 成功匹配关键词: "${apiMatched}"`;
																	if (
																		decision === "pending" ||
																		decision === "single" ||
																		decision === "quarantined"
																	)
																		decision = "normal";
																	foundInExtra = true;
																	break;
																}
															}
														} catch {}
													}

													if (!foundInExtra) {
														const paginationUrls = new Set();
														const linkRegex =
															/<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
														let pMatch;
														while ((pMatch = linkRegex.exec(html)) !== null) {
															const href = pMatch[1];
															const linkText = pMatch[2].trim();
															if (
																/(?:page|p)[=/]\d+|\/page\/\d+/i.test(href) ||
																/^[2-4]$|下一页|Next/i.test(linkText)
															) {
																try {
																	const resolved = new URL(href, targetUrl)
																		.href;
																	if (
																		resolved.startsWith(origin) &&
																		resolved !== targetUrl
																	)
																		paginationUrls.add(resolved);
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
																	headers,
																});
																if (pageRes.ok) {
																	const pageHtml = await pageRes.text();
																	const pageMatched = matchInText(pageHtml);
																	if (pageMatched) {
																		lastStatus = "found";
																		missingCount = 0;
																		failCount = 0;
																		protectedCount = 0;
																		lastMessage = `在分页友链 (${pageUrl}) 成功匹配关键词: "${pageMatched}"`;
																		if (
																			decision === "pending" ||
																			decision === "single" ||
																			decision === "quarantined"
																		)
																			decision = "normal";
																		foundInExtra = true;
																		break;
																	}
																}
															} catch {}
														}
													}
												} catch {}

												if (!foundInExtra) {
													lastStatus = "missing";
													failCount = 0;
													missingCount += 1;
													if (resp.status === 404) {
														lastMessage = `SPA单页应用(Nginx返回404但带有前端外壳)，已穿透后端API探测，未检索到本站链接 (${targetUrl})`;
													} else {
														lastMessage = `页面正常，经正文、动态接口及分页检索均未搜到本站关键词 (${targetUrl})`;
													}
													if (missingCount >= 3 && decision === "normal")
														decision = "pending";
												}
											}
										}
									}
								}
							} catch (err) {
								if (err.name === "AbortError" || err.name === "TimeoutError") {
									lastStatus = "error";
									failCount += 1;
									lastMessage = "请求超时 (>7s, 网络延迟高或服务器无响应)";
									if (failCount >= 3 && decision === "normal")
										decision = "pending";
								} else {
									lastStatus = "error";
									failCount += 1;
									lastMessage = err.message || "请求失败";
									if (failCount >= 3 && decision === "normal")
										decision = "pending";
								}
							}

							auditData[siteurl] = {
								missingCount,
								failCount,
								protectedCount,
								lastChecked: new Date().toISOString(),
								lastStatus,
								lastMessage,
								targetUrl,
								decision,
								decisionTime: prev.decisionTime,
							};
							fs.writeFileSync(
								auditFile,
								JSON.stringify(auditData, null, "\t"),
								"utf-8",
							);
							res.statusCode = 200;
							return res.end(
								JSON.stringify({
									success: true,
									siteurl,
									record: auditData[siteurl],
								}),
							);
						}

						// 3. 修改自定义友链地址
						if (action === "save-target-url") {
							if (!siteurl || !body.targetUrl) {
								res.statusCode = 400;
								return res.end(
									JSON.stringify({ error: "Missing siteurl or targetUrl" }),
								);
							}
							let auditData = {};
							if (fs.existsSync(auditFile)) {
								try {
									auditData = JSON.parse(fs.readFileSync(auditFile, "utf-8"));
								} catch {}
							}
							const prev = auditData[siteurl] || {
								missingCount: 0,
								failCount: 0,
								lastChecked: "",
								lastStatus: "found",
								decision: "normal",
							};
							auditData[siteurl] = {
								...prev,
								targetUrl: body.targetUrl.trim(),
							};
							fs.writeFileSync(
								auditFile,
								JSON.stringify(auditData, null, "\t"),
								"utf-8",
							);
							res.statusCode = 200;
							return res.end(
								JSON.stringify({
									success: true,
									siteurl,
									targetUrl: body.targetUrl.trim(),
								}),
							);
						}

						// 3. 人工裁决状态写入
						if (!siteurl || !decision) {
							res.statusCode = 400;
							return res.end(JSON.stringify({ error: "Missing parameters" }));
						}

						let auditData = {};
						if (fs.existsSync(auditFile)) {
							try {
								auditData = JSON.parse(fs.readFileSync(auditFile, "utf-8"));
							} catch {
								auditData = {};
							}
						}

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

						fs.writeFileSync(
							auditFile,
							JSON.stringify(auditData, null, "\t"),
							"utf-8",
						);

						res.statusCode = 200;
						res.end(
							JSON.stringify({
								success: true,
								siteurl,
								decision,
								record: auditData[siteurl],
							}),
						);
					} catch (e) {
						res.statusCode = 500;
						res.end(JSON.stringify({ error: e.message, stack: e.stack }));
					}
				});
			});
		},
	};
}

// Vite 插件：本地开发环境下处理壁纸预设色相保存请求，直接写入项目配置文件
function wallpaperHuePresetsDevApiPlugin() {
	return {
		name: "vite-plugin-wallpaper-hue-presets-api",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const url = req.url?.split("?")[0];
				if (
					url !== "/api/wallpaper-hue-presets" &&
					url !== "/api/wallpaper-hue-presets/"
				) {
					return next();
				}
				if (req.method !== "POST" && req.method !== "GET") {
					return next();
				}

				const origin = req.headers.origin || req.headers.referer;
				if (origin) {
					try {
						const originUrl = new URL(origin);
						const isLocal =
							originUrl.hostname === "localhost" ||
							originUrl.hostname === "127.0.0.1" ||
							originUrl.hostname === "::1";
						if (!isLocal) {
							res.statusCode = 403;
							return res.end(
								JSON.stringify({
									error: "Forbidden: Cross-origin requests not allowed",
								}),
							);
						}
					} catch {
						res.statusCode = 403;
						return res.end(
							JSON.stringify({ error: "Forbidden: Invalid origin" }),
						);
					}
				}

				if (req.method === "GET") {
					const targetPath = fs.existsSync(
						path.resolve(
							"../lengxiqwq-site-content/config/backgroundWallpaper.ts",
						),
					)
						? path.resolve(
								"../lengxiqwq-site-content/config/backgroundWallpaper.ts",
							)
						: path.resolve("src/config/backgroundWallpaper.ts");
					try {
						const content = fs.readFileSync(targetPath, "utf-8");
						const match = content.match(
							/wallpaperHuePresets:\s*\{([\s\S]*?)\},?/,
						);
						const presets = {};
						if (match && match[1]) {
							const lines = match[1].split("\n");
							for (const line of lines) {
								const lineMatch = line.match(/["']([^"']+)["']\s*:\s*(\d+)/);
								if (lineMatch) {
									presets[lineMatch[1]] = Number(lineMatch[2]);
								}
							}
						}
						res.setHeader("Content-Type", "application/json");
						return res.end(JSON.stringify({ success: true, presets }));
					} catch (e) {
						res.statusCode = 500;
						return res.end(JSON.stringify({ error: String(e) }));
					}
				}

				let bodyStr = "";
				req.on("data", (chunk) => {
					bodyStr += chunk;
				});
				req.on("end", async () => {
					res.setHeader("Content-Type", "application/json");
					try {
						const body = JSON.parse(bodyStr || "{}");
						const { presets } = body;
						if (!presets || typeof presets !== "object") {
							res.statusCode = 400;
							return res.end(
								JSON.stringify({ error: "Invalid presets data" }),
							);
						}

						const contentRepoPath = path.resolve(
							"../lengxiqwq-site-content/config/backgroundWallpaper.ts",
						);
						const mainRepoPath = path.resolve("src/config/backgroundWallpaper.ts");
						// 若存在私有内容仓，遵循 Rule 0 仅写入内容仓，依靠 contentRepoWatcher 自动热同步；仅在单代码仓时写入自身
						const targetPaths = fs.existsSync(contentRepoPath)
							? [contentRepoPath]
							: [mainRepoPath];

						// 先从现有配置文件中提取已有预设，与传入的数据智能合并，保证已有壁纸预设不丢失
						let existingPresets = {};
						const refPath = fs.existsSync(targetPaths[0])
							? targetPaths[0]
							: targetPaths[1];
						if (fs.existsSync(refPath)) {
							try {
								const existingContent = fs.readFileSync(refPath, "utf-8");
								const match = existingContent.match(
									/wallpaperHuePresets:\s*\{([\s\S]*?)\},?/,
								);
								if (match && match[1]) {
									for (const line of match[1].split("\n")) {
										const lineMatch = line.match(/["']([^"']+)["']\s*:\s*(\d+)/);
										if (lineMatch) {
											existingPresets[lineMatch[1]] = Number(lineMatch[2]);
										}
									}
								}
							} catch {}
						}

						const mergedPresets = { ...existingPresets, ...presets };
						const formattedPresets = Object.entries(mergedPresets)
							.map(([k, v]) => `\t\t"${k}": ${v},`)
							.join("\n");
						const presetBlock = `\twallpaperHuePresets: {\n${formattedPresets}\n\t},`;

						let updatedCount = 0;
						for (const targetPath of targetPaths) {
							if (fs.existsSync(targetPath)) {
								let content = fs.readFileSync(targetPath, "utf-8");
								if (content.includes("wallpaperHuePresets:")) {
									content = content.replace(
										/wallpaperHuePresets:\s*\{[\s\S]*?\},?/,
										presetBlock,
									);
								} else if (content.includes("src: {")) {
									const srcMatch = content.match(/src:\s*\{[\s\S]*?\n\t\},/);
									if (srcMatch) {
										content = content.replace(
											srcMatch[0],
											`${srcMatch[0]}\n${presetBlock}`,
										);
									} else {
										content = content.replace(
											/export const backgroundWallpaper[^{]*\{/,
											`$&\n${presetBlock}`,
										);
									}
								} else {
									content = content.replace(
										/export const backgroundWallpaper[^{]*\{/,
										`$&\n${presetBlock}`,
									);
								}
								fs.writeFileSync(targetPath, content, "utf-8");
								updatedCount++;
							}
						}

						res.statusCode = 200;
						return res.end(
							JSON.stringify({
								success: true,
								count: Object.keys(presets).length,
								updatedFiles: updatedCount,
							}),
						);
					} catch (e) {
						res.statusCode = 500;
						return res.end(JSON.stringify({ error: String(e) }));
					}
				});
			});
		},
	};
}

// Vite 插件：记录开发服务器运行锁，在服务退出时自动清理，防止多实例冲突
function devServerLockPlugin() {
	return {
		name: "vite-plugin-dev-server-lock",
		configureServer(server) {
			const lockPath = path.resolve(".dev.lock");
			const port = server.config.server.port || 4321;
			try {
				fs.writeFileSync(
					lockPath,
					JSON.stringify(
						{
							pid: process.pid,
							port,
							startTime: new Date().toISOString(),
							cwd: process.cwd(),
						},
						null,
						2,
					),
					"utf8",
				);
			} catch {}

			const cleanup = () => {
				try {
					if (fs.existsSync(lockPath)) {
						const raw = fs.readFileSync(lockPath, "utf8");
						const data = JSON.parse(raw);
						if (data.pid === process.pid) {
							fs.unlinkSync(lockPath);
						}
					}
				} catch {}
			};

			server.httpServer?.once("close", cleanup);
			process.once("exit", cleanup);
			process.once("SIGINT", () => {
				cleanup();
				process.exit(0);
			});
			process.once("SIGTERM", () => {
				cleanup();
				process.exit(0);
			});
		},
	};
}

// Vite 插件：本地开发时实时监听私有内容仓，变动时自动热同步并刷新页面
function contentRepoWatcher() {
	return {
		name: "vite-plugin-content-repo-watcher",
		configureServer(server) {
			let contentDir = process.env.CONTENT_DIR;
			if (!contentDir) {
				const sibling = path.resolve("../lengxiqwq-site-content");
				if (fs.existsSync(sibling)) {
					contentDir = sibling;
				}
			}
			if (!contentDir || !fs.existsSync(contentDir)) {
				return;
			}

			const resolvedDir = path.resolve(contentDir);
			server.watcher.add(resolvedDir);

			// 防抖与去重映射表，避免 Windows 下多重事件引发并发与重复 I/O
			const debounceTimers = new Map();

			const syncTarget = (filePath) => {
				const rel = path.relative(resolvedDir, filePath);
				if (
					rel.startsWith(".git") ||
					rel.startsWith("node_modules") ||
					rel.endsWith(".DS_Store") ||
					rel.endsWith("Thumbs.db")
				) {
					return;
				}

				let dest = null;
				let isConfig = false;

				if (rel.startsWith(`content${path.sep}`) || rel === "content") {
					dest = path.resolve("src", rel);
				} else if (rel.startsWith(`config${path.sep}`) || rel === "config") {
					dest = path.resolve("src", rel);
					isConfig = true;
				} else if (rel.startsWith(`public${path.sep}`) || rel === "public") {
					const sub = rel.slice("public".length + 1);
					dest = path.resolve("public", sub);
				}

				if (!dest) return;

				// 100ms 防抖，合并 Windows 短时间内的多重写入/元数据触发
				if (debounceTimers.has(filePath)) {
					clearTimeout(debounceTimers.get(filePath));
				}

				debounceTimers.set(
					filePath,
					setTimeout(() => {
						debounceTimers.delete(filePath);
						try {
							if (fs.existsSync(filePath)) {
								const stat = fs.statSync(filePath);
								if (stat.isDirectory()) {
									fs.mkdirSync(dest, { recursive: true });
								} else {
									// 检查目标文件是否已存在且内容一致，若未实质变更则跳过，杜绝冗余 I/O
									if (fs.existsSync(dest)) {
										try {
											const destStat = fs.statSync(dest);
											if (
												stat.size === destStat.size &&
												Math.abs(stat.mtimeMs - destStat.mtimeMs) < 50
											) {
												return;
											}
											const srcBuf = fs.readFileSync(filePath);
											const destBuf = fs.readFileSync(dest);
											if (srcBuf.equals(destBuf)) {
												return;
											}
										} catch {
											// 忽略比对异常，直接降级为覆盖写入
										}
									}

									fs.mkdirSync(path.dirname(dest), { recursive: true });
									fs.copyFileSync(filePath, dest);
									console.log(
										`[content-watcher] Synced: ${rel} -> ${path.relative(process.cwd(), dest)}`,
									);
								}
							} else if (fs.existsSync(dest)) {
								fs.rmSync(dest, { recursive: true, force: true });
								console.log(
									`[content-watcher] Removed: ${path.relative(process.cwd(), dest)}`,
								);
							}

							// 细粒度刷新分流策略：
							// 1. 内容文件（Markdown/MDX 等）：由 Astro 7 原生 Content Layer (glob-loader)
							//    自动捕获 src/content/ 的变更做增量热更，绝对严禁触发全局 full-reload！
							// 2. 静态资源（public/）：由 Vite 原生静态监听处理。
							// 3. 全局配置文件（config/）：注入 triggeredBy 精确源路径通知 Vite，
							//    仅局部重载依赖该配置的组件，彻底阻断全站雪崩式并发死锁。
							if (isConfig) {
								server.ws.send({
									type: "full-reload",
									triggeredBy: dest.replace(/\\/g, "/"),
								});
							}
						} catch (err) {
							console.error("[content-watcher] Sync error:", err);
						}
					}, 100),
				);
			};

			server.watcher.on("change", syncTarget);
			server.watcher.on("add", syncTarget);
			server.watcher.on("unlink", syncTarget);
		},
	};
}

// https://astro.build/config
export default defineConfig({
	site: siteConfig.site_url,

	base: "/",
	trailingSlash: "always",

	redirects: {
		// 动态路由迁移：旧 moments 路径 301 重定向至新 dynamic 路径
		"/moments": "/dynamic",
	},

	// 字体配置 - 只加载实际使用的字体，跳过未引用的以加快构建
	fonts: (() => {
		// 禁用字体功能时直接返回空数组，跳过 Astro Font API 集成
		if (!fontConfig.enable) return [];

		const used = collectUsedFontCssVars(fontConfig);
		return fontsList
			.filter((f) => used.has(f.cssVariable))
			.map((f) => {
				let provider;
				switch (f.provider) {
					case "google":
						provider = fontProviders.google();
						break;
					case "fontsource":
						provider = fontProviders.fontsource();
						break;
					case "local":
						provider = fontProviders.local();
						break;
					case "bunny":
						provider = fontProviders.bunny();
						break;
					case "fontshare":
						provider = fontProviders.fontshare();
						break;
					case "npm":
						provider = fontProviders.npm();
						break;
					default:
						provider = f.provider;
				}
				return { ...f, provider };
			});
	})(),

	adapter,

	// 图像优化配置
	image: {
		// 组件可自行传入 layout/widths；这里只控制 Markdown 正文图片
		layout: "none",
	},

	integrations: [
		swup({
			theme: false,
			animationClass: "transition-swup-", // see https://swup.js.org/options/#animationselector
			// the default value `transition-` cause transition delay
			// when the Tailwind class `transition-all` is used
			containers: [
				"#banner-overlay-container",
				"#banner-dim-container",
				"#swup-container",
				"#left-sidebar-dynamic",
				"#right-sidebar-dynamic",
				"#floating-toc-wrapper",
			],
			smoothScrolling: false,
			cache: true,
			preload: false,
			accessibility: true,
			updateHead: {
				awaitAssets: true,
				persistAssets: true, // 跨页保留 CSS/JS 资源标签，避免移除再重插导致 FOUC
				persistTags: false,
			},
			updateBodyClass: false,
			globalInstance: true,
			// 滚动相关配置优化
			resolveUrl: (url) => url,
			animateHistoryBrowsing: false,
			skipPopStateHandling: (event) => {
				// 跳过锚点链接的处理，让浏览器原生处理
				return event.state?.url?.includes("#");
			},
		}),
		icon({
			include: {
				"material-symbols": ["*"],
				"fa7-brands": ["*"],
				"fa7-regular": ["*"],
				"fa7-solid": ["*"],
				"simple-icons": ["*"],
				mdi: ["*"],
				mingcute: ["*"],
			},
		}),
		expressiveCode({
			themes: [expressiveCodeConfig.darkTheme, expressiveCodeConfig.lightTheme],
			useDarkModeMediaQuery: false,
			themeCssSelector: (theme) => `[data-theme='${theme.name}']`,
			plugins: [
				// pluginLanguageBadge 配置 - 从expressiveCodeConfig读取设置
				...(expressiveCodeConfig.pluginLanguageBadge?.enable === true
					? [pluginLanguageBadge()]
					: []),
				// pluginLanguageLogo 配置 - 从expressiveCodeConfig读取设置
				...(expressiveCodeConfig.pluginLanguageLogo?.enable === true
					? [
							pluginLanguageLogo({
								color: expressiveCodeConfig.pluginLanguageLogo.color ?? "mono",
								excludedLangs:
									expressiveCodeConfig.pluginLanguageLogo.excludedLangs ?? [],
							}),
						]
					: []),
				pluginCollapsibleSections(),
				pluginLineNumbers(),
				// pluginCollapsible 配置 - 从expressiveCodeConfig读取设置，使用i18n文本
				...(expressiveCodeConfig.pluginCollapsible?.enable === true
					? [
							pluginCollapsible({
								lineThreshold:
									expressiveCodeConfig.pluginCollapsible.lineThreshold || 15,
								previewLines:
									expressiveCodeConfig.pluginCollapsible.previewLines || 8,
								defaultCollapsed:
									expressiveCodeConfig.pluginCollapsible.defaultCollapsed ??
									true,
								expandButtonText: i18n(I18nKey.codeCollapsibleShowMore),
								collapseButtonText: i18n(I18nKey.codeCollapsibleShowLess),
								expandedAnnouncement: i18n(I18nKey.codeCollapsibleExpanded),
								collapsedAnnouncement: i18n(I18nKey.codeCollapsibleCollapsed),
							}),
						]
					: []),
			],
			defaultProps: {
				wrap: false,
				overridesByLang: {
					shellsession: {
						showLineNumbers: false,
					},
				},
			},
			styleOverrides: {
				borderRadius: "0.75rem",
				codeFontSize: "0.875rem",
				codeFontFamily:
					"var(--font-code, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace)",
				codeLineHeight: "1.5rem",
				frames: {},
				textMarkers: {
					delHue: 0,
					insHue: 180,
					markHue: 250,
				},
				languageBadge: {
					fontSize: "0.75rem",
					fontWeight: "bold",
					borderRadius: "0.25rem",
					opacity: "1",
					borderWidth: "0px",
					borderColor: "transparent",
				},
			},
			frames: {
				// 保留原生复制按钮，外观由 src/styles/expressive-code.css 覆盖成主题风格
				showCopyToClipboardButton: true,
			},
		}),
		svelte(),
		sitemap({
			serialize: (() => {
				let cachedMap = null;
				return (item) => {
					if (!cachedMap) {
						cachedMap = getContentLastmodMap();
					}
					const url = new URL(item.url);
					const pathname = url.pathname;
					const decodedPathname = decodeURI(pathname);
					const realDate =
						cachedMap.dates.get(pathname) ||
						cachedMap.dates.get(decodedPathname);

					if (pathname === "/" || pathname === "") {
						item.changefreq = "daily";
						item.priority = 1.0;
						if (cachedMap.latestPostDate) {
							item.lastmod = cachedMap.latestPostDate;
						} else {
							delete item.lastmod;
						}
					} else if (
						pathname.startsWith("/posts/") ||
						pathname.startsWith("/projects/")
					) {
						item.changefreq = "weekly";
						item.priority = 0.8;
						if (realDate) {
							item.lastmod = realDate;
						} else {
							delete item.lastmod;
						}
					} else {
						item.changefreq = "monthly";
						item.priority = 0.5;
						// 静态页面不伪报当前构建时间，保持 Google 对 sitemap 的权威信任
						delete item.lastmod;
					}
					return item;
				};
			})(),
			filter: (page) => {
				// 根据页面开关配置过滤sitemap
				const url = new URL(page);
				const pathname = url.pathname;
				// 动态页评论嵌入页仅供 iframe 内部调用，不应进 sitemap
				if (pathname === "/dynamic/comments/") {
					return false;
				}
				if (pathname === "/dynamic/" && !siteConfig.pages.dynamic) {
					return false;
				}
				if (
					(pathname === "/projects/" || pathname.startsWith("/projects/")) &&
					!siteConfig.pages.projects
				) {
					return false;
				}
				if (pathname === "/devices/" && !siteConfig.pages.devices) {
					return false;
				}
				if (pathname === "/timeline/" && !siteConfig.pages.timeline) {
					return false;
				}
				if (pathname.startsWith("/gallery/") && !siteConfig.pages.gallery) {
					return false;
				}
				if (pathname === "/friends/" && !siteConfig.pages.friends) {
					return false;
				}
				if (pathname === "/guestbook/" && !siteConfig.pages.guestbook) {
					return false;
				}
				if (pathname === "/booknav/" && !siteConfig.pages.booknav) {
					return false;
				}
				if (pathname === "/bilibili/" && !siteConfig.pages.bilibili) {
					return false;
				}
				if (pathname === "/bangumi/" && !siteConfig.pages.bangumi) {
					return false;
				}
				if (pathname === "/vndb/" && !siteConfig.pages.vndb) {
					return false;
				}
				if (pathname === "/myanimelist/" && !siteConfig.pages.mal) {
					return false;
				}
				if (pathname === "/sponsor/" && !siteConfig.pages.sponsor) {
					return false;
				}
				return true;
			},
		}),
		mdx(),
	],
	markdown: {
		processor: unified({
			remarkPlugins: [
				...(siteConfig.post.rehypeCallouts.enablePythonMarkdownAdmonitions !==
				false
					? [remarkAdmonitionToBlockquoteCallout]
					: []),
				remarkMath,
				remarkReadingTime,
				remarkWikiLink,
				remarkImageGrid,
				remarkExcerpt,
				remarkDirective,
				remarkSectionize,
				parseDirectiveNode,
				remarkMermaid,
				[remarkPlantuml, plantumlConfig],
			],
			rehypePlugins: [
				[rehypeKatex, { katex }],
				[rehypeCallouts, { theme: siteConfig.post.rehypeCallouts.theme }],
				rehypeSlug,
				rehypeCodeGroup,
				[rehypeMermaid, mermaidConfig],
				rehypePlantuml,
				rehypeDiagramPanZoom,
				rehypeFigure,
				[
					rehypeImageReferrerPolicy,
					{ domains: siteConfig.imageOptimization?.noReferrerDomains || [] },
				],
				[rehypeExternalLinks, { siteUrl: siteConfig.site_url }],
				[rehypeEmailProtection, { method: "base64" }], // 邮箱保护插件，支持 'base64' 或 'rot13'
				[
					rehypeComponents,
					{
						components: {
							github: GithubCardComponent,
						},
					},
				],
				[
					rehypeAutolinkHeadings,
					{
						behavior: "append",
						properties: {
							className: ["anchor"],
						},
						content: {
							type: "element",
							tagName: "span",
							properties: {
								className: ["anchor-icon"],
								"data-pagefind-ignore": true,
							},
							children: [
								{
									type: "text",
									value: "#",
								},
							],
						},
					},
				],
			],
		}),
	},
	vite: {
		plugins: [
			tailwindcss(),
			contentRepoWatcher(),
			devServerLockPlugin(),
			friendsAuditDevApiPlugin(),
			wallpaperHuePresetsDevApiPlugin(),
		],
		server: {
			watch: {
				ignored: ["**/package/**", "**/Firefly-docs/**"],
			},
		},
		resolve: {
			alias: {
				"@rehype-callouts-theme": `rehype-callouts/theme/${siteConfig.post.rehypeCallouts.theme}`,
			},
		},
		build: {
			minify: "esbuild",
			esbuildOptions: {
				minify: true,
				// 删除 debugger 语句；console.log / console.debug 无副作用，未使用返回值时会被 dead code elimination 移除，
				// console.warn / console.error 保留，确保生产环境出错时仍有日志可查
				drop: ["debugger"],
				pure: ["console.log", "console.debug"],
			},
			rollupOptions: {
				onwarn(warning, warn) {
					// temporarily suppress this warning
					if (
						warning.message.includes("is dynamically imported by") &&
						warning.message.includes("but also statically imported by")
					) {
						return;
					}
					warn(warning);
				},
			},
			// CSS 优化
			cssCodeSplit: true,
			cssMinify: "esbuild",
			assetsInlineLimit: 4096,
		},
	},
});
