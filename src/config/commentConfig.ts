import type { CommentConfig } from "../types/commentConfig";

export const commentConfig: CommentConfig = {
	// 评论系统类型: none, twikoo, waline, giscus, disqus, artalk，默认为none，即不启用评论系统
	type: "none",

	// twikoo评论系统配置
	twikoo: {
		envId: "",
		// 设置 Twikoo 评论系统语言
		lang: "zh-CN",
		// 是否启用文章访问量统计功能
		visitorCount: true,
		// Twikoo JS 文件地址，支持 CDN 链接
		jsUrl: "https://cdn.jsdelivr.net/npm/twikoo@1.6.44/dist/twikoo.all.min.js",
		// Twikoo 自定义 CSS 文件地址，为空则不加载
		cssUrl: "/assets/css/twikoo-custom.css",
	},

	// waline评论系统配置
	waline: {
		// waline 后端服务地址
		serverURL: "",
		// 设置 Waline 评论系统语言
		lang: "zh-CN",
		// 设置 Waline 评论系统表情地址
		emoji: [
			"https://unpkg.com/@waline/emojis@1.4.0/weibo",
			"https://unpkg.com/@waline/emojis@1.4.0/bilibili",
			"https://unpkg.com/@waline/emojis@1.4.0/bmoji",
		],
		login: "enable",
		// 是否启用文章访问量统计功能
		visitorCount: true,
	},

	// artalk评论系统配置
	artalk: {
		// artalk后端程序 API 地址
		server: "",
		// 设置 Artalk 语言
		locale: "zh-CN",
		// 是否启用文章访问量统计功能
		visitorCount: true,
	},

	// giscus评论系统配置
	giscus: {
		// 设置 Giscus 评论系统仓库
		repo: "",
		// 设置 Giscus 评论系统仓库ID
		repoId: "",
		// 设置 Giscus 评论系统分类
		category: "",
		// 获取 Giscus 评论系统分类ID
		categoryId: "",
		// 获取 Giscus 评论系统映射方式
		mapping: "title",
		// 获取 Giscus 评论系统严格模式
		strict: "0",
		// 获取 Giscus 评论系统反应功能
		reactionsEnabled: "1",
		// 获取 Giscus 评论系统元数据功能
		emitMetadata: "1",
		// 获取 Giscus 评论系统输入位置
		inputPosition: "top",
		// 获取 Giscus 评论系统语言
		lang: "zh-CN",
		// 获取 Giscus 评论系统加载方式
		loading: "lazy",
	},

	// disqus评论系统配置
	disqus: {
		// 获取 Disqus 评论系统
		shortname: "",
	},
};
