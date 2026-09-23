import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 将本地工作区的 src/content、src/config、public 恢复为 Git HEAD 中的纯净预设状态，
 * 清理本地开发或构建时从内容仓临时覆盖物化的文件。
 */
export function resetContent(silent = false) {
	try {
		// 1. 恢复被 Git 追踪的预设文件版本
		execSync("git checkout HEAD -- src/content src/config public", {
			stdio: "ignore",
		});

		// 2. 清理临时生成的未追踪文件与目录（如用户私有文章、相册等）
		execSync("git clean -fd src/content public", {
			stdio: "ignore",
		});

		// 3. 清理 Astro 本地缓存，避免残留数据
		for (const cacheDir of [".astro", "node_modules/.astro"]) {
			const resolved = path.resolve(cacheDir);
			if (fs.existsSync(resolved)) {
				fs.rmSync(resolved, { recursive: true, force: true });
			}
		}

		if (!silent) {
			console.log(
				"[content:reset] ✅ 已成功清理本地临时同步的内容，恢复为纯净模板预设状态。",
			);
		}
	} catch (err) {
		if (!silent) {
			console.error("[content:reset] ⚠️ 还原预设时出现警告或异常:", err);
		}
	}
}

// 允许直接命令行运行
if (
	import.meta.url.startsWith("file:") &&
	process.argv[1]?.includes("reset-content")
) {
	resetContent(false);
}
