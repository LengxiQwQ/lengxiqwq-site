import fs from "node:fs";
import path from "node:path";
import { isDevServerRunning, safeCleanAstroCaches } from "./dev-process-utils";

async function main() {
	const isPreDev =
		process.argv.includes("--for-dev") ||
		process.env.npm_lifecycle_event === "predev" ||
		process.env.npm_lifecycle_event === "prestart";

	// 🛡️ 运行时多实例互斥检测：若执行 pnpm dev / pnpm start 时已存在运行中的服务，拒绝重复启动
	if (isPreDev) {
		const devStatus = await isDevServerRunning();
		if (devStatus.running) {
			console.error("");
			console.error(
				"================================================================================",
			);
			console.error("[dev:guard] 🛑 检测到已有 Astro 开发服务器正在运行！");
			if (devStatus.pid) {
				console.error(`  - 运行进程 PID: ${devStatus.pid}`);
			}
			console.error(`  - 监听端口: ${devStatus.port || 4321}`);
			if (devStatus.startTime) {
				console.error(`  - 启动时间: ${devStatus.startTime}`);
			}
			console.error("");
			console.error(
				"  为防止多实例并发冲突导致 Vite 模块缓存损坏与热重载死锁，本次启动已被阻止。",
			);
			console.error(
				`  💡 提示：您可直接在浏览器中访问 http://localhost:${devStatus.port || 4321}`,
			);
			console.error(
				"      如需重新启动，请先在原终端中按 Ctrl+C 关闭已有服务，再执行 pnpm dev。",
			);
			console.error(
				"================================================================================",
			);
			console.error("");
			process.exit(1);
		}
	}

	let contentDir = process.env.CONTENT_DIR;

	// 本地开发友好支持：如果未指定 CONTENT_DIR，自动检测上级目录是否存在内容仓
	if (!contentDir) {
		const localSiblingContent = path.resolve("../lengxiqwq-site-content");
		if (fs.existsSync(localSiblingContent)) {
			contentDir = localSiblingContent;
			console.log(
				`[content:sync] Automatically detected local content repo at: ${contentDir}`,
			);
		} else {
			console.log(
				"[content:sync] CONTENT_DIR not set and ../lengxiqwq-site-content not found. Using upstream default content.",
			);
			process.exit(0);
		}
	}

	const resolvedContentDir = path.resolve(contentDir);
	if (!fs.existsSync(resolvedContentDir)) {
		console.error(
			`[content:sync] Error: CONTENT_DIR does not exist: ${resolvedContentDir}`,
		);
		process.exit(1);
	}

	console.log(`[content:sync] Syncing content from: ${resolvedContentDir}`);

	// Top-level mappings from content repository to Firefly site structure:
	// CONTENT_DIR/content -> src/content
	// CONTENT_DIR/config  -> src/config
	// CONTENT_DIR/public  -> public

	const mappings = [
		{
			src: path.join(resolvedContentDir, "content"),
			dest: path.resolve("src/content"),
			cleanSubdirs: true,
			cleanableDirs: new Set(["projects", "posts", "dynamic", "spec"]),
		},
		{
			src: path.join(resolvedContentDir, "config"),
			dest: path.resolve("src/config"),
		},
		{
			src: path.join(resolvedContentDir, "public"),
			dest: path.resolve("public"),
			cleanSubdirs: true,
			cleanableDirs: new Set(["gallery", "wallpapers"]),
			cleanSubpaths: [path.join("assets", "music")],
		},
	];

	let syncedCount = 0;

	for (const {
		src,
		dest,
		cleanSubdirs,
		cleanableDirs,
		cleanSubpaths,
	} of mappings) {
		if (fs.existsSync(src)) {
			if (cleanSubdirs && cleanableDirs) {
				// For collections / directories where user items completely replace demo items
				const entries = fs.readdirSync(src, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory() && cleanableDirs.has(entry.name)) {
						const targetDir = path.join(dest, entry.name);
						if (fs.existsSync(targetDir)) {
							console.log(
								`[content:sync] Cleaning preset directory: ${targetDir}`,
							);
							fs.rmSync(targetDir, { recursive: true, force: true });
						}
					}
				}
			}
			if (cleanSubpaths) {
				for (const subpath of cleanSubpaths) {
					const srcSub = path.join(src, subpath);
					const destSub = path.join(dest, subpath);
					if (fs.existsSync(srcSub) && fs.existsSync(destSub)) {
						console.log(`[content:sync] Cleaning preset subpath: ${destSub}`);
						fs.rmSync(destSub, { recursive: true, force: true });
					}
				}
			}
			console.log(`[content:sync] Materializing ${src} -> ${dest}`);
			try {
				fs.cpSync(src, dest, {
					recursive: true,
					force: true,
					filter: (sourcePath, destPath) => {
						try {
							if (
								fs.existsSync(destPath) &&
								fs.statSync(destPath).isFile() &&
								fs.statSync(sourcePath).isFile()
							) {
								const s = fs.statSync(sourcePath);
								const d = fs.statSync(destPath);
								if (
									s.size === d.size &&
									Math.abs(s.mtimeMs - d.mtimeMs) < 1000
								) {
									return false; // 文件未变更跳过，杜绝 Windows 下 1224 锁文件占用报错
								}
							}
						} catch {}
						return true;
					},
				});
			} catch (e: any) {
				if (e?.errno === 1224) {
					console.warn(
						"[content:sync] Warning: Some files are locked by Windows system cache (1224), continuing...",
					);
				} else {
					throw e;
				}
			}
			syncedCount++;
		}
	}

	// 🛡️ 安全清理 Astro 与 Vite 本地内容与模块缓存
	// 若服务处于运行中（如用户在开发时手动执行 content:sync），严禁删除 .astro，避免引发 404 与 content-assets.mjs 丢失
	await safeCleanAstroCaches();

	console.log(
		`[content:sync] Content sync complete. Materialized ${syncedCount} directory tree(s).`,
	);
}

main().catch((err) => {
	console.error("[content:sync] 异常:", err);
	process.exit(1);
});
