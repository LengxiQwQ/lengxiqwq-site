export interface ChatRoomMeta {
	id: string;
	name: string;
	subtitle: string;
}

export interface ChatConfig {
	/**
	 * 聊天室后端 Worker 基础地址（例如 "https://chat-api.lengxiqwq.com"）
	 * 留空时前端仅展示静态兜底提示，不发起联机请求
	 */
	serverURL: string;
	/**
	 * 聊天室主题房间列表（当前精简为单房间，未来可扩展多个独立房间及各自电台）
	 */
	rooms: ChatRoomMeta[];
	/**
	 * 是否启用聊天图片上传（复用 Waline R2 /api/upload 接口）
	 */
	enableImageUpload: boolean;
	/**
	 * PlaylistOut 公开 API 基础地址（可选，默认 https://playlistout-api.lengxiqwq.com）
	 */
	playlistOutApiURL?: string;
}
