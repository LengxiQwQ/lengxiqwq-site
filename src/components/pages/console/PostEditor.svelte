<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { compressAndConvertToWebp } from "@/utils/image-compress";

interface Props {
	workerApiUrl: string;
	token: string;
	onPostCommitted?: (result: Record<string, unknown>) => void;
	onToast?: (msg: string) => void;
}

const { workerApiUrl, token, onPostCommitted, onToast }: Props = $props();

// 文章元数据表单状态
let title = $state("");
let slug = $state("");
let category = $state("开发");
let isCustomCategory = $state(false);
let tags = $state<string[]>(["博客"]);
let tagInput = $state("");
let cover = $state("");
let excerpt = $state("");
let draft = $state(false);
let pinned = $state(false);
let content = $state("");

// 已有文章列表与编辑状态
interface ExistingPostItem {
	id: string;
	slug: string;
	title: string;
	description: string;
	published: number;
	publishedDate: string;
	category: string;
	tags: string[];
	cover: string;
	pinned: boolean;
	draft: boolean;
	wordCount: number;
	content: string;
}

let existingPosts = $state<ExistingPostItem[]>([]);
let isLoadingExistingPosts = $state(false);
let showPostSelector = $state(false);
let postSearchQuery = $state("");
let selectedCategoryFilter = $state("全部");
let editingOriginalSlug = $state<string | null>(null);
let editingPostTitle = $state<string | null>(null);

// 编辑器 UI 状态
let isFocusMode = $state(false);
let isSubmitting = $state(false);
let isUploadingCover = $state(false);
let isUploadingImage = $state(false);
let lastSavedTime = $state("");
let hasDraftRestored = $state(false);

// 引用
let textareaEl: HTMLTextAreaElement | null = $state(null);
let coverFileInput: HTMLInputElement | null = $state(null);
let inlineFileInput: HTMLInputElement | null = $state(null);

const DRAFT_STORAGE_KEY = "lengxiqwq_console_post_draft_v1";

const categoryPresets = [
	"技术笔记",
	"前端开发",
	"Astro & Svelte",
	"边缘计算",
	"随笔感悟",
	"开源分享",
	"踩坑记录",
];

const suggestedTags = [
	"Firefly",
	"Astro",
	"Svelte",
	"Cloudflare",
	"Worker",
	"TypeScript",
	"Tailwind",
	"D1",
	"R2",
	"运维",
];

// 加载全站已有文章列表
async function loadExistingPosts() {
	isLoadingExistingPosts = true;
	try {
		// 优先走 Worker API，降级走本站 /api/postContent.json
		let postsData: ExistingPostItem[] = [];
		try {
			const res = await fetch(`${workerApiUrl}/api/admin/posts`);
			if (res.ok) {
				const json = await res.json();
				if (json.code === 200 && Array.isArray(json.data)) {
					postsData = json.data;
				}
			}
		} catch {
			// fallback
		}

		if (postsData.length === 0) {
			const siteRes = await fetch("/api/postContent.json");
			if (siteRes.ok) {
				const siteJson = await siteRes.json();
				if (siteJson.code === 200 && Array.isArray(siteJson.data)) {
					postsData = siteJson.data;
				}
			}
		}

		existingPosts = postsData;
	} catch (err) {
		console.warn("Failed to load existing posts", err);
	} finally {
		isLoadingExistingPosts = false;
	}
}

// 选中并载入已有文章到编辑器中
function selectPostToEdit(post: ExistingPostItem) {
	title = post.title;
	slug = post.slug;
	category = post.category || "开发";
	isCustomCategory = false;
	tags =
		Array.isArray(post.tags) && post.tags.length > 0
			? [...post.tags]
			: ["博客"];
	cover = post.cover || "";
	excerpt = post.description || "";
	draft = Boolean(post.draft);
	pinned = Boolean(post.pinned);
	content = post.content || "";
	editingOriginalSlug = post.slug;
	editingPostTitle = post.title;
	showPostSelector = false;
	onToast?.(
		`📖 已载入文章《${post.title}》，可在此直接修改、增删内容并提交更新！`,
	);
}

// 退出修改模式，切换为新建文章
function switchToNewPostMode() {
	editingOriginalSlug = null;
	editingPostTitle = null;
	title = "";
	slug = "";
	category = "开发";
	isCustomCategory = false;
	tags = ["博客"];
	cover = "";
	excerpt = "";
	draft = false;
	pinned = false;
	content = "";
	lastSavedTime = "";
	try {
		localStorage.removeItem(DRAFT_STORAGE_KEY);
	} catch {}
	onToast?.("已切换为撰写新文章模式");
}

// 过滤现有文章
const filteredExistingPosts = $derived.by(() => {
	let list = existingPosts;
	if (selectedCategoryFilter !== "全部") {
		list = list.filter((p) => p.category === selectedCategoryFilter);
	}
	const q = postSearchQuery.toLowerCase().trim();
	if (q) {
		list = list.filter(
			(p) =>
				p.title.toLowerCase().includes(q) ||
				p.slug.toLowerCase().includes(q) ||
				p.description.toLowerCase().includes(q) ||
				p.tags?.some((t) => t.toLowerCase().includes(q)),
		);
	}
	return list;
});

// 获取现有文章的所有分类 (供弹窗筛选)
const existingCategories = $derived.by(() => {
	const cats = new Set<string>();
	cats.add("全部");
	for (const p of existingPosts) {
		if (p.category) cats.add(p.category);
	}
	return Array.from(cats);
});

