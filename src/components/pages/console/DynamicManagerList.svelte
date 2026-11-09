<script lang="ts">
import { onMount } from "svelte";
import { compressAndConvertToWebp } from "@/utils/image-compress";

interface DynamicMomentItem {
	id: string;
	content: string;
	images: string[];
	pinned: boolean;
	location: string | null;
	createdAt: number;
	updatedAt: number;
}

interface Props {
	workerApiUrl: string;
	token: string;
	refreshTrigger: number;
	onListUpdated?: () => void;
}

const { workerApiUrl, token, refreshTrigger, onListUpdated }: Props = $props();

let items = $state<DynamicMomentItem[]>([]);
let isLoading = $state(true);
let errorMessage = $state("");
let actionError = $state("");
let processingId = $state<string | null>(null);
let confirmDeleteId = $state<string | null>(null);

// 编辑中状态
let editingId = $state<string | null>(null);
let editContent = $state("");
let editLocation = $state("");
let editPinned = $state(false);
let editImages = $state<string[]>([]);
let isUploadingEditImage = $state(false);
let editErrorMessage = $state("");
let editFileInputEl: HTMLInputElement | null = null;

const quickTags = [
	"日常",
	"碎碎念",
	"技术",
	"折腾",
	"游戏",
	"随笔",
	"摄影",
	"思考",
];

async function loadItems() {
	isLoading = true;
	errorMessage = "";
	try {
		const listUrl = `${workerApiUrl}/api/dynamic/list?limit=100`;
		const response = await fetch(listUrl, {
			headers: {
				Accept: "application/json",
			},
		});

		const resJson = await response.json().catch(() => ({}));
		if (!response.ok || resJson.code !== 200 || !resJson.data) {
			errorMessage =
				resJson?.error || "拉取动态说说列表失败，请检查 Worker 连接";
			return;
		}

		items = resJson.data.items || [];
	} catch (err) {
		console.error("Failed to fetch moments", err);
		errorMessage = "网络连接异常，无法获取说说数据";
	} finally {
		isLoading = false;
	}
}

function startEditing(item: DynamicMomentItem) {
	editingId = item.id;
	editContent = item.content;
	editLocation = item.location || "";
	editPinned = Boolean(item.pinned);
	editImages = [...(item.images || [])];
	editErrorMessage = "";
}

function cancelEditing() {
	editingId = null;
	editErrorMessage = "";
}

function insertEditTag(tag: string) {
	const tagText = `#${tag} `;
	if (!editContent.includes(tagText.trim())) {
		if (
			editContent.endsWith(" ") ||
			editContent.endsWith("\n") ||
			editContent === ""
		) {
			editContent += tagText;
		} else {
			editContent += ` ${tagText}`;
		}
	}
}

async function handleUploadEditFiles(files: FileList | File[]) {
	if (!files || files.length === 0) return;

	isUploadingEditImage = true;
	editErrorMessage = "";

	for (const file of Array.from(files)) {
		if (!file.type.startsWith("image/")) {
			editErrorMessage = `文件 "${file.name}" 不是受支持的图片格式`;
			continue;
		}

		try {
			// 自动转码为 90% 质量的 WebP 格式并等比限制超高分辨率
			const compressResult = await compressAndConvertToWebp(file, {
				quality: 0.9,
			});
			const uploadFile = compressResult.file;

			if (uploadFile.size > 10 * 1024 * 1024) {
				editErrorMessage = `图片 "${file.name}" 压缩后仍超过 10MB 限制`;
				continue;
			}

			const formData = new FormData();
			formData.append("file", uploadFile);

			const uploadUrl = `${workerApiUrl}/api/dynamic/upload`;
			const response = await fetch(uploadUrl, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
				},
				body: formData,
			});

			const resJson = await response.json().catch(() => ({}));

			if (!response.ok || resJson.code !== 200 || !resJson.data?.url) {
				editErrorMessage =
					resJson?.error || `上传图片 "${file.name}" 失败，请检查服务`;
				break;
			}

			editImages = [...editImages, resJson.data.url];
		} catch (err) {
			console.error("Upload error", err);
			editErrorMessage = `网络异常，上传图片 "${file.name}" 失败`;
			break;
		}
	}

	isUploadingEditImage = false;
	if (editFileInputEl) editFileInputEl.value = "";
}

