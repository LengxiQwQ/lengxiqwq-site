<script lang="ts">
import { onMount } from "svelte";

interface Props {
	workerApiUrl: string;
	token: string;
	onToast?: (msg: string) => void;
}

const { workerApiUrl, token, onToast }: Props = $props();

let isTriggering = $state(false);
let lastTriggerResult = $state<{
	success: boolean;
	message: string;
	time: string;
} | null>(null);

// 触发 GitHub Actions 友链巡检工作流
async function triggerFriendCheckWorkflow() {
	isTriggering = true;
	try {
		const res = await fetch(`${workerApiUrl}/api/admin/trigger-friend-check`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
		});

		const json = await res.json();
		const now = new Date();
		const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;

		if (res.ok && json.code === 200) {
			lastTriggerResult = {
				success: true,
				message: json.message || "已成功向 GitHub 调度触发全网友链双向巡检！",
				time: timeStr,
			};
			onToast?.("🚀 友链双向巡检工作流已成功触发！");
		} else {
			lastTriggerResult = {
				success: false,
				message: json.error || "触发工作流异常",
				time: timeStr,
			};
			onToast?.(`触发巡检失败: ${json.error || "未知异常"}`);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		lastTriggerResult = {
			success: false,
			message: msg,
			time: new Date().toLocaleTimeString(),
		};
		onToast?.(`网络或服务连接异常: ${msg}`);
	} finally {
		isTriggering = false;
	}
}
</script>

