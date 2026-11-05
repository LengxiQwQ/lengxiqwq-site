import auditDataRaw from "../constants/friends-audit.json";
import healthDataRaw from "../constants/friends-health.json";
import type {
	FriendLink,
	FriendsAuditData,
	FriendsPageConfig,
} from "../types/friendsConfig";

// 友链健康检测状态数据
const healthData = healthDataRaw as Record<
	string,
	{ failCount: number; lastChecked: string; lastError?: string }
>;

// 友链双向性与巡检审查状态数据
const auditData = auditDataRaw as FriendsAuditData;

// 可以在src/content/spec/friends.md中编写友链页面下方的自定义内容

// 友链页面配置
export const friendsPageConfig: FriendsPageConfig = {
	// 页面标题，如果留空则使用 i18n 中的翻译
	title: "",

	// 页面描述文本，如果留空则使用 i18n 中的翻译
	description: "",

	// 是否显示底部自定义内容（friends.mdx 中的内容）
	showCustomContent: true,

	// 是否显示评论区，需要先在commentConfig.ts启用评论系统
	showComment: true,

	// 是否开启随机排序配置，如果开启，就会忽略权重，构建时进行一次随机排序
	randomizeSort: false,
};

// 友链配置（开源仓库默认占位模板预设）
export const friendsConfig: FriendLink[] = [
	{
		title: "夏夜流萤",
		imgurl:
			"https://weavatar.com/avatar/d252655d40d6874417a720bad0a6c5f77f8f6a1fd2f882f8f338402dc37e4190?s=640",
		desc: "飞萤之火自无梦的长夜亮起，绽放在终竟的明天。",
		siteurl: "https://blog.cuteleaf.cn",
		friendPageUrl: "https://blog.cuteleaf.cn/friends/",
		feedUrl: "https://blog.cuteleaf.cn/rss.xml",
		tags: ["Blog"],
		weight: 10, // 权重，数字越大排序越靠前
		enabled: true, // 是否启用
	},
	{
		title: "Firefly Docs",
		imgurl: "https://docs-firefly.cuteleaf.cn/logo.png",
		desc: "Firefly主题模板文档",
		siteurl: "https://docs-firefly.cuteleaf.cn",
		tags: ["Docs"],
		weight: 9,
		enabled: true,
	},
	{
		title: "Astro",
		imgurl: "https://avatars.githubusercontent.com/u/44914786?v=4&s=640",
		desc: "The web framework for content-driven websites. ⭐️ Star to support our work!",
		siteurl: "https://github.com/withastro/astro",
		tags: ["Framework"],
		weight: 8,
		enabled: true,
	},
];

// 获取启用的友链并进行排序（置顶项始终固定在最前，其余项支持随机或权重排序）
export const getEnabledFriends = (): FriendLink[] => {
	const friends = friendsConfig.filter((friend) => friend.enabled);
	const pinned = friends.filter((f) => f.pinned || f.weight >= 99);
	const normal = friends.filter((f) => !f.pinned && f.weight < 99);

	if (friendsPageConfig.randomizeSort) {
		normal.sort(() => Math.random() - 0.5);
	} else {
		normal.sort((a, b) => b.weight - a.weight);
	}

	return [...pinned.sort((a, b) => b.weight - a.weight), ...normal];
};

// 获取单向友链（包含连续 >=3 次未检索到反向链接自动判定的，以及站长确认的单向友链，在页面底部单独展示）
export const getSingleFriends = (): (FriendLink & {
	missingCount?: number;
	lastChecked?: string;
})[] => {
	const friends = friendsConfig.filter(
		(friend) => friend.enabled && !friend.tags?.includes("导航"),
	);
	return friends
		.filter((f) => {
			const audit = auditData[f.siteurl];
			// 白名单永不落入单向隔离区
			if (f.whitelist || audit?.decision === "whitelisted") {
				return false;
			}
			// 失联优先级高于单向，由 getQuarantinedFriends 负责展示
			if (
				audit?.decision === "quarantined" ||
				(audit?.failCount && audit.failCount >= 3) ||
				(healthData[f.siteurl] && healthData[f.siteurl].failCount >= 3)
			) {
				return false;
			}
			// 手动设定为 single 或自动连续未搜到 >= 3 次
			return (
				audit?.decision === "single" ||
				(audit?.missingCount && audit.missingCount >= 3)
			);
		})
		.map((f) => ({
			...f,
			missingCount: auditData[f.siteurl]?.missingCount,
			lastChecked: auditData[f.siteurl]?.lastChecked,
		}))
		.sort((a, b) => b.weight - a.weight);
};

// 获取健康的友链（排除连续未检出/失败 >=3 次的与已裁决为单向/失联的，置顶项始终固定在最前）
export const getHealthyFriends = (): FriendLink[] => {
	const friends = friendsConfig.filter((friend) => friend.enabled);
	const healthy = friends.filter((f) => {
		const audit = auditData[f.siteurl];
		// 白名单直接放行，永不隔离
		if (f.whitelist || audit?.decision === "whitelisted") {
			return true;
		}
		// 手动判定或自动连续 >=3 次未检出（单向友链自动隔离下沉）
		if (
			audit?.decision === "single" ||
			(audit?.missingCount && audit.missingCount >= 3)
		) {
			return false;
		}
		// 手动判定或自动连续 >=3 次 404/故障（失联隔离）
		if (
			audit?.decision === "quarantined" ||
			(audit?.failCount && audit.failCount >= 3) ||
			(healthData[f.siteurl] && healthData[f.siteurl].failCount >= 3)
		) {
			return false;
		}
		return true;
	});

	const pinned = healthy.filter((f) => f.pinned || f.weight >= 99);
	const normal = healthy.filter((f) => !f.pinned && f.weight < 99);

	if (friendsPageConfig.randomizeSort) {
		normal.sort(() => Math.random() - 0.5);
	} else {
		normal.sort((a, b) => b.weight - a.weight);
	}

	return [...pinned.sort((a, b) => b.weight - a.weight), ...normal];
};

// 获取被隔离的友链（连续失败 >=3 次或站长确认为失联）
export const getQuarantinedFriends = (): (FriendLink & {
	failCount: number;
	lastError?: string;
})[] => {
	const friends = friendsConfig.filter((friend) => friend.enabled);
	return friends
		.filter((f) => {
			const audit = auditData[f.siteurl];
			if (audit?.decision === "single") return false;
			if (f.whitelist || audit?.decision === "whitelisted") return false;

			return (
				audit?.decision === "quarantined" ||
				(audit?.failCount && audit.failCount >= 3) ||
				(healthData[f.siteurl] && healthData[f.siteurl].failCount >= 3)
			);
		})
		.map((f) => {
			const audit = auditData[f.siteurl];
			const failCount =
				audit?.decision === "quarantined" ||
				(audit?.failCount && audit.failCount >= 3)
					? audit.failCount || 3
					: healthData[f.siteurl]?.failCount || 3;
			const lastError = audit?.lastMessage || healthData[f.siteurl]?.lastError;

			return {
				...f,
				failCount,
				lastError,
			};
		});
};
