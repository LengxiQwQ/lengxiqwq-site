import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import sharp from "sharp";

const issueBody = process.env.ISSUE_BODY || "";
const issueNumber = process.env.ISSUE_NUMBER || "";
const issueUser = process.env.ISSUE_USER || "";
const githubToken = process.env.GITHUB_TOKEN || "";
const githubRepo = process.env.GITHUB_REPOSITORY || "";

let contentRepoDir = process.env.CONTENT_REPO_DIR || "";
if (!contentRepoDir) {
	if (fs.existsSync(path.resolve(".content-repo"))) {
		contentRepoDir = ".content-repo";
	} else if (fs.existsSync(path.resolve("../lengxiqwq-site-content"))) {
		contentRepoDir = path.resolve("../lengxiqwq-site-content");
	} else {
		contentRepoDir = ".content-repo";
	}
}

// GitHub API 请求辅助
async function githubRequest(
	endpoint: string,
	method = "GET",
	data?: Record<string, unknown>,
) {
	if (!githubToken || !githubRepo) {
		console.log(
			`[mock-github] ${method} ${endpoint}:`,
			JSON.stringify(data || {}),
		);
		return null;
	}

	const url = `https://api.github.com/repos/${githubRepo}${endpoint}`;
	const res = await fetch(url, {
		method,
		headers: {
			Authorization: `Bearer ${githubToken}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "Firefly-Dynamic-Bot",
			"Content-Type": "application/json",
		},
		body: data ? JSON.stringify(data) : undefined,
	});

	if (!res.ok) {
		const text = await res.text();
		console.error(`GitHub API Error (${res.status} ${endpoint}): ${text}`);
	}
	return res;
}

async function postComment(comment: string) {
	if (!issueNumber) return;
	await githubRequest(`/issues/${issueNumber}/comments`, "POST", {
		body: comment,
	});
}

async function closeIssue() {
	if (!issueNumber) return;
	await githubRequest(`/issues/${issueNumber}`, "PATCH", {
		state: "closed",
	});
}

// 解析 Issue 表单
function parseIssueBody(body: string) {
	const fieldRegex = /###\s*([^\r\n]+)\r?\n+([\s\S]*?)(?=(?:\r?\n###\s*|$))/g;
	const fields: Record<string, string> = {};
	let match: RegExpExecArray | null;

	while (true) {
		match = fieldRegex.exec(body);
		if (!match) break;
		const name = match[1].trim();
		const val = match[2].trim();
		fields[name] = val === "_No response_" ? "" : val;
	}

	return {
		content: fields["动态内容"] || "",
		pinned: fields["是否置顶"] === "是",
		location: fields["发布地点（选填）"] || "",
	};
}

// 格式化文件名时间戳
function getTimestampString(date: Date): {
	filenameTime: string;
	isoString: string;
} {
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	});
	const parts = formatter.formatToParts(date).reduce(
		(acc, part) => {
			if (part.type !== "literal") acc[part.type] = part.value;
			return acc;
		},
		{} as Record<string, string>,
	);

	const filenameTime = `${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
	return { filenameTime, isoString: date.toISOString() };
}

// 下载并使用 Sharp 优化图片
async function downloadAndOptimizeImage(
	imageUrl: string,
	outputDir: string,
	baseName: string,
): Promise<string | null> {
	try {
		const headers: Record<string, string> = {
			"User-Agent": "Firefly-Dynamic-Bot",
		};
		if (
			githubToken &&
			(imageUrl.includes("github.com") ||
				imageUrl.includes("githubusercontent.com"))
		) {
			headers.Authorization = `Bearer ${githubToken}`;
		}

		const res = await fetch(imageUrl, { headers });
		if (!res.ok) {
			console.warn(`[dynamic] 下载图片失败 (${res.status}): ${imageUrl}`);
			return null;
		}

		const buffer = Buffer.from(await res.arrayBuffer());
		const webpFileName = `${baseName}.webp`;
		const webpFilePath = path.join(outputDir, webpFileName);

		const optimizedBuffer = await sharp(buffer)
			.rotate()
			.resize({
				width: 1600,
				height: 1600,
				fit: "inside",
				withoutEnlargement: true,
			})
			.webp({ quality: 82 })
			.toBuffer();

		fs.writeFileSync(webpFilePath, optimizedBuffer);
		console.log(`[dynamic] ✅ 图片已优化并保存: ${webpFileName}`);
		return `/assets/images/dynamic/${webpFileName}`;
	} catch (error) {
		console.error(`[dynamic] 优化图片失败 [${imageUrl}]:`, error);
		return null;
	}
}

async function run() {
	// 1. 权限校验：仅允许仓库所有者提交发布
	const repoOwner = githubRepo.split("/")[0] || "LengxiQwQ";
	if (issueUser && issueUser.toLowerCase() !== repoOwner.toLowerCase()) {
		console.warn(
			`[dynamic] 拦截非博主提交: 用户 ${issueUser} 不是 ${repoOwner}`,
		);
		await postComment(
			`❌ 发布失败：仅仓库所有者 (@${repoOwner}) 有权限发布博客动态。`,
		);
		await closeIssue();
		return;
	}

	const parsed = parseIssueBody(issueBody);
	if (!parsed.content) {
		console.warn("[dynamic] 动态内容为空，放弃处理。");
		await postComment("❌ 发布失败：动态内容不能为空。");
		await closeIssue();
		return;
	}

	const targetDynamicDir = path.join(contentRepoDir, "content/dynamic");
	const targetImagesDir = path.join(
		contentRepoDir,
		"public/assets/images/dynamic",
	);
	fs.mkdirSync(targetDynamicDir, { recursive: true });
	fs.mkdirSync(targetImagesDir, { recursive: true });

	const now = new Date();
	const { filenameTime } = getTimestampString(now);

	// 2. 匹配并处理正文中的所有图片
	const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
	let processedContent = parsed.content;
	let match: RegExpExecArray | null;
	const imageMatches: Array<{ fullMatch: string; alt: string; url: string }> =
		[];

	while (true) {
		match = imageRegex.exec(parsed.content);
		if (!match) break;
		imageMatches.push({
			fullMatch: match[0],
			alt: match[1],
			url: match[2],
		});
	}

	let optimizedCount = 0;
	for (let i = 0; i < imageMatches.length; i++) {
		const img = imageMatches[i];
		const imgBaseName = `${filenameTime}_${i + 1}`;
		const localWebPath = await downloadAndOptimizeImage(
			img.url,
			targetImagesDir,
			imgBaseName,
		);

		if (localWebPath) {
			const replacement = `![${img.alt || "image"}](${localWebPath})`;
			processedContent = processedContent.replace(img.fullMatch, replacement);
			optimizedCount++;
		}
	}

	// 3. 构建 Markdown 文件内容与 Frontmatter
	const frontmatter: Record<string, unknown> = {
		published: now,
		pinned: parsed.pinned,
	};
	if (parsed.location) {
		frontmatter.location = parsed.location;
	}

	const fileContent = matter.stringify(
		`\n${processedContent.trim()}\n`,
		frontmatter,
	);
	const targetFileName = `${filenameTime}.md`;
	const targetFilePath = path.join(targetDynamicDir, targetFileName);

	fs.writeFileSync(targetFilePath, fileContent, "utf-8");
	console.log(`[dynamic] ✨ 动态文件已创建: ${targetFileName}`);

	// 4. 回复 Issue 并关闭
	const commentText = [
		"🎉 **动态发布成功！**",
		`- 📄 **文件名称**：\`${targetFileName}\``,
		`- 🖼️ **处理图片**：成功下载并转码优化 ${optimizedCount} 张 WebP 图片`,
		`- 📌 **是否置顶**：${parsed.pinned ? "是" : "否"}`,
		parsed.location ? `- 📍 **发布地点**：${parsed.location}` : "",
		"\n系统已自动将文件写入内容仓，并触发博客自动编译上线！✨",
	]
		.filter(Boolean)
		.join("\n");

	await postComment(commentText);
	await closeIssue();
}

run().catch(async (err) => {
	console.error("[dynamic] 执行出错:", err);
	await postComment(`❌ 处理动态时出现异常: ${String(err)}`);
	process.exit(1);
});
