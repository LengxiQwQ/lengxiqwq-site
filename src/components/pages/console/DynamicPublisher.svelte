<script lang="ts">
import { compressAndConvertToWebp } from "@/utils/image-compress";

interface Props {
	workerApiUrl: string;
	token: string;
	onPublished: () => void;
}

const { workerApiUrl, token, onPublished }: Props = $props();

let content = $state("");
let location = $state("");
let pinned = $state(false);
let uploadedImages = $state<string[]>([]);
let isUploadingImage = $state(false);
let isSubmitting = $state(false);
let errorMessage = $state("");
let successMessage = $state("");
let fileInputEl: HTMLInputElement | null = null;
let isDraggingOver = $state(false);

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

function insertTag(tag: string) {
	const tagText = `#${tag} `;
	if (!content.includes(tagText.trim())) {
		if (content.endsWith(" ") || content.endsWith("\n") || content === "") {
			content += tagText;
		} else {
			content += ` ${tagText}`;
		}
	}
}

async function handleUploadFiles(files: FileList | File[]) {
	if (!files || files.length === 0) return;

	isUploadingImage = true;
	errorMessage = "";

	for (const file of Array.from(files)) {
		if (!file.type.startsWith("image/")) {
			errorMessage = `文件 "${file.name}" 不是受支持的图片格式`;
			continue;
		}

		try {
			// 自动转码为 90% 质量的 WebP 格式并等比优化超高分辨率
			const compressResult = await compressAndConvertToWebp(file, {
				quality: 0.9,
			});
			const uploadFile = compressResult.file;

			if (uploadFile.size > 10 * 1024 * 1024) {
				errorMessage = `图片 "${file.name}" 压缩后仍超过 10MB 限制`;
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
				errorMessage =
					resJson?.error || `上传图片 "${file.name}" 失败，请检查服务`;
				break;
			}

			uploadedImages = [...uploadedImages, resJson.data.url];
		} catch (err) {
			console.error("Upload error", err);
			errorMessage = `网络异常，上传图片 "${file.name}" 失败`;
			break;
		}
	}

	isUploadingImage = false;
	if (fileInputEl) fileInputEl.value = "";
}

function removeImage(indexToRemove: number) {
	uploadedImages = uploadedImages.filter((_, idx) => idx !== indexToRemove);
}

function handleFileInputChange(e: Event) {
	const target = e.target as HTMLInputElement;
	if (target.files) {
		void handleUploadFiles(target.files);
	}
}

function handleDragOver(e: DragEvent) {
	e.preventDefault();
	isDraggingOver = true;
}

function handleDragLeave(e: DragEvent) {
	e.preventDefault();
	isDraggingOver = false;
}

function handleDrop(e: DragEvent) {
	e.preventDefault();
	isDraggingOver = false;
	if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
		void handleUploadFiles(e.dataTransfer.files);
	}
}

async function handlePublish() {
	if (!content.trim()) {
		errorMessage = "说说的文字内容不能为空";
		return;
	}

	errorMessage = "";
	successMessage = "";
	isSubmitting = true;

	try {
		const publishUrl = `${workerApiUrl}/api/dynamic/publish`;
		const response = await fetch(publishUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				content: content.trim(),
				images: uploadedImages,
				pinned,
				location: location.trim() || null,
			}),
		});

		const resJson = await response.json().catch(() => ({}));

		if (!response.ok || resJson.code !== 200) {
			errorMessage = resJson?.error || "发布失败，请稍后重试";
			return;
		}

		// 发布成功，重置表单
		content = "";
		location = "";
		pinned = false;
		uploadedImages = [];
		successMessage = "🎉 说说发布成功并已实时同步至 D1 数据库！";

		setTimeout(() => {
			successMessage = "";
		}, 4000);

		onPublished();
	} catch (err) {
		console.error("Publish moment failed", err);
		errorMessage = "发布请求失败，请检查网络连接";
	} finally {
		isSubmitting = false;
	}
}
</script>

