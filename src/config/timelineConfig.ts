import type { TimelineConfig } from "@/types/timelineConfig";

/**
 * 示例时间线配置（模板预设）
 */
export const timelineConfig: TimelineConfig = {
	enable: true,
	title: "时间线",
	description: "一些项目、折腾和一路走来的记录。",
	categories: [
		{
			key: "milestone",
			label: "里程碑",
			icon: "material-symbols:flag-rounded",
		},
		{
			key: "project",
			label: "项目",
			icon: "material-symbols:code-rounded",
		},
	],
	order: "desc",
	items: [
		{
			title: "个人博客上线",
			date: "2026.01",
			category: "milestone",
			subtitle: "个人主站",
			description: "使用 Firefly 主题搭建的现代化个人博客网站正式上线。",
			highlights: ["基于 Astro 与 Svelte 构建", "支持多端响应式与暗色模式"],
			tags: ["Astro", "Firefly", "Web"],
			icon: "material-symbols:rocket-launch-rounded",
			featured: true,
		},
		{
			title: "开源项目发布",
			date: "2026.02",
			category: "project",
			subtitle: "开源工具",
			description: "发布首个个人开源小工具，收获社区支持。",
			highlights: ["纯前端客户端处理", "支持导出多种格式"],
			tags: ["TypeScript", "Open Source"],
			icon: "material-symbols:code-rounded",
		},
	],
};
