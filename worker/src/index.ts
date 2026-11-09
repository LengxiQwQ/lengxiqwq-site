import { Hono } from "hono";
import { cors } from "hono/cors";
import adminRoutes from "./routes/admin";
import dynamicRoutes from "./routes/dynamic";
import fcircleRoutes, { syncFcircle } from "./routes/fcircle";
import githubRoutes from "./routes/github";
import healthRoutes from "./routes/health";
import statsRoutes from "./routes/stats";
import type { AppEnv, Bindings } from "./types";

const app = new Hono<AppEnv>();

// 1. 全局跨域（CORS）与预检（OPTIONS）支持
app.use("*", async (c, next) => {
	const configuredOrigins = (
		c.env.CORS_ORIGIN || "https://lengxiqwq.com,http://localhost:4321"
	)
		.split(",")
		.map((o) => o.trim())
		.filter(Boolean);

	const corsMiddleware = cors({
		origin: (origin) => {
			// 若无 Origin 标头（如服务端直调或健康探针），默认放行
			if (!origin) return "*";

			// 允许配置的特定域名，或泛域名通配符
			if (
				configuredOrigins.includes("*") ||
				configuredOrigins.includes(origin)
			) {
				return origin;
			}

			// 开发测试与预览环境智能放行 (localhost & 127.0.0.1 任意端口，以及 pages.dev 预览分支)
			if (
				origin.startsWith("http://localhost:") ||
				origin.startsWith("http://127.0.0.1:") ||
				origin.endsWith(".lengxiqwq-site.pages.dev")
			) {
				return origin;
			}

			return null;
		},
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization", "X-Master-Key"],
		exposeHeaders: ["Content-Length"],
		maxAge: 86400,
		credentials: true,
	});

	return corsMiddleware(c, next);
});

// 2. 注册业务路由模块
app.route("/api/health", healthRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/stats", statsRoutes);
app.route("/api/dynamic", dynamicRoutes);
app.route("/api/fcircle", fcircleRoutes);
app.route("/api/github", githubRoutes);

// 3. 根路由欢迎与探测信息
app.get("/", (c) => {
	return c.json({
		code: 200,
		service: "lengxiqwq-api",
		status: "running",
		docs: "https://lengxiqwq.com",
		timestamp: Date.now(),
	});
});

// 4. 全局 404 兜底
app.notFound((c) => {
	return c.json(
		{
			code: 404,
			error: `Not Found: ${c.req.method} ${c.req.path}`,
		},
		404,
	);
});

// 5. 全局未捕获异常处理
app.onError((err, c) => {
	console.error("Unhandled Gateway Exception:", err);
	return c.json(
		{
			code: 500,
			error: err.message || "Internal Server Error",
		},
		500,
	);
});

export default {
	fetch: app.fetch,
	async scheduled(
		_event: ScheduledEvent,
		env: Bindings,
		ctx: ExecutionContext,
	): Promise<void> {
		ctx.waitUntil(syncFcircle(env));
	},
};
