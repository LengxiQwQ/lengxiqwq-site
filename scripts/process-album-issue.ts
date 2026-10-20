import fs from "node:fs";
import path from "node:path";
import { pinyin } from "pinyin-pro";
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
			"User-Agent": "Firefly-Album-Bot",
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
		name: fields["相册名称"] || "",
		id: fields["相册英文 ID / 文件夹名（选填）"] || "",
		desc: fields["相册描述"] || "",
		date: fields["拍摄日期（选填，留空默认今天）"] || "",
		location: fields["拍摄地点（选填）"] || "",
		tags: fields["相册标签（选填，逗号分隔）"] || "",
		photos: fields["相册照片"] || "",
	};
}

// 自动生成 slug
function generateSlug(text: string): string {
	const parts: string[] = [];
	let buf = "";
	for (const ch of text) {
		if (/[一-鿿]/.test(ch)) {
			if (buf) {
				parts.push(buf);
				buf = "";
			}
			parts.push(pinyin(ch, { toneType: "none", type: "array" })[0]);
		} else {
			buf += ch;
		}
	}
	if (buf) parts.push(buf);

	return parts
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

// 获取今天日期 YYYY-MM-DD
function getTodayDate(): string {
	const now = new Date();
	const formatter = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const parts = formatter.formatToParts(now).reduce(
		(acc, part) => {
			if (part.type !== "literal") acc[part.type] = part.value;
			return acc;
		},
		{} as Record<string, string>,
	);
	return `${parts.year}-${parts.month}-${parts.day}`;
}

async function downloadAndOptimizePhoto(
	imageUrl: string,
	outputFilePath: string,
): Promise<boolean> {
	try {
		const headers: Record<string, string> = {
			"User-Agent": "Firefly-Album-Bot",
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
			console.warn(`[album] 下载照片失败 (${res.status}): ${imageUrl}`);
			return false;
		}

		const buffer = Buffer.from(await res.arrayBuffer());

		const optimizedBuffer = await sharp(buffer)
			.rotate()
			.resize({
				width: 2400,
				height: 2400,
				fit: "inside",
				withoutEnlargement: true,
			})
			.webp({ quality: 85 })
			.toBuffer();

		fs.writeFileSync(outputFilePath, optimizedBuffer);
		return true;
	} catch (error) {
		console.error(`[album] 优化照片失败 [${imageUrl}]:`, error);
		return false;
	}
}

async function run() {
	// 1. 权限校验
	const repoOwner = githubRepo.split("/")[0] || "LengxiQwQ";
	if (issueUser && issueUser.toLowerCase() !== repoOwner.toLowerCase()) {
		console.warn(`[album] 拦截非博主提交: 用户 ${issueUser} 不是 ${repoOwner}`);
		await postComment(
			`❌ 创建失败：仅仓库所有者 (@${repoOwner}) 有权限创建相册。`,
		);
		await closeIssue();
		return;
	}

	const parsed = parseIssueBody(issueBody);
	if (!parsed.name || !parsed.desc || !parsed.photos) {
		console.warn("[album] 相册名称、描述或照片为空，放弃处理。");
		await postComment("❌ 创建失败：相册名称、描述与照片均不能为空。");
		await closeIssue();
		return;
	}

	const albumId =
		parsed.id.trim() || generateSlug(parsed.name) || `album-${Date.now()}`;
	const albumDate = parsed.date.trim() || getTodayDate();
	const albumLocation = parsed.location.trim();
	const tagsList = parsed.tags
		? parsed.tags
				.split(/[,，]/)
				.map((t) => t.trim())
				.filter(Boolean)
		: ["摄影", "生活记录"];

	// 2. 提取照片链接
	const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
	const imageMatches: Array<{ alt: string; url: string }> = [];
	let match: RegExpExecArray | null;

	while (true) {
		match = imageRegex.exec(parsed.photos);
		if (!match) break;
		imageMatches.push({
			alt: match[1],
			url: match[2],
		});
	}

	if (imageMatches.length === 0) {
		await postComment("❌ 创建失败：未在表单中检测到已上传的照片图片。");
		await closeIssue();
		return;
	}

	const targetAlbumDir = path.join(contentRepoDir, "public/gallery", albumId);
	fs.mkdirSync(targetAlbumDir, { recursive: true });

	let successCount = 0;
	let coverPath = "";

	// 3. 批量下载并优化照片
	for (let i = 0; i < imageMatches.length; i++) {
		const img = imageMatches[i];
		const indexStr = String(i + 1).padStart(2, "0");
		const safeAlt = generateSlug(img.alt) || "photo";
		const outputFileName = `${indexStr}-${safeAlt}.webp`;
		const outputFilePath = path.join(targetAlbumDir, outputFileName);

		console.log(
			`[album] 📥 正在处理第 ${i + 1}/${imageMatches.length} 张照片: ${outputFileName}`,
		);
		const ok = await downloadAndOptimizePhoto(img.url, outputFilePath);
		if (ok) {
			successCount++;
			if (!coverPath) {
				coverPath = `/gallery/${albumId}/${outputFileName}`;
			}
		}
	}

	if (successCount === 0) {
		await postComment(
			"❌ 创建失败：所有照片下载与转码均失败，请检查图片链接。",
		);
		await closeIssue();
		return;
	}

	// 4. 注册相册到 galleryConfig.ts
	const galleryConfigPath = path.join(
		contentRepoDir,
		"config/galleryConfig.ts",
	);
	if (fs.existsSync(galleryConfigPath)) {
		let configContent = fs.readFileSync(galleryConfigPath, "utf-8");
		const newAlbumObj = `\t\t{\n\t\t\tid: "${albumId}",\n\t\t\tname: "${parsed.name.replace(/"/g, '\\"')}",\n\t\t\tdescription:\n\t\t\t\t"${parsed.desc.replace(/"/g, '\\"').replace(/\n/g, " ")}",\n\t\t\tdate: "${albumDate}",\n\t\t\tlocation: "${albumLocation.replace(/"/g, '\\"')}",\n\t\t\ttags: ${JSON.stringify(tagsList)},\n\t\t\tcover: "${coverPath}",\n\t\t},`;

		if (configContent.includes("albums: [")) {
			configContent = configContent.replace(
				"albums: [",
				`albums: [\n${newAlbumObj}`,
			);
			fs.writeFileSync(galleryConfigPath, configContent, "utf-8");
			console.log("[album] ✅ 已将相册注册至 galleryConfig.ts");
		}
	}

	// 5. 回复 Issue 并关闭
	const commentText = [
		"🎉 **相册创建成功！**",
		`- 📷 **相册名称**：${parsed.name}`,
		`- 📁 **相册标识**：\`${albumId}\``,
		`- 📅 **拍摄日期**：${albumDate}`,
		albumLocation ? `- 📍 **拍摄地点**：${albumLocation}` : "",
		`- 🏷️ **相册标签**：${tagsList.join("、")}`,
		`- 🖼️ **成功导入照片**：${successCount} 张（已全量转码为高清 WebP）`,
		`- 🌟 **相册封面**：\`${coverPath}\``,
		"\n系统已自动将相册资源写入内容仓，并触发博客自动编译上线！✨",
	]
		.filter(Boolean)
		.join("\n");

	await postComment(commentText);
	await closeIssue();
}

run().catch(async (err) => {
	console.error("[album] 执行出错:", err);
	await postComment(`❌ 处理相册时出现异常: ${String(err)}`);
	process.exit(1);
});
