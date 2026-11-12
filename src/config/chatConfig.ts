import type { ChatConfig } from "@/types/chatConfig";

export const chatConfig: ChatConfig = {
	// 聊天室后端 Worker 地址（留空时不发起联机请求）
	serverURL: "",
	rooms: [
		{
			id: "chat",
			name: "闲聊",
			subtitle: "随便聊聊日常与折腾",
		},
	],
	enableImageUpload: true,
};

