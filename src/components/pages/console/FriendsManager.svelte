<script lang="ts">
import { onMount } from "svelte";

interface Props {
	workerApiUrl: string;
	token: string;
	onToast?: (msg: string) => void;
}

const { workerApiUrl, token, onToast }: Props = $props();

export interface FriendAuditItem {
	title: string;
	desc: string;
	siteurl: string;
	imgurl: string;
	tags: string[];
	whitelist: boolean;
	targetUrl: string;
	audit: {
		missingCount?: number;
		failCount?: number;
		protectedCount?: number;
		lastChecked?: string;
		lastStatus?: string;
		lastMessage?: string;
		targetUrl?: string;
		decision?: string;
		decisionTime?: string;
		cleanMessage?: string;
	};
	category: "normal" | "single" | "quarantined" | "whitelisted";
}

export interface Summary {
	total: number;
	normal: number;
	single: number;
	quarantined: number;
	whitelisted: number;
	latestCheckedTimestamp: number;
	latestCheckedText: string;
}

type TabType = "all" | "normal" | "single" | "quarantined" | "whitelisted";

let items = $state<FriendAuditItem[]>([]);
let summary = $state<Summary>({
	total: 0,
	normal: 0,
	single: 0,
	quarantined: 0,
	whitelisted: 0,
	latestCheckedTimestamp: 0,
	latestCheckedText: "",
});

let currentTab = $state<TabType>("all");
let searchQuery = $state("");
let isLoading = $state(true);
let isTriggeringFullCheck = $state(false);

// 记录各个卡片的异步操作状态
let probingMap = $state<Record<string, boolean>>({});
let actionLoadingMap = $state<Record<string, boolean>>({});

// “修改友链地址” 弹窗状态
let editingFriend = $state<FriendAuditItem | null>(null);
let editTargetUrlInput = $state("");
let isSavingTargetUrl = $state(false);

// Svelte 动作指令：将弹窗直接传送至 document.body，彻底杜绝外层祖先元素 CSS transform/filter 导致的视口偏移
function portal(node: HTMLElement) {
	document.body.appendChild(node);
	return {
		destroy() {
			if (node.parentNode) {
				node.parentNode.removeChild(node);
			}
		},
	};
}

// “添加新友链” 弹窗状态
let isAddModalOpen = $state(false);
let isSubmittingAdd = $state(false);

// 弹窗打开时锁定页面背景滚动，关闭时自动恢复
$effect(() => {
	const shouldLock = isAddModalOpen || editingFriend !== null;
	if (typeof document !== "undefined") {
		if (shouldLock) {
			const originalOverflow = document.body.style.overflow;
			document.body.style.overflow = "hidden";
			return () => {
				document.body.style.overflow = originalOverflow;
			};
		}
	}
});
let newFriendForm = $state({
	title: "",
	siteurl: "",
	desc: "",
	imgurl: "",
	tagsStr: "博客",
	friendPageUrl: "",
});
let rawPasteText = $state("");

// 运行时环境判断：是否为本地开发环境
const isDev = $derived(
	typeof window !== "undefined" &&
		(window.location.hostname === "localhost" ||
			window.location.hostname === "127.0.0.1"),
);

// 计算过滤后的列表
const filteredItems = $derived(
	items.filter((item) => {
		const q = searchQuery.toLowerCase().trim();
		const matchQuery =
			!q ||
			item.title.toLowerCase().includes(q) ||
			item.siteurl.toLowerCase().includes(q) ||
			(item.desc && item.desc.toLowerCase().includes(q));

		let matchTab = true;
		if (currentTab !== "all") {
			matchTab = item.category === currentTab;
		}

		return matchQuery && matchTab;
	}),
);

// 重新汇总各项数量
function recalculateSummary() {
	const total = items.length;
	const whitelisted = items.filter((i) => i.category === "whitelisted").length;
	const quarantined = items.filter((i) => i.category === "quarantined").length;
	const single = items.filter((i) => i.category === "single").length;
	const normal = items.filter((i) => i.category === "normal").length;

	summary = {
		...summary,
		total,
		whitelisted,
		quarantined,
		single,
		normal,
	};
}

