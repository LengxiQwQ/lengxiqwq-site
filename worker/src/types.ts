export interface Bindings {
	DB: D1Database;
	KV: KVNamespace;
	R2: R2Bucket;
	CORS_ORIGIN?: string;
	R2_PUBLIC_DOMAIN?: string;
	MASTER_KEY?: string;
	JWT_SECRET?: string;
	GITHUB_TOKEN?: string;
	GITHUB_CONTENT_REPO?: string;
	GITHUB_MAIN_REPO?: string;
	UMAMI_API_KEY?: string;
	UMAMI_API_ENDPOINT?: string;
	UMAMI_WEBSITE_ID?: string;
	UMAMI_SHARE_TOKEN?: string;
	UMAMI_SHARE_ID?: string;
}

export interface Variables {
	adminUser?: boolean;
}

export interface AppEnv {
	Bindings: Bindings;
	Variables: Variables;
}

/**
 * D1 数据库中 dynamic_moments 表的底层字段定义
 */
export interface DynamicMomentRecord {
	id: string;
	content: string;
	images: string; // JSON string e.g. '["url1", "url2"]'
	pinned: number; // 0 | 1
	location: string | null;
	created_at: number;
	updated_at: number;
}

/**
 * 对外 REST API 输出的标准说说数据结构
 */
export interface DynamicMomentItem {
	id: string;
	content: string;
	images: string[];
	pinned: boolean;
	location: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface PublishMomentPayload {
	content: string;
	images?: string[];
	pinned?: boolean;
	location?: string | null;
}

export interface UpdateMomentPayload {
	content?: string;
	images?: string[];
	pinned?: boolean;
	location?: string | null;
}

/**
 * 友链朋友圈文章数据结构
 */
export interface FcirclePost {
	id: string;
	friendName: string;
	friendAvatar: string;
	friendUrl: string;
	title: string;
	link: string;
	pubDate: string; // ISO 8601 string
	excerpt?: string;
	sourceType?: "self" | "friend" | "subscription";
}

/**
 * 友链朋友圈统计数据结构
 */
export interface FcircleStats {
	friendCount: number;
	activeCount: number;
	todayCount: number;
	updatedAt: number;
	totalFriends?: number;
	activeFriends?: number;
	todayUpdates?: number;
	lastUpdated?: number;
}

/**
 * 友链或订阅抓取源
 */
export interface FeedSource {
	name: string;
	siteUrl: string;
	feedUrl: string;
	avatar: string;
	sourceType?: "self" | "friend" | "subscription";
}

/**
 * GitHub 仓库卡片数据结构
 */
export interface GithubRepoData {
	name: string;
	description: string;
	stars: number;
	stargazers_count: number;
	forks: number;
	language: string | null;
	license: string | null;
	avatarUrl: string;
	owner: {
		avatar_url: string;
	};
	updatedAt: string;
}

/**
 * 实时统计数据结构
 */
export interface StatsRealtimeData {
	activeUsers: number;
	timestamp: number;
	source: "umami" | "simulated";
}

/**
 * 30 天 PV/UV 趋势及汇总
 */
export interface StatsSummaryItem {
	date: string;
	pv: number;
	uv: number;
}

export interface StatsSummaryData {
	totalPv: number;
	totalUv: number;
	totalViews: number;
	uniqueVisitors: number;
	historicalPv?: number;
	historicalUv?: number;
	bounceRate: number; // 百分比, 如 38.5
	avgVisitDuration: number; // 秒数
	chart: StatsSummaryItem[];
	source: "umami" | "simulated";
}

/**
 * 访客画像与热门文章洞察
 */
export interface StatsTopPage {
	path: string;
	title: string;
	views: number;
}

export interface StatsMetricDistribution {
	name: string;
	code?: string;
	visits: number;
	percent: number;
}

export interface StatsInsightsData {
	topPages: StatsTopPage[];
	countries: StatsMetricDistribution[];
	browsers: StatsMetricDistribution[];
	os: StatsMetricDistribution[];
	source: "umami" | "simulated";
}

/**
 * 长文提交到 GitHub 仓库载荷
 */
export interface CommitPostPayload {
	title: string;
	slug: string;
	content: string;
	category?: string;
	tags?: string[];
	cover?: string;
	excerpt?: string;
	draft?: boolean;
	pinned?: boolean;
}

/**
 * 友链管理接口请求载荷
 */
export interface FriendDecisionPayload {
	siteurl: string;
	decision: "whitelisted" | "single" | "quarantined" | "normal";
}

export interface FriendTargetUrlPayload {
	siteurl: string;
	targetUrl: string;
}

export interface FriendProbeSinglePayload {
	siteurl: string;
	targetUrl?: string;
}

export interface AddFriendPayload {
	title: string;
	siteurl: string;
	desc?: string;
	imgurl?: string;
	tags?: string[];
	friendPageUrl?: string;
}
