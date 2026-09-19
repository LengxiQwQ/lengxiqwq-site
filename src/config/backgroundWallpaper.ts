import type { BackgroundWallpaperConfig } from "@/types/backgroundWallpaper";

export const backgroundWallpaper: BackgroundWallpaperConfig = {
	// 壁纸模式："banner" 横幅壁纸，"fullscreen" 全屏壁纸，"overlay" 覆盖透明，"none" 纯色背景无壁纸
	mode: "banner",
	// 是否启用背景视频播放
	playerEnable: false,
	src: {
		// 桌面背景图片
		desktop: [
			"assets/images/DesktopWallpaper/d1.avif",
			"assets/images/DesktopWallpaper/d2.avif",
			"assets/images/DesktopWallpaper/d3.avif",
			"assets/images/DesktopWallpaper/d4.avif",
			"assets/images/DesktopWallpaper/d5.avif",
			"assets/images/DesktopWallpaper/d6.avif",
		],
		// 移动背景图片
		mobile: [
			"assets/images/MobileWallpaper/m1.avif",
			"assets/images/MobileWallpaper/m2.avif",
			"assets/images/MobileWallpaper/m3.avif",
			"assets/images/MobileWallpaper/m4.avif",
			"assets/images/MobileWallpaper/m5.avif",
			"assets/images/MobileWallpaper/m6.avif",
		],
	},
	// 横幅壁纸和全屏壁纸共享配置
	common: {
		dimOpacity: 0.2,
		// 主页横幅文字
		homeText: {
			enable: true,
			title: "LengxiQwQ",
			titleSize: "4.5rem",
			subtitle: [
				"嗨，很高兴遇见你！",
				"在技术与游戏之间反复横跳 (´• ω •`)",
				"暂时放弃游戏主线任务，狂刷技术副本中...",
				"Live Photo Box & PlaylistOut 开发者",
				"梦想是打造自由度拉满的开放世界游戏 ✨",
			],
			subtitleSize: "1.5rem",
			typewriter: {
				enable: true,
				speed: 100,
				deleteSpeed: 50,
				pauseTime: 2000,
			},
			linksEnable: false,
			links: [],
		},
		carousel: {
			enable: false,
		},
		waves: {
			enable: {
				desktop: true,
				mobile: true,
			},
		},
		gradient: {
			enable: {
				desktop: true,
				mobile: true,
			},
			height: "10%",
		},
	},
	banner: {
		position: "center",
		postInfo: {
			mode: "description",
		},
		navbar: {
			transparentMode: "semi",
			blur: 12,
		},
	},
	overlay: {
		zIndex: -1,
		opacity: 0.8,
		blur: 3,
		cardOpacity: 0.8,
	},
	fullscreen: {
		layout: "classic",
		position: "center",
		navbar: {
			transparentMode: "semifull",
			blur: 12,
		},
		blurRamp: {
			enable: {
				desktop: true,
				mobile: true,
			},
		},
	},
};
