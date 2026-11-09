import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import type { AppEnv } from "../types";

/**
 * 管理员鉴权守卫中间件
 * 支持通过以下两种方式完成身份校验：
 * 1. Authorization: Bearer <JWT_TOKEN>（由 /api/admin/login 签发）
 * 2. Authorization: Bearer <MASTER_KEY> 或 X-Master-Key: <MASTER_KEY>（方便命令行/管理员直连）
 */
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
	const authHeader = c.req.header("Authorization");
	const customKeyHeader = c.req.header("X-Master-Key");
	const masterKey = c.env.MASTER_KEY;
	const jwtSecret = c.env.JWT_SECRET || masterKey || "lengxiqwq-default-secret";

	let token: string | undefined;

	if (authHeader?.startsWith("Bearer ")) {
		token = authHeader.slice(7).trim();
	} else if (customKeyHeader) {
		token = customKeyHeader.trim();
	}

	if (!token) {
		return c.json(
			{
				code: 401,
				error: "Unauthorized: Missing authorization token or Master Key",
			},
			401,
		);
	}

	// 1. 直通校验 Master Key
	if (masterKey && token === masterKey) {
		c.set("adminUser", true);
		return await next();
	}

	// 2. 校验 JWT Token
	try {
		const payload = (await verify(token, jwtSecret, "HS256")) as {
			sub?: string;
			role?: string;
			exp?: number;
		};
		if (payload && payload.role === "admin") {
			c.set("adminUser", true);
			return await next();
		}
	} catch (_err) {
		// JWT 签名失效或过期
	}

	return c.json(
		{
			code: 401,
			error: "Unauthorized: Invalid or expired token",
		},
		401,
	);
});
