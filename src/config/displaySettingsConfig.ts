import type { DisplaySettingsConfig } from "@/types/displaySettingsConfig";
import { resolveDisplaySettingsConfig } from "../utils/display-settings-utils";

// 显示设置面板开关配置
export const displaySettingsConfig: DisplaySettingsConfig =
	resolveDisplaySettingsConfig({
		// ── 总开关 (Master switch) ────────────────────────────
		// 视图设置面板总开关，开启后右上角显示调色盘按钮，点击展开主题色滑块与显示设置面板
		enable: true,

		// ── 外观 (Appearance) ──────────────────────────────────
		// 主题色选择器开关（色相滑块，0-360 无级调节颜色）
		themeColorSwitchable: true,

		// 文章列表布局切换开关
		layoutSwitchable: true,

		// 卡片边框和阴影开关
		cardBorderSwitchable: true,

		// 卡片风格跟随主题色开关
		cardFollowThemeSwitchable: true,

		// ── 壁纸 (Wallpaper) ──────────────────────────────────
		// 壁纸模式切换开关
		wallpaperModeSwitchable: true,

		// 全屏壁纸布局切换开关（classic / hero）
		fullscreenLayoutSwitchable: true,

		// 水波纹动画开关
		wavesSwitchable: true,

		// 渐变过渡效果开关
		gradientSwitchable: true,

		// 横幅标题显示开关
		bannerTitleSwitchable: true,

		// 壁纸轮播开关
		bannerCarouselSwitchable: true,

		// 全屏壁纸/透明覆盖模式参数调节开关
		overlaySwitchable: {
			opacity: true,
			blur: true,
			cardOpacity: true,
		},

		// ── 特效 (Effects) ────────────────────────────────────
		// 樱花特效开关
		sakuraSwitchable: true,
	});
