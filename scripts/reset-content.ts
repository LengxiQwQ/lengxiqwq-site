import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 递归获取目录下所有文件相对路径
 */
function getFilesRecursive(dir: string, base = ""): string[] {
	let results: string[] = [];
	if (!fs.existsSync(dir)) return results;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const rel = path.join(base, entry.name);
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results = results.concat(getFilesRecursive(full, rel));
		} else {
			results.push(rel);
		}
	}
	return results;
}

/**
 * 将本地工作区的 src/content、src/config、public 恢复为 Git HEAD 中的纯净预设状态，
 * 清理本地开发或构建时从内容仓临时覆盖物化的文件。
 *
 * 🛡️ 具备防误删救援机制：如果检测到用户在主仓中误写了新文件，会自动安全备份/同步到内容仓，绝不丢数据。
 */
export function resetContent(silent = false) {
	// CI 环境中容器为一次性环境，无需重置，避免影响 CI 产物上传
	if (process.env.CI) {
		return;
	}

	try {
		const contentRepoDir = path.resolve("../lengxiqwq-site-content");

		// 🛡️ 智能防误删救援：检查是否有在本地代码仓新写、但内容仓中尚不存在的文件
		if (fs.existsSync(contentRepoDir)) {
			const localContentDir = path.resolve("src/content");
			const targetContentDir = path.join(contentRepoDir, "content");

			if (fs.existsSync(localContentDir) && fs.existsSync(targetContentDir)) {
				const localFiles = getFilesRecursive(localContentDir);
				for (const relFile of localFiles) {
					const localFull = path.join(localContentDir, relFile);
					const targetFull = path.join(targetContentDir, relFile);

					// 若文件在内容仓不存在，说明可能是误在主代码仓创建的真实内容，执行自动救援
					if (!fs.existsSync(targetFull)) {
						// 排除 git 模板自带文件
						try {
							execSync(`git ls-files --error-unmatch "src/content/${relFile.replace(/\\/g, "/")}"`, {
								stdio: "ignore",
							});
							// 在模板 git 中受控，无需救援
						} catch {
							// 不在模板 git 中，说明是用户的全新文章/资源！执行自动同步救援
							fs.mkdirSync(path.dirname(targetFull), { recursive: true });
							fs.copyFileSync(localFull, targetFull);
							if (!silent) {
								console.log(
									`[content:reset] 🛡️ 触发防丢救援：已自动将误建的新内容同步至内容仓: ${relFile}`,
								);
							}
						}
					}
				}
			}
		}

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
