import fs from "node:fs";
import path from "node:path";
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
		plugins: [tailwindcss(), contentRepoWatcher(), devServerLockPlugin()],
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
