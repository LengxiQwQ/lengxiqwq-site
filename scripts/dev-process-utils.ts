import { execSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export interface DevServerLockData {
	pid: number;
	port: number;
	startTime: string;
	cwd: string;
}

export interface DevServerStatus {
	running: boolean;
	pid?: number;
	port?: number;
	startTime?: string;
	reason?: string;
}

const LOCK_FILE = path.resolve(".dev.lock");
const ASTRO_LOCK_FILE = path.resolve(".astro/dev.json");

/**
 * 检查指定操作系统进程是否存活
 */
export function isProcessAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		// EPERM 表示进程存在但当前用户没有信号发送权限，说明进程依然存活
		return (
			typeof err === "object" &&
			err !== null &&
			"code" in err &&
			(err as { code: string }).code === "EPERM"
		);
	}
}

/**
 * 尝试通过 TCP 探测指定端口是否处于监听状态
 */
export function isPortListening(
	port: number,
	host = "127.0.0.1",
	timeoutMs = 300,
): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new net.Socket();
		let hasResolved = false;

		const finish = (result: boolean) => {
			if (!hasResolved) {
				hasResolved = true;
				socket.destroy();
				resolve(result);
			}
		};

		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("timeout", () => finish(false));
		socket.once("error", () => finish(false));

		try {
			socket.connect(port, host);
		} catch {
			finish(false);
		}
	});
}

/**
 * 同时探测 IPv4 (127.0.0.1) 和 IPv6 (::1)
 */
export async function isPortOpenDualStack(
	port: number,
	timeoutMs = 300,
): Promise<boolean> {
	const [v4, v6] = await Promise.all([
		isPortListening(port, "127.0.0.1", timeoutMs),
		isPortListening(port, "::1", timeoutMs),
	]);
	return v4 || v6;
}

/**
 * 在 Windows 平台下尝试根据端口查询占用进程的 PID
 */
function findPidByPortWindows(port: number): number | undefined {
	try {
		const output = execSync(
			`powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`,
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
		).trim();
		const p = Number.parseInt(output, 10);
		return Number.isInteger(p) && p > 0 ? p : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 获取当前记录的开发服务器锁
 */
export function readDevLock(): DevServerLockData | null {
	if (!fs.existsSync(LOCK_FILE)) return null;
	try {
		const raw = fs.readFileSync(LOCK_FILE, "utf8");
		const data = JSON.parse(raw) as DevServerLockData;
		return data;
	} catch {
		return null;
	}
}

/**
 * 写入开发服务器锁文件
 */
export function acquireDevLock(
	port = 4321,
	pid: number = process.pid,
): DevServerLockData {
	const data: DevServerLockData = {
		pid,
		port,
		startTime: new Date().toISOString(),
		cwd: process.cwd(),
	};
	try {
		fs.writeFileSync(LOCK_FILE, JSON.stringify(data, null, 2), "utf8");
	} catch (err) {
		console.warn("[dev:guard] ⚠️ 写入锁文件失败:", err);
	}
	return data;
}

/**
 * 释放开发服务器锁文件
 */
export function releaseDevLock(pid?: number): void {
	if (!fs.existsSync(LOCK_FILE)) return;
	try {
		if (pid) {
			const lock = readDevLock();
			if (lock && lock.pid !== pid) {
				return; // 不是当前进程持有的锁，不予删除
			}
		}
		fs.unlinkSync(LOCK_FILE);
	} catch {
		// 忽略删除异常
	}
}

/**
 * 综合检测是否有 Astro 开发服务器正在运行
 * 检查顺序：
 * 1. 自定义 .dev.lock
 * 2. Astro 原生 .astro/dev.json
 * 3. Dual-stack TCP 网络端口 4321
 */
export async function isDevServerRunning(
	expectedPort = 4321,
): Promise<DevServerStatus> {
	// 1. 优先检查自定义锁文件
	const lock = readDevLock();
	if (lock) {
		const processAlive = isProcessAlive(lock.pid);
		const portActive = await isPortOpenDualStack(
			lock.port || expectedPort,
			200,
		);

		if (processAlive || portActive) {
			return {
				running: true,
				pid: lock.pid,
				port: lock.port || expectedPort,
				startTime: lock.startTime,
				reason: "active_lockfile",
			};
		}

		// 锁文件对应的进程已死亡且端口未被占用，清理残留陈旧锁
		releaseDevLock();
	}

	// 2. 检查 Astro 原生锁文件 .astro/dev.json
	if (fs.existsSync(ASTRO_LOCK_FILE)) {
		try {
			const raw = fs.readFileSync(ASTRO_LOCK_FILE, "utf8");
			const data = JSON.parse(raw);
			if (data && typeof data.pid === "number") {
				const processAlive = isProcessAlive(data.pid);
				const portActive = await isPortOpenDualStack(
					data.port || expectedPort,
					200,
				);
				if (processAlive || portActive) {
					return {
						running: true,
						pid: data.pid,
						port: data.port || expectedPort,
						startTime: data.startedAt,
						reason: "astro_native_lockfile",
					};
				}
			}
		} catch {
			// ignore JSON parse error
		}
	}

	// 3. 网络端口探测（检查常用开发端口 4321）
	const portOpen = await isPortOpenDualStack(expectedPort, 200);
	if (portOpen) {
		const pid =
			process.platform === "win32"
				? findPidByPortWindows(expectedPort)
				: undefined;
		return {
			running: true,
			pid,
			port: expectedPort,
			reason: "port_listening",
		};
	}

	return { running: false };
}

/**
 * 安全清理 Astro / Vite 本地构建缓存
 * 🛡️ 运行时保护：当检测到开发服务器正在运行时，坚决禁止删除 .astro，避免引发 404 与 content-assets.mjs 丢失
 */
export async function safeCleanAstroCaches(options?: {
	silent?: boolean;
	force?: boolean;
}): Promise<boolean> {
	const status = await isDevServerRunning();
	if (status.running && !options?.force) {
		if (!options?.silent) {
			console.log(
				`[dev:guard] 🛡️ 检测到 Astro 开发服务器正在运行 (PID: ${status.pid || "未知"}, 端口: ${status.port})，跳过删除 .astro 缓存以保护模块加载器。`,
			);
		}
		return false;
	}

	// 服务器未运行，执行清理
	for (const cacheDir of [
		".astro",
		"node_modules/.astro",
		"node_modules/.vite",
	]) {
		const resolved = path.resolve(cacheDir);
		if (fs.existsSync(resolved)) {
			try {
				fs.rmSync(resolved, { recursive: true, force: true });
			} catch (err) {
				if (!options?.silent) {
					console.warn(`[dev:guard] ⚠️ 清理缓存目录失败 ${cacheDir}:`, err);
				}
			}
		}
	}
	return true;
}
