/**
 * 托管平台与 CDN 边缘网络识别工具
 */

export type DetectHostingPlatformOptions = {
	env?: Record<string, string | undefined>;
	configuredHostingPlatform?: string;
};

const HOSTING_PLATFORM_OVERRIDE_KEY = "FIREFLY_HOSTING_PLATFORM";

/**
 * 构建期获取初始托管平台文本（用于静态 SSR 渲染兜底）
 */
export function getInitialHostingPlatform({
	env = process.env,
	configuredHostingPlatform,
}: DetectHostingPlatformOptions = {}): string {
	const overrideValue = env[HOSTING_PLATFORM_OVERRIDE_KEY];
	if (typeof overrideValue === "string" && overrideValue.trim() !== "") {
		return overrideValue.trim();
	}

	if (
		typeof configuredHostingPlatform === "string" &&
		configuredHostingPlatform.trim() !== ""
	) {
		return configuredHostingPlatform.trim();
	}

	return "Cloudflare Pages";
}

/**
 * 根据 HTTP 响应头和域名识别当前请求命中的托管平台 / CDN
 */
export function identifyHostingPlatformFromHeaders(
	headers: Headers,
	hostname = "",
): string | null {
	// 1. 本地开发环境
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "0.0.0.0" ||
		hostname.endsWith(".local")
	) {
		return "Local Dev";
	}

	const serverHeader = (headers.get("server") || "").toLowerCase();
	const viaHeader = (headers.get("via") || "").toLowerCase();

	// 2. 腾讯云 EdgeOne（优先检测最外层 CDN）
	if (
		headers.has("eo-cache-status") ||
		headers.has("eo-log-uuid") ||
		headers.has("eo-req-id") ||
		headers.has("eo-trace-id") ||
		serverHeader.includes("edgeone") ||
		serverHeader === "eo-cdn"
	) {
		return "EdgeOne";
	}

	// 3. 阿里云 ESA (Edge Security Acceleration)
	if (
		headers.has("esa-request-id") ||
		headers.has("esa-cache-status") ||
		headers.has("ali-swift-log-slice") ||
		serverHeader.includes("esa")
	) {
		return "ESA";
	}

	// 4. Cloudflare
	if (
		headers.has("cf-ray") ||
		headers.has("cf-cache-status") ||
		serverHeader.includes("cloudflare")
	) {
		return "Cloudflare";
	}

	// 5. Vercel
	if (
		headers.has("x-vercel-id") ||
		headers.has("x-vercel-cache") ||
		serverHeader === "vercel"
	) {
		return "Vercel";
	}

	// 6. Netlify
	if (headers.has("x-nf-request-id") || serverHeader === "netlify") {
		return "Netlify";
	}

	// 7. GitHub Pages
	if (headers.has("x-github-request-id") || serverHeader === "github.com") {
		return "GitHub Pages";
	}

	// 8. AWS CloudFront
	if (
		headers.has("x-amz-cf-id") ||
		headers.has("x-amz-cf-pop") ||
		viaHeader.includes("cloudfront")
	) {
		return "AWS CloudFront";
	}

	// 9. Fastly
	if (
		headers.has("fastly-restarts") ||
		headers.has("x-fastly-request-id") ||
		(headers.get("x-served-by") || "").toLowerCase().includes("fastly")
	) {
		return "Fastly";
	}

	// 10. 又拍云 (UPYUN)
	if (headers.has("x-upyun-uuid") || serverHeader.includes("upyun")) {
		return "又拍云";
	}

	return null;
}

let cachedHostingPlatform: string | null = null;
let inFlightPromise: Promise<string | null> | null = null;

/**
 * 客户端运行时通过当前页面 HEAD 请求嗅探所在平台与 CDN
 */
export async function detectHostingPlatformClient(): Promise<string | null> {
	if (typeof window === "undefined") {
		return null;
	}

	if (cachedHostingPlatform) {
		return cachedHostingPlatform;
	}

	if (inFlightPromise) {
		return inFlightPromise;
	}

	const hostname = window.location.hostname;
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "0.0.0.0" ||
		hostname.endsWith(".local")
	) {
		cachedHostingPlatform = "Local Dev";
		return cachedHostingPlatform;
	}

	inFlightPromise = (async () => {
		try {
			// 同源发起 HEAD 请求，仅读取响应头，不耗费页面内容流量
			const response = await fetch(window.location.pathname, {
				method: "HEAD",
				cache: "force-cache",
			});
			const detected = identifyHostingPlatformFromHeaders(
				response.headers,
				hostname,
			);
			if (detected) {
				cachedHostingPlatform = detected;
			}
			return detected;
		} catch {
			return null;
		} finally {
			inFlightPromise = null;
		}
	})();

	return inFlightPromise;
}
