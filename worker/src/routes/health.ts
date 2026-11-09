import { Hono } from "hono";
import type { AppEnv } from "../types";

const health = new Hono<AppEnv>();

/**
 * GET /api/health - 服务健康检查与状态诊断
 */
health.get("/", (c) => {
	return c.json({
		code: 200,
		status: "ok",
		service: "lengxiqwq-api",
		timestamp: Date.now(),
		version: "1.0.0",
		bindings: {
			hasDB: !!c.env.DB,
			hasKV: !!c.env.KV,
			hasR2: !!c.env.R2,
			hasMasterKey: !!c.env.MASTER_KEY,
		},
	});
});

export default health;
