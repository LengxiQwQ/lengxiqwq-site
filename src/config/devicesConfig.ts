import type { DevicesConfig } from "@/types/devicesConfig";

// 个人设备清单配置
export const devicesConfig: DevicesConfig = {
	groups: [
		{
			id: "primary",
			title: "主力设备",
			devices: [
				{
					name: "华硕天选 4",
					description:
						"主力开发和游戏设备，平时写代码、跑项目和编译都靠它。emm 华硕做工很烂，这才两年多铰链就坏了！",
					tags: ["i9-13900H", "RTX 4060", "3TB SSD"],
					icon: "material-symbols:laptop-windows-rounded",
				},
				{
					name: "iPhone 16 Pro Max",
					description:
						"现在的主力机，拍照和日常使用最多的设备之一，iOS 26 是真的卡呀！",
					tags: ["A18 Pro", "256GB", "白色钛金属"],
					icon: "fa7-solid:mobile-screen",
				},
				{
					name: "iPad Pro 2021",
					description:
						"平时拿来看资料、游戏和当副屏。不知道为啥，刷个抖音都烫手。",
					tags: ["Apple M1", "256GB", '11"'],
					icon: "material-symbols:tablet-mac",
				},
				{
					name: "OnePlus Ace 6",
					description:
						"Android 折腾机，刷机、用来玩各种开源项目。1TB 真是太爽啦。",
					tags: ["Snapdragon 8 Elite", "1TB", "测试"],
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
					description: "买了有点后悔其实，有点重，不过无极滚轮挺不错！",
					tags: ["HERO 25K", "LIGHTSPEED", "双模滚轮"],
					icon: "material-symbols:mouse",
				},
				{
					name: "AJAZZ AK980 V2",
					description: "这个我主要看上了它的颜色和小屏幕，怎么搭配键帽都好看。",
					tags: ["98 配列", "三模无线", "Gasket 结构"],
					icon: "material-symbols:keyboard-rounded",
				},
				{
					name: "Bose QuietComfort 45",
					description:
						"平时听歌、学习和出门都会用，戴久了耳朵疼，不过降噪是真的猛。",
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
						"我的第一把电吉他，这个音色真的很喜欢，特别是四档加 Overdrive 音色！",
					tags: ["Stratocaster", "单单单", "极光白"],
					icon: "fa7-solid:guitar",
				},
				{
					name: "YAMAHA THR10II Wireless",
					description:
						"这个真得吐槽！蓝牙模块太烂了，都没怎么用就坏了。想平时蓝牙听个歌都不行！不过音色还不错，卧室练琴也是够用了。",
					tags: ["THR10II", "VCM 模拟", "内置无线"],
					icon: "material-symbols:speaker",
				},
			],
		},
	],
};
