import type { DevicesConfig } from "@/types/devicesConfig";

// 个人设备清单配置
export const devicesConfig: DevicesConfig = {
	groups: [
		{
			id: "primary",
			title: "主力设备",
			devices: [
				{
					name: "华硕天选 4 (TX Gaming 4)",
					description:
						"主力开发和游戏设备，平时写代码、跑项目和编译 Live Photo Box 基本都靠它。",
					tags: ["i9-13900H", "RTX 4060", "3TB SSD"],
					icon: "material-symbols:laptop-windows-rounded",
				},
				{
					name: "iPhone 16 Pro Max",
					description:
						"现在的主力手机，拍照片和日常测试最常用的设备之一。",
					tags: ["A18 Pro", "256GB", "白色钛金属"],
					icon: "fa7-solid:mobile-screen",
				},
				{
					name: "iPad Pro 2021",
					description:
						"平时拿来看资料、影音和当副屏，偶尔也会折腾些音乐相关的东西。",
					tags: ["Apple M1", "256GB", "11\""],
					icon: "material-symbols:tablet-mac",
				},
				{
					name: "OnePlus Ace 6",
					description:
						"Android 折腾机，刷机、解锁和测试各种东西的时候比较常用。",
					tags: ["Snapdragon 8 Elite", "Android", "测试"],
					icon: "material-symbols:phone-android-rounded",
				},
			],
		},
		{
			id: "desktop",
			title: "桌面日常",
			devices: [
				{
					name: "Logitech G903 HERO",
					description:
						"用了很顺手的一只无线鼠标，无极滚轮是真的回不去了。",
					tags: ["HERO 25K", "LIGHTSPEED", "双模滚轮"],
					icon: "material-symbols:mouse",
				},
				{
					name: "AJAZZ AK980 V2",
					description:
						"现在桌面上的主力机械键盘，98 配列对我这种什么键都想留着的人很合适。",
					tags: ["98 配列", "三模无线", "Gasket 结构"],
					icon: "material-symbols:keyboard-rounded",
				},
				{
					name: "Bose QuietComfort 45",
					description:
						"平时听歌、学习和出门都会用，主要还是图它戴着舒服。",
					tags: ["消噪 / 通透", "蓝牙无线", "TriPort"],
					icon: "material-symbols:headphones-rounded",
				},
			],
		},
		{
			id: "music",
			title: "音乐角落",
			devices: [
				{
					name: "Fender Player Stratocaster",
					description:
						"现在主要在弹的电吉他。比起研究设备参数，我更想研究什么时候才能真的弹好。",
					tags: ["Stratocaster", "单单单", "极光白"],
					icon: "fa7-solid:guitar",
				},
				{
					name: "YAMAHA THR10II Wireless",
					description:
						"桌面练琴音箱，体积不大，平时在房间里练琴刚刚好。",
					tags: ["THR10II", "VCM 模拟", "内置无线"],
					icon: "material-symbols:speaker",
				},
			],
		},
	],
};
