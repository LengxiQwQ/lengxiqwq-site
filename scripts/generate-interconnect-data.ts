import fs from "node:fs/promises";
import path from "node:path";
import type { InterconnectSiteConfig } from "../src/types/chatConfig";

const OUTPUT_FILE = path.resolve("src/constants/interconnect-members.json");
const UPSTREAM_RAW_URL =
	"https://raw.githubusercontent.com/Jarvis0227/federated-chat/main/members.json";
const UPSTREAM_API_URL =
	"https://api.github.com/repos/Jarvis0227/federated-chat/contents/members.json";

interface RemoteMember {
	siteName?: string;
	siteDescription?: string;
	siteUrl?: string;
	chatName?: string;
	chatUrl?: string;
	siteIconUrl?: string;
	homeserver?: string;
	color?: string;
	matrixUserId?: string;
	githubUsername?: string;
	matrixAccountType?: string;
	matrixRelayUserId?: string;
}

/**
 * 提取 URL 或主机名中的小写域名（自动去除协议、端口与路径）
 */
function extractCleanHostname(raw?: string): string {
	const trimmed = (raw || "").trim();
	if (!trimmed) return "";
	try {
		const parsed = new URL(
			trimmed.includes("://") ? trimmed : `https://${trimmed}`,
		);
		return parsed.hostname.toLowerCase();
	} catch {
		return trimmed
			.replace(/^https?:\/\//i, "")
			.split(/[/:]/)[0]
			.toLowerCase();
	}
}

/**
 * 基于网站域名识别是否为当前本站（严禁依赖站长名称，以防未来站长昵称变更）
 */
function isSelfSiteByDomain(member: RemoteMember): boolean {
	const checkUrls = [member.siteUrl, member.chatUrl].filter(Boolean);
	for (const rawUrl of checkUrls) {
		const host = extractCleanHostname(rawUrl);
		if (host === "lengxiqwq.com" || host.endsWith(".lengxiqwq.com")) {
			return true;
		}
	}
	if (member.homeserver) {
		const hs = extractCleanHostname(member.homeserver);
		if (hs === "matrix.lengxiqwq.com" || hs.endsWith(".lengxiqwq.com")) {
			return true;
		}
	}
	return false;
}

/**
 * 将上游成员实体转换为博客所用的标准 InterconnectSiteConfig
 */
function mapRemoteMemberToConfig(member: RemoteMember): InterconnectSiteConfig {
	const siteUrl = (member.siteUrl || "").trim();
	const chatUrl = (member.chatUrl || "").trim() || siteUrl;
	const name =
		(member.siteName || "").trim() ||
		(member.chatName || "").trim() ||
		"互联友站";
	const owner =
		(member.siteName || "").trim() ||
		(member.githubUsername || "").trim() ||
		name;
	const badge = (member.chatName || "").trim() || name;
	const avatar = (member.siteIconUrl || "").trim();
	const desc = (member.siteDescription || "").trim();
	const homeserver = (member.homeserver || "").trim();
	const color = (member.color || "").trim();

	const aliasSet = new Set<string>();
	if (member.chatName?.trim()) aliasSet.add(member.chatName.trim());
	if (member.matrixUserId?.trim()) aliasSet.add(member.matrixUserId.trim());
	if (member.matrixRelayUserId?.trim())
		aliasSet.add(member.matrixRelayUserId.trim());
	if (member.githubUsername?.trim()) aliasSet.add(member.githubUsername.trim());

	// 针对已知友站做常见口语化历史别名补充（利于 Matrix 消息精准识别）
	if (siteUrl.includes("rainzt.cn") || homeserver.includes("rainzt.cn")) {
		aliasSet.add("听雨");
		aliasSet.add("听雨茶室");
	}
	if (siteUrl.includes("yybb.us") || homeserver.includes("yybb.us")) {
		aliasSet.add("aiovtue");
		aliasSet.add("雪的茶室");
		aliasSet.add("chat.yybb.us");
	}
	if (siteUrl.includes("somoe.xyz") || homeserver.includes("gbk.ink")) {
		aliasSet.add("gbk.ink");
		aliasSet.add("gbk");
		aliasSet.add("chat.gbk.ink");
	}
	if (siteUrl.includes("9ll.uk") || homeserver.includes("0dm.cn")) {
		aliasSet.add("鹤渊");
		aliasSet.add("9ll.uk");
		aliasSet.add("0dm.cn");
		aliasSet.add("matrix.0dm.cn");
	}
	if (siteUrl.includes("mibase.top") || homeserver.includes("mibase.top")) {
		aliasSet.add("mibase.top");
	}
	if (siteUrl.includes("qingwu.ink")) {
		aliasSet.add("qingwu");
		aliasSet.add("清吾长亭");
	}

	return {
		name,
		owner,
		siteUrl,
		chatUrl,
		homeserver: homeserver || undefined,
		avatar: avatar || undefined,
		desc: desc || undefined,
		badge: badge || undefined,
		color: color || undefined,
		aliases: Array.from(aliasSet),
		isSelf: false,
	};
}

async function fetchFromRaw(): Promise<RemoteMember[]> {
	const res = await fetch(UPSTREAM_RAW_URL, {
		signal: AbortSignal.timeout(6000),
		headers: {
			Accept: "application/json",
			"User-Agent": "lengxiqwq-site-updater",
		},
	});
	if (!res.ok) {
		throw new Error(`Raw URL responded with HTTP ${res.status}`);
	}
	const data = (await res.json()) as RemoteMember[];
	if (!Array.isArray(data)) {
		throw new Error("Raw data is not an array");
	}
	return data;
}

async function fetchFromApi(): Promise<RemoteMember[]> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github.v3+json",
		"User-Agent": "lengxiqwq-site-updater",
	};
	const token = process.env.GITHUB_TOKEN?.trim();
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const res = await fetch(UPSTREAM_API_URL, {
		headers,
		signal: AbortSignal.timeout(6000),
	});
	if (!res.ok) {
		throw new Error(`GitHub API responded with HTTP ${res.status}`);
	}
	const meta = (await res.json()) as { content?: string; encoding?: string };
	if (!meta.content || meta.encoding !== "base64") {
		throw new Error("GitHub API payload format invalid");
	}
	const jsonStr = Buffer.from(meta.content, "base64").toString("utf-8");
	const data = JSON.parse(jsonStr) as RemoteMember[];
	if (!Array.isArray(data)) {
		throw new Error("API data is not an array");
	}
	return data;
}