// 加载友链与巡检审查全部数据
async function loadFriendsData() {
	isLoading = true;
	try {
		// 优先从站点自带的静态/动态 API 读取
		const res = await fetch(`/api/friendsAudit.json?_t=${Date.now()}`);
		if (res.ok) {
			const json = await res.json();
			if (json.code === 200 && Array.isArray(json.items)) {
				items = json.items;
				if (json.summary) {
					summary = json.summary;
				} else {
					recalculateSummary();
				}
				return;
			}
		}

		// 降级尝试从 Cloudflare Worker 后端读取
		const workerRes = await fetch(`${workerApiUrl}/api/admin/friends`, {
			headers: {
				Authorization: `Bearer ${token}`,
			},
		});
		if (workerRes.ok) {
			const json = await workerRes.json();
			if (json.code === 200 && Array.isArray(json.items)) {
				items = json.items;
				if (json.summary) {
					summary = json.summary;
				} else {
					recalculateSummary();
				}
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn("加载友链审查数据失败:", msg);
		onToast?.(`加载友链数据失败: ${msg}`);
	} finally {
		isLoading = false;
	}
}

// 现场单站重测
async function handleProbeSingle(item: FriendAuditItem) {
	if (probingMap[item.siteurl]) return;
	probingMap[item.siteurl] = true;

	try {
		if (isDev) {
			// 本地开发模式走 Vite 中间件直接调用 CLI
			const res = await fetch("/api/friends-audit/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "probe-single",
					siteurl: item.siteurl,
					targetUrl: item.targetUrl,
				}),
			});
			const json = await res.json();
			if (res.ok && json.record) {
				updateItemAuditRecord(item.siteurl, json.record);
				onToast?.(`《${item.title}》重测完成`);
			} else {
				onToast?.(`重测失败: ${json.error || "未知错误"}`);
			}
		} else {
			// 线上生产模式走 Worker 边缘探测
			const res = await fetch(
				`${workerApiUrl}/api/admin/friends/probe-single`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
					body: JSON.stringify({
						siteurl: item.siteurl,
						targetUrl: item.targetUrl,
					}),
				},
			);
			const json = await res.json();
			if (res.ok && json.code === 200 && json.data?.record) {
				updateItemAuditRecord(item.siteurl, json.data.record);
				onToast?.(json.message || `《${item.title}》重测完成`);
			} else {
				onToast?.(`重测失败: ${json.error || "接口异常"}`);
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		onToast?.(`探测请求异常: ${msg}`);
	} finally {
		probingMap[item.siteurl] = false;
	}
}

// 人工裁决（设白名单/设为单向/设为失效/恢复自动）
async function handleDecision(
	item: FriendAuditItem,
	decision: "whitelisted" | "single" | "quarantined" | "normal",
) {
	if (actionLoadingMap[item.siteurl]) return;
	actionLoadingMap[item.siteurl] = true;

	try {
		if (isDev) {
			const res = await fetch("/api/friends-audit/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					siteurl: item.siteurl,
					decision,
				}),
			});
			const json = await res.json();
			if (res.ok && json.record) {
				updateItemAuditRecord(item.siteurl, json.record);
				onToast?.(`已更新: ${getDecisionLabel(decision)}`);
			} else {
				onToast?.(`更新失败: ${json.error || "未知异常"}`);
			}
		} else {
			const res = await fetch(`${workerApiUrl}/api/admin/friends/decision`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					siteurl: item.siteurl,
					decision,
				}),
			});
			const json = await res.json();
			if (res.ok && json.code === 200 && json.data?.record) {
				updateItemAuditRecord(item.siteurl, json.data.record);
				onToast?.(`已更新: ${getDecisionLabel(decision)}`);
			} else {
				onToast?.(`更新失败: ${json.error || "接口异常"}`);
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		onToast?.(`请求异常: ${msg}`);
	} finally {
		actionLoadingMap[item.siteurl] = false;
	}
}

// 更新本地条目的审计记录并更新分类状态
function updateItemAuditRecord(
	siteurl: string,
	record: Record<string, unknown>,
) {
	const target = items.find((i) => i.siteurl === siteurl);
	if (!target) return;

	target.audit = {
		...target.audit,
		...record,
	};

	const decision = (target.audit.decision || "normal") as string;
	const isWhitelisted = decision === "whitelisted" || target.whitelist;
	const isQuarantined =
		!isWhitelisted &&
		(decision === "quarantined" || (target.audit.failCount || 0) >= 3);
	const isSingle =
		!isWhitelisted &&
		!isQuarantined &&
		(decision === "single" || (target.audit.missingCount || 0) >= 3);

	target.category = isWhitelisted
		? "whitelisted"
		: isQuarantined
			? "quarantined"
			: isSingle
				? "single"
				: "normal";

	recalculateSummary();
}

function getDecisionLabel(d: string): string {
	switch (d) {
		case "whitelisted":
			return "白名单";
		case "single":
			return "设为单向";
		case "quarantined":
			return "设为失效";
		default:
			return "恢复自动";
	}
}

// 打开修改友链地址弹窗
function openEditTargetModal(item: FriendAuditItem) {
	editingFriend = item;
	editTargetUrlInput = item.targetUrl || item.siteurl;
}