function removeEditImage(indexToRemove: number) {
	editImages = editImages.filter((_, idx) => idx !== indexToRemove);
}

async function saveEdit(item: DynamicMomentItem) {
	const cleanContent = editContent.trim();
	if (!cleanContent) {
		editErrorMessage = "说说内容不能为空";
		return;
	}

	processingId = item.id;
	editErrorMessage = "";

	try {
		const updateUrl = `${workerApiUrl}/api/dynamic/${item.id}`;
		const response = await fetch(updateUrl, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				content: cleanContent,
				images: editImages,
				location: editLocation.trim() || null,
				pinned: editPinned,
			}),
		});

		const resJson = await response.json().catch(() => ({}));
		if (!response.ok || resJson.code !== 200 || !resJson.data) {
			editErrorMessage = resJson?.error || "保存修改失败，请重试";
			return;
		}

		// 本地即时更新该条说说
		items = items.map((old) =>
			old.id === item.id
				? {
						...old,
						content: cleanContent,
						images: editImages,
						location: editLocation.trim() || null,
						pinned: editPinned,
						updatedAt: Date.now(),
					}
				: old,
		);

		editingId = null;
		onListUpdated?.();
	} catch (err) {
		console.error("Save edit failed", err);
		editErrorMessage = "网络连接异常，无法保存修改";
	} finally {
		processingId = null;
	}
}

async function togglePin(item: DynamicMomentItem) {
	processingId = item.id;
	actionError = "";

	try {
		const updateUrl = `${workerApiUrl}/api/dynamic/${item.id}`;
		const response = await fetch(updateUrl, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				pinned: !item.pinned,
			}),
		});

		const resJson = await response.json().catch(() => ({}));
		if (!response.ok || resJson.code !== 200) {
			actionError = resJson?.error || "切换置顶状态失败";
			return;
		}

		// 重新拉取以保持全局置顶优先排序
		await loadItems();
		onListUpdated?.();
	} catch (err) {
		console.error("Toggle pin failed", err);
		actionError = "切换置顶状态网络异常";
	} finally {
		processingId = null;
	}
}

async function deleteMoment(id: string) {
	processingId = id;
	actionError = "";

	try {
		const deleteUrl = `${workerApiUrl}/api/dynamic/${id}`;
		const response = await fetch(deleteUrl, {
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});

		const resJson = await response.json().catch(() => ({}));
		if (!response.ok || resJson.code !== 200) {
			actionError = resJson?.error || "删除说说失败";
			return;
		}

		confirmDeleteId = null;
		items = items.filter((item) => item.id !== id);
		onListUpdated?.();
	} catch (err) {
		console.error("Delete failed", err);
		actionError = "删除请求失败，请稍后重试";
	} finally {
		processingId = null;
	}
}

