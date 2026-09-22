import type { TimelineConfig } from "@/types/timelineConfig";

/**
 * 个人时间线配置与正式数据源。
 */
export const timelineConfig: TimelineConfig = {
	enable: true,
	title: "时间线",
	description: "一些项目、折腾和一路走来的记录。",
	categories: [
		{
			key: "milestone",
			label: "里程碑",
			icon: "material-symbols:flag-rounded",
		},
		{
			key: "project",
			label: "项目",
			icon: "material-symbols:code-rounded",
		},
	],
	order: "desc",
	items: [
		{
			title: "冷汐的杂货铺上线",
			date: "2026.09",
			category: "milestone",
			subtitle: "个人主站",
			description:
				"把个人网站正式搬到 lengxiqwq.com。这里不只放技术文章，也会放项目、动态、照片、音乐、游戏和各种日常内容。",
			highlights: [
				"代码与内容双仓分离，保障个人隐私与数据安全",
				"全站由 GitHub Pages 托管与 Cloudflare DNS 提供全球访问支持",
			],
			tags: ["Astro", "Firefly", "Dual-Repo", "Web"],
			links: [
				{
					label: "GitHub",
					url: "https://github.com/LengxiQwQ/lengxiqwq-site",
					icon: "fa7-brands:github",
				},
				{
					label: "Website",
					url: "https://lengxiqwq.com",
					icon: "material-symbols:link-rounded",
				},
			],
			icon: "material-symbols:rocket-launch-rounded",
			featured: true,
		},
		{
			title: "PlaylistOut 继续扩成完整网站",
			date: "2026.09",
			category: "project",
			subtitle: "开源全栈平台",
			description:
				"最初只是一个 QQ 音乐歌单导出脚本，后来逐步加入网易云、酷狗、汽水音乐，以及批量导出、Web 界面、CLI 和公开 API。核心事情仍然没变：把歌单解析成可以自己保存和继续使用的数据。",
			highlights: [
				"支持 QQ 音乐（含批量导出）、网易云、酷狗与汽水音乐多平台解析",
				"支持 TXT / CSV / Excel (.xlsx) / JSON 格式导出与一键复制，纯客户端内存生成保障隐私",
				"提供开源本地 CLI 脚本，并支持对外开放 API 调用直接返回歌单结构化 JSON 数据",
			],
			tags: ["TypeScript", "React", "Cloudflare Workers", "Open API", "CLI"],
			links: [
				{
					label: "GitHub",
					url: "https://github.com/LengxiQwQ/playlistout",
					icon: "fa7-brands:github",
				},
				{
					label: "Website",
					url: "https://playlistout.lengxiqwq.com",
					icon: "material-symbols:link-rounded",
				},
			],
			icon: "material-symbols:queue-music-outline-rounded",
			featured: true,
		},
		{
			title: "Live Photo Box 开始迁移 Native 核心",
			date: "2026.08",
			category: "project",
			subtitle: "架构迁移",
			description:
				"Live Photo Box 的开发分支开始把原本依赖外部工具的一部分媒体、元数据和协议处理逐步迁移到 C++20 的 LivePhotoBox.Native。目前这项架构迁移仍在持续推进，逐步收拢底层媒体处理链路，为后续协议扩展、稳定性和跨平台能力打基础。",
			highlights: [
				"逐步下沉媒体、元数据和协议处理至 C++20 Native 核心",
				"开发分支持续推进，提高底层掌控度并优化处理流程",
			],
			tags: ["C++", "C#", "WinUI 3", "Architecture", "Media"],
			links: [
				{
					label: "GitHub",
					url: "https://github.com/LengxiQwQ/live-photo-box",
					icon: "fa7-brands:github",
				},
				{
					label: "Website",
					url: "https://livephotobox.lengxiqwq.com",
					icon: "material-symbols:link-rounded",
				},
			],
			icon: "material-symbols:speed-rounded",
			featured: true,
		},
		{
			title: "Live Photo Box 开始做",
			date: "2026.03",
			category: "project",
			subtitle: "开源桌面工具",
			description:
				"开始做一个 Windows 实况照片工具箱，目标是解决不同品牌和设备之间 Live Photo / Motion Photo 不好查看、转换和迁移的问题。后来功能逐渐扩展到合成、拆分、协议转换、修复、编辑和 CLI。",
			tags: ["C#", "WinUI 3", "Windows App SDK", "CLI"],
			links: [
				{
					label: "GitHub",
					url: "https://github.com/LengxiQwQ/live-photo-box",
					icon: "fa7-brands:github",
				},
				{
					label: "Website",
					url: "https://livephotobox.lengxiqwq.com",
					icon: "material-symbols:link-rounded",
				},
			],
			icon: "material-symbols:photo-library-outline-rounded",
		},
		{
			title: "CapsLock IME Switcher",
			date: "2025.11",
			category: "project",
			subtitle: "实用工具",
			description:
				"为了让 Windows 中英文切换更顺手，写了一个 AutoHotkey v2 小工具：短按 CapsLock 切换输入法，长按仍然保留大小写功能。",
			tags: ["AutoHotkey", "Windows", "Efficiency"],
			links: [
				{
					label: "GitHub",
					url: "https://github.com/LengxiQwQ/capslock-ime-switcher",
					icon: "fa7-brands:github",
				},
			],
			icon: "material-symbols:keyboard-outline-rounded",
		},
		{
			title: "Car Rental Management System",
			date: "2025.11",
			category: "project",
			subtitle: "大学课程项目",
			description:
				"大学 PRG2201 Object-Oriented Programming 课程的小组项目。使用 Java Swing、JDBC 和 MySQL 做了一套汽车租赁管理系统，包含车辆、客户、租赁、归还、员工、报表和日志等模块。",
			tags: ["Java", "Swing", "MySQL", "OOP"],
			links: [
				{
					label: "GitHub",
					url: "https://github.com/LengxiQwQ/car-rental-management-system",
					icon: "fa7-brands:github",
				},
			],
			icon: "material-symbols:school-outline-rounded",
		},
		{
			title: "PlaylistOut 的前身",
			date: "2025.10",
			category: "project",
			subtitle: "Python 脚本",
			description:
				"最开始只是为了备份自己的 QQ 音乐歌单，写了一个 Python 导出脚本。后来才一点点长成现在的 PlaylistOut。",
			tags: ["Python", "Script", "Music"],
			links: [
				{
					label: "GitHub",
					url: "https://github.com/LengxiQwQ/playlistout",
					icon: "fa7-brands:github",
				},
			],
			icon: "material-symbols:code-rounded",
		},
		{
			title: "注册 GitHub",
			date: "2022.01",
			category: "milestone",
			subtitle: "起点",
			description:
				"注册 GitHub 个人账号，开始把代码和各种折腾项目往 GitHub 上放。",
			tags: ["GitHub", "Beginning"],
			links: [
				{
					label: "Profile",
					url: "https://github.com/LengxiQwQ",
					icon: "fa7-brands:github",
				},
			],
			icon: "material-symbols:flag-outline-rounded",
		},
	],
};