async function readExistingSnapshot(): Promise<
	InterconnectSiteConfig[] | null
> {
	try {
		const raw = await fs.readFile(OUTPUT_FILE, "utf-8");
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as InterconnectSiteConfig[]) : null;
	} catch {
		return null;
	}
}

async function main() {
	const existingSnapshot = await readExistingSnapshot();
	let remoteList: RemoteMember[] | null = null;

	// 1. 尝试主通道与备用通道拉取
	try {
		remoteList = await fetchFromRaw();
	} catch (rawErr) {
		console.warn(
			"[INTERCONNECT] Raw fetch failed, falling back to GitHub API...",
			rawErr instanceof Error ? rawErr.message : rawErr,
		);
		try {
			remoteList = await fetchFromApi();
		} catch (apiErr) {
			console.warn(
				"[INTERCONNECT] Both raw and API fetches failed.",
				apiErr instanceof Error ? apiErr.message : apiErr,
			);
		}
	}

	// 2. 校验与降级保护
	if (!remoteList || remoteList.length === 0) {
		if (existingSnapshot && existingSnapshot.length > 0) {
			console.warn(
				`[INTERCONNECT] ⚠️ 无法连接到上游仓库，已平滑降级并保留本地现有的 ${existingSnapshot.length} 个互联友站快照。`,
			);
			process.exit(0);
		} else {
			console.warn(
				"[INTERCONNECT] ⚠️ 未能获取到上游列表且本地无快照，将生成空列表兜底。",
			);
			remoteList = [];
		}
	}

	// 3. 严格排除本站域名，其余站点按原顺序映射
	const filteredConfigs: InterconnectSiteConfig[] = remoteList
		.filter((item) => !isSelfSiteByDomain(item))
		.map(mapRemoteMemberToConfig);

	const serialized = `${JSON.stringify(filteredConfigs, null, "\t")}\n`;

	// 4. 检查是否与现有文件一致，避免产生无意义的 Git 扰动
	if (existingSnapshot) {
		const currentSerialized = `${JSON.stringify(existingSnapshot, null, "\t")}\n`;
		if (currentSerialized === serialized) {
			console.log(
				`[INTERCONNECT] ✅ 互联茶室名单无变动（共 ${filteredConfigs.length} 个外部友站），跳过写入。`,
			);
			process.exit(0);
		}
	}

	await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
	await fs.writeFile(OUTPUT_FILE, serialized, "utf-8");
	console.log(
		`[INTERCONNECT] 🎉 成功同步并持久化 ${filteredConfigs.length} 个互联友站快照至: ${OUTPUT_FILE}`,
	);
}

main().catch((err) => {
	console.error("[INTERCONNECT] Unexpected top-level error:", err);
	process.exit(0); // 始终保证不中断构建！
});
