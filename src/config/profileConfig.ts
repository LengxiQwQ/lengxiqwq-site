import type { ProfileConfig } from "../types/profileConfig";

export const profileConfig: ProfileConfig = {
	// 头像
	avatar: "/assets/images/avatar.webp",

	// 公开外链头像（用于友链申请等外链互换场景，推荐 256px 兼顾高清与加载速度）
	avatarUrl: "https://weavatar.com/avatar/52f243e67ccc2293d68c6f33db3f4083?s=256",

	// 名字
	name: "冷汐OωO",

	// 个人签名
	bio: "你好谢谢小笼包再见！",

	// 联系方式配置
	contact: {
		email: "lengxi@lengxiqwq.com",
		qq: "3197635836",
	},

	// 链接配置
	links: [
		{
			name: "GitHub",
			icon: "fa7-brands:github",
			url: "https://github.com/LengxiQwQ",
			showName: false,
		},
		{
			name: "Bilibili",
			icon: "fa7-brands:bilibili",
			url: "https://space.bilibili.com/477811145",
			showName: false,
		},
		{
			name: "YouTube",
			icon: "fa7-brands:youtube",
			url: "https://www.youtube.com/@lengxiya",
			showName: false,
		},
		{
			name: "RSS",
			icon: "fa7-solid:rss",
			url: "/rss/",
			showName: false,
		},
	],
};
