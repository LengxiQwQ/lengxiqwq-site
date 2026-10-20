import type { DevicesConfig } from "@/types/devicesConfig";

// 示例设备清单配置（模板预设）
export const devicesConfig: DevicesConfig = {
	groups: [
		{
			id: "primary",
			title: "主力设备",
			description: "日常开发与核心生产力工具",
			devices: [
				{
					name: "示例开发笔记本",
					brand: "Apple",
					alias: "生产力主力机",
					status: "服役中",
					description: "日常主力开发设备，用于编写代码与测试项目。",
					tags: ["Apple M3", "32GB", "1TB SSD"],
					icon: "material-symbols:laptop-mac-rounded",
				},
				{
					name: "示例智能手机",
					brand: "Apple",
					alias: "日常随身",
					status: "服役中",
					description: "主力移动设备，拍照与日常交流使用。",
					tags: ["OLED", "256GB"],
					icon: "fa7-solid:mobile-screen",
				},
			],
		},
		{
			id: "accessories",
			title: "外设与配件",
			description: "桌面办公外设与影音装备",
			devices: [
				{
					name: "示例 4K 显示器",
					brand: "Dell",
					status: "服役中",
					description: "27 英寸 4K 高分屏，支持 Type-C 反向供电。",
					tags: ["4K", '27"', "Type-C"],
					icon: "material-symbols:desktop-windows-rounded",
				},
			],
		},
	],
};
