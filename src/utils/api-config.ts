/**
 * Cloudflare Worker API 统一地址配置助手
 * 负责解析并返回博客系统对接 Worker 微服务的最优 API 基础地址
 */

export function getWorkerApiUrl(): string {
	const envUrl = import.meta.env.PUBLIC_WORKER_API_URL;
	if (typeof envUrl === "string" && envUrl.trim().length > 0) {
		return envUrl.trim().replace(/\/+$/, "");
	}

	// 本地开发环境自动对接本地本地 Wrangler 开发端口
	if (import.meta.env.DEV) {
		return "http://127.0.0.1:8787";
	}

	// 生产环境默认使用独立 API 域名
	return "https://api.lengxiqwq.com";
}
