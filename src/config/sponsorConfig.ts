import type { SponsorConfig } from "../types/sponsorConfig";

export const sponsorConfig: SponsorConfig = {
	// 页面标题，如果留空则使用 i18n 中的翻译
	title: "",

	// 页面描述文本，如果留空则使用 i18n 中的翻译
	description: "",

	// 打赏用途说明
	usage:
		"您的打赏将用于服务器维护、内容创作和开源项目持续迭代，非常感谢您的支持与鼓励！",

	// 是否显示打赏者列表
	showSponsorsList: true,

	// 是否显示评论区，需要先在commentConfig.ts启用评论系统
	showComment: true,

	// 是否在文章详情页底部显示打赏按钮
	showButtonInPost: true,

	// 打赏方式列表
	methods: [
		{
			name: "微信",
			icon: "fa7-brands:weixin",
			qrCode: "/assets/images/sponsor/wechat.png",
			link: "",
			description: "使用 微信 扫码打赏",
			enabled: true,
		},
		{
			name: "支付宝",
			icon: "fa7-brands:alipay",
			qrCode: "/assets/images/sponsor/alipay.png",
			link: "",
			description: "使用 支付宝 扫码打赏",
			enabled: true,
		},
		{
			name: "爱发电",
			icon: "simple-icons:afdian",
			qrCode: "",
			link: "https://afdian.com/a/lengxiqwq",
			description: "通过 爱发电 进行赞助支持",
			enabled: true,
		},
		{
			name: "Ko-fi",
			icon: "simple-icons:kofi",
			qrCode: "",
			link: "https://ko-fi.com/lengxiqwq",
			description: "Buy a Coffee for Lengxi",
			enabled: true,
		},
	],

	// 打赏者列表（可选）
	sponsors: [
		{
			name: "匿名用户",
			amount: "¥5",
			date: "2026-09-03T19:02:38",
			message: "喜欢画风，期待下一个作品(ღ˘⌣˘ღ)",
		},
		{
			name: "零度",
			amount: "¥1",
			date: "2026-08-11T21:36:57",
			message: "opporeno5能不能实况",
		},
		{
			name: "匿名用户",
			amount: "¥1",
			date: "2026-01-29T00:25:46",
			message: "🦌🦌",
		},
	],
};