<div class="card-base p-5 md:p-6 rounded-(--radius-large) shadow-lg border border-(--line-divider) relative overflow-hidden mb-6">
	<div class="flex items-center justify-between mb-4 pb-3 border-b border-(--line-divider)">
		<div class="flex items-center gap-2">
			<span class="text-xl">✍️</span>
			<h3 class="font-bold text-base text-neutral-800 dark:text-neutral-100">
				发布新动态说说
			</h3>
		</div>
		<span class="text-xs px-2.5 py-1 rounded-full bg-(--primary)/10 text-(--primary) font-medium">
			实时直连 Worker D1
		</span>
	</div>

	<!-- 快捷标签栏 -->
	<div class="flex flex-wrap items-center gap-1.5 mb-3">
		<span class="text-xs text-(--content-meta) mr-1">快捷话题:</span>
		{#each quickTags as tag}
			<button
				type="button"
				onclick={() => insertTag(tag)}
				class="text-xs px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/5 hover:bg-(--primary)/15 hover:text-(--primary) text-(--content-meta) transition-colors cursor-pointer"
			>
				#{tag}
			</button>
		{/each}
	</div>

	<!-- 输入文本域 -->
	<div class="relative mb-3">
		<textarea
			bind:value={content}
			rows="4"
			placeholder="记录此刻的灵感、折腾日常或随笔感悟...（支持 Markdown 语法与代码块）"
			disabled={isSubmitting}
			class="w-full p-3.5 rounded-(--radius-large) bg-black/5 dark:bg-white/5 border border-(--line-divider) text-neutral-800 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none focus:border-(--primary) focus:ring-2 focus:ring-(--primary)/20 transition-all text-sm leading-relaxed resize-y min-h-[120px]"
		></textarea>
	</div>

	<!-- 图片拖拽上传区与预览网格 -->
	<div class="mb-4">
		<!-- 隐藏原生文件输入 -->
		<input
			type="file"
			bind:this={fileInputEl}
			onchange={handleFileInputChange}
			accept="image/*"
			multiple
			class="hidden"
		/>

		<!-- 拖拽/点击上传槽 -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			ondrop={handleDrop}
			onclick={() => fileInputEl?.click()}
			onkeydown={(e) => (e.key === "Enter" || e.key === " ") && fileInputEl?.click()}
			tabindex="0"
			role="button"
			class="border-2 border-dashed rounded-(--radius-large) p-4 text-center cursor-pointer transition-all {isDraggingOver ? 'border-(--primary) bg-(--primary)/10 scale-[1.01]' : 'border-(--line-divider) hover:border-(--primary)/60 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]'}"
		>
			<div class="flex flex-col items-center justify-center gap-1.5">
				{#if isUploadingImage}
					<svg class="animate-spin h-6 w-6 text-(--primary)" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
					</svg>
					<span class="text-xs text-(--primary) font-medium">正在直传图片至 Cloudflare R2...</span>
				{:else}
					<svg class="w-6 h-6 text-(--content-meta)" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
					</svg>
					<div class="text-xs text-(--content-meta)">
						<span class="font-medium text-(--primary)">点击上传图片</span> 或将图片拖拽至此区域
						<span class="opacity-70">（支持多图，单图上限 10MB）</span>
					</div>
				{/if}
			</div>
		</div>

		<!-- 已上传图片缩略预览网格 -->
		{#if uploadedImages.length > 0}
			<div class="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2.5 mt-3">
				{#each uploadedImages as imgUrl, idx}
					<div class="relative group aspect-square rounded-xl overflow-hidden border border-(--line-divider) bg-black/5 dark:bg-white/5">
						<img src={imgUrl} alt="已上传图 {idx + 1}" class="w-full h-full object-cover" />
						<button
							type="button"
							onclick={(e) => { e.stopPropagation(); removeImage(idx); }}
							class="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 hover:bg-red-600 text-white flex items-center justify-center text-xs opacity-90 transition-all cursor-pointer shadow-md"
							title="删除此图"
							aria-label="删除此图"
						>
							✕
						</button>
						<span class="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/60 text-[10px] text-white">
							#{idx + 1}
						</span>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- 附加信息（地点、心情、置顶） -->
	<div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 mb-4 pt-3 border-t border-(--line-divider)">
		<div class="flex items-center gap-2 flex-1">
			<span class="text-sm text-(--content-meta)">📍</span>
			<input
				type="text"
				bind:value={location}
				placeholder="位置 / 心情标签 (可选，如: 深圳 · 湾区 / 🎧 听歌中)"
				disabled={isSubmitting}
				class="w-full max-w-sm px-3 py-1.5 text-xs rounded-(--radius-large) bg-black/5 dark:bg-white/5 border border-(--line-divider) text-neutral-800 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none focus:border-(--primary)"
			/>
		</div>

		<label class="flex items-center gap-2 cursor-pointer select-none text-xs text-neutral-700 dark:text-neutral-300">
			<input
				type="checkbox"
				bind:checked={pinned}
				disabled={isSubmitting}
				class="w-4 h-4 rounded text-(--primary) focus:ring-(--primary) border-(--line-divider) cursor-pointer"
			/>
			<span>📌 置顶此动态</span>
		</label>
	</div>

	<!-- 错误与成功消息反馈 -->
	{#if errorMessage}
		<div class="p-3 mb-3 rounded-(--radius-large) bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs flex items-center gap-2">
			<span>⚠️ {errorMessage}</span>
		</div>
	{/if}

	{#if successMessage}
		<div class="p-3 mb-3 rounded-(--radius-large) bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs flex items-center gap-2">
			<span>{successMessage}</span>
		</div>
	{/if}

	<!-- 操作提交按钮 -->
	<div class="flex justify-end gap-3">
		<button
			type="button"
			onclick={handlePublish}
			disabled={isSubmitting || isUploadingImage || !content.trim()}
			class="px-6 py-2.5 rounded-(--radius-large) bg-(--primary) hover:brightness-105 active:scale-[0.99] text-white font-medium text-sm flex items-center gap-2 transition-all shadow-md shadow-(--primary)/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
		>
			{#if isSubmitting}
				<svg class="animate-spin -ml-1 mr-1 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
				</svg>
				<span>正在发布...</span>
			{:else}
				<span>🚀 立即发布说说</span>
			{/if}
		</button>
	</div>
</div>
