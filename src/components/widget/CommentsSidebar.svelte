<script lang="ts">
/**
 * 侧边栏“最新评论”组件
 * 从评论系统（Waline / Twikoo / Artalk）聚合拉取全站访客最新评论（排除站长自身）
 */

import { onMount } from "svelte";
import I18nKey from "@/i18n/i18nKey";
import { i18n } from "@/i18n/translation";
import type { CommentConfig } from "@/types/commentConfig";
import { formatRelativeTime } from "@/utils/date-utils";
import {
	fetchRecentComments,
	type RecentCommentEntry,
} from "@/utils/recent-comments-adapter";
import { url } from "@/utils/url-utils";

interface Props {
	commentConfig: CommentConfig;
	limit: number;
	authorName?: string;
}

let { commentConfig, limit, authorName }: Props = $props();

let comments: RecentCommentEntry[] = $state([]);
let loading = $state(true);
let error = $state(false);

// 默认占位头像 SVG（纯矢量 Data URL，无额外网络开销）
const DEFAULT_AVATAR =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2394a3b8'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

onMount(async () => {
	try {
		comments = await fetchRecentComments(
			commentConfig,
			limit,
			authorName,
			true,
		);
	} catch (e) {
		console.error("[CommentsSidebar] Failed to load comments:", e);
		error = true;
	} finally {
		loading = false;
	}
});

// 提取目标 URL 的纯路径名（自动剥离网络协议、域名、hash 与 search 参数）
function extractPathname(targetUrl: string): string {
	if (!targetUrl) return "/";
	try {
		if (targetUrl.startsWith("http://") || targetUrl.startsWith("https://")) {
			return new URL(targetUrl).pathname;
		}
	} catch {}
	return targetUrl.split("#")[0].split("?")[0] || "/";
}

// 解析评论来源分类：统一严格为双字显示（文章、留言、动态、相册、设备、书签、项目、友链、游戏等）
function getSourceCategory(targetUrl: string): string {
	if (!targetUrl) return "文章";
	const clean = extractPathname(targetUrl).replace(/\/+$/, "") || "/";
	if (clean.startsWith("/posts")) return "文章";
	if (clean.startsWith("/guestbook")) return "留言";
	if (clean.startsWith("/dynamic")) return "动态";
	if (clean.startsWith("/gallery")) return "相册";
	if (clean.startsWith("/devices")) return "设备";
	if (clean.startsWith("/booknav")) return "书签";
	if (clean.startsWith("/projects")) return "项目";
	if (clean.startsWith("/friends")) return "友链";
	if (clean.startsWith("/sponsor")) return "赞助";
	if (clean.startsWith("/steam")) return "游戏";
	if (clean.startsWith("/about")) return "关于";
	return "文章";
}

// 拼接跳转链接
function getCommentHref(entry: RecentCommentEntry): string {
	const rawPath = extractPathname(entry.url);
	// 确保页面路径末尾带有斜杠，严格匹配 Astro 的 trailingSlash: "always" 配置，避免缺少斜杠时 404
	const normalized = rawPath.endsWith("/") ? rawPath : `${rawPath}/`;
	const baseUrl = url(normalized);
	return `${baseUrl}#${entry.id}`;
}

// 点击跳转拦截，支持同页面直接平滑滚动与跨页面定位保障
function handleCommentClick(e: MouseEvent, entry: RecentCommentEntry) {
	if (typeof window === "undefined") return;

	// 存入 sessionStorage 供跨页跳转后精准平滑下滑与极光高亮（双重保险）
	try {
		sessionStorage.setItem("waline-target-comment", entry.id);
	} catch {}

	const rawPath = extractPathname(entry.url);
	let decodedTarget = rawPath;
	try {
		decodedTarget = decodeURIComponent(rawPath);
	} catch {}
	const cleanTarget = decodedTarget.replace(/\/+$/, "") || "/";

	let decodedCurrent = window.location.pathname;
	try {
		decodedCurrent = decodeURIComponent(window.location.pathname);
	} catch {}
	const currentPath = decodedCurrent.replace(/\/+$/, "") || "/";

	if (cleanTarget === currentPath) {
		// 同一页面内点击：更新地址栏 hash 但阻止浏览器原生生硬瞬移，转由平滑下滑与高亮接管
		e.preventDefault();
		const newHash = `#${entry.id}`;
		if (window.location.hash !== newHash) {
			window.history.pushState(null, "", newHash);
		}

		// 调用平滑下滑与极光高亮
		const scrollToComment = (
			window as unknown as {
				__scrollToWalineComment?: (id: string) => void;
			}
		).__scrollToWalineComment;

		if (typeof scrollToComment === "function") {
			scrollToComment(entry.id);
		} else {
			window.dispatchEvent(
				new CustomEvent("waline:scroll-to-comment", {
					detail: { id: entry.id },
				}),
			);
		}
	}
}

function handleAvatarError(e: Event) {
	const target = e.currentTarget as HTMLImageElement;
	if (target && target.src !== DEFAULT_AVATAR) {
		target.src = DEFAULT_AVATAR;
	}
}
</script>

<div class="flex flex-col gap-1">
	{#if loading}
		<div class="flex justify-center p-4">
			<svg class="size-5 animate-spin text-(--primary)" viewBox="0 0 24 24" fill="none">
				<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" opacity="0.25"/>
				<path d="M4 12a8 8 0 018-8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
			</svg>
		</div>
	{:else if error || comments.length === 0}
		<p class="m-0 p-3 text-center text-sm text-neutral-500">
			{i18n(I18nKey.noComments)}
		</p>
	{:else}
		{#each comments as entry (entry.id)}
			{@const source = getSourceCategory(entry.url)}
			{@const href = getCommentHref(entry)}
			<a
				{href}
				onclick={(e) => handleCommentClick(e, entry)}
				class="group flex min-w-0 items-center gap-2.5 rounded-lg p-2
					text-neutral-700/85 dark:text-neutral-300/85
					hover:bg-(--btn-plain-bg-hover) hover:text-(--primary)
					active:bg-(--btn-plain-bg-active) transition-colors duration-150"
				aria-label={`评论：${entry.nick} - ${entry.content}`}
			>
				<!-- 评论者头像（无角标圆点，纯净圆形） -->
				<div class="shrink-0">
					<img
						src={entry.avatar || DEFAULT_AVATAR}
						alt={entry.nick}
						class="size-8 rounded-full object-cover ring-1 ring-black/5 dark:ring-white/10"
						loading="lazy"
						onerror={handleAvatarError}
					/>
				</div>

				<!-- 评论正文主体 -->
				<div class="min-w-0 flex-1">
					<!-- 首行：昵称（可省略...） 弹性间隔 时间 · 来源（绝对不可压缩） -->
					<div class="flex items-center justify-between gap-2 text-xs leading-4">
						<span class="font-medium truncate text-neutral-900 dark:text-neutral-100 group-hover:text-(--primary) transition-colors min-w-0">
							{entry.nick}
						</span>

						<div class="shrink-0 flex items-center gap-1 text-[11px] text-neutral-400 dark:text-neutral-500 whitespace-nowrap">
							<time datetime={new Date(entry.time).toISOString()}>
								{formatRelativeTime(entry.time)}
							</time>
							<span>·</span>
							<span>{source}</span>
						</div>
					</div>

					<!-- 次行：评论内容单行省略 -->
					<p class="m-0 mt-1 truncate text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
						{entry.content}
					</p>
				</div>
			</a>
		{/each}
	{/if}
</div>
