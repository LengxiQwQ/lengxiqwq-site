/**
 * Cloudflare Worker API 统一地址配置助手
 * 负责解析并返回博客系统对接 Worker 微服务的最优 API 基础地址
 */

export function getWorkerApiUrl(): string {
	const envUrl = import.meta.env.PUBLIC_WORKER_API_URL;
	if (typeof envUrl === "string" && envUrl.trim().length > 0) {
		return envUrl.trim().replace(/\/+$/, "");
	}

	// 生产与开发环境默认直连已部署上线的 Cloudflare Worker 独立服务
	// 享有全球 CDN 加速与云端 D1 / KV / R2 实时同步，电脑关机后线上与本地均稳定可用
	return "https://lengxiqwq-api.date200325.workers.dev";
}