// 保存友链页面地址
async function handleSaveTargetUrl() {
	if (!editingFriend || !editTargetUrlInput.trim()) return;
	const targetFriend = editingFriend;
	const newUrl = editTargetUrlInput.trim();
	isSavingTargetUrl = true;

	try {
		if (isDev) {
			const res = await fetch("/api/friends-audit/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "save-target-url",
					siteurl: targetFriend.siteurl,
					targetUrl: newUrl,
				}),
			});
			if (res.ok) {
				targetFriend.targetUrl = newUrl;
				targetFriend.audit.targetUrl = newUrl;
				onToast?.("已保存友链页面地址，正在重测...");
				editingFriend = null;
				handleProbeSingle(targetFriend);
			} else {
				onToast?.("保存友链地址失败");
			}
		} else {
			const res = await fetch(`${workerApiUrl}/api/admin/friends/target-url`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					siteurl: targetFriend.siteurl,
					targetUrl: newUrl,
				}),
			});
			const json = await res.json();
			if (res.ok && json.code === 200) {
				targetFriend.targetUrl = newUrl;
				targetFriend.audit.targetUrl = newUrl;
				onToast?.("已保存友链页面地址，正在重测...");
				editingFriend = null;
				handleProbeSingle(targetFriend);
			} else {
				onToast?.(`保存失败: ${json.error || "未知异常"}`);
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		onToast?.(`网络异常: ${msg}`);
	} finally {
		isSavingTargetUrl = false;
	}
}

// 检查全部友链
async function handleTriggerFullCheck() {
	if (isTriggeringFullCheck) return;
	isTriggeringFullCheck = true;

	try {
		if (isDev) {
			onToast?.("正在检查友链...");
			const res = await fetch("/api/friends-audit/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "run-full-check" }),
			});
			const json = await res.json();
			if (res.ok) {
				onToast?.("友链检查完成");
				await loadFriendsData();
			} else {
				onToast?.(`检查失败: ${json.error || "未知错误"}`);
			}
		} else {
			onToast?.("正在触发检查任务...");
			const res = await fetch(
				`${workerApiUrl}/api/admin/trigger-friend-check`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
					},
				},
			);
			const json = await res.json();
			if (res.ok && json.code === 200) {
				onToast?.("检查任务已触发");
			} else {
				onToast?.(`触发任务失败: ${json.error || "未知错误"}`);
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		onToast?.(`请求失败: ${msg}`);
	} finally {
		isTriggeringFullCheck = false;
	}
}

// 快速解析粘贴的整段友链文案
function handleParsePasteText() {
	if (!rawPasteText.trim()) return;
	const lines = rawPasteText
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);

	for (const line of lines) {
		const match = line.match(/^([^:：]+)[:：]\s*(.*)$/);
		if (match) {
			const key = match[1].trim();
			const val = match[2].trim();
			if (/名称|标题|name|title/i.test(key)) newFriendForm.title = val;
			else if (/链接|网址|地址|url|site/i.test(key))
				newFriendForm.siteurl = val;
			else if (/头像|avatar|img|icon/i.test(key)) newFriendForm.imgurl = val;
			else if (/描述|介绍|简介|desc|bio/i.test(key)) newFriendForm.desc = val;
			else if (/分类|标签|tag/i.test(key)) newFriendForm.tagsStr = val;
			else if (/友链页|check|target/i.test(key))
				newFriendForm.friendPageUrl = val;
		}
	}
	onToast?.("已识别并填入表单");
}

// 提交新增友链
async function handleAddFriendSubmit() {
	const title = newFriendForm.title.trim();
	const siteurl = newFriendForm.siteurl.trim();

	if (!title) {
		onToast?.("请填写友链名称");
		return;
	}
	if (!siteurl) {
		onToast?.("请填写站点链接");
		return;
	}

	const tags = newFriendForm.tagsStr
		.split(/[,，\s]+/)
		.map((t) => t.trim())
		.filter(Boolean);

	isSubmittingAdd = true;

	try {
		if (isDev) {
			const res = await fetch("/api/friends-audit/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "add-friend",
					title,
					siteurl,
					desc: newFriendForm.desc.trim(),
					imgurl: newFriendForm.imgurl.trim(),
					tags,
					friendPageUrl: newFriendForm.friendPageUrl.trim(),
				}),
			});
			const json = await res.json();
			if (res.ok) {
				onToast?.(`友链《${title}》已添加`);
				isAddModalOpen = false;
				resetAddFriendForm();
				await loadFriendsData();
			} else {
				onToast?.(`添加失败: ${json.error || "未知异常"}`);
			}
		} else {
			const res = await fetch(`${workerApiUrl}/api/admin/friends/add`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					title,
					siteurl,
					desc: newFriendForm.desc.trim(),
					imgurl: newFriendForm.imgurl.trim(),
					tags,
					friendPageUrl: newFriendForm.friendPageUrl.trim(),
				}),
			});
			const json = await res.json();
			if (res.ok && json.code === 200) {
				onToast?.(`友链《${title}》已添加`);
				isAddModalOpen = false;
				resetAddFriendForm();
				await loadFriendsData();
			} else {
				onToast?.(`添加失败: ${json.error || "接口异常"}`);
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		onToast?.(`提交异常: ${msg}`);
	} finally {
		isSubmittingAdd = false;
	}
}

