<script lang="ts">
interface Props {
	workerApiUrl: string;
	onLoginSuccess: (token: string, expiresAt: number) => void;
}

const { workerApiUrl, onLoginSuccess }: Props = $props();

let masterKey = $state("");
let showPassword = $state(false);
let isSubmitting = $state(false);
let errorMessage = $state("");

async function handleSubmit(event: SubmitEvent) {
	event.preventDefault();
	if (!masterKey.trim()) {
		errorMessage = "请输入站长暗号 (Master Key)";
		return;
	}

	errorMessage = "";
	isSubmitting = true;

	try {
		const targetUrl = `${workerApiUrl}/api/admin/login`;
		const response = await fetch(targetUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				masterKey: masterKey.trim(),
			}),
		});

		const result = await response.json().catch(() => ({}));

		if (!response.ok || result.code !== 200) {
			errorMessage =
				result?.error || result?.message || "暗号验证失败或服务不可用";
			return;
		}

		const token = result.data?.token;
		const expiresAt = result.data?.expiresAt || Date.now() + 7 * 86400 * 1000;

		if (!token) {
			errorMessage = "服务器返回的数据异常：缺少有效 Token";
			return;
		}

		// 持久化到 localStorage（支持关闭浏览器或新开标签页后依然保持已登录状态）
		try {
			localStorage.setItem("admin_token", token);
			localStorage.setItem("admin_token_expires_at", String(expiresAt));
			sessionStorage.setItem("admin_token", token);
			sessionStorage.setItem("admin_token_expires_at", String(expiresAt));
		} catch (e) {
			console.warn("Storage write failed", e);
		}

		onLoginSuccess(token, expiresAt);
	} catch (err: unknown) {
		console.error("Login request failed", err);
		errorMessage =
			"无法连接到 Worker 认证服务，请检查网络或确认 Worker 服务是否启动";
	} finally {
		isSubmitting = false;
	}
}
</script>

<div class="card-base p-6 md:p-10 max-w-lg mx-auto shadow-2xl backdrop-blur-xl border border-(--line-divider) relative overflow-hidden my-8">
	<!-- 顶部装饰光斑 -->
	<div class="absolute -top-16 -right-16 w-36 h-36 bg-(--primary) opacity-20 rounded-full blur-2xl pointer-events-none"></div>
	<div class="absolute -bottom-16 -left-16 w-36 h-36 bg-purple-500 opacity-15 rounded-full blur-2xl pointer-events-none"></div>

	<div class="text-center mb-8 relative">
		<div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-(--primary)/10 text-(--primary) mb-4 ring-8 ring-(--primary)/5">
			<svg class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
			</svg>
		</div>
		<h2 class="text-2xl font-bold tracking-tight text-neutral-800 dark:text-neutral-100">
			博客管理中枢
		</h2>
		<p class="text-sm text-(--content-meta) mt-1.5">
			请输入站长 Master Key 暗号以解锁专属控制面板
		</p>
	</div>

	<form onsubmit={handleSubmit} class="space-y-5 relative">
		<div>
			<label for="master-key-input" class="block text-xs font-semibold uppercase tracking-wider text-(--content-meta) mb-2">
				Master Key / 站长暗号
			</label>
			<div class="relative">
				<input
					id="master-key-input"
					type={showPassword ? "text" : "password"}
					bind:value={masterKey}
					placeholder="••••••••••••••••"
					autocomplete="current-password"
					required
					disabled={isSubmitting}
					class="w-full px-4 py-3 pr-12 rounded-(--radius-large) bg-black/5 dark:bg-white/5 border border-(--line-divider) text-neutral-800 dark:text-neutral-100 placeholder-neutral-400 focus:outline-none focus:border-(--primary) focus:ring-2 focus:ring-(--primary)/20 transition-all font-mono text-sm"
				/>
				<button
					type="button"
					onclick={() => showPassword = !showPassword}
					class="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-neutral-400 hover:text-(--primary) transition-colors rounded-lg"
					aria-label={showPassword ? "隐藏暗号" : "显示暗号"}
				>
					{#if showPassword}
						<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18" />
						</svg>
					{:else}
						<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
						</svg>
					{/if}
				</button>
			</div>
		</div>

		{#if errorMessage}
			<div class="p-3.5 rounded-(--radius-large) bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs flex items-center gap-2">
				<svg class="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
				</svg>
				<span>{errorMessage}</span>
			</div>
		{/if}

		<button
			type="submit"
			disabled={isSubmitting}
			class="w-full py-3.5 px-6 rounded-(--radius-large) bg-(--primary) hover:brightness-105 active:scale-[0.99] text-white font-medium flex items-center justify-center gap-2 transition-all shadow-md shadow-(--primary)/25 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
		>
			{#if isSubmitting}
				<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
					<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
					<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
				</svg>
				<span>正在核验暗号...</span>
			{:else}
				<span>🚀 进入控制台</span>
			{/if}
		</button>

		<div class="text-center pt-2 flex flex-col items-center gap-2">
			<a href="/" class="text-xs text-(--primary) hover:underline flex items-center gap-1">
				<span>← 返回博客首页</span>
			</a>
			<span class="text-xs text-(--content-meta) opacity-70">
				基于 Cloudflare Worker JWT 鉴权 · 登录后自动保持长期登录态
			</span>
		</div>
	</form>
</div>
