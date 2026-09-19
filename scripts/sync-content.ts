import fs from "node:fs";
import path from "node:path";

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
	},
	{
		src: path.join(resolvedContentDir, "config"),
		dest: path.resolve("src/config"),
	},
	{
		src: path.join(resolvedContentDir, "public"),
		dest: path.resolve("public"),
	},
];

let syncedCount = 0;

for (const { src, dest } of mappings) {
	if (fs.existsSync(src)) {
		console.log(`[content:sync] Materializing ${src} -> ${dest}`);
		fs.cpSync(src, dest, { recursive: true, force: true });
		syncedCount++;
	}
}

console.log(
	`[content:sync] Content sync complete. Materialized ${syncedCount} directory tree(s).`,
);
