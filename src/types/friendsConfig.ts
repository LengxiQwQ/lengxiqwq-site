// 友链配置
export type FriendLink = {
	title: string; // 友链标题
	imgurl: string; // 头像图片URL
	desc: string; // 友链描述
	siteurl: string; // 友链地址
	feedUrl?: string; // 友链 RSS/Atom 订阅地址
	screenshot?: string; // 站点网页截图 URL（可选）
	email?: string; // 站长联系邮箱（仅保存在私有内容仓中，前端构建绝不输出）
	tags?: string[]; // 标签数组
	weight: number; // 权重，数字越大排序越靠前
	enabled: boolean; // 是否启用
	pinned?: boolean; // 是否置顶（始终固定在分区最上方）
	fcircle?: boolean; // 是否加入友链朋友圈（默认：博客类友链为 true，导航/工具类为 false；设为 false 时不抓取、不聚合到朋友圈中）
	friendPageUrl?: string; // 对方放置友链的专属页面（可选，默认回退至 siteurl）
	whitelist?: boolean; // 站长免检白名单（针对 SPA 单页客户端渲染或特殊站点，永久算作双向正常）
};

// 站长对友链审查的人工裁决状态
export type FriendAuditDecision =
	| "normal" // 正常双向（未触发阈值）
	| "pending" // 触发连续 3 次异常，待站长审查（前台仍保留在正常区，不公开处决）
	| "single" // 站长已确认为单向友链（前台移入【待回链】区）
	| "quarantined" // 站长已确认为失效/404（前台移入【暂时无法访问】区）
	| "whitelisted"; // 站长标记为免检白名单（永久算作双向正常，不再告警）

// 友链巡检探测结果状态
export type FriendAuditCheckStatus =
	| "found" // 成功搜到本站关键词
	| "missing" // 页面正常（HTTP 200）但未找到关键词
	| "404" // 页面返回 404 Not Found
	| "protected" // 防御阻断（CF盾/403/503/WAF/超时），冻结计数
	| "error"; // 其他网络异常

// 友链巡检记录结构
export type FriendAuditRecord = {
	missingCount: number; // 连续确认缺失关键词次数
	failCount: number; // 连续 404 或网络故障次数
	protectedCount?: number; // 连续反爬拦截/超时次数
	lastChecked: string; // ISO 时间戳
	lastStatus: FriendAuditCheckStatus;
	lastMessage?: string; // 探测详情说明
	targetUrl?: string; // 本次实际探测的目标 URL
	decision: FriendAuditDecision; // 站长裁决状态
	decisionTime?: string; // 站长做出裁决的时间
};

// 审计状态文件集合映射
export type FriendsAuditData = Record<string, FriendAuditRecord>;

export type FriendsPageConfig = {
	title?: string; // 页面标题，留空则使用 i18n 中的翻译
	description?: string; // 页面描述，留空则使用 i18n 中的翻译
	showCustomContent?: boolean; // 是否显示自定义内容（friends.mdx）
	showComment?: boolean; // 是否显示评论区，默认 true
	randomizeSort?: boolean; // 是否打乱排序，如果为 true，将忽略 weight，随机排序
};
