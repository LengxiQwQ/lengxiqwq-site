import type { AnnouncementConfig } from "@/types/announcementConfig";

export const announcementConfig: AnnouncementConfig = {
	// 公告标题，留空则走i18n默认标题
	title: "",

	// 公告内容
	content: `最近还在折腾 Live Photo Box，一个实况照片合成、拆分、转换和修复的桌面端工具箱。
这段时间主要在把一部分底层媒体与协议处理逐步迁移到 C++ Native 核心，希望批量处理更加稳定，新版本预计一个月左右和大家见面 OωO！`,

	// 是否允许用户关闭公告
	closable: true,

	link: {
		// 启用链接
		enable: true,
		// 链接文本
		text: "看看项目",
		// 链接 URL
		url: "/projects/live-photo-box/",
		// 内部链接
		external: false,
	},
};