function formatDate(timestamp: number): string {
	if (!timestamp) return "";
	const date = new Date(timestamp);
	return date.toLocaleString("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

// 监听外层刷新触发器
$effect(() => {
	if (refreshTrigger !== undefined) {
		void loadItems();
	}
});

onMount(() => {
	void loadItems();
});
</script>

<div class="card-base p-5 md:p-6 rounded-(--radius-large) shadow-lg border border-(--line-divider)">
	<div class="flex items-center justify-between mb-4 pb-3 border-b border-(--line-divider)">
		<div class="flex items-center gap-2.5">
			<span class="text-xl">📋</span>
			<h3 class="font-bold text-base text-neutral-800 dark:text-neutral-100">
				已发布说说管理与修改
			</h3>
			<span class="text-xs px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/5 text-(--content-meta) font-mono">
				共 {items.length} 条
			</span>
		</div>

		<button
			type="button"
			onclick={loadItems}
			disabled={isLoading}
			class="text-xs px-3 py-1.5 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-(--primary)/10 hover:text-(--primary) text-(--content-meta) transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
			title="刷新说说列表"
		>
			<svg class="w-3.5 h-3.5 {isLoading ? 'animate-spin' : ''}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
			</svg>
			<span>刷新</span>
		</button>
	</div>

	{#if actionError}
		<div class="p-3 mb-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs flex items-center justify-between">
			<span>⚠️ {actionError}</span>
			<button type="button" onclick={() => actionError = ""} class="text-xs opacity-70 hover:opacity-100 cursor-pointer">✕</button>
		</div>
	{/if}

	{#if isLoading && items.length === 0}
		<div class="py-12 text-center text-(--content-meta)">
			<svg class="animate-spin h-7 w-7 mx-auto mb-2 text-(--primary)" fill="none" viewBox="0 0 24 24">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
			</svg>
			<p class="text-xs">正在从 Worker D1 加载说说列表...</p>
		</div>
	{:else if errorMessage}
		<div class="py-8 text-center text-red-500 text-xs">
			<p>{errorMessage}</p>
			<button
				type="button"
				onclick={loadItems}
				class="mt-2 text-xs px-3 py-1 rounded bg-(--primary) text-white hover:brightness-105 cursor-pointer"
			>
				重试
			</button>
		</div>
	{:else if items.length === 0}
		<div class="py-12 text-center text-(--content-meta) text-sm">
			<span class="text-3xl block mb-2 opacity-50">🍃</span>
			<p>暂无任何已发布的动态说说</p>
			<p class="text-xs opacity-70 mt-1">在上方发布器输入文字并点击发布即可记录瞬间</p>
		</div>
	{:else}
		<div class="space-y-4">
			{#each items as item (item.id)}
				{#if editingId === item.id}
					<!-- ✏️ 内联就地修改模式卡片 -->
					<div class="p-5 rounded-2xl border-2 border-(--primary) bg-(--primary)/[0.03] dark:bg-(--primary)/[0.05] shadow-md transition-all relative">
						<div class="flex items-center justify-between mb-3 pb-2 border-b border-(--primary)/20">
							<div class="flex items-center gap-2">
								<span class="text-base">✏️</span>
								<h4 class="font-bold text-sm text-(--primary)">正在修改此条说说</h4>
								<span class="text-[11px] font-mono opacity-60">ID: {item.id}</span>
							</div>

							<button
								type="button"
								onclick={cancelEditing}
								class="text-xs px-2.5 py-1 rounded-md text-(--content-meta) hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer"
							>
								✕ 取消
							</button>
						</div>

						{#if editErrorMessage}
							<div class="p-2.5 mb-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs">
								⚠️ {editErrorMessage}
							</div>
						{/if}

						<!-- 快捷话题标签药丸 -->
						<div class="flex flex-wrap gap-1.5 mb-3">
							<span class="text-[11px] text-(--content-meta) self-center mr-1">插入标签:</span>
							{#each quickTags as tag}
								<button
									type="button"
									onclick={() => insertEditTag(tag)}
									class="text-[11px] px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/5 hover:bg-(--primary)/15 hover:text-(--primary) text-(--content-meta) transition-all cursor-pointer"
								>
									#{tag}
								</button>
							{/each}
						</div>

						<!-- 编辑文本框 -->
						<textarea
							bind:value={editContent}
							rows="4"
							placeholder="修改你的说说内容..."
							class="w-full p-3 rounded-xl bg-white dark:bg-neutral-800 border border-(--line-divider) focus:border-(--primary) focus:ring-2 focus:ring-(--primary)/20 text-sm text-neutral-800 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 outline-none transition-all resize-y"
						></textarea>

						<!-- 配图管理网格 -->
						<div class="mt-3">
							<div class="flex items-center justify-between mb-2">
								<span class="text-xs font-medium text-neutral-700 dark:text-neutral-300">
									配图管理 ({editImages.length} 张)
								</span>

								<!-- 上传新图按钮 -->
								<div>
									<input
										type="file"
										accept="image/*"
										multiple
										bind:this={editFileInputEl}
										onchange={(e) => {
											const target = e.target as HTMLInputElement;
											if (target.files) void handleUploadEditFiles(target.files);
										}}
										class="hidden"
									/>
									<button
										type="button"
										onclick={() => editFileInputEl?.click()}
										disabled={isUploadingEditImage}
										class="text-xs px-2.5 py-1 rounded-md bg-(--primary)/10 hover:bg-(--primary)/20 text-(--primary) font-medium transition-all flex items-center gap-1 cursor-pointer disabled:opacity-50"
									>
										{#if isUploadingEditImage}
											<svg class="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
												<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
												<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
											</svg>
											<span>正在上传 R2...</span>
										{:else}
											<span>🖼️ 上传/追加配图</span>
										{/if}
									</button>
								</div>
							</div>

							{#if editImages.length > 0}
								<div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2 mb-3">
									{#each editImages as imgUrl, idx}
										<div class="relative group aspect-square rounded-lg overflow-hidden border border-(--line-divider) bg-black/5 dark:bg-white/5">
											<img
												src={imgUrl}
												alt="配图 {idx + 1}"
												class="w-full h-full object-cover"
											/>
											<button
												type="button"
												onclick={() => removeEditImage(idx)}
												class="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/70 hover:bg-red-600 text-white flex items-center justify-center text-xs opacity-80 group-hover:opacity-100 transition-all cursor-pointer"
												title="删除此图片"
											>
												✕
											</button>
										</div>
									{/each}
								</div>
							{/if}
						</div>

						<!-- 位置与置顶设置 -->
						<div class="flex flex-wrap items-center justify-between gap-3 mt-3 pt-3 border-t border-(--line-divider)">
							<div class="flex items-center gap-3">
								<div class="flex items-center gap-1 text-xs">
									<span class="text-(--content-meta)">📍</span>
									<input
										type="text"
										bind:value={editLocation}
										placeholder="位置标签 (如: 上海·家里)"
										class="px-2 py-1 rounded-md bg-white dark:bg-neutral-800 border border-(--line-divider) text-xs outline-none focus:border-(--primary) w-36 sm:w-44"
									/>
								</div>

								<label class="flex items-center gap-1.5 text-xs text-(--content-meta) cursor-pointer select-none">
									<input
										type="checkbox"
										bind:checked={editPinned}
										class="rounded border-(--line-divider) text-(--primary) focus:ring-(--primary) cursor-pointer"
									/>
									<span>📌 置顶此条</span>
								</label>
							</div>

							<!-- 保存与取消操作 -->
							<div class="flex items-center gap-2">
								<button
									type="button"
									onclick={cancelEditing}
									disabled={processingId === item.id}
									class="px-3 py-1.5 rounded-lg text-xs font-medium text-(--content-meta) hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
								>
									取消
								</button>

								<button
									type="button"
									onclick={() => saveEdit(item)}
									disabled={processingId === item.id || !editContent.trim()}
									class="px-4 py-1.5 rounded-lg text-xs font-medium bg-(--primary) text-white hover:brightness-105 shadow-sm transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
								>
									{#if processingId === item.id}
										<svg class="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
											<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
											<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
										</svg>
										<span>保存中...</span>
									{:else}
										<span>💾 保存修改</span>
									{/if}
								</button>
							</div>
						</div>
					</div>
				{:else}
					<!-- 📖 普通展示卡片 -->
					<div class="p-4 rounded-xl border border-(--line-divider) bg-black/[0.02] dark:bg-white/[0.02] hover:border-(--primary)/40 transition-all relative">
						<!-- 条目顶部元信息 -->
						<div class="flex items-center justify-between gap-2 mb-2 text-xs">
							<div class="flex items-center gap-2 flex-wrap">
								{#if item.pinned}
									<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-(--primary)/15 text-(--primary) font-semibold text-[11px]">
										📌 置顶
									</span>
								{/if}
								<time class="text-(--content-meta)">
									{formatDate(item.createdAt)}
								</time>
								{#if item.updatedAt && item.updatedAt > item.createdAt + 1000}
									<span class="text-[10px] text-(--content-meta) opacity-70">
										(已编辑)
									</span>
								{/if}
								{#if item.location}
									<span class="text-(--content-meta) flex items-center gap-0.5">
										📍 {item.location}
									</span>
								{/if}
							</div>

							<div class="text-[11px] font-mono text-(--content-meta) opacity-60">
								ID: {item.id}
							</div>
						</div>

						<!-- 说说文字正文 -->
						<div class="text-sm text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap leading-relaxed break-words mb-3">
							{item.content}
						</div>

						<!-- 配图预览网格 -->
						{#if item.images && item.images.length > 0}
							<div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2 mb-3">
								{#each item.images as imgUrl, imgIdx}
									<a
										href={imgUrl}
										target="_blank"
										rel="noopener noreferrer"
										class="relative group aspect-square rounded-lg overflow-hidden border border-(--line-divider) bg-black/5 dark:bg-white/5 block"
									>
										<img
											src={imgUrl}
											alt="配图 {imgIdx + 1}"
											loading="lazy"
											class="w-full h-full object-cover group-hover:scale-105 transition-transform"
										/>
									</a>
								{/each}
							</div>
						{/if}

						<!-- 操作栏 -->
						<div class="flex items-center justify-between pt-2 border-t border-(--line-divider)/60 text-xs">
							<span class="text-[11px] text-(--content-meta)">
								{item.images?.length ? `含 ${item.images.length} 张配图` : "纯文本"}
							</span>

							<div class="flex items-center gap-2">
								<!-- ✏️ 编辑说说按钮 -->
								<button
									type="button"
									onclick={() => startEditing(item)}
									disabled={processingId === item.id}
									class="px-2.5 py-1 rounded-md text-xs font-medium bg-(--primary)/10 text-(--primary) hover:bg-(--primary)/20 transition-colors cursor-pointer"
									title="修改此条说说的文字、图片或位置"
								>
									✏️ 修改说说
								</button>

								<!-- 切换置顶按钮 -->
								<button
									type="button"
									onclick={() => togglePin(item)}
									disabled={processingId === item.id}
									class="px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer {item.pinned ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20' : 'bg-black/5 dark:bg-white/5 text-(--content-meta) hover:bg-(--primary)/15 hover:text-(--primary)'}"
								>
									{item.pinned ? "取消置顶" : "📌 置顶此条"}
								</button>

								<!-- 删除按钮 -->
								{#if confirmDeleteId === item.id}
									<div class="flex items-center gap-1.5">
										<span class="text-red-500 font-semibold text-[11px]">确定删除？</span>
										<button
											type="button"
											onclick={() => deleteMoment(item.id)}
											disabled={processingId === item.id}
											class="px-2 py-0.5 rounded bg-red-600 text-white text-xs hover:bg-red-700 cursor-pointer"
										>
											确认
										</button>
										<button
											type="button"
											onclick={() => confirmDeleteId = null}
											class="px-2 py-0.5 rounded bg-black/10 dark:bg-white/10 text-(--content-meta) text-xs hover:opacity-100 cursor-pointer"
										>
											取消
										</button>
									</div>
								{:else}
									<button
										type="button"
										onclick={() => confirmDeleteId = item.id}
										disabled={processingId === item.id}
										class="px-2.5 py-1 rounded-md text-xs bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 font-medium transition-colors cursor-pointer"
									>
										🗑️ 删除
									</button>
								{/if}
							</div>
						</div>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>
