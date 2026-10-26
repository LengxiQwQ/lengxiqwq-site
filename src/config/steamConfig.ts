import type { SteamConfig } from "@/types/steamConfig";

// ============================================================================
// Steam 游戏记录配置（开源模板默认预设）
// ============================================================================
export const steamConfig: SteamConfig = {
	// 你的 17 位数字 SteamID64（例如：76561198...）
	steamId: "",

	// Steam Web API 密钥（建议在私有内容仓或环境变量中配置）
	apiKey: "",

	// 隐藏游玩总时长少于此分钟数的游戏
	hideGamesUnderMinutes: 10,

	// 是否显示顶部玩家数据看板
	showStats: true,

	// 是否在看板中突出展示最近游玩
	showRecent: true,

	// 游戏网格每页展示数量
	pageSize: 60,
};
