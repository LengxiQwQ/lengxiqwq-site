import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const dynamicDir = path.join(rootDir, "src/content/dynamic");

if (!fs.existsSync(dynamicDir)) {
	console.error("Dynamic dir not found:", dynamicDir);
	process.exit(1);
}

const files = fs.readdirSync(dynamicDir).filter((f) => f.endsWith(".md"));
console.log(`Found ${files.length} markdown moments in ${dynamicDir}`);

const moments = [];

for (const file of files) {
	const raw = fs.readFileSync(path.join(dynamicDir, file), "utf8");
	let published = "";
	let pinned = 0;
	let location = null;
	let body = raw;

	if (raw.startsWith("---")) {
		const parts = raw.split("---");
		if (parts.length >= 3) {
			const fm = parts[1];
			body = parts.slice(2).join("---").trim();

			const pubMatch = fm.match(/published:\s*(.+)/);
			if (pubMatch) published = pubMatch[1].trim();

			const pinMatch = fm.match(/pinned:\s*(true|false)/);
			if (pinMatch && pinMatch[1] === "true") pinned = 1;

			const locMatch = fm.match(/location:\s*(.+)/);
			if (locMatch) location = locMatch[1].trim().replace(/^['"]|['"]$/g, "");
		}
	}

	// 提取 Markdown 图片
	const images = [];
	const imgRegex = /!\[.*?\]\((.*?)\)/g;
	let match = imgRegex.exec(body);
	while (match !== null) {
		images.push(match[1]);
		match = imgRegex.exec(body);
	}

	// 清理正文中的图片占位标记
	const cleanBody = body.replace(/!\[.*?\]\(.*?\)/g, "").trim();

	// 计算时间戳
	let timestamp = Date.now();
	if (published) {
		const d = new Date(published);
		if (!Number.isNaN(d.getTime())) timestamp = d.getTime();
	} else {
		const datePart = file.replace(".md", "");
		const d = new Date(datePart.replace(/-/g, "/"));
		if (!Number.isNaN(d.getTime())) timestamp = d.getTime();
	}

	const id = `dyn_${file.replace(".md", "").replace(/[^a-zA-Z0-9]/g, "_")}`;

	moments.push({
		id,
		content: cleanBody || "分享了一张图片",
		images,
		pinned,
		location,
		created_at: timestamp,
		updated_at: timestamp,
	});
}

// 按创建时间倒序排列（置顶优先）
moments.sort((a, b) => {
	if (a.pinned !== b.pinned) return b.pinned - a.pinned;
	return b.created_at - a.created_at;
});

console.log(`Parsed ${moments.length} moments successfully.`);

// 生成 SQL 导入文件
const sqlStatements = [
	"-- 自动从现有 Markdown 动态数据迁移初始内容至 Cloudflare D1 dynamic_moments 表",
	"DELETE FROM dynamic_moments;",
];

for (const m of moments) {
	const escContent = m.content.replace(/'/g, "''");
	const escImages = JSON.stringify(m.images).replace(/'/g, "''");
	const escLocation = m.location ? `'${m.location.replace(/'/g, "''")}'` : "NULL";

	sqlStatements.push(
		`INSERT INTO dynamic_moments (id, content, images, pinned, location, created_at, updated_at) VALUES ('${m.id}', '${escContent}', '${escImages}', ${m.pinned}, ${escLocation}, ${m.created_at}, ${m.updated_at});`,
	);
}

const outPath = path.join(rootDir, "worker/seed-moments.sql");
fs.writeFileSync(outPath, sqlStatements.join("\n"), "utf8");
console.log(`Successfully generated SQL seed file: ${outPath} (${moments.length} rows)`);