<div class="friends-manager space-y-6">
	<!-- 顶部引导与快捷巡检触发卡片 -->
	<div class="card-base p-5 md:p-6 rounded-(--radius-large) shadow-lg border border-(--line-divider)">
		<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-(--line-divider) mb-5">
			<div class="flex items-center gap-3">
				<div class="w-10 h-10 rounded-2xl bg-(--primary)/15 text-(--primary) flex items-center justify-center text-xl font-bold">
					🤝
				</div>
				<div>
					<h2 class="text-base font-bold text-neutral-800 dark:text-neutral-100 flex items-center gap-2">
						友链健康与双向巡检中枢
						<span class="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium">
							SOP 双向引擎
						</span>
					</h2>
					<p class="text-xs text-(--content-meta) mt-0.5">
						基于单一事实源自动化巡检引擎，支持 WAF 反爬阻断穿透与死链熔断隔离
					</p>
				</div>
			</div>

			<!-- 一键触发全网巡检按钮 -->
			<button
				type="button"
				onclick={triggerFriendCheckWorkflow}
				disabled={isTriggering}
				class="text-xs px-4 py-2 rounded-xl bg-(--primary) text-white font-bold flex items-center gap-2 hover:opacity-90 shadow-md shadow-(--primary)/20 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
			>
				{#if isTriggering}
					<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
						<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
					</svg>
					<span>正在调度 GitHub Actions...</span>
				{:else}
					<span>⚡ 一键触发全网双向巡检</span>
				{/if}
			</button>
		</div>

		<!-- 上次触发状态结果提示 -->
		{#if lastTriggerResult}
			<div class="p-3.5 rounded-xl border mb-5 text-xs flex items-center justify-between gap-3 {lastTriggerResult.success ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-800 dark:text-emerald-200' : 'bg-red-500/10 border-red-500/30 text-red-800 dark:text-red-200'}">
				<div class="flex items-center gap-2">
					<span>{lastTriggerResult.success ? "✅" : "❌"}</span>
					<span>{lastTriggerResult.message}</span>
				</div>
				<span class="font-mono text-[11px] opacity-75 shrink-0">{lastTriggerResult.time}</span>
			</div>
		{/if}

		<!-- 3 个特性核心指标卡片 -->
		<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
			<div class="p-4 rounded-2xl bg-black/3 dark:bg-white/3 border border-(--line-divider)">
				<div class="text-xs text-(--content-meta) mb-1 flex items-center gap-1.5">
					<span>🛡️</span>
					<span>WAF 穿透与指纹伪装</span>
				</div>
				<div class="text-sm font-bold text-neutral-800 dark:text-neutral-100">
					Chrome 131 真实指纹
				</div>
				<p class="text-[11px] text-(--content-meta) mt-1">
					绕过 Cloudflare Turnstile 与五秒盾阻断
				</p>
			</div>

			<div class="p-4 rounded-2xl bg-black/3 dark:bg-white/3 border border-(--line-divider)">
				<div class="text-xs text-(--content-meta) mb-1 flex items-center gap-1.5">
					<span>🔄</span>
					<span>三级双向嗅探链</span>
				</div>
				<div class="text-sm font-bold text-neutral-800 dark:text-neutral-100">
					主页 → /links/ → SPA API
				</div>
				<p class="text-[11px] text-(--content-meta) mt-1">
					深度穿透动态单页与 Hexo/Butterfly/Volantis
				</p>
			</div>

			<div class="p-4 rounded-2xl bg-black/3 dark:bg-white/3 border border-(--line-divider)">
				<div class="text-xs text-(--content-meta) mb-1 flex items-center gap-1.5">
					<span>⚙️</span>
					<span>定时自动守护</span>
				</div>
				<div class="text-sm font-bold text-neutral-800 dark:text-neutral-100">
					每日 12:12 自动巡检
				</div>
				<p class="text-[11px] text-(--content-meta) mt-1">
					避开高峰期，异常站点自动进入隔离区
				</p>
			</div>
		</div>
	</div>

	<!-- 核心快捷导航与操作直达面板 -->
	<div class="grid grid-cols-1 md:grid-cols-2 gap-5">
		<!-- 本地审计审查后台 -->
		<div class="card-base p-5 rounded-(--radius-large) shadow-lg border border-(--line-divider) flex flex-col justify-between">
			<div>
				<div class="flex items-center gap-2.5 mb-2">
					<span class="text-xl">📋</span>
					<h3 class="text-sm font-bold text-neutral-800 dark:text-neutral-100">
						本地友链双向审计看板 (Audit Viewer)
					</h3>
				</div>
				<p class="text-xs text-(--content-meta) leading-relaxed mb-4">
					基于本地 JSON 审计事实源，直观审查全部友链的反向回链状态、存活检测、白名单豁免以及隔离下架建议。
				</p>
			</div>
			<a
				href="/admin/friends-audit/"
				target="_blank"
				rel="noopener noreferrer"
				class="text-xs px-4 py-2 rounded-xl border border-(--line-divider) text-neutral-700 dark:text-neutral-200 hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-between transition-colors"
			>
				<span>打开双向审计管理界面</span>
				<span class="text-sm">↗</span>
			</a>
		</div>

		<!-- GitHub Actions 运行记录直达 -->
		<div class="card-base p-5 rounded-(--radius-large) shadow-lg border border-(--line-divider) flex flex-col justify-between">
			<div>
				<div class="flex items-center gap-2.5 mb-2">
					<span class="text-xl">🐙</span>
					<h3 class="text-sm font-bold text-neutral-800 dark:text-neutral-100">
						GitHub Actions 自动化流水线
					</h3>
				</div>
				<p class="text-xs text-(--content-meta) leading-relaxed mb-4">
					查看云端 <code>check-friends.yml</code> 工作流的实时运行状态、并发抓取日志，以及自动提交至内容仓的 Commit 变更。
				</p>
			</div>
			<a
				href="https://github.com/LengxiQwQ/lengxiqwq-site/actions/workflows/check-friends.yml"
				target="_blank"
				rel="noopener noreferrer"
				class="text-xs px-4 py-2 rounded-xl border border-(--line-divider) text-neutral-700 dark:text-neutral-200 hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-between transition-colors"
			>
				<span>查看 GitHub 运行日志</span>
				<span class="text-sm">↗</span>
			</a>
		</div>
	</div>
</div>