function resetAddFriendForm() {
	newFriendForm = {
		title: "",
		siteurl: "",
		desc: "",
		imgurl: "",
		tagsStr: "博客",
		friendPageUrl: "",
	};
	rawPasteText = "";
}

onMount(() => {
	loadFriendsData();
});
</script>

<div class="friends-manager card-base p-5 md:p-6 space-y-5">
	<!-- 顶部标题与快捷操作区 -->
	<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-(--line-divider)">
		<div class="flex items-center gap-3">
			<div class="w-9 h-9 rounded-xl bg-(--primary)/15 text-(--primary) flex items-center justify-center font-bold shrink-0">
				<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
				</svg>
			</div>
			<div>
				<h2 class="text-base font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
					友链管理
					{#if summary.latestCheckedText}
						<span class="text-xs font-normal text-(--content-meta)">
							(最近检查: {summary.latestCheckedText})
						</span>
					{/if}
				</h2>
				<p class="text-xs text-(--content-meta)">
					检查友链连通性与反向链接，支持单站重测与白名单设置
				</p>
			</div>
		</div>

		<!-- 顶栏快捷操作按钮组 -->
		<div class="flex items-center gap-2 shrink-0">
			<!-- 添加友链按钮 -->
			<button
				type="button"
				onclick={() => (isAddModalOpen = true)}
				class="text-xs px-3.5 py-2 rounded-xl bg-(--primary) text-white font-medium flex items-center gap-1.5 hover:opacity-90 shadow-sm transition-all cursor-pointer"
			>
				<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
				</svg>
				<span>添加友链</span>
			</button>

			<!-- 触发检查友链按钮 -->
			<button
				type="button"
				onclick={handleTriggerFullCheck}
				disabled={isTriggeringFullCheck}
				class="text-xs px-3.5 py-2 rounded-xl bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-neutral-700 dark:text-neutral-200 border border-(--line-divider) font-medium flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
			>
				{#if isTriggeringFullCheck}
					<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
					</svg>
					<span>正在检查...</span>
				{:else}
					<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
					</svg>
					<span>检查友链</span>
				{/if}
			</button>
		</div>
	</div>

	<!-- 状态统计筛选与紧凑搜索栏（同排展示） -->
	<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
		<!-- 5 个状态筛选按钮（紧凑横排） -->
		<div class="flex items-center gap-1.5 flex-wrap sm:flex-nowrap">
			<!-- 全部 -->
			<button
				type="button"
				onclick={() => (currentTab = "all")}
				class="py-1.5 px-3 rounded-xl text-xs transition-all cursor-pointer flex items-center gap-1.5 border {currentTab === 'all' ? 'bg-(--primary) text-white border-(--primary) font-bold shadow-sm' : 'bg-black/4 dark:bg-white/4 border-(--line-divider) text-neutral-700 dark:text-neutral-300 hover:bg-black/8 dark:hover:bg-white/8'}"
			>
				<span>全部</span>
				<span class="font-bold">{summary.total}</span>
			</button>

			<!-- 正常 -->
			<button
				type="button"
				onclick={() => (currentTab = "normal")}
				class="py-1.5 px-3 rounded-xl text-xs transition-all cursor-pointer flex items-center gap-1.5 border {currentTab === 'normal' ? 'bg-emerald-600 text-white border-emerald-600 font-bold shadow-sm' : 'bg-emerald-500/10 border-emerald-500/25 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15'}"
			>
				<span class="w-1.5 h-1.5 rounded-full {currentTab === 'normal' ? 'bg-white' : 'bg-emerald-500'} shrink-0"></span>
				<span>正常</span>
				<span class="font-bold">{summary.normal}</span>
			</button>

			<!-- 单向 -->
			<button
				type="button"
				onclick={() => (currentTab = "single")}
				class="py-1.5 px-3 rounded-xl text-xs transition-all cursor-pointer flex items-center gap-1.5 border {currentTab === 'single' ? 'bg-orange-600 text-white border-orange-600 font-bold shadow-sm' : 'bg-orange-500/10 border-orange-500/25 text-orange-700 dark:text-orange-300 hover:bg-orange-500/15'}"
			>
				<span class="w-1.5 h-1.5 rounded-full {currentTab === 'single' ? 'bg-white' : 'bg-orange-500'} shrink-0"></span>
				<span>单向</span>
				<span class="font-bold">{summary.single}</span>
			</button>

			<!-- 失效 -->
			<button
				type="button"
				onclick={() => (currentTab = "quarantined")}
				class="py-1.5 px-3 rounded-xl text-xs transition-all cursor-pointer flex items-center gap-1.5 border {currentTab === 'quarantined' ? 'bg-rose-600 text-white border-rose-600 font-bold shadow-sm' : 'bg-rose-500/10 border-rose-500/25 text-rose-700 dark:text-rose-300 hover:bg-rose-500/15'}"
			>
				<span class="w-1.5 h-1.5 rounded-full {currentTab === 'quarantined' ? 'bg-white' : 'bg-rose-500'} shrink-0"></span>
				<span>失效</span>
				<span class="font-bold">{summary.quarantined}</span>
			</button>

			<!-- 白名单 -->
			<button
				type="button"
				onclick={() => (currentTab = "whitelisted")}
				class="py-1.5 px-3 rounded-xl text-xs transition-all cursor-pointer flex items-center gap-1.5 border {currentTab === 'whitelisted' ? 'bg-blue-600 text-white border-blue-600 font-bold shadow-sm' : 'bg-blue-500/10 border-blue-500/25 text-blue-700 dark:text-blue-300 hover:bg-blue-500/15'}"
			>
				<span class="w-1.5 h-1.5 rounded-full {currentTab === 'whitelisted' ? 'bg-white' : 'bg-blue-500'} shrink-0"></span>
				<span>白名单</span>
				<span class="font-bold">{summary.whitelisted}</span>
			</button>
		</div>

		<!-- 右侧：紧凑搜索框 -->
		<div class="relative w-full sm:w-56 md:w-64 shrink-0">
			<input
				type="text"
				bind:value={searchQuery}
				placeholder="搜索友链..."
				class="w-full px-3 py-1.5 pl-8 rounded-xl text-xs bg-black/5 dark:bg-white/5 text-neutral-800 dark:text-neutral-200 border border-(--line-divider) focus:border-(--primary) outline-none transition-all"
			/>
			<svg class="w-3.5 h-3.5 absolute left-2.5 top-2 text-(--content-meta)" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
			</svg>
			{#if searchQuery}
				<button
					type="button"
					onclick={() => (searchQuery = "")}
					class="absolute right-2.5 top-1.5 text-xs text-(--content-meta) hover:text-neutral-800 dark:hover:text-neutral-100 cursor-pointer"
				>
					✕
				</button>
			{/if}
		</div>
	</div>

		<!-- 友链列表区 -->
		{#if isLoading}
			<div class="py-12 text-center text-xs text-(--content-meta) flex items-center justify-center gap-2">
				<svg class="w-4 h-4 animate-spin text-(--primary)" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
				</svg>
				<span>正在加载友链列表...</span>
			</div>
		{:else if filteredItems.length === 0}
			<div class="py-12 text-center text-xs text-(--content-meta)">
				没有找到匹配的友情链接
			</div>
		{:else}
			<div class="space-y-3 pt-1">
				{#each filteredItems as item (item.siteurl)}
					{@const isWhitelisted = item.category === "whitelisted"}
					{@const isQuarantined = item.category === "quarantined"}
					{@const isSingle = item.category === "single"}
					{@const isNormal = item.category === "normal"}
					{@const isProbing = probingMap[item.siteurl]}
					{@const isActionLoading = actionLoadingMap[item.siteurl]}

					<div
						class="p-4 rounded-xl border transition-all flex flex-col md:flex-row md:items-center justify-between gap-4 {isWhitelisted ? 'border-blue-500/30 bg-blue-500/5' : isSingle ? 'border-orange-500/30 bg-orange-500/5' : isQuarantined ? 'border-rose-500/30 bg-rose-500/5 opacity-85' : 'border-(--line-divider) hover:border-black/15 dark:hover:border-white/15'}"
					>
						<!-- 左侧基本信息与状态指标 -->
						<div class="flex items-start gap-3.5 min-w-0 flex-1">
							<!-- 头像与容灾 -->
							<img
								src={item.imgurl}
								alt={item.title}
								onerror={(e) => {
									(e.currentTarget as HTMLImageElement).src =
										"https://weavatar.com/avatar/default?s=120";
								}}
								class="w-11 h-11 rounded-xl object-cover shrink-0 bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10"
								loading="lazy"
							/>

							<div class="min-w-0 space-y-1 flex-1">
								<div class="flex items-center gap-2 flex-wrap">
									<span class="font-bold text-sm text-neutral-800 dark:text-neutral-100 truncate">
										{item.title}
									</span>

									<!-- 状态徽章 -->
									{#if isWhitelisted}
										<span class="text-[10px] px-2 py-0.5 rounded-md bg-blue-500/15 text-blue-600 dark:text-blue-400 font-medium">
											白名单
										</span>
									{:else if isQuarantined}
										<span class="text-[10px] px-2 py-0.5 rounded-md bg-rose-500/15 text-rose-600 dark:text-rose-400 font-medium">
											失效
										</span>
									{:else if isSingle}
										<span class="text-[10px] px-2 py-0.5 rounded-md bg-orange-500/15 text-orange-600 dark:text-orange-400 font-medium">
											单向
										</span>
									{:else if isNormal}
										<span class="text-[10px] px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium">
											正常
										</span>
									{/if}

									<!-- 分类标签 -->
									{#each item.tags as tag}
										<span class="text-[10px] px-1.5 py-0.2 rounded bg-black/5 dark:bg-white/5 text-(--content-meta)">
											#{tag}
										</span>
									{/each}
								</div>

								<!-- 站点链接与友链页面地址 -->
								<div class="text-xs text-(--content-meta) flex flex-wrap items-center gap-x-3 gap-y-1">
									<a
										href={item.siteurl}
										target="_blank"
										rel="noopener noreferrer"
										class="hover:underline text-(--primary) flex items-center gap-1 truncate max-w-xs"
									>
										<svg class="w-3 h-3 text-(--content-meta) shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
										</svg>
										<span>{item.siteurl}</span>
									</a>

									{#if item.targetUrl && item.targetUrl !== item.siteurl}
										<div class="flex items-center gap-1.5">
											<a
												href={item.targetUrl}
												target="_blank"
												rel="noopener noreferrer"
												class="hover:underline text-emerald-600 dark:text-emerald-400 flex items-center gap-1 truncate max-w-xs"
												title="已指定友链页面地址"
											>
												<svg class="w-3 h-3 text-emerald-600 dark:text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
													<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
												</svg>
												<span>友链页: {item.targetUrl}</span>
											</a>
											<button
												type="button"
												onclick={() => openEditTargetModal(item)}
												class="text-[11px] text-(--content-meta) hover:text-(--primary) underline cursor-pointer"
											>
												修改
											</button>
										</div>
									{:else}
										<button
											type="button"
											onclick={() => openEditTargetModal(item)}
											class="text-xs text-(--content-meta) hover:text-(--primary) underline flex items-center gap-1 cursor-pointer"
										>
											<span>指定友链页</span>
										</button>
									{/if}
								</div>

								<!-- 诊断记录 -->
								<div class="text-[11px] text-(--content-meta) flex flex-wrap items-center gap-x-2">
									{#if item.audit.cleanMessage || item.audit.lastMessage}
										<span>最近记录: {item.audit.cleanMessage || item.audit.lastMessage}</span>
									{:else}
										<span>暂无检查记录</span>
									{/if}

									{#if (item.audit.missingCount || 0) > 0}
										<span class="text-orange-500 font-medium">· 未检测到友链: {item.audit.missingCount}/3 次</span>
									{/if}
									{#if (item.audit.failCount || 0) > 0}
										<span class="text-rose-500 font-medium">· 访问失败: {item.audit.failCount}/3 次</span>
									{/if}
									{#if (item.audit.protectedCount || 0) > 0}
										<span class="text-blue-500 font-medium">· 访问受限: {item.audit.protectedCount}/3 次</span>
									{/if}
								</div>

								<!-- 遇访问受限提示 -->
								{#if !isWhitelisted && (item.audit.lastStatus === "protected" || (item.audit.protectedCount || 0) >= 3)}
									<div class="text-[11px] text-blue-600 dark:text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-md mt-0.5 inline-flex items-center gap-1">
										<span>存在访问限制，可手动打开查看</span>
									</div>
								{/if}
							</div>
						</div>

						<!-- 右侧操作按钮组 -->
						<div class="shrink-0 grid grid-cols-3 gap-1.5 self-start md:self-center">
							<!-- 打开（新标签页访问） -->
							<a
								href={item.targetUrl || item.siteurl}
								target="_blank"
								rel="noopener noreferrer"
								class="px-2.5 py-1 text-xs rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-neutral-700 dark:text-neutral-300 transition-colors inline-flex items-center justify-center gap-1 whitespace-nowrap"
								title="新标签页打开友链页面"
							>
								<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
								</svg>
								<span>打开</span>
							</a>

							<!-- 重测 -->
							<button
								type="button"
								onclick={() => handleProbeSingle(item)}
								disabled={isProbing}
								class="px-2.5 py-1 text-xs rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-neutral-700 dark:text-neutral-300 transition-colors inline-flex items-center justify-center gap-1 cursor-pointer whitespace-nowrap disabled:opacity-50"
								title="重新测试该站点的连通性与反向链接"
							>
								{#if isProbing}
									<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
										<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
										<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
									</svg>
									<span>检测中</span>
								{:else}
									<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
									</svg>
									<span>重测</span>
								{/if}
							</button>

							<!-- 恢复自动 -->
							<button
								type="button"
								onclick={() => handleDecision(item, "normal")}
								disabled={isActionLoading}
								class="px-2.5 py-1 text-xs rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-neutral-700 dark:text-neutral-300 transition-colors cursor-pointer text-center whitespace-nowrap disabled:opacity-50"
								title="恢复自动检测"
							>
								恢复自动
							</button>

							<!-- 白名单切换 -->
							{#if isWhitelisted}
								<button
									type="button"
									onclick={() => handleDecision(item, "normal")}
									disabled={isActionLoading}
									class="px-2 py-1 text-xs rounded-lg font-medium bg-blue-600 text-white hover:bg-blue-700 cursor-pointer text-center whitespace-nowrap disabled:opacity-50"
									title="移出白名单"
								>
									移出白名单
								</button>
							{:else}
								<button
									type="button"
									onclick={() => handleDecision(item, "whitelisted")}
									disabled={isActionLoading}
									class="px-2 py-1 text-xs rounded-lg font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 hover:bg-blue-500/25 cursor-pointer text-center whitespace-nowrap disabled:opacity-50"
									title="设为白名单"
								>
									设为白名单
								</button>
							{/if}

							<!-- 设为单向 -->
							<button
								type="button"
								onclick={() => handleDecision(item, "single")}
								disabled={isActionLoading}
								class="px-2 py-1 text-xs rounded-lg font-medium cursor-pointer text-center whitespace-nowrap disabled:opacity-50 {isSingle && item.audit.decision === 'single' ? 'bg-orange-500 text-white' : 'bg-orange-500/15 text-orange-600 dark:text-orange-400 hover:bg-orange-500/25'}"
								title="手动设为单向"
							>
								设为单向
							</button>

							<!-- 设为失效 -->
							<button
								type="button"
								onclick={() => handleDecision(item, "quarantined")}
								disabled={isActionLoading}
								class="px-2 py-1 text-xs rounded-lg font-medium cursor-pointer text-center whitespace-nowrap disabled:opacity-50 {isQuarantined && item.audit.decision === 'quarantined' ? 'bg-rose-500 text-white' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25'}"
								title="手动设为失效"
							>
								设为失效
							</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
</div>

<!-- 修改友链页面地址弹窗 -->
{#if editingFriend}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		use:portal
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) editingFriend = null;
		}}
		class="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto overscroll-contain"
	>
		<div class="card-base w-full max-w-md p-5 rounded-2xl shadow-2xl border border-(--line-divider) space-y-4 my-auto">
			<div class="flex items-center justify-between">
				<h3 class="text-sm font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
					<svg class="w-4 h-4 text-(--primary)" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
					</svg>
					<span>修改友链页面地址</span>
				</h3>
				<button
					type="button"
					onclick={() => (editingFriend = null)}
					class="text-(--content-meta) hover:text-neutral-800 dark:hover:text-neutral-100 text-sm cursor-pointer"
				>
					✕
				</button>
			</div>

			<p class="text-xs text-(--content-meta)">
				若 <strong>{editingFriend.title}</strong> 的友链不在主页（如在 /friends 等独立页面），请在此填写友链页面的具体网址：
			</p>

			<input
				type="url"
				bind:value={editTargetUrlInput}
				placeholder="https://example.com/friends"
				class="w-full px-3 py-2 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-(--line-divider) focus:border-(--primary) outline-none text-neutral-800 dark:text-neutral-100 font-mono"
			/>

			<div class="flex items-center justify-end gap-2 pt-2">
				<button
					type="button"
					onclick={() => (editingFriend = null)}
					class="px-3.5 py-1.5 rounded-xl text-xs text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5"
				>
					取消
				</button>
				<button
					type="button"
					onclick={handleSaveTargetUrl}
					disabled={isSavingTargetUrl}
					class="px-4 py-1.5 rounded-xl text-xs font-bold bg-(--primary) text-white shadow-sm hover:opacity-90 disabled:opacity-50 cursor-pointer"
				>
					{isSavingTargetUrl ? "保存中..." : "保存并重测"}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- 添加新友链弹窗 -->
{#if isAddModalOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div
		use:portal
		role="dialog"
		aria-modal="true"
		tabindex="-1"
		onclick={(e) => {
			if (e.target === e.currentTarget) isAddModalOpen = false;
		}}
		class="fixed inset-0 z-[9999] bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto overscroll-contain"
	>
		<div class="card-base w-full max-w-lg p-5 md:p-6 rounded-2xl shadow-2xl border border-(--line-divider) space-y-4 my-auto max-h-[92vh] overflow-y-auto">
			<div class="flex items-center justify-between pb-3 border-b border-(--line-divider)">
				<h3 class="text-base font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
					<svg class="w-4 h-4 text-(--primary)" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
					</svg>
					<span>添加友链</span>
				</h3>
				<button
					type="button"
					onclick={() => (isAddModalOpen = false)}
					class="text-(--content-meta) hover:text-neutral-800 dark:hover:text-neutral-100 text-sm cursor-pointer"
				>
					✕
				</button>
			</div>

			<!-- 快捷粘贴文本识别卡片 -->
			<div class="p-3 rounded-xl bg-black/3 dark:bg-white/3 border border-(--line-divider) space-y-2">
				<div class="text-[11px] text-(--content-meta) flex items-center justify-between">
					<span>支持粘贴整段友链信息自动识别：</span>
					{#if rawPasteText.trim()}
						<button
							type="button"
							onclick={handleParsePasteText}
							class="text-[11px] text-(--primary) hover:underline font-bold cursor-pointer"
						>
							立即识别
						</button>
					{/if}
				</div>
				<textarea
					bind:value={rawPasteText}
					placeholder="例如粘贴：&#10;名称：夏夜流萤&#10;链接：https://blog.cuteleaf.cn&#10;描述：飞萤之火自无梦的长夜亮起...&#10;头像：https://example.com/avatar.png"
					rows="3"
					class="w-full p-2.5 rounded-lg text-xs bg-black/4 dark:bg-white/4 border border-(--line-divider) text-neutral-800 dark:text-neutral-200 outline-none focus:border-(--primary) font-mono"
				></textarea>
			</div>

			<!-- 细分表单字段 -->
			<div class="space-y-3">
				<div>
					<label class="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
						站点名称 (Title) <span class="text-red-500">*</span>
					</label>
					<input
						type="text"
						bind:value={newFriendForm.title}
						placeholder="例如：夏夜流萤"
						class="w-full px-3 py-2 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-(--line-divider) text-neutral-800 dark:text-neutral-200 outline-none focus:border-(--primary)"
					/>
				</div>

				<div>
					<label class="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
						站点链接 (Site URL) <span class="text-red-500">*</span>
					</label>
					<input
						type="url"
						bind:value={newFriendForm.siteurl}
						placeholder="例如：https://blog.cuteleaf.cn"
						class="w-full px-3 py-2 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-(--line-divider) text-neutral-800 dark:text-neutral-200 outline-none focus:border-(--primary) font-mono"
					/>
				</div>

				<div>
					<label class="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
						头像链接 (Avatar URL)
					</label>
					<input
						type="url"
						bind:value={newFriendForm.imgurl}
						placeholder="例如：https://blog.cuteleaf.cn/avatar.jpg"
						class="w-full px-3 py-2 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-(--line-divider) text-neutral-800 dark:text-neutral-200 outline-none focus:border-(--primary) font-mono"
					/>
				</div>

				<div>
					<label class="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
						站点描述 (Description)
					</label>
					<input
						type="text"
						bind:value={newFriendForm.desc}
						placeholder="一句话介绍"
						class="w-full px-3 py-2 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-(--line-divider) text-neutral-800 dark:text-neutral-200 outline-none focus:border-(--primary)"
					/>
				</div>

				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<div>
						<label class="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
							分类标签 (默认“博客”)
						</label>
						<input
							type="text"
							bind:value={newFriendForm.tagsStr}
							placeholder="博客"
							class="w-full px-3 py-2 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-(--line-divider) text-neutral-800 dark:text-neutral-200 outline-none focus:border-(--primary)"
						/>
					</div>

					<div>
						<label class="block text-xs font-semibold text-neutral-700 dark:text-neutral-300 mb-1">
							专属友链页 (选填)
						</label>
						<input
							type="url"
							bind:value={newFriendForm.friendPageUrl}
							placeholder="若友链在独立单页请填写"
							class="w-full px-3 py-2 rounded-xl text-xs bg-black/5 dark:bg-white/5 border border-(--line-divider) text-neutral-800 dark:text-neutral-200 outline-none focus:border-(--primary) font-mono"
						/>
					</div>
				</div>
			</div>

			<!-- 弹窗底部操作区 -->
			<div class="flex items-center justify-end gap-2.5 pt-3 border-t border-(--line-divider)">
				<button
					type="button"
					onclick={() => (isAddModalOpen = false)}
					class="px-4 py-2 rounded-xl text-xs text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/5"
				>
					取消
				</button>
				<button
					type="button"
					onclick={handleAddFriendSubmit}
					disabled={isSubmittingAdd}
					class="px-5 py-2 rounded-xl text-xs font-bold bg-(--primary) text-white shadow-md hover:opacity-90 disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
				>
					{#if isSubmittingAdd}
						<svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
						</svg>
						<span>正在提交...</span>
					{:else}
						<span>确认添加</span>
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}
