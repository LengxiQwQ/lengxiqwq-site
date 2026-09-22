import type { CommentConfig } from "@/types/commentConfig";

export const commentConfig: CommentConfig = {
	// 评论系统类型: none, twikoo, waline, giscus, disqus, artalk
	type: "twikoo",

	// twikoo评论系统配置
	twikoo: {
		envId: "https://lengxi-website.netlify.app/.netlify/functions/twikoo",
		// 设置 Twikoo 评论系统语言
		lang: "zh-CN",
		// 是否启用文章访问量统计功能
		visitorCount: true,
		// Twikoo JS 文件地址，支持 CDN 链接
		jsUrl: "https://cdn.jsdelivr.net/npm/twikoo@1.6.44/dist/twikoo.all.min.js",
		// Twikoo 自定义 CSS 文件地址，为空则不加载
		cssUrl: "/assets/css/twikoo-custom.css",
	},
};
