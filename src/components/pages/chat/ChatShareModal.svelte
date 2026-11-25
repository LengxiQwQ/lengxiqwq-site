<script module lang="ts">
import {
	fetchShareThumbsCached,
	getCachedShareThumbs,
	resolveShareThumbUrl,
} from "./chatShareThumbs";

export interface ArticleItem {
	id: string;
	title: string;
	description: string;
	published: number;
	publishedDate: string;
	category?: string;
	image?: string;
	url: string;
}

export interface MomentItem {
	id: string;
	published: number;
	html: string;
	images: Array<{ src: string; alt?: string }>;
	searchText: string;
	dateStr: string;
	relativeTime: string;
}

export interface FriendItem {
	id: string;
	title: string;
	desc: string;
	siteurl: string;
	imgurl: string;
	tags: string[];
	pinned: boolean;
	order: number;
}

let cachedArticles: ArticleItem[] | null = null;
let cachedMoments: MomentItem[] | null = null;
let cachedFriends: FriendItem[] | null = null;

let inflightArticles: Promise<ArticleItem[]> | null = null;
let inflightMoments: Promise<MomentItem[]> | null = null;
let inflightFriends: Promise<FriendItem[]> | null = null;

function stripHtmlTags(html: string): string {
	return (html || "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function parseTimestamp(val: unknown): number {
	if (typeof val === "number" && Number.isFinite(val)) return val;
	if (typeof val === "string" && val.trim()) {
		const num = Number(val);
		if (Number.isFinite(num) && num > 0) return num;
		const parsed = Date.parse(val);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}

function formatMomentDate(timestamp: number): string {
	if (!timestamp) return "动态分享";
	try {
		const d = new Date(timestamp);
		if (Number.isNaN(d.getTime())) return "动态分享";
		return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
	} catch {
		return "动态分享";
	}
}

function getRelativeTime(timestamp: number): string {
	if (!timestamp) return "";
	const now = Date.now();
	const diffSec = Math.floor((now - timestamp) / 1000);
	if (diffSec < 60) return "刚刚";
	const diffMin = Math.floor(diffSec / 60);
	if (diffMin < 60) return `${diffMin}分钟前`;
	const diffHour = Math.floor(diffMin / 60);
	if (diffHour < 24) return `${diffHour}小时前`;
	const diffDay = Math.floor(diffHour / 24);
	if (diffDay < 30) return `${diffDay}天前`;
	const diffMonth = Math.floor(diffDay / 30);
	if (diffMonth < 12) return `${diffMonth}个月前`;
	return `${Math.floor(diffMonth / 12)}年前`;
}

async function fetchArticlesCached(force = false): Promise<ArticleItem[]> {
	if (cachedArticles && !force) return cachedArticles;
	if (inflightArticles && !force) return inflightArticles;
	const task = (async () => {
		const [resp, thumbs] = await Promise.all([
			fetch("/api/allPostMeta.json"),
			fetchShareThumbsCached(force),
		]);
		if (!resp.ok) {
			throw new Error(`HTTP ${resp.status}`);
		}
		const postRes = await resp.json();
		const list = Array.isArray(postRes) ? postRes : [];
		const mapped: ArticleItem[] = list.map((p: Record<string, unknown>) => ({
			id: String(p.id || ""),
			title: String(p.title || "未命名文章"),
			description: String(p.description || ""),
			published: parseTimestamp(p.published),
			publishedDate: String(p.publishedDate || ""),
			category: p.category ? String(p.category) : "",
			image: p.image ? String(p.image) : "",
			url: String(p.url || `/posts/${String(p.id || "")}/`),
		}));
		cachedArticles = mapped;
		if (typeof Image !== "undefined") {
			for (const item of mapped.slice(0, 6)) {
				if (item.image) {
					const thumb = resolveShareThumbUrl(item.image, "article-sm", thumbs);
					if (thumb && !thumb.startsWith("data:")) {
						const img = new Image();
						img.decoding = "async";
						img.src = thumb;
					}
				}
			}
		}
		return mapped;
	})().finally(() => {
		if (inflightArticles === task) inflightArticles = null;
	});
	inflightArticles = task;
	return task;
}

async function fetchMomentsCached(force = false): Promise<MomentItem[]> {
	if (cachedMoments && !force) return cachedMoments;
	if (inflightMoments && !force) return inflightMoments;
	const task = (async () => {
		const [resp, thumbs] = await Promise.all([
			fetch("/api/dynamic.json"),
			fetchShareThumbsCached(force),
		]);
		if (!resp.ok) {
			throw new Error(`HTTP ${resp.status}`);
		}
		const momentRes = await resp.json();
		const list = Array.isArray(momentRes)
			? momentRes
			: Array.isArray(momentRes?.items)
				? momentRes.items
				: [];
		const mapped: MomentItem[] = list.map((m: Record<string, unknown>) => {
			const ts = parseTimestamp(m.published);
			const htmlStr = typeof m.html === "string" ? m.html : "";
			const rawSearchText =
				typeof m.searchText === "string" && m.searchText.trim()
					? m.searchText
					: stripHtmlTags(htmlStr);
			return {
				id: String(m.id || ""),
				published: ts,
				html: htmlStr,
				images: Array.isArray(m.images)
					? (m.images as Array<{ src: string; alt?: string }>)
					: [],
				searchText: rawSearchText,
				dateStr: formatMomentDate(ts),
				relativeTime: getRelativeTime(ts),
			};
		});
		cachedMoments = mapped;
		if (typeof Image !== "undefined") {
			for (const item of mapped.slice(0, 6)) {
				const src = item.images?.[0]?.src;
				if (src) {
					const thumb = resolveShareThumbUrl(src, "square-sm", thumbs);
					if (thumb && !thumb.startsWith("data:")) {
						const img = new Image();
						img.decoding = "async";
						img.src = thumb;
					}
				}
			}
		}
		return mapped;
	})().finally(() => {
		if (inflightMoments === task) inflightMoments = null;
	});
	inflightMoments = task;
	return task;
}

async function fetchFriendsCached(force = false): Promise<FriendItem[]> {
	if (cachedFriends && !force) return cachedFriends;
	if (inflightFriends && !force) return inflightFriends;
	const task = (async () => {
		const [resp, thumbs] = await Promise.all([
			fetch("/api/friends.json"),
			fetchShareThumbsCached(force),
		]);
		if (!resp.ok) {
			throw new Error(`HTTP ${resp.status}`);
		}
		const friendRes = await resp.json();
		const list = Array.isArray(friendRes) ? friendRes : [];
		const mapped: FriendItem[] = list
			.map((f: Record<string, unknown>, idx: number) => ({
				id: String(f.id || f.siteurl || `friend-${idx}`),
				title: String(f.title || "未命名友链"),
				desc: String(f.desc || ""),
				siteurl: String(f.siteurl || ""),
				imgurl: String(f.imgurl || ""),
				tags: Array.isArray(f.tags) ? f.tags.map((t) => String(t)) : [],
				pinned: Boolean(f.pinned),
				order:
					typeof f.order === "number" && Number.isFinite(f.order)
						? f.order
						: idx,
			}))
			.filter((item) => Boolean(item.siteurl))
			.sort((a, b) => {
				if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
				return a.order - b.order;
			});
		cachedFriends = mapped;
		if (typeof Image !== "undefined") {
			for (const item of mapped.slice(0, 6)) {
				if (item.imgurl) {
					const thumb = resolveShareThumbUrl(item.imgurl, "square-sm", thumbs);
					if (thumb && !thumb.startsWith("data:")) {
						const img = new Image();
						img.decoding = "async";
						img.src = thumb;
					}
				}
			}
		}
		return mapped;
	})().finally(() => {
		if (inflightFriends === task) inflightFriends = null;
	});
	inflightFriends = task;
	return task;
}

export function preloadChatShareData(): void {
	if (typeof window === "undefined") return;
	void fetchShareThumbsCached().catch(() => {});
	void fetchArticlesCached().catch(() => {});
	void fetchMomentsCached().catch(() => {});
	void fetchFriendsCached().catch(() => {});
}
</script>

<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { siteConfig } from "@/config/siteConfig";
import {
	extractHostname,
	formatLxArticleShare,
	formatLxFriendShare,
	formatLxMomentShare,
} from "./chatShareProtocol";

interface Props {
	open: boolean;
	onClose: () => void;
	onShare: (content: string) => void;
}

const { open, onClose, onShare }: Props = $props();

const PAGE_SIZE = 20;

let activeTab = $state<"articles" | "moments" | "friends">("articles");
let searchQuery = $state("");
let articles = $state<ArticleItem[]>(cachedArticles ?? []);
let moments = $state<MomentItem[]>(cachedMoments ?? []);
let friends = $state<FriendItem[]>(cachedFriends ?? []);
let articleLimit = $state(PAGE_SIZE);
let momentLimit = $state(PAGE_SIZE);
let friendLimit = $state(PAGE_SIZE);

let isArticlesLoading = $state(false);
let isMomentsLoading = $state(false);
let isFriendsLoading = $state(false);
let articlesLoaded = $state(Boolean(cachedArticles));
let momentsLoaded = $state(Boolean(cachedMoments));
let friendsLoaded = $state(Boolean(cachedFriends));
let articlesError = $state("");
let momentsError = $state("");
let friendsError = $state("");
let localThumbs = $state<Record<string, string>>(getCachedShareThumbs());
const thumbFallbackUrls = new SvelteSet<string>();
const failedThumbUrls = new SvelteSet<string>();

function getDisplayThumb(
	rawUrl: string,
	preset: "article-sm" | "square-sm",
): string {
	if (!rawUrl || failedThumbUrls.has(rawUrl)) return "";
	if (thumbFallbackUrls.has(rawUrl)) return rawUrl;
	return resolveShareThumbUrl(rawUrl, preset, localThumbs);
}

function handleThumbError(
	rawUrl: string,
	preset: "article-sm" | "square-sm",
	currentSrc: string,
) {
	if (!rawUrl) return;
	const resolved = resolveShareThumbUrl(rawUrl, preset, localThumbs);
	if (
		!thumbFallbackUrls.has(rawUrl) &&
		currentSrc === resolved &&
		currentSrc !== rawUrl
	) {
		thumbFallbackUrls.add(rawUrl);
		return;
	}
	failedThumbUrls.add(rawUrl);
}

let searchInputEl = $state<HTMLInputElement | null>(null);
let listScrollEl = $state<HTMLDivElement | null>(null);
let scrollRaf: number | null = null;
let lastLoadMoreCheck = 0;

function selectTab(tab: "articles" | "moments" | "friends") {
	activeTab = tab;
	if (
		typeof window !== "undefined" &&
		!window.matchMedia("(width < 768px), (pointer: coarse)").matches
	) {
		searchInputEl?.focus();
	}
}

function isLocalHostname(hostname: string): boolean {
	const h = hostname.toLowerCase();
	return (
		h === "localhost" ||
		h === "127.0.0.1" ||
		h === "0.0.0.0" ||
		h === "::1" ||
		h === "[::1]" ||
		h.endsWith(".local") ||
		/^192\.168\./.test(h) ||
		/^10\./.test(h) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(h)
	);
}

function getShareOrigin(): string {
	const configuredOrigin = (siteConfig.site_url || "https://lengxiqwq.com")
		.trim()
		.replace(/\/+$/, "");
	if (typeof window === "undefined") return configuredOrigin;
	return isLocalHostname(window.location.hostname)
		? configuredOrigin
		: window.location.origin;
}

function ensureAbsoluteUrl(pathOrUrl: string): string {
	if (!pathOrUrl) return "";
	const origin = getShareOrigin();
	if (/^https?:\/\//i.test(pathOrUrl)) {
		try {
			const parsed = new URL(pathOrUrl);
			if (isLocalHostname(parsed.hostname)) {
				return `${origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
			}
		} catch {
			// keep original url
		}
		return pathOrUrl;
	}
	return `${origin}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}

async function loadArticles(force = false) {
	if (!force && cachedArticles) {
		articles = cachedArticles;
		articlesLoaded = true;
		articlesError = "";
		return;
	}
	if ((articlesLoaded && !force) || isArticlesLoading) return;
	isArticlesLoading = true;
	articlesError = "";
	try {
		articles = await fetchArticlesCached(force);
		articlesLoaded = true;
	} catch (err) {
		console.error("加载博客文章失败", err);
		articlesError = "文章列表加载失败，请稍后重试";
	} finally {
		isArticlesLoading = false;
	}
}

async function loadMoments(force = false) {
	if (!force && cachedMoments) {
		moments = cachedMoments;
		momentsLoaded = true;
		momentsError = "";
		return;
	}
	if ((momentsLoaded && !force) || isMomentsLoading) return;
	isMomentsLoading = true;
	momentsError = "";
	try {
		moments = await fetchMomentsCached(force);
		momentsLoaded = true;
	} catch (err) {
		console.error("加载即刻说说失败", err);
		momentsError = "说说列表加载失败，请稍后重试";
	} finally {
		isMomentsLoading = false;
	}
}

async function loadFriends(force = false) {
	if (!force && cachedFriends) {
		friends = cachedFriends;
		friendsLoaded = true;
		friendsError = "";
		return;
	}
	if ((friendsLoaded && !force) || isFriendsLoading) return;
	isFriendsLoading = true;
	friendsError = "";
	try {
		friends = await fetchFriendsCached(force);
		friendsLoaded = true;
	} catch (err) {
		console.error("加载友链列表失败", err);
		friendsError = "友链列表加载失败，请稍后重试";
	} finally {
		isFriendsLoading = false;
	}
}

function ensureDataReady() {
	void fetchShareThumbsCached().then((map) => {
		if (Object.keys(map).length > 0) localThumbs = map;
	});
	void loadArticles();
	void loadMoments();
	void loadFriends();
}

// 组件首次挂载即后台预加载（即使处于隐藏预挂载状态），确保点开即刻有数据、无加载抖动
ensureDataReady();

$effect(() => {
	if (open) {
		untrack(() => {
			if (searchQuery) {
				searchQuery = "";
			}
			articleLimit = PAGE_SIZE;
			momentLimit = PAGE_SIZE;
			friendLimit = PAGE_SIZE;
			if (listScrollEl && listScrollEl.scrollTop !== 0) {
				listScrollEl.scrollTop = 0;
			}
			ensureDataReady();
		});
	}
});

$effect(() => {
	const _tab = activeTab;
	const _q = searchQuery;
	untrack(() => {
		articleLimit = PAGE_SIZE;
		momentLimit = PAGE_SIZE;
		friendLimit = PAGE_SIZE;
		if (listScrollEl && listScrollEl.scrollTop !== 0) {
			listScrollEl.scrollTop = 0;
		}
		if (_tab === "moments" && !momentsLoaded && !isMomentsLoading) {
			void loadMoments(true);
		} else if (_tab === "friends" && !friendsLoaded && !isFriendsLoading) {
			void loadFriends(true);
		} else if (_tab === "articles" && !articlesLoaded && !isArticlesLoading) {
			void loadArticles(true);
		}
	});
});

const filteredArticles = $derived.by(() => {
	const q = searchQuery.trim().toLowerCase();
	if (!q) return articles;
	return articles.filter(
		(a) =>
			a.title.toLowerCase().includes(q) ||
			a.description.toLowerCase().includes(q) ||
			Boolean(a.category?.toLowerCase().includes(q)),
	);
});

const displayedArticles = $derived(filteredArticles.slice(0, articleLimit));
const hasMoreArticles = $derived(articleLimit < filteredArticles.length);

const filteredMoments = $derived.by(() => {
	const q = searchQuery.trim().toLowerCase();
	if (!q) return moments;
	return moments.filter(
		(m) =>
			m.searchText.toLowerCase().includes(q) ||
			m.dateStr.toLowerCase().includes(q),
	);
});

const displayedMoments = $derived(filteredMoments.slice(0, momentLimit));
const hasMoreMoments = $derived(momentLimit < filteredMoments.length);

const filteredFriends = $derived.by(() => {
	const q = searchQuery.trim().toLowerCase();
	if (!q) return friends;
	return friends.filter(
		(f) =>
			f.title.toLowerCase().includes(q) ||
			f.desc.toLowerCase().includes(q) ||
			f.siteurl.toLowerCase().includes(q) ||
			f.tags.some((t) => t.toLowerCase().includes(q)),
	);
});

const displayedFriends = $derived(filteredFriends.slice(0, friendLimit));
const hasMoreFriends = $derived(friendLimit < filteredFriends.length);

function loadMoreCurrentTab() {
	if (activeTab === "articles" && hasMoreArticles) {
		articleLimit = Math.min(filteredArticles.length, articleLimit + PAGE_SIZE);
	} else if (activeTab === "moments" && hasMoreMoments) {
		momentLimit = Math.min(filteredMoments.length, momentLimit + PAGE_SIZE);
	} else if (activeTab === "friends" && hasMoreFriends) {
		friendLimit = Math.min(filteredFriends.length, friendLimit + PAGE_SIZE);
	}
}

function handleListScroll() {
	if (!listScrollEl || scrollRaf !== null) return;
	scrollRaf = requestAnimationFrame(() => {
		scrollRaf = null;
		if (!listScrollEl) return;
		const now = performance.now();
		if (now - lastLoadMoreCheck < 150) return;
		lastLoadMoreCheck = now;
		const { scrollTop, scrollHeight, clientHeight } = listScrollEl;
		if (scrollHeight - (scrollTop + clientHeight) < 180) {
			loadMoreCurrentTab();
		}
	});
}

onDestroy(() => {
	if (scrollRaf !== null) {
		cancelAnimationFrame(scrollRaf);
		scrollRaf = null;
	}
});

function handlePickArticle(item: ArticleItem) {
	const absUrl = ensureAbsoluteUrl(item.url);
	const absCover = item.image ? ensureAbsoluteUrl(item.image) : undefined;
	const payload = formatLxArticleShare({
		title: item.title,
		description: item.description,
		url: absUrl,
		cover: absCover,
	});
	onShare(payload);
	onClose();
}

function handlePickMoment(item: MomentItem) {
	const cleanText = (item.searchText || "")
		.replace(/!\[.*?\]\(.*?\)/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
	const absUrl = ensureAbsoluteUrl(`/dynamic/#${item.id}`);
	const firstImage = item.images?.[0]?.src;
	const absCover = firstImage ? ensureAbsoluteUrl(firstImage) : undefined;

	const payload = formatLxMomentShare({
		date: item.dateStr,
		content: cleanText,
		url: absUrl,
		cover: absCover,
	});
	onShare(payload);
	onClose();
}

function handlePickFriend(item: FriendItem) {
	const absUrl = ensureAbsoluteUrl(item.siteurl);
	const absAvatar = item.imgurl ? ensureAbsoluteUrl(item.imgurl) : undefined;
	const payload = formatLxFriendShare({
		name: item.title,
		description: item.desc,
		url: absUrl,
		avatar: absAvatar,
	});
	onShare(payload);
	onClose();
}
</script>

<div
  class="chat-share-popover-content flex flex-col flex-1 min-h-0 overflow-hidden select-none"
  role="dialog"
  tabindex="-1"
  aria-label="分享文章、说说与友链"
  onclick={(e) => e.stopPropagation()}
  onkeydown={(e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }}
>
  <!-- 顶部固定控制栏：胶囊选项卡 + 关闭按钮 + 搜索框 -->
  <div class="chat-share-toolbar px-3 pt-2.5 pb-2 border-b border-[var(--skin-line)]/50 bg-[var(--skin-surface)] flex flex-col gap-2 shrink-0">
    <div class="flex items-center justify-between gap-2">
      <div class="chat-share-segmented-control flex items-center p-0.5 rounded-full bg-[var(--btn-plain-bg-hover)] border border-[var(--skin-line)]/40 min-w-0">
        <button
          type="button"
          class="chat-share-tab-btn flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-full text-[11.5px] font-bold transition-colors duration-150 cursor-pointer shrink-0 {activeTab === 'articles' ? 'active text-[var(--skin-text)] shadow-2xs' : 'text-[var(--chat-meta-color)] hover:text-[var(--skin-text)]'}"
          onclick={() => selectTab("articles")}
        >
          <span>文章</span>
          <span class="min-w-4 text-center text-[10px] px-1 py-0 rounded-full font-bold tabular-nums {activeTab === 'articles' ? 'bg-[var(--primary)]/15 text-[var(--primary)]' : 'bg-[var(--skin-line)]/60 text-[var(--chat-meta-color)]'}">
            {articles.length}
          </span>
        </button>

        <button
          type="button"
          class="chat-share-tab-btn flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-full text-[11.5px] font-bold transition-colors duration-150 cursor-pointer shrink-0 {activeTab === 'moments' ? 'active text-[var(--skin-text)] shadow-2xs' : 'text-[var(--chat-meta-color)] hover:text-[var(--skin-text)]'}"
          onclick={() => selectTab("moments")}
        >
          <span>说说</span>
          <span class="min-w-4 text-center text-[10px] px-1 py-0 rounded-full font-bold tabular-nums {activeTab === 'moments' ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-[var(--skin-line)]/60 text-[var(--chat-meta-color)]'}">
            {moments.length}
          </span>
        </button>

        <button
          type="button"
          class="chat-share-tab-btn flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-full text-[11.5px] font-bold transition-colors duration-150 cursor-pointer shrink-0 {activeTab === 'friends' ? 'active text-[var(--skin-text)] shadow-2xs' : 'text-[var(--chat-meta-color)] hover:text-[var(--skin-text)]'}"
          onclick={() => selectTab("friends")}
        >
          <span>友链</span>
          <span class="min-w-4 text-center text-[10px] px-1 py-0 rounded-full font-bold tabular-nums {activeTab === 'friends' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-[var(--skin-line)]/60 text-[var(--chat-meta-color)]'}">
            {friends.length}
          </span>
        </button>
      </div>

      <button
        type="button"
        class="chat-popover-close-btn"
        aria-label="关闭"
        onclick={onClose}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </div>

    <!-- 搜索过滤条 -->
    <div class="relative flex items-center w-full">
      <svg class="absolute left-2.5 w-3.5 h-3.5 text-[var(--chat-meta-color)]/70 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>

      <input
        bind:this={searchInputEl}
        type="text"
        bind:value={searchQuery}
        placeholder={activeTab === 'articles' ? '搜索文章标题或分类...' : activeTab === 'moments' ? '搜索说说内容或日期...' : '搜索友链名称、简介或标签...'}
        class="chat-share-search-input w-full h-8 pl-8 pr-7 text-xs bg-[var(--card-bg)] border border-[var(--skin-line)]/60 rounded-lg text-[var(--skin-text)] placeholder:text-[var(--chat-meta-color)]/60 focus:outline-none transition-colors duration-150"
      />

      {#if searchQuery}
        <button
          type="button"
          class="chat-share-search-clear absolute right-2 w-4.5 h-4.5 flex items-center justify-center rounded-full text-[11px] text-[var(--chat-meta-color)] hover:text-[var(--skin-text)] hover:bg-[var(--btn-plain-bg-hover)] transition-colors cursor-pointer"
          aria-label="清空搜索条件"
          onclick={() => {
            searchQuery = "";
            searchInputEl?.focus();
          }}
        >
          ✕
        </button>
      {/if}
    </div>
  </div>

  <!-- 滚动列表区（固定尺寸容器 + 单列紧凑卡片，边滚动边加载） -->
  <div
    bind:this={listScrollEl}
    onscroll={handleListScroll}
    class="chat-share-list-container flex-1 overflow-y-auto custom-scrollbar px-2.5 py-2 min-h-0"
  >
    {#if activeTab === "articles"}
      {#if isArticlesLoading && articles.length === 0}
        <div class="space-y-2">
          {#each [1, 2, 3, 4] as _i}
            <div class="flex items-start gap-2.5 p-2 rounded-xl border border-[var(--skin-line)]/40 bg-[var(--card-bg)] min-h-[4.25rem] animate-pulse">
              <div class="w-20 h-12.5 rounded-lg bg-[var(--skin-line)]/30 shrink-0"></div>
              <div class="flex-1 min-w-0 space-y-1.5 py-0.5">
                <div class="h-3.5 w-4/5 bg-[var(--skin-line)]/40 rounded"></div>
                <div class="h-2.5 w-full bg-[var(--skin-line)]/25 rounded"></div>
              </div>
            </div>
          {/each}
        </div>
      {:else if articlesError && articles.length === 0}
        <div class="flex flex-col items-center justify-center py-10 text-center gap-2.5">
          <p class="text-xs font-semibold text-[var(--skin-text)] m-0">{articlesError}</p>
          <button
            type="button"
            class="px-3.5 py-1 text-xs font-semibold rounded-full bg-[var(--primary)] text-white hover:opacity-90 transition-opacity cursor-pointer border-none"
            onclick={() => void loadArticles(true)}
          >
            重新加载
          </button>
        </div>
      {:else if filteredArticles.length === 0}
        <div class="flex flex-col items-center justify-center py-10 text-center gap-2">
          <p class="text-xs text-[var(--skin-text)] font-semibold m-0">
            {searchQuery ? `未找到包含「${searchQuery}」的博文` : "暂无可分享的文章"}
          </p>
          {#if searchQuery}
            <button
              type="button"
              class="text-xs text-[var(--primary)] hover:underline font-medium cursor-pointer bg-transparent border-none"
              onclick={() => { searchQuery = ""; }}
            >
              清空搜索词
            </button>
          {/if}
        </div>
      {:else}
        <div class="space-y-1.5">
          {#each displayedArticles as article, idx (article.id)}
            {@const articleThumb = article.image ? getDisplayThumb(article.image, "article-sm") : ""}
            <button
              type="button"
              class="chat-share-card group relative flex items-start gap-2.5 p-2 rounded-xl bg-[var(--card-bg)] hover:bg-[var(--btn-plain-bg-hover)]/75 border border-[var(--skin-line)]/50 hover:border-[var(--primary)]/55 text-left transition-colors duration-150 cursor-pointer w-full min-h-[4.25rem] overflow-hidden"
              onclick={() => handlePickArticle(article)}
            >
              <div class="w-20 h-12.5 rounded-lg overflow-hidden shrink-0 relative bg-[var(--btn-plain-bg-hover)] flex items-center justify-center border border-[var(--skin-line)]/40">
                {#if articleThumb}
                  <img
                    src={articleThumb}
                    alt=""
                    width="80"
                    height="50"
                    decoding="async"
                    class="w-full h-full object-cover"
                    loading={idx < 8 ? "eager" : "lazy"}
                    onerror={() => handleThumbError(article.image || "", "article-sm", articleThumb)}
                  />
                {:else}
                  <svg class="w-4 h-4 text-[var(--primary)]/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                {/if}
              </div>

              <div class="flex-1 min-w-0 flex flex-col justify-between gap-1 self-stretch">
                <strong class="text-xs font-bold text-[var(--skin-text)] group-hover:text-[var(--primary)] transition-colors line-clamp-1 leading-snug">
                  {article.title}
                </strong>
                <p class="text-[11px] text-[var(--chat-meta-color)] line-clamp-1 leading-snug m-0 opacity-90 min-h-[0.95rem]">
                  {article.description || "点击分享这篇文章"}
                </p>
                <div class="flex items-center justify-between gap-1.5 text-[10px] text-[var(--chat-meta-color)]">
                  <div class="flex items-center gap-1.5 min-w-0">
                    {#if article.category}
                      <span class="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-[var(--primary)]/12 text-[var(--primary)] leading-none shrink-0">
                        {article.category}
                      </span>
                    {/if}
                    <span class="truncate opacity-80">{article.publishedDate || "博客文章"}</span>
                  </div>
                  <span class="font-bold text-[var(--primary)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0">分享 ↵</span>
                </div>
              </div>
            </button>
          {/each}
        </div>

        {#if hasMoreArticles}
          <button
            type="button"
            class="w-full py-2 mt-1 text-center text-[11px] text-[var(--chat-meta-color)] hover:text-[var(--primary)] transition-colors cursor-pointer bg-transparent border-none"
            onclick={loadMoreCurrentTab}
          >
            下滑或点击加载更多（已显示 {displayedArticles.length} / {filteredArticles.length} 篇）
          </button>
        {:else if filteredArticles.length >= PAGE_SIZE}
          <div class="py-2 text-center text-[11px] text-[var(--chat-meta-color)]/70">
            已加载全部 {filteredArticles.length} 篇博文
          </div>
        {/if}
      {/if}
    {:else if activeTab === "moments"}
      {#if isMomentsLoading && moments.length === 0}
        <div class="space-y-2">
          {#each [1, 2, 3, 4] as _i}
            <div class="flex items-start gap-2.5 p-2 rounded-xl border border-[var(--skin-line)]/40 bg-[var(--card-bg)] min-h-[4.25rem] animate-pulse">
              <div class="w-12 h-12 rounded-lg bg-[var(--skin-line)]/30 shrink-0"></div>
              <div class="flex-1 min-w-0 space-y-1.5 py-0.5">
                <div class="h-3 w-1/3 bg-[var(--skin-line)]/40 rounded"></div>
                <div class="h-2.5 w-full bg-[var(--skin-line)]/25 rounded"></div>
              </div>
            </div>
          {/each}
        </div>
      {:else if momentsError && moments.length === 0}
        <div class="flex flex-col items-center justify-center py-10 text-center gap-2.5">
          <p class="text-xs font-semibold text-[var(--skin-text)] m-0">{momentsError}</p>
          <button
            type="button"
            class="px-3.5 py-1 text-xs font-semibold rounded-full bg-emerald-500 text-white hover:opacity-90 transition-opacity cursor-pointer border-none"
            onclick={() => void loadMoments(true)}
          >
            重新加载
          </button>
        </div>
      {:else if filteredMoments.length === 0}
        <div class="flex flex-col items-center justify-center py-10 text-center gap-2">
          <p class="text-xs text-[var(--skin-text)] font-semibold m-0">
            {searchQuery ? `未找到包含「${searchQuery}」的说说` : "暂无可分享的说说"}
          </p>
          {#if searchQuery}
            <button
              type="button"
              class="text-xs text-[var(--primary)] hover:underline font-medium cursor-pointer bg-transparent border-none"
              onclick={() => { searchQuery = ""; }}
            >
              清空搜索词
            </button>
          {/if}
        </div>
      {:else}
        <div class="space-y-1.5">
          {#each displayedMoments as moment, idx (moment.id)}
            {@const momentRawImg = moment.images?.[0]?.src || ""}
            {@const momentThumb = momentRawImg ? getDisplayThumb(momentRawImg, "square-sm") : ""}
            <button
              type="button"
              class="chat-share-card group relative flex items-start gap-2.5 p-2 rounded-xl bg-[var(--card-bg)] hover:bg-[var(--btn-plain-bg-hover)]/75 border border-[var(--skin-line)]/50 hover:border-emerald-500/55 text-left transition-colors duration-150 cursor-pointer w-full min-h-[4.25rem] overflow-hidden"
              onclick={() => handlePickMoment(moment)}
            >
              {#if momentThumb}
                <div class="w-12 h-12 rounded-lg overflow-hidden shrink-0 relative bg-[var(--btn-plain-bg-hover)] border border-[var(--skin-line)]/40">
                  <img
                    src={momentThumb}
                    alt=""
                    width="48"
                    height="48"
                    decoding="async"
                    class="w-full h-full object-cover"
                    loading={idx < 8 ? "eager" : "lazy"}
                    onerror={() => handleThumbError(momentRawImg, "square-sm", momentThumb)}
                  />
                  {#if moment.images.length > 1}
                    <span class="absolute bottom-0.5 right-0.5 px-1 py-0.5 rounded text-[8.5px] font-bold bg-black/65 text-white leading-none">
                      +{moment.images.length}
                    </span>
                  {/if}
                </div>
              {:else}
                <div class="w-12 h-12 rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0 border border-emerald-500/20">
                  <svg class="w-4.5 h-4.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
                  </svg>
                </div>
              {/if}

              <div class="flex-1 min-w-0 flex flex-col justify-between gap-1 self-stretch">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="text-[11.5px] font-bold text-[var(--skin-text)] group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors truncate">
                    {moment.dateStr}
                  </span>
                  {#if moment.relativeTime}
                    <span class="text-[10px] text-[var(--chat-meta-color)] shrink-0">
                      ({moment.relativeTime})
                    </span>
                  {/if}
                </div>

                <p class="text-[11px] text-[var(--skin-text)]/85 line-clamp-2 leading-snug m-0 break-words">
                  {moment.searchText.replace(/!\[.*?\]\(.*?\)/g, "").trim() || "暂无文字描述"}
                </p>

                <div class="flex items-center justify-between gap-1.5 text-[10px] text-[var(--chat-meta-color)]">
                  <span>{moment.images?.length ? `${moment.images.length} 张配图` : "纯文字动态"}</span>
                  <span class="font-bold text-emerald-600 dark:text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">分享 ↵</span>
                </div>
              </div>
            </button>
          {/each}
        </div>

        {#if hasMoreMoments}
          <button
            type="button"
            class="w-full py-2 mt-1 text-center text-[11px] text-[var(--chat-meta-color)] hover:text-emerald-500 transition-colors cursor-pointer bg-transparent border-none"
            onclick={loadMoreCurrentTab}
          >
            下滑或点击加载更多（已显示 {displayedMoments.length} / {filteredMoments.length} 条）
          </button>
        {:else if filteredMoments.length >= PAGE_SIZE}
          <div class="py-2 text-center text-[11px] text-[var(--chat-meta-color)]/70">
            已加载全部 {filteredMoments.length} 条说说
          </div>
        {/if}
      {/if}
    {:else}
      {#if isFriendsLoading && friends.length === 0}
        <div class="space-y-2">
          {#each [1, 2, 3, 4] as _i}
            <div class="flex items-center gap-2.5 p-2 rounded-xl border border-[var(--skin-line)]/40 bg-[var(--card-bg)] min-h-[4.25rem] animate-pulse">
              <div class="w-12 h-12 rounded-xl bg-[var(--skin-line)]/30 shrink-0"></div>
              <div class="flex-1 min-w-0 space-y-1.5 py-0.5">
                <div class="h-3.5 w-1/2 bg-[var(--skin-line)]/40 rounded"></div>
                <div class="h-2.5 w-4/5 bg-[var(--skin-line)]/25 rounded"></div>
              </div>
            </div>
          {/each}
        </div>
      {:else if friendsError && friends.length === 0}
        <div class="flex flex-col items-center justify-center py-10 text-center gap-2.5">
          <p class="text-xs font-semibold text-[var(--skin-text)] m-0">{friendsError}</p>
          <button
            type="button"
            class="px-3.5 py-1 text-xs font-semibold rounded-full bg-amber-500 text-white hover:opacity-90 transition-opacity cursor-pointer border-none"
            onclick={() => void loadFriends(true)}
          >
            重新加载
          </button>
        </div>
      {:else if filteredFriends.length === 0}
        <div class="flex flex-col items-center justify-center py-10 text-center gap-2">
          <p class="text-xs text-[var(--skin-text)] font-semibold m-0">
            {searchQuery ? `未找到包含「${searchQuery}」的友链` : "暂无可分享的友链"}
          </p>
          {#if searchQuery}
            <button
              type="button"
              class="text-xs text-[var(--primary)] hover:underline font-medium cursor-pointer bg-transparent border-none"
              onclick={() => { searchQuery = ""; }}
            >
              清空搜索词
            </button>
          {/if}
        </div>
      {:else}
        <div class="space-y-1.5">
          {#each displayedFriends as friend, idx (friend.id)}
            {@const host = extractHostname(friend.siteurl)}
            {@const friendThumb = friend.imgurl ? getDisplayThumb(friend.imgurl, "square-sm") : ""}
            <button
              type="button"
              class="chat-share-card group relative flex items-center gap-2.5 p-2 rounded-xl bg-[var(--card-bg)] hover:bg-[var(--btn-plain-bg-hover)]/75 border border-[var(--skin-line)]/50 hover:border-amber-500/55 text-left transition-colors duration-150 cursor-pointer w-full min-h-[4.25rem] overflow-hidden"
              onclick={() => handlePickFriend(friend)}
            >
              <div class="w-12 h-12 rounded-xl overflow-hidden shrink-0 relative bg-[var(--btn-plain-bg-hover)] border border-[var(--skin-line)]/40 flex items-center justify-center">
                {#if friendThumb}
                  <img
                    src={friendThumb}
                    alt=""
                    width="48"
                    height="48"
                    decoding="async"
                    class="w-full h-full object-cover"
                    loading={idx < 8 ? "eager" : "lazy"}
                    onerror={() => handleThumbError(friend.imgurl, "square-sm", friendThumb)}
                  />
                {:else}
                  <svg class="w-5 h-5 text-amber-500/75" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                  </svg>
                {/if}
              </div>

              <div class="flex-1 min-w-0 flex flex-col justify-between gap-1 self-stretch">
                <div class="flex items-center gap-1.5 min-w-0">
                  <strong class="text-xs font-bold text-[var(--skin-text)] group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors line-clamp-1 leading-snug">
                    {friend.title}
                  </strong>
                  {#if friend.tags[0]}
                    <span class="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-500/12 text-amber-600 dark:text-amber-400 leading-none shrink-0">
                      {friend.tags[0]}
                    </span>
                  {/if}
                </div>

                <p class="text-[11px] text-[var(--chat-meta-color)] line-clamp-1 leading-snug m-0 opacity-90 min-h-[0.95rem]">
                  {friend.desc || "点击分享这个友链"}
                </p>

                <div class="flex items-center justify-between gap-1.5 text-[10px] text-[var(--chat-meta-color)]">
                  <span class="truncate opacity-80">{host || friend.siteurl}</span>
                  <span class="font-bold text-amber-600 dark:text-amber-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">分享 ↵</span>
                </div>
              </div>
            </button>
          {/each}
        </div>

        {#if hasMoreFriends}
          <button
            type="button"
            class="w-full py-2 mt-1 text-center text-[11px] text-[var(--chat-meta-color)] hover:text-amber-500 transition-colors cursor-pointer bg-transparent border-none"
            onclick={loadMoreCurrentTab}
          >
            下滑或点击加载更多（已显示 {displayedFriends.length} / {filteredFriends.length} 个）
          </button>
        {:else if filteredFriends.length >= PAGE_SIZE}
          <div class="py-2 text-center text-[11px] text-[var(--chat-meta-color)]/70">
            已加载全部 {filteredFriends.length} 个友链
          </div>
        {/if}
      {/if}
    {/if}
  </div>

  <!-- 底部固定状态栏 -->
  <div class="chat-share-footer px-3 py-1.5 border-t border-[var(--skin-line)]/40 bg-[var(--skin-surface)]/80 text-[10.5px] text-[var(--chat-meta-color)] flex items-center justify-between shrink-0">
    <div class="flex items-center gap-1.5 tabular-nums">
      <span class="w-1.5 h-1.5 rounded-full {activeTab === 'moments' ? 'bg-emerald-500' : activeTab === 'friends' ? 'bg-amber-500' : 'bg-[var(--primary)]'} opacity-80"></span>
      <span>
        {#if activeTab === "articles"}
          {displayedArticles.length} / {filteredArticles.length} 篇博文
        {:else if activeTab === "moments"}
          {displayedMoments.length} / {filteredMoments.length} 条说说
        {:else}
          {displayedFriends.length} / {filteredFriends.length} 个友链
        {/if}
      </span>
    </div>
    <span class="opacity-75">点击卡片直接分享</span>
  </div>
</div>

<style>
  .chat-share-tab-btn.active {
    background-color: var(--skin-surface, #ffffff);
  }

  :global(.dark) .chat-share-tab-btn.active {
    background-color: var(--btn-regular-bg, #262626);
  }

  .chat-share-search-input:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 18%, transparent);
  }
</style>