// 动态计算全站可供选择的文章分类（合并真实文章中已有的分类 + 常用默认分类，按文章频次排序）
const availableCategories = $derived.by(() => {
	const countMap = new Map<string, number>();
	for (const p of existingPosts) {
		if (p.category) {
			countMap.set(p.category, (countMap.get(p.category) || 0) + 1);
		}
	}
	const defaults = [
		"开发",
		"折腾",
		"日常",
		"技术笔记",
		"随笔感悟",
		"前端开发",
		"开源分享",
	];
	for (const d of defaults) {
		if (!countMap.has(d)) countMap.set(d, 0);
	}
	return Array.from(countMap.entries())
		.sort((a, b) => b[1] - a[1])
		.map(([cat]) => cat);
});

// 动态提取全站真实高频标签
const dynamicSuggestedTags = $derived.by(() => {
	const tagCount = new Map<string, number>();
	for (const p of existingPosts) {
		if (Array.isArray(p.tags)) {
			for (const t of p.tags) {
				const clean = t.trim();
				if (clean) tagCount.set(clean, (tagCount.get(clean) || 0) + 1);
			}
		}
	}
	if (tagCount.size > 0) {
		return Array.from(tagCount.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 16)
			.map(([t]) => t);
	}
	return suggestedTags;
});

