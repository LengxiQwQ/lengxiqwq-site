import { Hono } from "hono";
import { sign } from "hono/jwt";
import type { AppEnv } from "../types";

const auth = new Hono<AppEnv>();

interface LoginRequestBody {
	masterKey?: string;
	password?: string;
	key?: string;
}

/**
 * POST /api/admin/login - 管理员暗号登录
 * 请求体: { masterKey: string }
 * 返回: { code: 200, data: { token: string, expiresIn: number, expiresAt: number } }
 */
auth.post("/login", async (c) => {
	const body: LoginRequestBody = await c.req
		.json<LoginRequestBody>()
		.catch(() => ({}) as LoginRequestBody);
	const candidateKey = body.masterKey || body.password || body.key;

	const masterKey = c.env.MASTER_KEY;

	if (!masterKey) {
		return c.json(
			{
				code: 500,
				error:
					"Server misconfiguration: MASTER_KEY is not configured in worker environment",
			},
			500,
		);
	}

	if (!candidateKey || candidateKey !== masterKey) {
		return c.json(
			{
				code: 401,
				error: "Authentication failed: Invalid Master Key",
			},
			401,
		);
	}

	const jwtSecret = c.env.JWT_SECRET || masterKey;
	const expiresInSeconds = 7 * 24 * 60 * 60; // 7 天有效期
	const currentTimestamp = Math.floor(Date.now() / 1000);
	const expiresAt = currentTimestamp + expiresInSeconds;

	const payload = {
		sub: "admin",
		role: "admin",
		iat: currentTimestamp,
		exp: expiresAt,
	};

	const token = await sign(payload, jwtSecret);

	return c.json({
		code: 200,
		message: "Login successful",
		data: {
			token,
			expiresIn: expiresInSeconds,
			expiresAt: expiresAt * 1000,
		},
	});
});

export default auth;
