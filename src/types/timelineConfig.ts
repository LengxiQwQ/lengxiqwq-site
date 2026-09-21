/**
 * 时间线页面相关类型定义
 */

export interface TimelineCategory {
	/** 稳定标识，供时间线条目引用与筛选 */
	key: string;
	/** 分类显示名称 */
	label: string;
	/** 图标（Astro Icon 或 Iconify 名） */
	icon?: string;
}

export interface TimelineLink {
	/** 链接显示文本 */
	label: string;
	/** 目标 URL */
	url: string;
	/** 可选图标 */
	icon?: string;
}

export interface TimelineItem {
	/** 可选独立开关；false 时不参与渲染与计数 */
	enable?: boolean;
	/** 节点标题（事件、项目或里程碑名称） */
	title: string;
	/** 时间或时间范围（如 "2026.09", "2025.11"） */
	date: string;
	/** 归属分类 key（对应 TimelineCategory.key） */
	category?: string;
	/** 副标题 / 角色 / 标签描述 */
	subtitle?: string;
	/** 地点信息 */
	location?: string;
	/** 详细描述说明 */
	description?: string;
	/** 关键要点 / 成就清单 */
	highlights?: string[];
	/** 技术栈 / 关联标签 */
	tags?: string[];
	/** 外部关联链接 */
	links?: TimelineLink[];
	/** 节点自定义图标，未指定时使用分类图标或默认图标 */
	icon?: string;
	/** 是否为重点里程碑节点（高亮徽标与外框展示） */
	featured?: boolean;
}

export interface TimelineConfig {
	/** 页面总开关；false 时隐藏导航入口，访问 /timeline/ 跳转 404 */
	enable: boolean;
	/** 页面标题 */
	title?: string;
	/** 页面描述 */
	description?: string;
	/** 筛选分类列表 */
	categories: TimelineCategory[];
	/** 排序方向：默认 "desc"（倒序，最新在前） */
	order?: "desc" | "asc";
	/** 时间线条目数据 */
	items: TimelineItem[];
}