// 简单轻量 Markdown 转 HTML 解析器
function renderMarkdown(md: string): string {
	if (!md)
		return '<p class="text-(--content-meta) italic">正文内容为空，在左侧输入 Markdown 即可在此实时预览...</p>';

	let html = md
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");

	// 1. 代码块
	html = html.replace(
		/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g,
		(_match, _lang, code) => {
			return `<pre class="my-4 p-4 rounded-xl bg-black/5 dark:bg-white/5 border border-(--line-divider) overflow-x-auto font-mono text-xs text-neutral-800 dark:text-neutral-200"><code>${code.trim()}</code></pre>`;
		},
	);

	// 2. 标题
	html = html
		.replace(
			/^### (.*$)/gim,
			'<h3 class="text-base font-bold text-neutral-800 dark:text-neutral-100 mt-5 mb-2">$1</h3>',
		)
		.replace(
			/^## (.*$)/gim,
			'<h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100 mt-6 mb-3 pb-1 border-b border-(--line-divider)">$1</h2>',
		)
		.replace(
			/^# (.*$)/gim,
			'<h1 class="text-xl font-extrabold text-neutral-800 dark:text-neutral-100 mt-6 mb-3">$1</h1>',
		);

	// 3. 引用块
	html = html.replace(
		/^&gt;\s?(.*$)/gim,
		'<blockquote class="border-l-4 border-(--primary) pl-3 py-1 my-2 text-xs text-neutral-600 dark:text-neutral-300 italic bg-(--primary)/5 rounded-r">$1</blockquote>',
	);

	// 4. 图片与链接
	html = html.replace(
		/!\[([^\]]*)\]\(([^)]+)\)/g,
		'<img src="$2" alt="$1" class="my-3 rounded-xl max-h-72 object-cover border border-(--line-divider) shadow-sm" />',
	);
	html = html.replace(
		/\[([^\]]+)\]\(([^)]+)\)/g,
		'<a href="$2" target="_blank" rel="noopener noreferrer" class="text-(--primary) underline underline-offset-2 hover:opacity-80">$1</a>',
	);

	// 5. 行内格式
	html = html.replace(
		/\*\*([^*]+)\*\*/g,
		'<strong class="font-bold text-neutral-900 dark:text-neutral-100">$1</strong>',
	);
	html = html.replace(/\*([^*]+)\*/g, '<em class="italic">$1</em>');
	html = html.replace(
		/~~([^~]+)~~/g,
		'<del class="line-through text-(--content-meta)">$1</del>',
	);
	html = html.replace(
		/`([^`]+)`/g,
		'<code class="px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 font-mono text-xs text-(--primary)">$1</code>',
	);

	// 6. 分割线
	html = html.replace(
		/^---$/gim,
		'<hr class="my-4 border-(--line-divider)" />',
	);

	// 7. 无序列表与有序列表
	html = html.replace(
		/^- (.*$)/gim,
		'<li class="ml-4 list-disc text-xs text-neutral-700 dark:text-neutral-300 my-0.5">$1</li>',
	);
	html = html.replace(
		/^\d+\. (.*$)/gim,
		'<li class="ml-4 list-decimal text-xs text-neutral-700 dark:text-neutral-300 my-0.5">$1</li>',
	);

	// 8. 段落换行
	html = html.replace(
		/\n\n+/g,
		'</p><p class="my-2 text-xs leading-relaxed text-neutral-800 dark:text-neutral-200">',
	);
	html = `<p class="my-2 text-xs leading-relaxed text-neutral-800 dark:text-neutral-200">${html}</p>`;

	return html;
}

// 智能根据标题生成 Slug
function generateSlugFromTitle() {
	if (!title) return;
	const candidate = title
		.toLowerCase()
		.trim()
		.replace(/[\s\t\n]+/g, "-")
		.replace(/[^a-z0-9_\-\u4e00-\u9fa5]+/g, "")
		.replace(/^-+|-+$/g, "");
	slug = candidate || `post-${Date.now()}`;
}

// 添加标签
function addTag(newTag: string) {
	const clean = newTag.trim().replace(/^#+/, "");
	if (clean && !tags.includes(clean)) {
		tags = [...tags, clean];
	}
	tagInput = "";
	triggerDraftSave();
}

function removeTag(tagToRemove: string) {
	tags = tags.filter((t) => t !== tagToRemove);
	triggerDraftSave();
}

function handleTagKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" || e.key === ",") {
		e.preventDefault();
		addTag(tagInput);
	}
}

// 快捷插入 Markdown 语法
function insertMarkdownSyntax(prefix: string, suffix = "", defaultText = "") {
	if (!textareaEl) return;
	const start = textareaEl.selectionStart;
	const end = textareaEl.selectionEnd;
	const selected = content.slice(start, end) || defaultText;
	const replacement = `${prefix}${selected}${suffix}`;

	content = content.slice(0, start) + replacement + content.slice(end);

	setTimeout(() => {
		if (textareaEl) {
			textareaEl.focus();
			textareaEl.setSelectionRange(
				start + prefix.length,
				start + prefix.length + selected.length,
			);
		}
	}, 10);
	triggerDraftSave();
}

// 上传封面图到 R2（自动转 WebP 90% 质量）
async function handleCoverFileChange(e: Event) {
	const target = e.target as HTMLInputElement;
	if (!target.files || target.files.length === 0) return;
	const file = target.files[0];

	isUploadingCover = true;
	try {
		// 客户端智能转码为 90% 质量 WebP
		const compressResult = await compressAndConvertToWebp(file, {
			quality: 0.9,
		});
		const uploadFile = compressResult.file;

		const formData = new FormData();
		formData.append("file", uploadFile);

		const res = await fetch(`${workerApiUrl}/api/dynamic/upload`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: formData,
		});
		const json = await res.json().catch(() => ({}));

		if (res.ok && json.code === 200 && json.data?.url) {
			cover = json.data.url;
			const ratioText =
				compressResult.ratio > 0 ? ` (体积优化 -${compressResult.ratio}%)` : "";
			onToast?.(`🖼️ 封面图已自动转码 WebP 90% 并上传至 R2！${ratioText}`);
			triggerDraftSave();
		} else {
			onToast?.(`封面上传失败: ${json.error || "服务异常"}`);
		}
	} catch (err) {
		console.error("Upload cover error:", err);
		onToast?.("封面上传网络异常");
	} finally {
		isUploadingCover = false;
		if (coverFileInput) coverFileInput.value = "";
	}
}

// 直传插图到 R2 并插入到光标所在 Markdown 位置（自动转 WebP 90% 质量）
async function handleInlineImageChange(e: Event) {
	const target = e.target as HTMLInputElement;
	if (!target.files || target.files.length === 0) return;
	const file = target.files[0];

	isUploadingImage = true;
	try {
		// 客户端智能转码为 90% 质量 WebP
		const compressResult = await compressAndConvertToWebp(file, {
			quality: 0.9,
		});
		const uploadFile = compressResult.file;

		const formData = new FormData();
		formData.append("file", uploadFile);

		const res = await fetch(`${workerApiUrl}/api/dynamic/upload`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: formData,
		});
		const json = await res.json().catch(() => ({}));

		if (res.ok && json.code === 200 && json.data?.url) {
			const cleanName = uploadFile.name.replace(/\.[^/.]+$/, "");
			const imgMarkdown = `\n![${cleanName}](${json.data.url})\n`;
			insertMarkdownSyntax(imgMarkdown, "", "");
			const ratioText =
				compressResult.ratio > 0 ? ` (体积优化 -${compressResult.ratio}%)` : "";
			onToast?.(`🖼️ 插图已转码 WebP 90% 并直传插入正文！${ratioText}`);
		} else {
			onToast?.(`插图上传失败: ${json.error || "服务异常"}`);
		}
	} catch (err) {
		console.error("Upload inline image error:", err);
		onToast?.("插图上传网络异常");
	} finally {
		isUploadingImage = false;
		if (inlineFileInput) inlineFileInput.value = "";
	}
}

// 防抖本地草稿自动持久化
let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
function triggerDraftSave() {
	if (draftSaveTimer) clearTimeout(draftSaveTimer);
	draftSaveTimer = setTimeout(() => {
		try {
			// 如果在修改已有文章，不轻易覆盖新建草稿
			if (!editingOriginalSlug) {
				const draftData = {
					title,
					slug,
					category,
					isCustomCategory,
					tags,
					cover,
					excerpt,
					draft,
					pinned,
					content,
					savedAt: Date.now(),
				};
				localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draftData));
			}
			const now = new Date();
			lastSavedTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
		} catch (e) {
			console.warn("Auto save draft failed", e);
		}
	}, 1000);
}

// 恢复草稿
function restoreDraft() {
	try {
		const saved = localStorage.getItem(DRAFT_STORAGE_KEY);
		if (saved) {
			const data = JSON.parse(saved);
			if (data.title || data.content) {
				title = data.title || "";
				slug = data.slug || "";
				category = data.category || "开发";
				isCustomCategory = Boolean(data.isCustomCategory);
				tags = Array.isArray(data.tags) ? data.tags : ["博客"];
				cover = data.cover || "";
				excerpt = data.excerpt || "";
				draft = Boolean(data.draft);
				pinned = Boolean(data.pinned);
				content = data.content || "";
				hasDraftRestored = true;
				onToast?.("📝 已自动为您恢复上次未提交的本地草稿！");
			}
		}
	} catch (e) {
		console.warn("Restore draft error:", e);
	}
}

// 清空当前草稿
function clearDraft() {
	if (!confirm("确定要清空当前的草稿内容吗？此操作无法撤销。")) return;
	title = "";
	slug = "";
	category = "开发";
	isCustomCategory = false;
	tags = ["博客"];
	cover = "";
	excerpt = "";
	draft = false;
	pinned = false;
	content = "";
	try {
		localStorage.removeItem(DRAFT_STORAGE_KEY);
	} catch {}
	lastSavedTime = "";
	hasDraftRestored = false;
	editingOriginalSlug = null;
	editingPostTitle = null;
	onToast?.("草稿已彻底清空");
}

// 提交文章至 GitHub 内容仓（支持新建与更新）
async function commitPostToGitHub() {
	if (!title.trim()) {
		onToast?.("⚠️ 请输入文章标题！");
		return;
	}
	if (!slug.trim()) {
		generateSlugFromTitle();
	}
	if (!content.trim()) {
		onToast?.("⚠️ 正文内容不能为空！");
		return;
	}

	isSubmitting = true;
	try {
		const payload = {
			title: title.trim(),
			slug: slug.trim(),
			content: content.trim(),
			category: category.trim(),
			tags,
			cover: cover.trim(),
			excerpt: excerpt.trim(),
			draft,
			pinned,
		};

		const res = await fetch(`${workerApiUrl}/api/admin/commit-post`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(payload),
		});

		const json = await res.json().catch(() => ({}));

		if (res.ok && json.code === 200) {
			const actionWord = editingOriginalSlug ? "更新" : "创建";
			onToast?.(
				`🚀 文章《${title}》已成功${actionWord}并提交至 GitHub 内容仓！`,
			);
			onPostCommitted?.(json.data || { slug, title });

			// 清除已提交的本地草稿
			try {
				localStorage.removeItem(DRAFT_STORAGE_KEY);
			} catch {}
			lastSavedTime = "";

			// 重新拉取文章列表
			void loadExistingPosts();
		} else {
			onToast?.(`提交失败: ${json.error || `状态码 ${res.status}`}`);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		onToast?.(`提交网络异常: ${msg}`);
	} finally {
		isSubmitting = false;
	}
}

// ESC 退出全屏或弹窗
function handleGlobalKeydown(e: KeyboardEvent) {
	if (e.key === "Escape") {
		if (showPostSelector) {
			showPostSelector = false;
		} else if (isFocusMode) {
			isFocusMode = false;
		}
	}
}

onMount(() => {
	restoreDraft();
	void loadExistingPosts();
	if (typeof window !== "undefined") {
		window.addEventListener("keydown", handleGlobalKeydown);
	}
});

onDestroy(() => {
	if (typeof window !== "undefined") {
		window.removeEventListener("keydown", handleGlobalKeydown);
	}
});
</script>

<!-- 隐藏的文件上传 input 触发器 -->
<input
	type="file"
	accept="image/*"
	bind:this={coverFileInput}
	onchange={handleCoverFileChange}
	class="hidden"
/>
<input
	type="file"
	accept="image/*"
	bind:this={inlineFileInput}
	onchange={handleInlineImageChange}
	class="hidden"
/>

<div class="post-editor-container w-full {isFocusMode ? 'fixed inset-0 z-50 bg-(--card-bg) p-4 md:p-6 overflow-hidden flex flex-col shadow-2xl backdrop-blur-xl' : 'card-base p-5 md:p-6 rounded-(--radius-large) shadow-lg border border-(--line-divider) relative'}">
	<!-- 顶部已有文章修改横幅（如果是编辑已有文章模式） -->
	{#if editingOriginalSlug}
		<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-800 dark:text-amber-200 mb-4 animate-in fade-in">
			<div class="flex items-center gap-2 text-xs sm:text-sm font-medium flex-wrap">
				<span class="text-base">✏️</span>
				<span>正在修改已有文章：<strong>《{editingPostTitle || title}》</strong></span>
				<span class="text-[11px] font-mono px-2 py-0.5 rounded bg-amber-500/20 text-amber-900 dark:text-amber-100">
					Slug: {editingOriginalSlug}
				</span>
			</div>
			<div class="flex items-center gap-2 self-end sm:self-auto">
				<button
					type="button"
					onclick={() => { showPostSelector = true; void loadExistingPosts(); }}
					class="text-xs px-2.5 py-1 rounded-md bg-amber-500/20 hover:bg-amber-500/30 transition-colors font-medium cursor-pointer"
				>
					切换其他文章
				</button>
				<button
					type="button"
					onclick={switchToNewPostMode}
					class="text-xs px-2.5 py-1 rounded-md bg-black/10 dark:bg-white/10 hover:bg-black/20 text-(--content-meta) transition-colors cursor-pointer"
				>
					✕ 退出修改，新建文章
				</button>
			</div>
		</div>
	{/if}

	<!-- 顶部标题栏与模式切换 -->
	<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-(--line-divider) mb-5">
		<div class="flex items-center gap-3">
			<div class="w-9 h-9 rounded-xl bg-(--primary)/15 text-(--primary) flex items-center justify-center text-lg font-bold">
				{editingOriginalSlug ? "✏️" : "📝"}
			</div>
			<div>
				<h2 class="text-base font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
					{editingOriginalSlug ? "文章在线编辑与更新" : "Markdown 长文撰写与发布器"}
					{#if isFocusMode}
						<span class="text-[11px] px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 font-semibold">
							✨ 全屏沉浸模式
						</span>
					{/if}
				</h2>
				<p class="text-xs text-(--content-meta)">
					{editingOriginalSlug ? "直接修改文章元数据与正文，保存后将自动提交更新 Commit 到 GitHub 内容仓" : "编写标准 Markdown，一键自动生成 Frontmatter 并通过 Worker 直推 GitHub 内容仓"}
				</p>
			</div>
		</div>

		<!-- 右上角快捷状态与按钮 -->
		<div class="flex items-center gap-2.5 flex-wrap">
			<!-- 选择已有文章按钮 -->
			{#if !editingOriginalSlug}
				<button
					type="button"
					onclick={() => { showPostSelector = true; void loadExistingPosts(); }}
					class="text-xs px-3 py-1.5 rounded-lg bg-(--primary)/10 text-(--primary) hover:bg-(--primary)/20 font-medium transition-all flex items-center gap-1.5 cursor-pointer shadow-xs"
					title="选择已发布的文章进行二次编辑修改"
				>
					<span>📚 选择已有文章修改 ({existingPosts.length ? `${existingPosts.length} 篇` : "载入中"})</span>
				</button>
			{/if}

			<!-- 草稿状态显示 -->
			{#if lastSavedTime && !editingOriginalSlug}
				<span class="text-[11px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-mono">
					<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
					草稿已存 {lastSavedTime}
				</span>
			{/if}

			<!-- 清空草稿按钮 -->
			<button
				type="button"
				onclick={clearDraft}
				class="text-xs px-2.5 py-1.5 rounded-lg border border-(--line-divider) text-(--content-meta) hover:text-red-500 hover:bg-red-500/10 transition-colors cursor-pointer"
				title="清空当前输入区"
			>
				清空
			</button>

			<!-- 一键全屏 / 沉浸模式 (Focus Mode) 切换按钮 -->
			<button
				type="button"
				onclick={() => (isFocusMode = !isFocusMode)}
				class="text-xs px-3 py-1.5 rounded-lg border border-(--line-divider) flex items-center gap-1.5 transition-colors cursor-pointer {isFocusMode ? 'bg-(--primary) text-white font-semibold shadow-md' : 'text-neutral-700 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5'}"
				title={isFocusMode ? "退出全屏 (ESC)" : "展开全屏沉浸模式"}
			>
				{#if isFocusMode}
					<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
					</svg>
					<span>退出全屏 (ESC)</span>
				{:else}
					<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
					</svg>
					<span>全屏沉浸模式</span>
				{/if}
			</button>

			<!-- 提交到 GitHub 按钮 -->
			<button
				type="button"
				onclick={commitPostToGitHub}
				disabled={isSubmitting}
				class="text-xs px-4 py-1.5 rounded-lg bg-(--primary) text-white font-bold flex items-center gap-1.5 hover:opacity-90 shadow-md shadow-(--primary)/25 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{#if isSubmitting}
					<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
					</svg>
					<span>推送中...</span>
				{:else if editingOriginalSlug}
					<span>💾 保存并更新文章 (提交至 GitHub)</span>
				{:else}
					<span>🚀 提交到 GitHub 内容仓</span>
				{/if}
			</button>
		</div>
	</div>

	<!-- 文章基础配置表单 (标题、Slug、分类、标签、封面等) -->
	<div class="space-y-3 mb-4">
		<!-- 第一行：标题 + Slug -->
		<div class="grid grid-cols-1 md:grid-cols-3 gap-3">
			<div class="md:col-span-2 space-y-1">
				<label class="block text-xs font-semibold text-neutral-700 dark:text-neutral-300">
					文章标题 <span class="text-red-500">*</span>
				</label>
				<input
					type="text"
					bind:value={title}
					oninput={triggerDraftSave}
					placeholder="输入吸引读者的精彩标题..."
					class="w-full text-xs px-3 py-2 rounded-xl border border-(--line-divider) bg-black/3 dark:bg-white/3 focus:outline-none focus:border-(--primary) text-neutral-800 dark:text-neutral-100 transition-colors"
				/>
			</div>

			<div class="space-y-1">
				<div class="flex items-center justify-between">
					<label class="block text-xs font-semibold text-neutral-700 dark:text-neutral-300">
						URL Slug <span class="text-red-500">*</span>
					</label>
					{#if !editingOriginalSlug}
						<button
							type="button"
							onclick={generateSlugFromTitle}
							class="text-[11px] text-(--primary) hover:underline cursor-pointer"
						>
							智能生成
						</button>
					{/if}
				</div>
				<input
					type="text"
					bind:value={slug}
					oninput={triggerDraftSave}
					placeholder="post-slug-example"
					class="w-full text-xs px-3 py-2 rounded-xl border border-(--line-divider) bg-black/3 dark:bg-white/3 focus:outline-none focus:border-(--primary) text-neutral-800 dark:text-neutral-100 font-mono transition-colors"
				/>
			</div>
		</div>

		<!-- 第二行：分类、标签、草稿与置顶状态 -->
		<div class="grid grid-cols-1 md:grid-cols-3 gap-3">
			<!-- 分类选择与新增 -->
			<div class="space-y-1">
				<div class="flex items-center justify-between">
					<label class="block text-xs font-semibold text-neutral-700 dark:text-neutral-300">
						文章分类
					</label>
					<button
						type="button"
						onclick={() => {
							isCustomCategory = !isCustomCategory;
							if (!isCustomCategory && !availableCategories.includes(category)) {
								category = availableCategories[0] || "开发";
							}
						}}
						class="text-[11px] text-(--primary) hover:underline cursor-pointer"
					>
						{isCustomCategory ? "↩️ 从已有分类选择" : "➕ 自定义新分类"}
					</button>
				</div>
				<div class="flex gap-1.5">
					{#if isCustomCategory}
						<input
							type="text"
							bind:value={category}
							oninput={triggerDraftSave}
							placeholder="输入新分类名称 (如: 开发、折腾)..."
							class="w-full text-xs px-2.5 py-2 rounded-xl border border-(--primary) bg-black/3 dark:bg-white/3 focus:outline-none text-neutral-800 dark:text-neutral-100 transition-colors"
						/>
					{:else}
						<select
							bind:value={category}
							onchange={(e) => {
								const val = (e.target as HTMLSelectElement).value;
								if (val === "__new__") {
									category = "";
									isCustomCategory = true;
								}
								triggerDraftSave();
							}}
							class="flex-1 text-xs px-2.5 py-2 rounded-xl border border-(--line-divider) bg-black/3 dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 focus:outline-none focus:border-(--primary) cursor-pointer"
						>
							{#each availableCategories as cat}
								<option value={cat}>{cat}</option>
							{/each}
							<option value="__new__">➕ 输入全新分类...</option>
						</select>
					{/if}
				</div>
			</div>

			<!-- 标签输入与药丸 -->
			<div class="md:col-span-2 space-y-1">
				<label class="block text-xs font-semibold text-neutral-700 dark:text-neutral-300">
					标签列表 (回车或逗号添加)
				</label>
				<div class="flex flex-wrap items-center gap-1.5 p-1.5 rounded-xl border border-(--line-divider) bg-black/3 dark:bg-white/3 focus-within:border-(--primary) transition-colors">
					{#each tags as t}
						<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-(--primary)/15 text-(--primary) text-[11px] font-medium">
							#{t}
							<button
								type="button"
								onclick={() => removeTag(t)}
								class="hover:opacity-75 cursor-pointer ml-0.5"
							>
								✕
							</button>
						</span>
					{/each}
					<input
						type="text"
						bind:value={tagInput}
						onkeydown={handleTagKeydown}
						placeholder={tags.length === 0 ? "输入标签后按回车..." : "添加更多..."}
						class="flex-1 min-w-[80px] text-xs px-2 py-1 bg-transparent focus:outline-none text-neutral-800 dark:text-neutral-100"
					/>
				</div>
			</div>
		</div>

		<!-- 推荐快捷标签药丸 (基于全站文章真实提取的高频标签) -->
		<div class="flex items-center gap-1.5 flex-wrap">
			<span class="text-[11px] text-(--content-meta)">常用标签:</span>
			{#each dynamicSuggestedTags as st}
				<button
					type="button"
					onclick={() => addTag(st)}
					class="text-[11px] px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/5 hover:bg-(--primary)/15 hover:text-(--primary) text-(--content-meta) transition-all cursor-pointer"
				>
					+{st}
				</button>
			{/each}
		</div>

		<!-- 第三行：封面图设置与摘要 -->
		<div class="grid grid-cols-1 md:grid-cols-2 gap-3">
			<div class="space-y-1">
				<div class="flex items-center justify-between">
					<label class="block text-xs font-semibold text-neutral-700 dark:text-neutral-300">
						封面图片 URL (可选)
					</label>
					<button
						type="button"
						onclick={() => coverFileInput?.click()}
						disabled={isUploadingCover}
						class="text-[11px] text-(--primary) hover:underline flex items-center gap-1 cursor-pointer disabled:opacity-50"
					>
						{#if isUploadingCover}
							<span>上传中...</span>
						{:else}
							<span>🖼️ 上传至 R2</span>
						{/if}
					</button>
				</div>
				<input
					type="text"
					bind:value={cover}
					oninput={triggerDraftSave}
					placeholder="https://img.lengxiqwq.com/... 或留空"
					class="w-full text-xs px-3 py-2 rounded-xl border border-(--line-divider) bg-black/3 dark:bg-white/3 focus:outline-none focus:border-(--primary) text-neutral-800 dark:text-neutral-100 font-mono transition-colors"
				/>
				<p class="text-[10px] text-(--content-meta)">
					💡 留空将自动使用全站配置的随机封面图（与之前保持完全一致）
				</p>
			</div>

			<div class="space-y-1">
				<div class="flex items-center justify-between flex-wrap gap-2">
					<label class="block text-xs font-semibold text-neutral-700 dark:text-neutral-300">
						文章摘要 / 描述
					</label>
					<div class="flex items-center gap-3">
						<label class="flex items-center gap-1 text-[11px] text-(--content-meta) hover:text-(--primary) cursor-pointer select-none">
							<input
								type="checkbox"
								bind:checked={pinned}
								onchange={triggerDraftSave}
								class="rounded text-(--primary) focus:ring-(--primary) cursor-pointer"
							/>
							<span>📌 置顶此文章</span>
						</label>
						<label class="flex items-center gap-1 text-[11px] text-(--content-meta) hover:text-amber-600 dark:hover:text-amber-400 cursor-pointer select-none">
							<input
								type="checkbox"
								bind:checked={draft}
								onchange={triggerDraftSave}
								class="rounded text-(--primary) focus:ring-(--primary) cursor-pointer"
							/>
							<span>📝 保存为草稿</span>
						</label>
					</div>
				</div>
				<input
					type="text"
					bind:value={excerpt}
					oninput={triggerDraftSave}
					placeholder="简短描述文章核心内容（留空默认采用标题）..."
					class="w-full text-xs px-3 py-2 rounded-xl border border-(--line-divider) bg-black/3 dark:bg-white/3 focus:outline-none focus:border-(--primary) text-neutral-800 dark:text-neutral-100 transition-colors"
				/>
			</div>
		</div>
	</div>

	<!-- Markdown 编辑工具栏快捷按钮 -->
	<div class="flex items-center gap-1.5 flex-wrap p-2 mb-3 rounded-xl bg-black/3 dark:bg-white/3 border border-(--line-divider)">
		<span class="text-[11px] font-bold text-(--content-meta) mr-1">快捷语法:</span>
		<button
			type="button"
			onclick={() => insertMarkdownSyntax("\n## ", "\n", "二级标题")}
			class="p-1.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-xs font-bold cursor-pointer text-neutral-700 dark:text-neutral-300"
			title="二级标题"
		>
			H2
		</button>
		<button
			type="button"
			onclick={() => insertMarkdownSyntax("\n### ", "\n", "三级标题")}
			class="p-1.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-xs font-bold cursor-pointer text-neutral-700 dark:text-neutral-300"
			title="三级标题"
		>
			H3
		</button>
		<button
			type="button"
			onclick={() => insertMarkdownSyntax("**", "**", "粗体内容")}
			class="p-1.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-xs font-bold cursor-pointer text-neutral-700 dark:text-neutral-300"
			title="粗体"
		>
			B
		</button>
		<button
			type="button"
			onclick={() => insertMarkdownSyntax("*", "*", "斜体文字")}
			class="p-1.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-xs italic cursor-pointer text-neutral-700 dark:text-neutral-300"
			title="斜体"
		>
			I
		</button>
		<button
			type="button"
			onclick={() => insertMarkdownSyntax("\n> ", "\n", "引用文本")}
			class="p-1.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-xs cursor-pointer text-neutral-700 dark:text-neutral-300"
			title="引用块"
		>
			” 引用
		</button>
		<button
			type="button"
			onclick={() => insertMarkdownSyntax("\n- ", "\n", "列表项")}
			class="p-1.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-xs cursor-pointer text-neutral-700 dark:text-neutral-300"
			title="无序列表"
		>
			• 列表
		</button>
		<button
			type="button"
			onclick={() => insertMarkdownSyntax("\n```ts\n", "\n```\n", "// 输入代码")}
			class="p-1.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-xs font-mono cursor-pointer text-neutral-700 dark:text-neutral-300"
			title="代码块"
		>
			代码块
		</button>
		<button
			type="button"
			onclick={() => insertMarkdownSyntax("[", "](https://example.com)", "链接文字")}
			class="p-1.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-xs cursor-pointer text-neutral-700 dark:text-neutral-300"
			title="插入链接"
		>
			🔗 链接
		</button>
		<span class="w-px h-4 bg-(--line-divider) mx-1"></span>

		<!-- 直传插图到 R2 按钮 -->
		<button
			type="button"
			onclick={() => inlineFileInput?.click()}
			disabled={isUploadingImage}
			class="px-2 py-1 rounded bg-(--primary)/10 text-(--primary) hover:bg-(--primary)/20 text-xs flex items-center gap-1 cursor-pointer transition-colors"
			title="直传插图至 Cloudflare R2 并自动插入 Markdown"
		>
			{#if isUploadingImage}
				<span class="animate-spin text-xs">⏳</span>
				<span>上传中...</span>
			{:else}
				<span>🖼️ 直传插图到 R2</span>
			{/if}
		</button>
	</div>

	<!-- 分屏区域：左侧 Markdown 输入框 + 右侧实时预览 (高度自适应/沉浸全屏撑满) -->
	<div class="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 {isFocusMode ? 'min-h-0' : 'min-h-[460px]'}">
		<!-- 左侧：输入框 -->
		<div class="flex flex-col h-full rounded-2xl border border-(--line-divider) bg-black/2 dark:bg-white/2 overflow-hidden focus-within:border-(--primary) transition-colors">
			<div class="px-3 py-1.5 bg-black/5 dark:bg-white/5 border-b border-(--line-divider) text-[11px] font-mono text-(--content-meta) flex items-center justify-between">
				<span>Markdown 源码编辑</span>
				<span>字数: {content.length}</span>
			</div>
			<textarea
				bind:this={textareaEl}
				bind:value={content}
				oninput={triggerDraftSave}
				placeholder="在此输入 Markdown 正文内容... 支持双向实时渲染、代码块、列表、图片与引用语法"
				class="w-full flex-1 p-3.5 bg-transparent resize-none focus:outline-none font-mono text-xs leading-relaxed text-neutral-800 dark:text-neutral-100 {isFocusMode ? 'h-full' : 'min-h-[380px]'}"
			></textarea>
		</div>

		<!-- 右侧：实时渲染预览 -->
		<div class="flex flex-col h-full rounded-2xl border border-(--line-divider) bg-black/2 dark:bg-white/2 overflow-hidden">
			<div class="px-3 py-1.5 bg-black/5 dark:bg-white/5 border-b border-(--line-divider) text-[11px] font-mono text-(--content-meta) flex items-center justify-between">
				<span>实时排版效果预览</span>
				<span>HTML 渲染</span>
			</div>
			<div class="p-4 overflow-y-auto flex-1 prose-sm text-neutral-800 dark:text-neutral-100 {isFocusMode ? 'h-full' : 'max-h-[500px]'}">
				<!-- 预览封面图 -->
				{#if cover}
					<div class="mb-4 rounded-xl overflow-hidden border border-(--line-divider) max-h-48">
						<img src={cover} alt="封面预览" class="w-full h-48 object-cover" />
					</div>
				{/if}

				<!-- 预览文章头部 -->
				{#if title}
					<h1 class="text-xl font-extrabold text-neutral-900 dark:text-neutral-100 mb-2">
						{title}
					</h1>
					<div class="flex flex-wrap items-center gap-2 text-[11px] text-(--content-meta) mb-4 pb-2 border-b border-(--line-divider)">
						<span>📂 {category || "未分类"}</span>
						<span>·</span>
						<span>🏷️ {tags.join(", ")}</span>
						{#if pinned}
							<span class="px-1.5 py-0.2 rounded bg-indigo-500/15 text-indigo-600 text-[10px] font-semibold">📌 置顶</span>
						{/if}
						{#if draft}
							<span class="px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-600 text-[10px]">📝 草稿模式</span>
						{/if}
					</div>
				{/if}

				<!-- 正文渲染 -->
				<!-- svelte-ignore a11y_missing_attribute -->
				{@html renderMarkdown(content)}
			</div>
		</div>
	</div>
</div>

<!-- 📚 已有文章选择抽屉 / 弹窗 (选择后载入修改) -->
{#if showPostSelector}
	<div class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/50 backdrop-blur-sm animate-in fade-in">
		<div
			class="card-base w-full max-w-3xl max-h-[85vh] rounded-2xl shadow-2xl border border-(--line-divider) flex flex-col overflow-hidden bg-white dark:bg-neutral-900"
			role="dialog"
			aria-modal="true"
		>
			<!-- 弹窗顶栏 -->
			<div class="flex items-center justify-between px-5 py-4 border-b border-(--line-divider)">
				<div class="flex items-center gap-2.5">
					<span class="text-xl">📚</span>
					<div>
						<h3 class="font-bold text-sm sm:text-base text-neutral-800 dark:text-neutral-100">
							选择已有博客文章进行编辑
						</h3>
						<p class="text-xs text-(--content-meta)">
							点击任意文章，即可将完整 Markdown 正文与元数据载入编辑器中修改更新
						</p>
					</div>
				</div>

				<button
					type="button"
					onclick={() => showPostSelector = false}
					class="w-7 h-7 rounded-full flex items-center justify-center text-(--content-meta) hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
				>
					✕
				</button>
			</div>

			<!-- 搜索框与分类过滤器 -->
			<div class="p-4 border-b border-(--line-divider) bg-black/[0.02] dark:bg-white/[0.02] space-y-3">
				<div class="relative">
					<span class="absolute left-3 top-2.5 text-(--content-meta) text-xs">🔍</span>
					<input
						type="text"
						bind:value={postSearchQuery}
						placeholder="搜索文章标题、Slug 或标签..."
						class="w-full pl-8 pr-3 py-2 rounded-xl border border-(--line-divider) bg-white dark:bg-neutral-800 text-xs focus:outline-none focus:border-(--primary) text-neutral-800 dark:text-neutral-100"
					/>
				</div>

				<!-- 分类标签过滤器 -->
				<div class="flex items-center gap-1.5 flex-wrap">
					<span class="text-[11px] text-(--content-meta)">分类:</span>
					{#each existingCategories as cat}
						<button
							type="button"
							onclick={() => selectedCategoryFilter = cat}
							class="text-[11px] px-2.5 py-0.5 rounded-full transition-all cursor-pointer {selectedCategoryFilter === cat ? 'bg-(--primary) text-white font-semibold' : 'bg-black/5 dark:bg-white/5 text-(--content-meta) hover:bg-(--primary)/15'}"
						>
							{cat}
						</button>
					{/each}
				</div>
			</div>

			<!-- 文章列表区域 -->
			<div class="p-4 overflow-y-auto flex-1 space-y-2.5">
				{#if isLoadingExistingPosts}
					<div class="py-12 text-center text-(--content-meta)">
						<svg class="animate-spin h-6 w-6 mx-auto mb-2 text-(--primary)" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						<p class="text-xs">正在拉取全站文章列表与正文...</p>
					</div>
				{:else if filteredExistingPosts.length === 0}
					<div class="py-12 text-center text-(--content-meta) text-xs">
						<span class="text-3xl block mb-2 opacity-50">🔍</span>
						<p>未找到匹配的文章</p>
					</div>
				{:else}
					{#each filteredExistingPosts as post (post.id)}
						<div class="p-3.5 rounded-xl border border-(--line-divider) hover:border-(--primary)/50 bg-black/[0.01] dark:bg-white/[0.01] hover:bg-(--primary)/[0.02] transition-all flex items-center justify-between gap-3 group">
							<div class="space-y-1 min-w-0 flex-1">
								<div class="flex items-center gap-2 flex-wrap">
									<h4 class="font-bold text-xs sm:text-sm text-neutral-800 dark:text-neutral-100 truncate">
										{post.title}
									</h4>
									{#if post.pinned}
										<span class="px-1.5 py-0.2 rounded bg-(--primary)/15 text-(--primary) text-[10px] font-semibold">
											置顶
										</span>
									{/if}
									{#if post.draft}
										<span class="px-1.5 py-0.2 rounded bg-amber-500/15 text-amber-600 text-[10px]">
											草稿
										</span>
									{/if}
								</div>

								<div class="flex items-center gap-2 text-[11px] text-(--content-meta) flex-wrap">
									<span>📅 {post.publishedDate}</span>
									<span>·</span>
									<span class="px-1.5 py-0.2 rounded bg-black/5 dark:bg-white/5">📂 {post.category}</span>
									<span>·</span>
									<span>📝 {post.wordCount} 字</span>
									<span class="font-mono opacity-60">Slug: {post.slug}</span>
								</div>

								{#if post.description}
									<p class="text-xs text-(--content-meta) line-clamp-1 opacity-80">
										{post.description}
									</p>
								{/if}
							</div>

							<!-- 载入编辑按钮 -->
							<button
								type="button"
								onclick={() => selectPostToEdit(post)}
								class="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-(--primary)/10 text-(--primary) hover:bg-(--primary) hover:text-white transition-all cursor-pointer shadow-xs"
							>
								✏️ 载入修改
							</button>
						</div>
					{/each}
				{/if}
			</div>

			<!-- 弹窗底栏 -->
			<div class="flex items-center justify-between px-5 py-3 border-t border-(--line-divider) bg-black/[0.02] dark:bg-white/[0.02] text-xs">
				<span class="text-(--content-meta)">
					共 {filteredExistingPosts.length} 篇可用文章
				</span>
				<button
					type="button"
					onclick={() => showPostSelector = false}
					class="px-3 py-1 rounded-lg border border-(--line-divider) text-(--content-meta) hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
				>
					关闭
				</button>
			</div>
		</div>
	</div>
{/if}
