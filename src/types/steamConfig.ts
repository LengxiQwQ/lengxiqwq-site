// Steam 游戏记录配置与数据类型定义

export interface SteamPlayerSummary {
	steamid: string;
	personaname: string;
	profileurl: string;
	avatar: string;
	avatarmedium: string;
	avatarfull: string;
	avatarhash?: string;
	personastate: number; // 0=离线, 1=在线, 2=忙碌, 3=离开, 4=打瞌睡, 5=想交易, 6=想玩
	gameextrainfo?: string; // 当前正在玩的游戏名称
	gameid?: string;
	communityvisibilitystate?: number;
	lastlogoff?: number;
}

export interface SteamGameItem {
	appid: number;
	name: string;
	playtime_forever: number; // 总时长（分钟）
	playtime_2weeks?: number; // 最近两周时长（分钟）
	img_icon_url?: string;
	rtime_last_played?: number; // 上次游玩时间戳
	// 衍生字段
	playtime_hours: number;
	playtime_2weeks_hours?: number;
	cover_url: string;
	header_url: string;
	store_url: string;
}

export interface SteamStats {
	totalGames: number;
	totalPlaytimeHours: number;
	recentPlaytimeHours: number;
	lastUpdated: string;
}

export interface SteamBadgeItem {
	badgeid: number;
	level: number;
	completion_time: number;
	xp: number;
	scarcity?: number;
	appid?: number;
	communityitemid?: string;
	border_color?: number;
}

export interface SteamLevelInfo {
	player_level: number;
	player_xp: number;
	player_xp_needed_to_level_up: number;
	player_xp_needed_current_level: number;
	badges_count: number;
	progress_percent: number; // 当前等级升级进度百分比 (0-100)
	badges?: SteamBadgeItem[];
}

export interface SteamData {
	profile: SteamPlayerSummary;
	stats: SteamStats;
	levelInfo?: SteamLevelInfo;
	recentGames: SteamGameItem[];
	games: SteamGameItem[];
}

export interface SteamConfig {
	/** 用户的 17 位 SteamID64（如 76561198...） */
	steamId: string;
	/** Steam Web API Key（请在私有内容仓或环境变量中配置，避免提交到公开仓） */
	apiKey?: string;
	/** 隐藏游戏时间少于多少分钟的游戏（避免大量挂卡游戏污染列表，默认 10） */
	hideGamesUnderMinutes?: number;
	/** 是否显示顶部数据看板卡片 */
	showStats?: boolean;
	/** 是否在数据看板展示最近游玩板块 */
	showRecent?: boolean;
	/** 每页展示游戏卡片数量，默认 24 */
	pageSize?: number;
}
