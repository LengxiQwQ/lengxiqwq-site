import type { TimelineConfig } from "@/types/timelineConfig";

/**
 * 时间线页面配置（公开仓默认与 fallback 配置）。
 * 正式个人数据由私有内容仓接管覆盖。
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
	items: [],
};
