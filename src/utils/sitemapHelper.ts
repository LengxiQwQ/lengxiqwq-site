import fs from "node:fs";
import path from "node:path";

export interface ContentLastmodResult {
	dates: Map<string, string>;
	latestPostDate?: string;
}

/**
 * 扫描文章与项目文件的前文字符串，提取真实发表或更新时间，
 * 避免在 Sitemap 中将所有未变更页面盲目标记为当天构建时间。
 */
export function getContentLastmodMap(): ContentLastmodResult {
	const dates = new Map<string, string>();
	let latestPostDate: Date | null = null;
	const contentDirs = [
		{ dir: path.resolve("src/content/posts"), prefix: "/posts/" },
		{ dir: path.resolve("src/content/projects"), prefix: "/projects/" },
		{ dir: path.resolve("src/content/dynamic"), prefix: "/dynamic/" },
	];

	function scan(directory: string, prefix: string) {
		if (!fs.existsSync(directory)) return;
		const entries = fs.readdirSync(directory, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				scan(fullPath, prefix);
			} else if (entry.name.endsWith(".md") || entry.name.endsWith(".mdx")) {
				try {
					const content = fs.readFileSync(fullPath, "utf8");
					const pub = content.match(/published:\s*([^\n\r]+)/);
					const upd = content.match(/updated:\s*([^\n\r]+)/);
					const dateStr = (upd ? upd[1] : pub ? pub[1] : "")
						.trim()
						.replace(/^['"]|['"]$/g, "");
					if (dateStr) {
						const date = new Date(dateStr);
						if (!Number.isNaN(date.getTime())) {
							const rel = path
								.relative(directory, fullPath)
								.replace(/\\/g, "/")
								.replace(/\.(md|mdx)$/, "");
							const iso = date.toISOString();
							dates.set(`${prefix}${encodeURI(rel)}/`, iso);
							dates.set(`${prefix}${rel}/`, iso);
							if (!latestPostDate || date > latestPostDate) {
								latestPostDate = date;
							}
						}
					}
				} catch {}
			}
		}
	}

	for (const { dir, prefix } of contentDirs) {
		scan(dir, prefix);
	}

	const isoString = latestPostDate
		? (latestPostDate as Date).toISOString()
		: undefined;
	return { dates, latestPostDate: isoString };
}
