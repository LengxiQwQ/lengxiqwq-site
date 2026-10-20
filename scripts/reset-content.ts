import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDevServerRunning, safeCleanAstroCaches } from "./dev-process-utils";

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
 * 获取主仓库当前被 Git 追踪的所有文件集合（O(1) 批量查询，避免循环创建子进程）
 */
function getTrackedFilesSet(): Set<string> {
	try {
		const out = execSync("git -c core.quotepath=false ls-files", {
			encoding: "utf8",
		});
		return new Set(
			out
				.split(/\r?\n/)
				.map((f) => f.trim())
				.filter(Boolean),
		);
	} catch {
		return new Set();
	}
}

/**
 * 获取主仓库当前相对 HEAD 有修改（未暂存或已暂存）的所有文件集合
 */
function getModifiedFilesSet(): Set<string> {
	try {
		const out = execSync("git -c core.quotepath=false diff --name-only HEAD", {
			encoding: "utf8",
		});
		return new Set(
			out
				.split(/\r?\n/)
				.map((f) => f.trim())
				.filter(Boolean),
		);
	} catch {
		return new Set();
	}
}

/**
 * 将本地工作区的 src/content、src/config、public 恢复为 Git HEAD 中的纯净预设状态，
 * 清理本地开发或构建时从内容仓临时覆盖物化的文件。
 *
 * 🛡️ 智能防丢失与双向救援机制：
 * 1. 新建救援：如果用户误在主仓新建了文件，自动安全备份至内容仓。
 * 2. 改动救援：如果用户误在主仓直接修改了文章或配置，自动将最新修改写回内容仓。
 * 3. 模板隔离：绝对不会将主仓纯净的 Git 模板预设反向污染至内容仓。
 * 4. 运行时保护：开发服务器运行期间，默认跳过重置，防止误杀正在运行的 Vite 缓存与文章内容。
 */
export async function resetContent(silent = false): Promise<void> {
	// CI 环境中容器为一次性环境，无需重置，避免影响 CI 产物上传
	if (process.env.CI) {
		return;
	}

	const isForced =
		process.argv.includes("--force") || process.env.FORCE_RESET === "true";

	// 🛡️ 开发服务器运行态保护
	const devStatus = await isDevServerRunning();
	if (devStatus.running && !isForced) {
		if (!silent) {
			console.warn("");
			console.warn(
				`[content:reset] ⚠️ 检测到 Astro 开发服务器正在运行 (PID: ${devStatus.pid || "未知"}，端口: ${devStatus.port || 4321})。`,
			);
			console.warn(
				"[content:reset] 🛡️ 为保护正在运行的本地开发环境不被破坏，已自动跳过内容重置。",
			);
			console.warn(
				"[content:reset] 💡 提示：如确需强制重置，请先停止开发服务器，或执行: pnpm content:reset --force",
			);
			console.warn("");
		}
		return;
	}

	try {
		const contentRepoDir = path.resolve("../lengxiqwq-site-content");

		// 🛡️ 执行多目录双向安全救援防护
		if (fs.existsSync(contentRepoDir)) {
			const trackedFilesSet = getTrackedFilesSet();
			const modifiedFilesSet = getModifiedFilesSet();

			const rescueTargets = [
				{
					localDir: path.resolve("src/content"),
					targetDir: path.join(contentRepoDir, "content"),
				},
				{
					localDir: path.resolve("src/config"),
					targetDir: path.join(contentRepoDir, "config"),
				},
				{
					localDir: path.resolve("public"),
					targetDir: path.join(contentRepoDir, "public"),
				},
			];

			for (const { localDir, targetDir } of rescueTargets) {
				if (!fs.existsSync(localDir) || !fs.existsSync(targetDir)) continue;

				const localFiles = getFilesRecursive(localDir);
				for (const relFile of localFiles) {
					if (
						relFile.includes(".git") ||
						relFile.endsWith(".DS_Store") ||
						relFile.endsWith("Thumbs.db")
					) {
						continue;
					}

					const localFilePath = path.join(localDir, relFile);
					const targetFilePath = path.join(targetDir, relFile);
					const gitRelPath = path.relative(process.cwd(), localFilePath);
					const normalizedGitRel = gitRelPath.replace(/\\/g, "/");
					const isTracked = trackedFilesSet.has(normalizedGitRel);
					const isClean = !modifiedFilesSet.has(normalizedGitRel);

					// 情况 1: 内容仓中不存在该文件
					if (!fs.existsSync(targetFilePath)) {
						// 若主代码仓 Git 原本就追踪了此模板文件，无需救援
						if (isTracked) {
							continue;
						}
						// 不在模板 git 中，说明是用户在主仓误建的全新文章或资源 -> 执行新建救援
						fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
						fs.copyFileSync(localFilePath, targetFilePath);
						if (!silent) {
							console.log(
								`[content:reset] 🛡️ 触发防丢救援：已自动将误建的新文件备份至内容仓: ${gitRelPath}`,
							);
						}
					} else {
						// 情况 2: 内容仓中存在同名文件
						// 若主仓本地文件与 Git HEAD 完全一致（纯净模板状态），绝不反向覆盖内容仓！
						if (isTracked && isClean) {
							continue;
						}

						// 比较本地修改时间与文件内容
						try {
							const localStat = fs.statSync(localFilePath);
							const targetStat = fs.statSync(targetFilePath);

							// 仅当本地修改时间更新，且内容发生实质变动时，才回写救援
							if (localStat.mtimeMs > targetStat.mtimeMs) {
								const localBuf = fs.readFileSync(localFilePath);
								const targetBuf = fs.readFileSync(targetFilePath);

								if (!localBuf.equals(targetBuf)) {
									fs.copyFileSync(localFilePath, targetFilePath);
									if (!silent) {
										console.log(
											`[content:reset] 🛡️ 触发防丢救援：已自动将主仓最新修改写回内容仓: ${gitRelPath}`,
										);
									}
								}
							}
						} catch {
							// 忽略单个文件状态读取异常
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

		// 3. 安全清理 Astro 与 Vite 本地缓存
		await safeCleanAstroCaches({ silent, force: isForced });

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
	resetContent(false).catch((err) => {
		console.error("[content:reset] 异常:", err);
		process.exit(1);
	});
}
