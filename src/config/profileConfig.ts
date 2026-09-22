import type { ProfileConfig } from "../types/profileConfig";

export const profileConfig: ProfileConfig = {
	// 头像
	avatar: "/assets/images/avatar.webp",

	// 名字
	name: "冷汐OωO",

	// 个人签名
	bio: "你好谢谢小笼包再见！",

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
