import type { ChatConfig } from "@/types/chatConfig";

export const chatConfig: ChatConfig = {
	// 聊天室独立 Cloudflare Worker 后端地址（自定义子域）
	serverURL: "https://chat-api.lengxiqwq.com",
	rooms: [
		{
			id: "interconnect",
			name: "互联茶室",
			subtitle: "和其他站点的朋友一起聊天",
		},
		{
			id: "chat",
			name: "闲聊",
			subtitle: "随便聊聊日常与折腾",
		},
	],
	enableImageUpload: true,
	interconnectSites: [
		{
			name: "听雨茶室",
			owner: "朝朝听雨",
			avatar: "https://rainzt.cn/zzty.png",
			url: "https://rainzt.cn/chat/",
			desc: "物物而不物于物，念念而不念于念",
		},
		{
			name: "Detached 茶室",
			owner: "Detached",
			avatar: "https://detached.online/favicon.ico",
			url: "https://detached.online/chat/",
			desc: "Detached 互联聊天室",
		},
		{
			name: "雪的茶室",
			owner: "AIOVTUE-雪",
			avatar: "https://daily.yybb.us/owo/snow/snow-03.webp",
			url: "https://chat.yybb.us/",
			desc: "来自 daily.yybb.us 的雪之茶室",
		},
		{
			name: "Somoe 茶室",
			owner: "Somoe",
			avatar: "https://somoe.xyz/favicon.ico",
			url: "https://somoe.xyz/chat",
			desc: "Somoe 互联茶室",
		},
	],
};
