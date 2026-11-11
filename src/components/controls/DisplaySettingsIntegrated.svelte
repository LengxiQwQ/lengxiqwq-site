<script lang="ts">
import {
	WALLPAPER_BANNER,
	WALLPAPER_FULLSCREEN,
	WALLPAPER_NONE,
	WALLPAPER_OVERLAY,
} from "@constants/constants";
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import {
	getDefaultBannerCarouselEnabled,
	getDefaultBannerTitleEnabled,
	getDefaultCardBorderEnabled,
	getDefaultCardFollowThemeEnabled,
	getDefaultFullscreenLayout,
	getDefaultGradientEnabled,
	getDefaultHue,
	getDefaultOverlayBlur,
	getDefaultOverlayCardOpacity,
	getDefaultOverlayOpacity,
	getDefaultSakuraEnabled,
	getDefaultWavesEnabled,
	getFollowWallpaperHue,
	getHue,
	getPresetHueForWallpaper,
	getStoredBannerCarouselEnabled,
	getStoredBannerTitleEnabled,
	getStoredCardBorderEnabled,
	getStoredCardFollowThemeEnabled,
	getStoredFullscreenLayout,
	getStoredGradientEnabled,
	getStoredOverlayBlur,
	getStoredOverlayCardOpacity,
	getStoredOverlayOpacity,
	getStoredSakuraEnabled,
	getStoredWallpaperMode,
	getStoredWavesEnabled,
	getThemeHueMode,
	getWallpaperHuePresets,
	normalizeWallpaperKey,
	saveWallpaperPresetHue,
	setBannerCarouselEnabled,
	setBannerTitleEnabled,
	setCardBorderEnabled,
	setCardFollowThemeEnabled,
	setFollowWallpaperHue,
	setFullscreenLayout,
	setGradientEnabled,
	setHue,
	setOverlayBlur,
	setOverlayCardOpacity,
	setOverlayOpacity,
	setSakuraEnabled,
	setThemeHueMode,
	setWallpaperMode,
	setWavesEnabled,
	type ThemeHueMode,
} from "@utils/setting-utils";
import { onMount } from "svelte";
import Icon from "@/components/common/Icon.svelte";
import {
	backgroundWallpaper,
	displaySettingsConfig,
	siteConfig,
} from "@/config";
import type { FullscreenWallpaperLayout, WALLPAPER_MODE } from "@/types/config";
import {
	extractDominantHue,
	getActiveWallpaperImg,
} from "@/utils/color-extract-utils";

type OverlaySliderItem = {
	key: "opacity" | "blur" | "cardOpacity";
	enabled: boolean;
	label: string;
	displayValue: string;
	ariaLabel: string;
	min: number;
	max: number;
	step: number;
	value: number;
	onValueChange: (value: number) => void;
};

type TabKey = "appearance" | "wallpaper" | "effects";

type WallpaperOption = {
	id: string;
	src: string;
	name: string;
	device: "desktop" | "mobile";
	index: number;
};

let hue = $state(getHue());
const defaultHue = getDefaultHue();
let followWallpaperHue = $state(getFollowWallpaperHue());
let themeHueMode = $state<ThemeHueMode>(getThemeHueMode());
let wallpaperPresets = $state<Record<string, number>>(getWallpaperHuePresets());
let wallpaperOptions = $state(parseWallpaperOptions());
let activeWallpaperSrc = $state<string>("");
let selectedWallpaperSrc = $state<string>("");
let userPinnedSelection = $state<boolean>(false);
let isSavingConfig = $state<boolean>(false);
let saveStatusMessage = $state<string>("");
let isMobileViewport = $state(
	typeof window !== "undefined" ? window.innerWidth < 1024 : false,
);

function parseWallpaperOptions(): {
	desktop: WallpaperOption[];
	mobile: WallpaperOption[];
} {
	const cleanName = (src: string) => {
		const file = src.split("/").pop() || src;
		return file.replace(/\.[^.]+$/, "");
	};

	const desktop: WallpaperOption[] = [];
	const mobile: WallpaperOption[] = [];

	const bgSrc = backgroundWallpaper.src;
	if (typeof bgSrc === "object" && bgSrc !== null && !Array.isArray(bgSrc)) {
		const dt = Array.isArray(bgSrc.desktop)
			? bgSrc.desktop
			: typeof bgSrc.desktop === "string"
				? [bgSrc.desktop]
				: [];
		dt.forEach((src, index) => {
			desktop.push({
				id: `dt-${index}`,
				src,
				name: cleanName(src),
				device: "desktop",
				index,
			});
		});

		const mb = Array.isArray(bgSrc.mobile)
			? bgSrc.mobile
			: typeof bgSrc.mobile === "string"
				? [bgSrc.mobile]
				: [];
		mb.forEach((src, index) => {
			mobile.push({
				id: `mb-${index}`,
				src,
				name: cleanName(src),
				device: "mobile",
				index,
			});
		});
	} else if (Array.isArray(bgSrc)) {
		bgSrc.forEach((src, index) => {
			desktop.push({
				id: `bg-${index}`,
				src,
				name: cleanName(src),
				device: "desktop",
				index,
			});
		});
	} else if (typeof bgSrc === "string") {
		desktop.push({
			id: "bg-0",
			src: bgSrc,
			name: cleanName(bgSrc),
			device: "desktop",
			index: 0,
		});
	}

	return { desktop, mobile };
}

let currentWallpaperList = $derived.by(() => {
	if (isMobileViewport) {
		return wallpaperOptions.mobile.length > 0
			? wallpaperOptions.mobile
			: wallpaperOptions.desktop;
	}
	return wallpaperOptions.desktop.length > 0
		? wallpaperOptions.desktop
		: wallpaperOptions.mobile;
});

let selectedWallpaperName = $derived.by(() => {
	const found = currentWallpaperList.find(
		(w) => w.src === selectedWallpaperSrc,
	);
	if (found) return found.name;
	const clean = selectedWallpaperSrc.split("/").pop() || "";
	return clean.replace(/\.[^.]+$/, "") || "当前壁纸";
});

function getWallpaperHue(src: string): number {
	const preset = getPresetHueForWallpaper(src);
	if (typeof preset === "number") return preset;
	// 若暂无预设，先沿用当前已生效的主题色相，绝不强行跳回默认色产生闪烁
	return typeof hue === "number" ? hue : defaultHue;
}

function selectWallpaper(wp: WallpaperOption) {
	if (isSavingConfig) return;
	selectedWallpaperSrc = wp.src;
	userPinnedSelection = true;
	const preset = getPresetHueForWallpaper(wp.src);
	if (typeof preset === "number") {
		// 若已有该壁纸专属预设，直接无缝切入预设色
		hue = preset;
		setHue(preset);
	}
	// 若该壁纸暂无预设，先保持当前色相不闪烁，等待壁纸节点就绪提取或由用户手动调色

	window.dispatchEvent(
		new CustomEvent("switchWallpaper", {
			detail: { index: wp.index, src: wp.src },
		}),
	);
	requestAnimationFrame(refreshAllRangeProgress);
}

function switchThemeHueMode(mode: ThemeHueMode) {
	themeHueMode = mode;
	setThemeHueMode(mode);
	followWallpaperHue = mode !== "custom";

	if (mode === "custom") {
		const storedCustom =
			typeof window !== "undefined" && window.localStorage
				? localStorage.getItem("customHue")
				: null;
		const targetHue = storedCustom
			? Number.parseInt(storedCustom, 10)
			: defaultHue;
		hue = targetHue;
		setHue(targetHue);
		requestAnimationFrame(refreshAllRangeProgress);
	} else if (mode === "auto") {
		const img = getActiveWallpaperImg();
		if (img) {
			extractDominantHue(img).then((extractedHue) => {
				hue = extractedHue;
				setHue(extractedHue);
				requestAnimationFrame(refreshAllRangeProgress);
			});
		}
	} else if (mode === "preset") {
		const targetSrc = selectedWallpaperSrc || activeWallpaperSrc;
		if (targetSrc) {
			const preset = getPresetHueForWallpaper(targetSrc);
			if (typeof preset === "number") {
				hue = preset;
				setHue(preset);
			} else {
				const img = getActiveWallpaperImg();
				if (img) {
					extractDominantHue(img).then((extractedHue) => {
						hue = extractedHue;
						setHue(extractedHue);
					});
				}
			}
		}
		requestAnimationFrame(refreshAllRangeProgress);
	}
}

function handleHueInput() {
	if (themeHueMode === "auto") {
		switchThemeHueMode("custom");
	}
}

const isDev = import.meta.env.DEV;

function getCurrentWallpaperIndex(): number {
	if (!currentWallpaperList.length) return 0;
	if (!selectedWallpaperSrc) return 0;
	const idx = currentWallpaperList.findIndex(
		(w) =>
			w.src === selectedWallpaperSrc ||
			(selectedWallpaperSrc && w.src.endsWith(selectedWallpaperSrc)) ||
			(selectedWallpaperSrc && selectedWallpaperSrc.endsWith(w.src)),
	);
	return idx >= 0 ? idx : 0;
}

function prevWallpaper() {
	if (isSavingConfig) return;
	if (currentWallpaperList.length <= 1) return;
	const currentIdx = getCurrentWallpaperIndex();
	const prevIdx =
		(currentIdx - 1 + currentWallpaperList.length) %
		currentWallpaperList.length;
	selectWallpaper(currentWallpaperList[prevIdx]);
}

function nextWallpaper() {
	if (isSavingConfig) return;
	if (currentWallpaperList.length <= 1) return;
	const currentIdx = getCurrentWallpaperIndex();
	const nextIdx = (currentIdx + 1) % currentWallpaperList.length;
	selectWallpaper(currentWallpaperList[nextIdx]);
}

async function savePresetsToProject() {
	if (isSavingConfig) return;
	isSavingConfig = true;
	saveStatusMessage = "保存中...";

	try {
		const targetHue = hue; // 严格锁定当前所调的色相，保存期间绝不接受任何外部事件篡改！
		// 汇总所有壁纸预设（合并项目配置既有预设、用户本地预设以及当前编辑选中的色相）
		const allPresets: Record<string, number> = {
			...(backgroundWallpaper.wallpaperHuePresets || {}),
			...wallpaperPresets,
		};
		const targetSrc =
			selectedWallpaperSrc ||
			activeWallpaperSrc ||
			currentWallpaperList[0]?.src ||
			"";
		if (targetSrc && typeof targetHue === "number") {
			const clean = normalizeWallpaperKey(targetSrc);
			const filename = clean.split("/").pop() || "";
			const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
			allPresets[nameWithoutExt] = targetHue;
			allPresets[filename] = targetHue;
			allPresets[clean] = targetHue;
			saveWallpaperPresetHue(targetSrc, targetHue);
			wallpaperPresets = getWallpaperHuePresets();
			hue = targetHue;
			setHue(targetHue);
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 3000);

		try {
			const res = await fetch("/api/wallpaper-hue-presets/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ presets: allPresets }),
				signal: controller.signal,
			});
			clearTimeout(timeoutId);
			if (res.ok) {
				const data = await res.json();
				if (data.success) {
					saveStatusMessage = "✅ 保存成功！已写入项目文件";
					return;
				}
			}
			saveStatusMessage = "✅ 已保存至本地缓存";
		} catch {
			clearTimeout(timeoutId);
			// 本地已在上面通过 saveWallpaperPresetHue 保存生效
			saveStatusMessage = "✅ 已保存至本地缓存（可点右侧复制）";
		}
	} catch (e) {
		console.error("Save presets error:", e);
		saveStatusMessage = "⚠️ 保存遇到问题，请重试";
	} finally {
		isSavingConfig = false;
		setTimeout(() => {
			saveStatusMessage = "";
		}, 3000);
	}
}

async function copyPresetsCode() {
	try {
		const allPresets: Record<string, number> = {
			...(backgroundWallpaper.wallpaperHuePresets || {}),
			...wallpaperPresets,
		};
		const targetHue = hue;
		const targetSrc =
			selectedWallpaperSrc ||
			activeWallpaperSrc ||
			currentWallpaperList[0]?.src ||
			"";
		if (targetSrc && typeof targetHue === "number") {
			const clean = normalizeWallpaperKey(targetSrc);
			const filename = clean.split("/").pop() || "";
			const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
			allPresets[nameWithoutExt] = targetHue;
			allPresets[filename] = targetHue;
			allPresets[clean] = targetHue;
			saveWallpaperPresetHue(targetSrc, targetHue);
			wallpaperPresets = getWallpaperHuePresets();
		}

		const lines = Object.entries(allPresets).map(
			([k, v]) => `\t\t"${k}": ${v},`,
		);
		const code = `\twallpaperHuePresets: {\n${lines.join("\n")}\n\t},`;

		await navigator.clipboard.writeText(code);
		saveStatusMessage = "📋 配置代码已复制到剪贴板";
	} catch (e) {
		console.error("Copy presets code error:", e);
		saveStatusMessage = "⚠️ 复制失败";
	} finally {
		setTimeout(() => {
			saveStatusMessage = "";
		}, 3000);
	}
}
let wallpaperMode: WALLPAPER_MODE = $state(backgroundWallpaper.mode);
const defaultWallpaperMode = backgroundWallpaper.mode;
let fullscreenLayout: FullscreenWallpaperLayout = $state(
	getDefaultFullscreenLayout(),
);
const defaultFullscreenLayout = getDefaultFullscreenLayout();
let currentLayout: "list" | "grid" = $state("list");
const defaultLayout = siteConfig.postListLayout.defaultMode;
const mobileDefaultLayout =
	siteConfig.postListLayout.mobileDefaultMode || defaultLayout;
let mounted = $state(false);
let isSmallScreen = $state(
	typeof window !== "undefined" ? window.innerWidth < 1200 : false,
);
let isMobileWidth = $state(
	typeof window !== "undefined" ? window.innerWidth < 780 : false,
);
let isSwitching = $state(false);
let wavesEnabled = $state(true);
const defaultWavesEnabled = getDefaultWavesEnabled();
let gradientEnabled = $state(true);
const defaultGradientEnabled = getDefaultGradientEnabled();
let bannerTitleEnabled = $state(true);
const defaultBannerTitleEnabled = getDefaultBannerTitleEnabled();
let bannerCarouselEnabled = $state(true);
const defaultBannerCarouselEnabled = getDefaultBannerCarouselEnabled();
let sakuraEnabled = $state(true);
const defaultSakuraEnabled = getDefaultSakuraEnabled();
let overlayOpacity = $state(getDefaultOverlayOpacity());
const defaultOverlayOpacity = getDefaultOverlayOpacity();
let overlayBlur = $state(getDefaultOverlayBlur());
const defaultOverlayBlur = getDefaultOverlayBlur();
let overlayCardOpacity = $state(getDefaultOverlayCardOpacity());
const defaultOverlayCardOpacity = getDefaultOverlayCardOpacity();
const defaultCardBorderEnabled = getDefaultCardBorderEnabled();
let cardBorderEnabled = $state(defaultCardBorderEnabled);
const defaultCardFollowThemeEnabled = getDefaultCardFollowThemeEnabled();
let cardFollowThemeEnabled = $state(defaultCardFollowThemeEnabled);

const isWallpaperSwitchable = displaySettingsConfig.wallpaperModeSwitchable;
const isFullscreenLayoutSwitchable = $derived(
	displaySettingsConfig.fullscreenLayoutSwitchable &&
		wallpaperMode === WALLPAPER_FULLSCREEN,
);
const allowLayoutSwitch = displaySettingsConfig.layoutSwitchable;
let effectiveDefaultLayout = $derived(
	isMobileWidth ? mobileDefaultLayout : defaultLayout,
);
const showThemeColor = displaySettingsConfig.themeColorSwitchable;
const isWavesSwitchable = displaySettingsConfig.wavesSwitchable;
const isGradientSwitchable = displaySettingsConfig.gradientSwitchable;
// 检查是否启用横幅标题配置（功能开关，非用户切换开关）
const isBannerTitleEnabled =
	backgroundWallpaper.common?.homeText?.enable ?? false;
const isBannerTitleSwitchable =
	isBannerTitleEnabled && displaySettingsConfig.bannerTitleSwitchable;
const isBannerCarouselSwitchable =
	displaySettingsConfig.bannerCarouselSwitchable;
const isSakuraSwitchable = displaySettingsConfig.sakuraSwitchable;
const isCardBorderSwitchable = displaySettingsConfig.cardBorderSwitchable;
const isCardFollowThemeSwitchable =
	displaySettingsConfig.cardFollowThemeSwitchable;
// 是否有任何横幅设置可显示（后续添加新设置时在此处添加条件）
const hasBannerSettings =
	isWavesSwitchable ||
	isGradientSwitchable ||
	isBannerTitleSwitchable ||
	isBannerCarouselSwitchable;
const overlaySwitchableConfig = displaySettingsConfig.overlaySwitchable;
const isOverlaySettingsSwitchable =
	typeof overlaySwitchableConfig === "boolean" ? overlaySwitchableConfig : true;
const isOverlayOpacitySwitchable =
	typeof overlaySwitchableConfig === "boolean"
		? overlaySwitchableConfig
		: (overlaySwitchableConfig.opacity ?? false);
const isOverlayBlurSwitchable =
	typeof overlaySwitchableConfig === "boolean"
		? overlaySwitchableConfig
		: (overlaySwitchableConfig.blur ?? false);
const isOverlayCardOpacitySwitchable =
	typeof overlaySwitchableConfig === "boolean"
		? overlaySwitchableConfig
		: (overlaySwitchableConfig.cardOpacity ?? false);
const hasOverlaySettings =
	isOverlaySettingsSwitchable &&
	(isOverlayOpacitySwitchable ||
		isOverlayBlurSwitchable ||
		isOverlayCardOpacitySwitchable);
// 全屏壁纸模式的模糊渐变是否启用（按当前设备读取 fullscreen.blurRamp 配置，未配置默认开启）
const isFullscreenBlurRampEnabled = $derived.by(() => {
	const enable = backgroundWallpaper.fullscreen?.blurRamp?.enable;
	if (typeof enable === "boolean") return enable;
	if (!enable) return true;
	return isMobileViewport ? enable.mobile : enable.desktop;
});
let overlaySettingsIsDefault = $derived(
	(!isOverlayOpacitySwitchable || overlayOpacity === defaultOverlayOpacity) &&
		(!isOverlayBlurSwitchable || overlayBlur === defaultOverlayBlur) &&
		(!isOverlayCardOpacitySwitchable ||
			overlayCardOpacity === defaultOverlayCardOpacity),
);
// 横幅设置是否全部为默认值（用于控制恢复默认按钮的显隐）
let bannerSettingsIsDefault = $derived(
	(!isBannerTitleSwitchable ||
		bannerTitleEnabled === defaultBannerTitleEnabled) &&
		(!isWavesSwitchable || wavesEnabled === defaultWavesEnabled) &&
		(!isGradientSwitchable || gradientEnabled === defaultGradientEnabled) &&
		(!isBannerCarouselSwitchable ||
			bannerCarouselEnabled === defaultBannerCarouselEnabled),
);
let cardSettingsIsDefault = $derived(
	(!isCardBorderSwitchable || cardBorderEnabled === defaultCardBorderEnabled) &&
		(!isCardFollowThemeSwitchable ||
			cardFollowThemeEnabled === defaultCardFollowThemeEnabled),
);

const hasAnyContent = $derived(
	showThemeColor ||
		isWallpaperSwitchable ||
		isFullscreenLayoutSwitchable ||
		allowLayoutSwitch ||
		hasBannerSettings ||
		hasOverlaySettings ||
		isSakuraSwitchable,
);

// --- Tab visibility ---
const hasAppearanceTab = $derived(
	showThemeColor ||
		allowLayoutSwitch ||
		isCardBorderSwitchable ||
		isCardFollowThemeSwitchable,
);
const hasWallpaperTab = $derived(
	isWallpaperSwitchable ||
		isFullscreenLayoutSwitchable ||
		((wallpaperMode === WALLPAPER_OVERLAY ||
			wallpaperMode === WALLPAPER_FULLSCREEN) &&
			hasOverlaySettings) ||
		((wallpaperMode === WALLPAPER_BANNER ||
			wallpaperMode === WALLPAPER_FULLSCREEN) &&
			hasBannerSettings),
);
const hasEffectsTab = $derived(isSakuraSwitchable);

let visibleTabs = $derived.by(() => {
	const tabs: { key: TabKey; icon: string; label: string }[] = [];
	if (hasAppearanceTab)
		tabs.push({
			key: "appearance",
			icon: "material-symbols:palette",
			label: i18n(I18nKey.settingsTabAppearance),
		});
	if (hasWallpaperTab)
		tabs.push({
			key: "wallpaper",
			icon: "material-symbols:wallpaper",
			label: i18n(I18nKey.settingsTabWallpaper),
		});
	if (hasEffectsTab)
		tabs.push({
			key: "effects",
			icon: "mdi:flower-poppy",
			label: i18n(I18nKey.settingsTabEffects),
		});
	return tabs;
});

let showTabBar = $derived(visibleTabs.length > 1);
let activeTab = $state<TabKey>("appearance");

// Auto-switch active tab if it becomes invisible
$effect(() => {
	if (!visibleTabs.find((t) => t.key === activeTab) && visibleTabs.length > 0) {
		activeTab = visibleTabs[0].key;
	}
});

// Auto-switch to wallpaper tab when entering overlay/fullscreen mode
$effect(() => {
	if (
		(wallpaperMode === WALLPAPER_OVERLAY ||
			wallpaperMode === WALLPAPER_FULLSCREEN) &&
		hasOverlaySettings
	) {
		activeTab = "wallpaper";
	}
});

let overlaySliderItems = $derived<OverlaySliderItem[]>([
	{
		key: "opacity",
		// 全屏壁纸模式不需要背景透明度，隐藏该滑块（仍显示模糊与卡片透明度）
		enabled:
			isOverlayOpacitySwitchable && wallpaperMode !== WALLPAPER_FULLSCREEN,
		label: i18n(I18nKey.overlayOpacity),
		displayValue: `${Math.round(overlayOpacity * 100)}%`,
		ariaLabel: i18n(I18nKey.overlayOpacity),
		min: 20,
		max: 100,
		step: 1,
		value: Math.round(overlayOpacity * 100),
		onValueChange: (value) => {
			overlayOpacity = value / 100;
		},
	},
	{
		key: "blur",
		// 全屏壁纸模式关闭模糊渐变时隐藏模糊滑块（overlay 模式不受影响）
		enabled:
			isOverlayBlurSwitchable &&
			!(wallpaperMode === WALLPAPER_FULLSCREEN && !isFullscreenBlurRampEnabled),
		label: i18n(I18nKey.overlayBlur),
		displayValue: `${overlayBlur.toFixed(1)}px`,
		ariaLabel: i18n(I18nKey.overlayBlur),
		min: 0,
		max: 20,
		step: 0.5,
		value: overlayBlur,
		onValueChange: (value) => {
			overlayBlur = value;
		},
	},
	{
		key: "cardOpacity",
		enabled: isOverlayCardOpacitySwitchable,
		label: i18n(I18nKey.overlayCardOpacity),
		displayValue: `${Math.round(overlayCardOpacity * 100)}%`,
		ariaLabel: i18n(I18nKey.overlayCardOpacity),
		min: 20,
		max: 100,
		step: 1,
		value: Math.round(overlayCardOpacity * 100),
		onValueChange: (value) => {
			overlayCardOpacity = value / 100;
		},
	},
]);
// 当前模式下是否有任何 overlay 滑块实际可见（模糊滑块可能因关闭模糊渐变而隐藏）
let hasVisibleOverlaySlider = $derived(
	overlaySliderItems.some((item) => item.enabled),
);

let isHueDefault = $derived.by(() => {
	// 预设模式（preset）与跟随壁纸模式（auto）下，颜色由壁纸及其默认预设管理，不应触发或显示顶部的恢复默认值按钮
	if (themeHueMode !== "custom") return true;

	// 自定义模式下：只有当用户手动设置的自定义色相不等于系统兜底默认值 355 时，才激活并展示恢复默认按钮
	if (typeof window !== "undefined" && window.localStorage) {
		const storedCustom = localStorage.getItem("customHue");
		if (storedCustom && Number.parseInt(storedCustom, 10) !== defaultHue) {
			return false;
		}
	}
	return hue === defaultHue;
});

function resetHue() {
	if (typeof window !== "undefined" && window.localStorage) {
		// 自定义色相重置为兜底默认值 355
		localStorage.setItem("customHue", String(defaultHue));
		localStorage.setItem("hue", String(defaultHue));
	}
	hue = defaultHue;
	setHue(defaultHue);
	// 重置后切回“壁纸预设”模式，按壁纸专属预设颜色显示
	switchThemeHueMode("preset");
	requestAnimationFrame(refreshAllRangeProgress);
}

function resetWallpaperMode() {
	wallpaperMode = defaultWallpaperMode;
	setWallpaperMode(defaultWallpaperMode);
}

function resetFullscreenLayout() {
	fullscreenLayout = defaultFullscreenLayout;
	setFullscreenLayout(defaultFullscreenLayout);
}

function switchFullscreenLayout(layout: FullscreenWallpaperLayout) {
	if (fullscreenLayout === layout) return;
	fullscreenLayout = layout;
	setFullscreenLayout(layout);
}

function resetLayout() {
	currentLayout = effectiveDefaultLayout;
	localStorage.removeItem("postListLayout");

	// 触发自定义事件，通知页面布局已改变
	const event = new CustomEvent("layoutChange", {
		detail: { layout: effectiveDefaultLayout },
	});
	window.dispatchEvent(event);
}

function resetWavesEnabled() {
	wavesEnabled = defaultWavesEnabled;
	setWavesEnabled(defaultWavesEnabled);
}

function resetGradientEnabled() {
	gradientEnabled = defaultGradientEnabled;
	setGradientEnabled(defaultGradientEnabled);
}

function resetBannerSettings() {
	if (
		isBannerTitleSwitchable &&
		bannerTitleEnabled !== defaultBannerTitleEnabled
	) {
		bannerTitleEnabled = defaultBannerTitleEnabled;
		setBannerTitleEnabled(defaultBannerTitleEnabled);
	}
	if (isWavesSwitchable && wavesEnabled !== defaultWavesEnabled) {
		wavesEnabled = defaultWavesEnabled;
		setWavesEnabled(defaultWavesEnabled);
	}
	if (isGradientSwitchable && gradientEnabled !== defaultGradientEnabled) {
		gradientEnabled = defaultGradientEnabled;
		setGradientEnabled(defaultGradientEnabled);
	}
	if (
		isBannerCarouselSwitchable &&
		bannerCarouselEnabled !== defaultBannerCarouselEnabled
	) {
		bannerCarouselEnabled = defaultBannerCarouselEnabled;
		setBannerCarouselEnabled(defaultBannerCarouselEnabled);
	}
}

function resetOverlaySettings() {
	if (isOverlayOpacitySwitchable && overlayOpacity !== defaultOverlayOpacity) {
		overlayOpacity = defaultOverlayOpacity;
		setOverlayOpacity(defaultOverlayOpacity);
	}
	if (isOverlayBlurSwitchable && overlayBlur !== defaultOverlayBlur) {
		overlayBlur = defaultOverlayBlur;
		setOverlayBlur(defaultOverlayBlur);
	}
	if (
		isOverlayCardOpacitySwitchable &&
		overlayCardOpacity !== defaultOverlayCardOpacity
	) {
		overlayCardOpacity = defaultOverlayCardOpacity;
		setOverlayCardOpacity(defaultOverlayCardOpacity);
	}

	requestAnimationFrame(refreshAllRangeProgress);
}

function toggleWavesEnabled() {
	wavesEnabled = !wavesEnabled;
	setWavesEnabled(wavesEnabled);
}

function toggleGradientEnabled() {
	gradientEnabled = !gradientEnabled;
	setGradientEnabled(gradientEnabled);
}

function toggleBannerTitleEnabled() {
	bannerTitleEnabled = !bannerTitleEnabled;
	setBannerTitleEnabled(bannerTitleEnabled);
}

function toggleBannerCarouselEnabled() {
	bannerCarouselEnabled = !bannerCarouselEnabled;
	setBannerCarouselEnabled(bannerCarouselEnabled);
}

function toggleSakuraEnabled() {
	sakuraEnabled = !sakuraEnabled;
	setSakuraEnabled(sakuraEnabled);
}

function toggleCardBorderEnabled() {
	cardBorderEnabled = !cardBorderEnabled;
	setCardBorderEnabled(cardBorderEnabled);
}

function toggleCardFollowThemeEnabled() {
	cardFollowThemeEnabled = !cardFollowThemeEnabled;
	setCardFollowThemeEnabled(cardFollowThemeEnabled);
}

function resetCardSettings() {
	if (
		isCardBorderSwitchable &&
		cardBorderEnabled !== defaultCardBorderEnabled
	) {
		cardBorderEnabled = defaultCardBorderEnabled;
		setCardBorderEnabled(defaultCardBorderEnabled);
	}
	if (
		isCardFollowThemeSwitchable &&
		cardFollowThemeEnabled !== defaultCardFollowThemeEnabled
	) {
		cardFollowThemeEnabled = defaultCardFollowThemeEnabled;
		setCardFollowThemeEnabled(defaultCardFollowThemeEnabled);
	}
}

function switchWallpaperMode(newMode: WALLPAPER_MODE) {
	wallpaperMode = newMode;
	setWallpaperMode(newMode);
	window.scrollTo({ top: 0 });

	if (newMode === WALLPAPER_OVERLAY || newMode === WALLPAPER_FULLSCREEN) {
		requestAnimationFrame(refreshAllRangeProgress);
	}
}

function checkScreenSize() {
	isSmallScreen = window.innerWidth < 1200;
	isMobileWidth = window.innerWidth < 780;
	isMobileViewport = window.innerWidth < 1024;
	// 低于380px强制网格模式
	if (window.innerWidth < 380 && currentLayout === "list") {
		currentLayout = "grid";
		const event = new CustomEvent("layoutChange", {
			detail: { layout: "grid" },
		});
		window.dispatchEvent(event);
	}
}

function updateRangeProgress(input: HTMLInputElement) {
	const min = Number(input.min || 0);
	const max = Number(input.max || 100);
	const value = Number(input.value || 0);
	const progress = ((value - min) * 100) / (max - min || 1);
	input.style.setProperty(
		"--range-progress",
		`${Math.min(100, Math.max(0, progress))}%`,
	);
}

function refreshAllRangeProgress() {
	const panel = document.getElementById("display-setting");
	if (!panel) return;

	const rangeInputs = Array.from(
		panel.querySelectorAll('input[type="range"]'),
	) as HTMLInputElement[];

	rangeInputs.forEach((input) => {
		updateRangeProgress(input);
	});
}

function switchLayout() {
	if (!mounted || isSwitching) return;

	isSwitching = true;
	currentLayout = currentLayout === "list" ? "grid" : "list";
	localStorage.setItem("postListLayout", currentLayout);

	// 触发自定义事件，通知页面布局已改变
	const event = new CustomEvent("layoutChange", {
		detail: { layout: currentLayout },
	});
	window.dispatchEvent(event);

	// 动画完成后重置状态
	setTimeout(() => {
		isSwitching = false;
	}, 500);
}

onMount(() => {
	mounted = true;
	checkScreenSize();

	// 从localStorage读取保存的壁纸模式
	wallpaperMode = getStoredWallpaperMode();

	// 从localStorage读取保存的全屏壁纸布局
	fullscreenLayout = getStoredFullscreenLayout();

	// 从localStorage读取水波纹动画状态
	wavesEnabled = getStoredWavesEnabled();

	// 从localStorage读取渐变过渡状态
	gradientEnabled = getStoredGradientEnabled();

	// 从localStorage读取横幅标题状态
	bannerTitleEnabled = getStoredBannerTitleEnabled();

	// 从localStorage读取横幅轮播状态
	bannerCarouselEnabled = getStoredBannerCarouselEnabled();

	// 从localStorage读取樱花特效状态
	sakuraEnabled = getStoredSakuraEnabled();

	// 从localStorage读取卡片样式状态
	cardBorderEnabled = getStoredCardBorderEnabled();
	cardFollowThemeEnabled = getStoredCardFollowThemeEnabled();

	// 从localStorage读取全屏透明设置状态
	overlayOpacity = getStoredOverlayOpacity();
	overlayBlur = getStoredOverlayBlur();
	overlayCardOpacity = getStoredOverlayCardOpacity();

	// 从localStorage读取用户偏好布局
	const savedLayout = localStorage.getItem("postListLayout");
	if (savedLayout && (savedLayout === "list" || savedLayout === "grid")) {
		currentLayout = savedLayout;
	} else {
		currentLayout =
			window.innerWidth < 780 ? mobileDefaultLayout : defaultLayout;
	}

	// 监听窗口大小变化
	window.addEventListener("resize", checkScreenSize);

	return () => {
		window.removeEventListener("resize", checkScreenSize);
	};
});

// 监听布局变化事件
onMount(() => {
	const handleCustomEvent = (event: Event) => {
		const customEvent = event as CustomEvent<{ layout: "list" | "grid" }>;
		currentLayout = customEvent.detail.layout;
	};

	window.addEventListener("layoutChange", handleCustomEvent);

	return () => {
		window.removeEventListener("layoutChange", handleCustomEvent);
	};
});

onMount(() => {
	const panel = document.getElementById("display-setting");
	if (!panel) return;

	const handleRangeInput = (event: Event) => {
		const target = event.target;
		if (target instanceof HTMLInputElement && target.type === "range") {
			updateRangeProgress(target);
		}
	};

	refreshAllRangeProgress();
	panel.addEventListener("input", handleRangeInput);

	return () => {
		panel.removeEventListener("input", handleRangeInput);
	};
});

onMount(() => {
	const handleWallpaperModeChange = (event: Event) => {
		const customEvent = event as CustomEvent<{ mode: WALLPAPER_MODE }>;
		wallpaperMode = customEvent.detail.mode;
	};

	window.addEventListener("wallpaperModeChange", handleWallpaperModeChange);

	return () => {
		window.removeEventListener(
			"wallpaperModeChange",
			handleWallpaperModeChange,
		);
	};
});

onMount(() => {
	const handleHueChange = (event: Event) => {
		if (isSavingConfig) return; // 正在保存配置时，完全拦截并丢弃外部任何 hueChange 篡改！
		const customEvent = event as CustomEvent<{ hue: number }>;
		if (typeof customEvent.detail?.hue === "number") {
			hue = customEvent.detail.hue;
			requestAnimationFrame(refreshAllRangeProgress);
		}
	};
	const handleFollowChange = (event: Event) => {
		const customEvent = event as CustomEvent<{ enable: boolean }>;
		if (typeof customEvent.detail?.enable === "boolean") {
			followWallpaperHue = customEvent.detail.enable;
		}
	};
	const handleModeChange = (event: Event) => {
		const customEvent = event as CustomEvent<{ mode: ThemeHueMode }>;
		if (customEvent.detail?.mode) {
			themeHueMode = customEvent.detail.mode;
		}
	};
	const handlePresetsChange = () => {
		wallpaperPresets = getWallpaperHuePresets();
	};
	const handleWpChange = (event: Event) => {
		if (isSavingConfig) return; // 正在保存配置时，严禁外部壁纸切换事件打乱保存状态！
		const customEvent = event as CustomEvent<{
			img: HTMLImageElement;
			src?: string;
		}>;
		const src =
			customEvent.detail?.src ||
			customEvent.detail?.img?.getAttribute("data-wallpaper-src") ||
			customEvent.detail?.img?.currentSrc ||
			"";
		if (src) {
			activeWallpaperSrc = src;
			if (!userPinnedSelection) {
				selectedWallpaperSrc = src;
				if (themeHueMode === "preset") {
					hue = getWallpaperHue(src);
					requestAnimationFrame(refreshAllRangeProgress);
				}
			}
		}
	};

	window.addEventListener("hueChange", handleHueChange);
	window.addEventListener("followWallpaperHueChange", handleFollowChange);
	window.addEventListener("themeHueModeChange", handleModeChange);
	window.addEventListener("wallpaperHuePresetsChange", handlePresetsChange);
	window.addEventListener("wallpaperChange", handleWpChange);

	// 获取页面当前真实挂载的活跃壁纸
	const currentWp =
		(typeof window !== "undefined"
			? (window as unknown as { __currentWallpaperSrc?: string })
					.__currentWallpaperSrc
			: "") || "";
	if (currentWp) {
		activeWallpaperSrc = currentWp;
		if (!selectedWallpaperSrc) {
			selectedWallpaperSrc = currentWp;
		}
	} else if (!selectedWallpaperSrc && currentWallpaperList.length > 0) {
		selectedWallpaperSrc = currentWallpaperList[0].src;
		activeWallpaperSrc = currentWallpaperList[0].src;
	}

	// 扫描 DOM 补充可能存在的壁纸节点
	const domSlides = document.querySelectorAll<HTMLElement>(
		"#banner-images-container .slide-item, #banner-images-container .banner-image-slot",
	);
	domSlides.forEach((el) => {
		const src = el.getAttribute("data-wallpaper-src");
		if (!src) return;
		const isMobile = el.classList.contains("lg:hidden");
		const targetList = isMobile
			? wallpaperOptions.mobile
			: wallpaperOptions.desktop;
		if (!targetList.some((item) => item.src === src)) {
			const clean = src.split("/").pop() || src;
			targetList.push({
				id: `${isMobile ? "mb" : "dt"}-${targetList.length}`,
				src,
				name: clean.replace(/\.[^.]+$/, ""),
				device: isMobile ? "mobile" : "desktop",
				index: targetList.length,
			});
		}
	});

	return () => {
		window.removeEventListener("hueChange", handleHueChange);
		window.removeEventListener("followWallpaperHueChange", handleFollowChange);
		window.removeEventListener("themeHueModeChange", handleModeChange);
		window.removeEventListener(
			"wallpaperHuePresetsChange",
			handlePresetsChange,
		);
		window.removeEventListener("wallpaperChange", handleWpChange);
	};
});

let isInitialHueEffect = true;
$effect(() => {
	const currentHue = hue;
	const currentMode = themeHueMode;
	if (isInitialHueEffect) {
		isInitialHueEffect = false;
		return;
	}
	if (currentHue || currentHue === 0) {
		setHue(currentHue);
		if (
			currentMode === "custom" &&
			typeof window !== "undefined" &&
			window.localStorage
		) {
			localStorage.setItem("customHue", String(currentHue));
		}
	}
});

$effect(() => {
	if (wallpaperMode === WALLPAPER_OVERLAY) {
		if (isOverlayOpacitySwitchable) {
			setOverlayOpacity(overlayOpacity);
		}
		if (isOverlayBlurSwitchable) {
			setOverlayBlur(overlayBlur);
		}
		if (isOverlayCardOpacitySwitchable) {
			setOverlayCardOpacity(overlayCardOpacity);
		}
	} else if (wallpaperMode === WALLPAPER_FULLSCREEN) {
		// 全屏壁纸不透明，只应用模糊与卡片透明度
		if (isOverlayBlurSwitchable) {
			setOverlayBlur(overlayBlur);
		}
		if (isOverlayCardOpacitySwitchable) {
			setOverlayCardOpacity(overlayCardOpacity);
		}
	}
});

// Tab 切换后刷新滑块进度（overlay 滑块在 DOM 中才生效）
$effect(() => {
	// eslint-disable-next-line @typescript-eslint/no-unused-expressions
	activeTab;
	requestAnimationFrame(refreshAllRangeProgress);
});
</script>

{#if hasAnyContent}
<div id="display-setting" class="float-panel float-panel-closed absolute transition-all w-80 right-4 px-3 pt-0 pb-3 max-h-[80vh] overflow-y-auto custom-scrollbar" data-floating-panel data-floating-panel-trigger="display-settings-switch" inert aria-hidden="true">
	<!-- Tab Bar -->
	{#if showTabBar}
	<div class="flex gap-1 border-b border-black/5 dark:border-white/10 pt-3 pb-1 mb-3">
		{#each visibleTabs as tab (tab.key)}
			<button
				class="focus-ring-inset flex-1 flex flex-col items-center justify-center gap-1.5 py-2 px-2 text-xs font-medium transition-colors rounded-lg min-w-0
					{activeTab === tab.key
						? 'bg-(--btn-plain-bg-hover) text-(--primary)'
						: 'text-gray-500 dark:text-gray-400 hover:bg-(--btn-plain-bg-hover) hover:text-gray-700 dark:hover:text-gray-300'}"
				onclick={() => activeTab = tab.key}
			>
				<Icon icon={tab.icon} class="text-[1.5rem] shrink-0"></Icon>
				<span class="truncate">{tab.label}</span>
			</button>
		{/each}
	</div>
	{/if}

	<!-- Appearance Tab: Theme Color + Layout -->
	{#if activeTab === "appearance"}
		<!-- Theme Color Section -->
		{#if showThemeColor}
		<div class="">
			<div class="section-title">
				{i18n(I18nKey.themeColor)}
				<button
					aria-label="Reset to Default"
					class="btn-regular rounded-md active:scale-90"
					class:opacity-0={isHueDefault}
					class:pointer-events-none={isHueDefault}
					disabled={isHueDefault}
					aria-hidden={isHueDefault ? "true" : undefined}
					onclick={resetHue}
				>
					<div class="text-(--btn-content)">
						<Icon icon="fa7-solid:arrow-rotate-left" class="text-[0.75rem]"></Icon>
					</div>
				</button>
				<div id="hueValue" class="transition bg-(--btn-regular-bg) rounded-md flex justify-center
				font-bold items-center text-(--btn-content)">
					{hue}
				</div>
			</div>

			<!-- 3-Mode Selector (壁纸预设 -> 自动识别 -> 自定义) -->
			<div class="grid grid-cols-3 gap-1.5 mb-2">
				<button
					type="button"
					aria-label={i18n(I18nKey.themeColorPreset)}
					class="btn-regular rounded-md py-2 px-1 flex flex-col items-center justify-center gap-1.5 active:scale-95 transition-all text-xs font-medium cursor-pointer"
					class:opacity-60={themeHueMode !== "preset"}
					class:bg-(--btn-regular-bg-hover)={themeHueMode === "preset"}
					class:text-(--primary)={themeHueMode === "preset"}
					class:font-semibold={themeHueMode === "preset"}
					onclick={() => switchThemeHueMode("preset")}
				>
					<svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
						<path d="M12 3c-4.97 0-9 4.03-9 9 0 2.12.74 4.07 1.97 5.61L4.35 19.4c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0l2.06-2.06C9.28 19.49 10.59 20 12 20c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
					</svg>
					<span class="truncate">{i18n(I18nKey.themeColorPreset)}</span>
				</button>
				<button
					type="button"
					aria-label={i18n(I18nKey.themeColorAuto)}
					class="btn-regular rounded-md py-2 px-1 flex flex-col items-center justify-center gap-1.5 active:scale-95 transition-all text-xs font-medium cursor-pointer"
					class:opacity-60={themeHueMode !== "auto"}
					class:bg-(--btn-regular-bg-hover)={themeHueMode === "auto"}
					class:text-(--primary)={themeHueMode === "auto"}
					class:font-semibold={themeHueMode === "auto"}
					onclick={() => switchThemeHueMode("auto")}
				>
					<svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
						<path d="m19 9 1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25z"/>
					</svg>
					<span class="truncate">{i18n(I18nKey.themeColorAuto)}</span>
				</button>
				<button
					type="button"
					aria-label={i18n(I18nKey.themeColorCustom)}
					class="btn-regular rounded-md py-2 px-1 flex flex-col items-center justify-center gap-1.5 active:scale-95 transition-all text-xs font-medium cursor-pointer"
					class:opacity-60={themeHueMode !== "custom"}
					class:bg-(--btn-regular-bg-hover)={themeHueMode === "custom"}
					class:text-(--primary)={themeHueMode === "custom"}
					class:font-semibold={themeHueMode === "custom"}
					onclick={() => switchThemeHueMode("custom")}
				>
					<svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor">
						<path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/>
					</svg>
					<span class="truncate">{i18n(I18nKey.themeColorCustom)}</span>
				</button>
			</div>

			<!-- 1. 预设模式（preset） -->
			{#if themeHueMode === "preset"}
				{#if isDev}
				<!-- 本地开发模式：壁纸预设完整配置面板（滑块内置在盒子内部，和谐一体） -->
				<div class="p-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-black/5 dark:border-white/10 flex flex-col gap-2 mb-2 transition-colors">
					<!-- 顶栏：自适应显示当前视口端类型与壁纸总数 -->
					<div class="flex items-center justify-between px-0.5">
						<span class="text-[11px] font-medium text-(--btn-content) opacity-70">
							{isMobileViewport ? "移动端壁纸" : "桌面端壁纸"}
						</span>
						<span class="text-[10px] text-(--primary) font-mono font-medium">
							共 {currentWallpaperList.length} 张
						</span>
					</div>

					<!-- 紧凑轮播控制条：淡色主题色背景 -->
					<div class="flex items-center gap-1.5 p-1 rounded-lg bg-(--btn-regular-bg) text-(--btn-content) border border-black/5 dark:border-white/5 shadow-2xs">
						<button
							type="button"
							class="w-7 h-7 rounded-md flex items-center justify-center text-(--btn-content) hover:bg-(--btn-regular-bg-hover) active:scale-90 transition-all cursor-pointer disabled:opacity-30 shrink-0"
							onclick={prevWallpaper}
							disabled={currentWallpaperList.length <= 1}
							title="上一张壁纸"
						>
							<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="15 18 9 12 15 6"></polyline>
							</svg>
						</button>

						<div class="flex-1 min-w-0 text-center px-1">
							<div class="text-xs font-semibold text-(--primary) truncate leading-tight" title={selectedWallpaperName}>
								{selectedWallpaperName}
							</div>
							<div class="text-[10px] opacity-70 font-mono leading-none mt-0.5">
								{getCurrentWallpaperIndex() + 1} / {currentWallpaperList.length}
							</div>
						</div>

						<button
							type="button"
							class="w-7 h-7 rounded-md flex items-center justify-center text-(--btn-content) hover:bg-(--btn-regular-bg-hover) active:scale-90 transition-all cursor-pointer disabled:opacity-30 shrink-0"
							onclick={nextWallpaper}
							disabled={currentWallpaperList.length <= 1}
							title="下一张壁纸"
						>
							<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="9 18 15 12 9 6"></polyline>
							</svg>
						</button>
					</div>

					<!-- 调色彩虹滑块（内置在卡片盒子中，专门为当前壁纸挑选色相） -->
					<div class="hue-slider-shell w-full h-6 px-1 bg-[oklch(0.80_0.10_0)] dark:bg-[oklch(0.70_0.10_0)] rounded-md select-none">
						<input aria-label={i18n(I18nKey.themeColor)} type="range" min="0" max="360" bind:value={hue}
							   oninput={handleHueInput}
							   class="slider" id="colorSlider" step="5" style="width: 100%">
					</div>

					<!-- 保存 / 复制 按钮（等宽对称，规范统一标准配色） -->
					<div class="flex gap-2 pt-0.5">
						<button
							type="button"
							class="flex-1 btn-regular rounded-lg py-1.5 px-3 flex items-center justify-center gap-1.5 active:scale-95 transition-all text-xs font-medium cursor-pointer"
							class:bg-(--btn-regular-bg-hover)={isSavingConfig}
							class:text-(--primary)={isSavingConfig}
							disabled={isSavingConfig}
							onclick={savePresetsToProject}
						>
							<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
								<polyline points="17 21 17 13 7 13 7 21"></polyline>
								<polyline points="7 3 7 8 15 8"></polyline>
							</svg>
							<span>{isSavingConfig ? "保存中..." : "保存"}</span>
						</button>
						<button
							type="button"
							class="flex-1 btn-regular rounded-lg py-1.5 px-3 flex items-center justify-center gap-1.5 active:scale-95 transition-all text-xs font-medium cursor-pointer"
							onclick={copyPresetsCode}
							title="复制配置代码"
						>
							<svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
								<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
							</svg>
							<span>复制</span>
						</button>
					</div>

					<!-- 状态提示 -->
					{#if saveStatusMessage}
					<div class="text-[11px] px-2 py-1 rounded-md text-center transition-all bg-(--btn-plain-bg-hover) text-(--primary) font-medium">
						{saveStatusMessage}
					</div>
					{/if}
				</div>
				{:else}
				<!-- 正常访客/生产环境模式：纯净显示提示，不显示任何滑块与编辑控件 -->
				<div class="text-[11px] text-(--btn-content) opacity-70 mb-2 flex items-center gap-1.5 px-0.5">
					<svg class="w-3.5 h-3.5 text-(--primary) shrink-0" viewBox="0 0 24 24" fill="currentColor">
						<path d="M12 3c-4.97 0-9 4.03-9 9 0 2.12.74 4.07 1.97 5.61L4.35 19.4c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0l2.06-2.06C9.28 19.49 10.59 20 12 20c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/>
					</svg>
					<span>已启用壁纸专属预设色，切换壁纸时自动匹配</span>
				</div>
				{/if}
			<!-- 2. 自动识别模式（auto）：纯自动计算，不提供也不显示调色滑块 -->
			{:else if themeHueMode === "auto"}
				<div class="text-[11px] text-(--btn-content) opacity-70 mb-2 flex items-center gap-1.5 px-0.5">
					<svg class="w-3.5 h-3.5 text-(--primary) shrink-0" viewBox="0 0 24 24" fill="currentColor">
						<path d="m19 9 1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25z"/>
					</svg>
					<span>自动识别当前壁纸并提取色调</span>
				</div>
			<!-- 3. 自定义模式（custom）：用户自由设定色相，展示彩虹滑块 -->
			{:else if themeHueMode === "custom"}
				<div class="text-[11px] text-(--btn-content) opacity-70 mb-2 flex items-center gap-1.5 px-0.5">
					<svg class="w-3.5 h-3.5 text-(--primary) shrink-0" viewBox="0 0 24 24" fill="currentColor">
						<path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z"/>
					</svg>
					<span>拖动滑块自由设定全站主题色</span>
				</div>

				<div class="hue-slider-shell w-full h-6 px-1 bg-[oklch(0.80_0.10_0)] dark:bg-[oklch(0.70_0.10_0)] rounded-md select-none mb-2">
					<input aria-label={i18n(I18nKey.themeColor)} type="range" min="0" max="360" bind:value={hue}
						   oninput={handleHueInput}
						   class="slider" id="colorSlider" step="5" style="width: 100%">
				</div>
			{/if}
		</div>
		{/if}

		<!-- Layout Switch Section -->
		{#if allowLayoutSwitch}
		<div class="">
			<div class="section-title">
				{i18n(I18nKey.postListLayout)}
				<button aria-label="Reset to Default" class="btn-regular rounded-md active:scale-90"
						class:opacity-0={currentLayout === effectiveDefaultLayout} class:pointer-events-none={currentLayout === effectiveDefaultLayout}
						disabled={currentLayout === effectiveDefaultLayout} aria-hidden={currentLayout === effectiveDefaultLayout ? "true" : undefined} onclick={resetLayout}>
					<div class="text-(--btn-content)">
						<Icon icon="fa7-solid:arrow-rotate-left" class="text-[0.75rem]"></Icon>
					</div>
				</button>
			</div>
			<div class="flex gap-2">
				<button
					aria-label={i18n(I18nKey.postListLayoutList)}
					class="flex-1 btn-regular rounded-md py-2 px-3 flex items-center justify-center gap-2 active:scale-95 transition-all relative overflow-hidden"
					class:opacity-60={currentLayout !== 'list'}
					class:bg-(--btn-regular-bg-hover)={currentLayout === 'list'}
					disabled={isSwitching}
					onclick={switchLayout}
					title={i18n(I18nKey.postListLayoutList)}
				>
					<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
						<path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>
					</svg>
					<span class="text-xs font-medium">{i18n(I18nKey.postListLayoutList)}</span>
				</button>
				<button
					aria-label={i18n(I18nKey.postListLayoutGrid)}
					class="flex-1 btn-regular rounded-md py-2 px-3 flex items-center justify-center gap-2 active:scale-95 transition-all relative overflow-hidden"
					class:opacity-60={currentLayout !== 'grid'}
					class:bg-(--btn-regular-bg-hover)={currentLayout === 'grid'}
					disabled={isSwitching}
					onclick={switchLayout}
					title={i18n(I18nKey.postListLayoutGrid)}
				>
					<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
						<path d="M3 3h7v7H3V3zm0 11h7v7H3v-7zm11-11h7v7h-7V3zm0 11h7v7h-7v-7z"/>
					</svg>
					<span class="text-xs font-medium">{i18n(I18nKey.postListLayoutGrid)}</span>
				</button>
			</div>
		</div>
		{/if}

		<!-- Card Settings Section -->
		{#if isCardBorderSwitchable || isCardFollowThemeSwitchable}
		<div>
			<div class="section-title">
				{i18n(I18nKey.cardSettings)}
				<button aria-label="Reset to Default" class="btn-regular rounded-md active:scale-90"
						class:opacity-0={cardSettingsIsDefault} class:pointer-events-none={cardSettingsIsDefault}
						disabled={cardSettingsIsDefault} aria-hidden={cardSettingsIsDefault ? "true" : undefined} onclick={resetCardSettings}>
					<div class="text-(--btn-content)">
						<Icon icon="fa7-solid:arrow-rotate-left" class="text-[0.75rem]"></Icon>
					</div>
				</button>
			</div>
			<div class="space-y-1">
				{#if isCardBorderSwitchable}
				<button
					class="w-full btn-regular rounded-md py-2 px-3 flex items-center gap-3 text-left active:scale-95 transition-all relative overflow-hidden"
					class:bg-(--btn-regular-bg-hover)={cardBorderEnabled}
					onclick={toggleCardBorderEnabled}
				>
					<Icon icon="material-symbols:border-outer-rounded" class="text-[1.25rem] shrink-0"></Icon>
					<span class="text-sm flex-1">{i18n(I18nKey.cardBorder)}</span>
					<div class="w-10 h-5 rounded-full transition-all duration-200 relative"
						 class:bg-(--primary)={cardBorderEnabled}
						 class:bg-(--btn-regular-bg-active)={!cardBorderEnabled}>
						<div class="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200"
							 class:left-0.5={!cardBorderEnabled}
							 class:left-5={cardBorderEnabled}></div>
					</div>
				</button>
				{/if}
				{#if isCardFollowThemeSwitchable}
				<button
					class="w-full btn-regular rounded-md py-2 px-3 flex items-center gap-3 text-left active:scale-95 transition-all relative overflow-hidden"
					class:bg-(--btn-regular-bg-hover)={cardFollowThemeEnabled}
					onclick={toggleCardFollowThemeEnabled}
				>
					<Icon icon="material-symbols:palette" class="text-[1.25rem] shrink-0"></Icon>
					<span class="text-sm flex-1">{i18n(I18nKey.cardFollowTheme)}</span>
					<div class="w-10 h-5 rounded-full transition-all duration-200 relative"
						 class:bg-(--primary)={cardFollowThemeEnabled}
						 class:bg-(--btn-regular-bg-active)={!cardFollowThemeEnabled}>
						<div class="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200"
							 class:left-0.5={!cardFollowThemeEnabled}
							 class:left-5={cardFollowThemeEnabled}></div>
					</div>
				</button>
				{/if}
			</div>
		</div>
		{/if}
	{/if}

	<!-- Wallpaper Tab: Mode + Overlay + Banner Settings -->
	{#if activeTab === "wallpaper"}
		<!-- Wallpaper Mode Section -->
		{#if isWallpaperSwitchable}
		<div>
			<div class="section-title">
				{i18n(I18nKey.wallpaperMode)}
				<button aria-label="Reset to Default" class="btn-regular rounded-md active:scale-90"
						class:opacity-0={wallpaperMode === defaultWallpaperMode} class:pointer-events-none={wallpaperMode === defaultWallpaperMode}
						disabled={wallpaperMode === defaultWallpaperMode} aria-hidden={wallpaperMode === defaultWallpaperMode ? "true" : undefined} onclick={resetWallpaperMode}>
					<div class="text-(--btn-content)">
						<Icon icon="fa7-solid:arrow-rotate-left" class="text-[0.75rem]"></Icon>
					</div>
				</button>
			</div>
			<div class="grid grid-cols-2 gap-2">
				<button
					class="btn-regular rounded-md py-2 px-3 flex items-center justify-center gap-2 active:scale-95 transition-all relative overflow-hidden"
					class:opacity-60={wallpaperMode !== WALLPAPER_BANNER}
					class:bg-(--btn-regular-bg-hover)={wallpaperMode === WALLPAPER_BANNER}
					onclick={() => switchWallpaperMode(WALLPAPER_BANNER)}
				>
					<Icon icon="material-symbols:image-outline" class="text-[1.25rem] shrink-0"></Icon>
					<span class="text-xs font-medium">{i18n(I18nKey.wallpaperBannerMode)}</span>
				</button>
				<button
					class="btn-regular rounded-md py-2 px-3 flex items-center justify-center gap-2 active:scale-95 transition-all relative overflow-hidden"
					class:opacity-60={wallpaperMode !== WALLPAPER_FULLSCREEN}
					class:bg-(--btn-regular-bg-hover)={wallpaperMode === WALLPAPER_FULLSCREEN}
					onclick={() => switchWallpaperMode(WALLPAPER_FULLSCREEN)}
				>
					<Icon icon="material-symbols:wallpaper" class="text-[1.25rem] shrink-0"></Icon>
					<span class="text-xs font-medium">{i18n(I18nKey.wallpaperFullscreenMode)}</span>
				</button>
				<button
					class="btn-regular rounded-md py-2 px-3 flex items-center justify-center gap-2 active:scale-95 transition-all relative overflow-hidden"
					class:opacity-60={wallpaperMode !== WALLPAPER_OVERLAY}
					class:bg-(--btn-regular-bg-hover)={wallpaperMode === WALLPAPER_OVERLAY}
					onclick={() => switchWallpaperMode(WALLPAPER_OVERLAY)}
				>
					<Icon icon="material-symbols:full-coverage-outline-rounded" class="text-[1.25rem] shrink-0"></Icon>
					<span class="text-xs font-medium">{i18n(I18nKey.wallpaperOverlayMode)}</span>
				</button>
				<button
					class="btn-regular rounded-md py-2 px-3 flex items-center justify-center gap-2 active:scale-95 transition-all relative overflow-hidden"
					class:opacity-60={wallpaperMode !== WALLPAPER_NONE}
					class:bg-(--btn-regular-bg-hover)={wallpaperMode === WALLPAPER_NONE}
					onclick={() => switchWallpaperMode(WALLPAPER_NONE)}
				>
					<Icon icon="material-symbols:hide-image-outline" class="text-[1.25rem] shrink-0"></Icon>
					<span class="text-xs font-medium">{i18n(I18nKey.wallpaperNoneMode)}</span>
				</button>
			</div>
		</div>
		{/if}

		<!-- Fullscreen Layout Section -->
		{#if isFullscreenLayoutSwitchable}
		<div>
			<div class="section-title">
				{i18n(I18nKey.fullscreenLayout)}
				<button aria-label="Reset to Default" class="btn-regular rounded-md active:scale-90"
						class:opacity-0={fullscreenLayout === defaultFullscreenLayout} class:pointer-events-none={fullscreenLayout === defaultFullscreenLayout}
						disabled={fullscreenLayout === defaultFullscreenLayout} aria-hidden={fullscreenLayout === defaultFullscreenLayout ? "true" : undefined} onclick={resetFullscreenLayout}>
					<div class="text-(--btn-content)">
						<Icon icon="fa7-solid:arrow-rotate-left" class="text-[0.75rem]"></Icon>
					</div>
				</button>
			</div>
			<div class="grid grid-cols-2 gap-2">
				<button
					class="btn-regular rounded-md py-2 px-3 flex items-center justify-center gap-2 active:scale-95 transition-all relative overflow-hidden"
					class:opacity-60={fullscreenLayout !== "classic"}
					class:bg-(--btn-regular-bg-hover)={fullscreenLayout === "classic"}
					onclick={() => switchFullscreenLayout("classic")}
				>
					<Icon icon="material-symbols:view-day-outline" class="text-[1.25rem] shrink-0"></Icon>
					<span class="text-xs font-medium">{i18n(I18nKey.fullscreenClassicLayout)}</span>
				</button>
				<button
					class="btn-regular rounded-md py-2 px-3 flex items-center justify-center gap-2 active:scale-95 transition-all relative overflow-hidden"
					class:opacity-60={fullscreenLayout !== "hero"}
					class:bg-(--btn-regular-bg-hover)={fullscreenLayout === "hero"}
					onclick={() => switchFullscreenLayout("hero")}
				>
					<Icon icon="material-symbols:desktop-landscape-outline-rounded" class="text-[1.25rem] shrink-0"></Icon>
					<span class="text-xs font-medium">{i18n(I18nKey.fullscreenHeroLayout)}</span>
				</button>
			</div>
		</div>
		{/if}

		<!-- Overlay Settings Section（全屏壁纸模式也复用 overlay 的透明/模糊/卡片透明度设置） -->
		{#if (wallpaperMode === WALLPAPER_OVERLAY || (wallpaperMode === WALLPAPER_FULLSCREEN && fullscreenLayout === "hero")) && hasOverlaySettings && hasVisibleOverlaySlider}
		<div class="">
			<div class="section-title">
				{i18n(I18nKey.overlaySettings)}
				<button aria-label="Reset to Default" class="btn-regular rounded-md active:scale-90"
						class:opacity-0={overlaySettingsIsDefault} class:pointer-events-none={overlaySettingsIsDefault}
						disabled={overlaySettingsIsDefault} aria-hidden={overlaySettingsIsDefault ? "true" : undefined} onclick={resetOverlaySettings}>
					<div class="text-(--btn-content)">
						<Icon icon="fa7-solid:arrow-rotate-left" class="text-[0.75rem]"></Icon>
					</div>
				</button>
			</div>
			<div class="space-y-2">
				{#each overlaySliderItems as item (item.key)}
					{#if item.enabled}
						<div class="rounded-md bg-(--btn-regular-bg) p-2">
							<div class="flex items-center justify-between mb-1">
								<span class="text-xs font-medium text-(--btn-content) opacity-80">{item.label}</span>
								<span class="text-xs text-(--btn-content)">{item.displayValue}</span>
							</div>
							<input
								aria-label={item.ariaLabel}
								type="range"
								min={item.min}
								max={item.max}
								step={item.step}
								value={item.value}
								oninput={(e) => item.onValueChange(Number((e.currentTarget as HTMLInputElement).value))}
								class="slider w-full overlay-slider"
							/>
						</div>
					{/if}
				{/each}
			</div>
		</div>
		{/if}

		<!-- Banner Settings Section -->
		{#if (wallpaperMode === WALLPAPER_BANNER || wallpaperMode === WALLPAPER_FULLSCREEN) && hasBannerSettings}
		<div class="">
			<div class="section-title">
				{i18n(I18nKey.wallpaperSettings)}
				<button aria-label="Reset to Default" class="btn-regular rounded-md active:scale-90"
						class:opacity-0={bannerSettingsIsDefault} class:pointer-events-none={bannerSettingsIsDefault}
						disabled={bannerSettingsIsDefault} aria-hidden={bannerSettingsIsDefault ? "true" : undefined} onclick={resetBannerSettings}>
					<div class="text-(--btn-content)">
						<Icon icon="fa7-solid:arrow-rotate-left" class="text-[0.75rem]"></Icon>
					</div>
				</button>
			</div>
			<div class="space-y-1">
				<!-- Banner Title Switch -->
				{#if isBannerTitleSwitchable}
				<button
					class="w-full btn-regular rounded-md py-2 px-3 flex items-center gap-3 text-left active:scale-95 transition-all relative overflow-hidden"
					class:bg-(--btn-regular-bg-hover)={bannerTitleEnabled}
					onclick={toggleBannerTitleEnabled}
				>
					<Icon icon="material-symbols:titlecase-rounded" class="text-[1.25rem] shrink-0"></Icon>
					<span class="text-sm flex-1">{i18n(I18nKey.wallpaperTitle)}</span>
					<div class="w-10 h-5 rounded-full transition-all duration-200 relative"
						 class:bg-(--primary)={bannerTitleEnabled}
						 class:bg-(--btn-regular-bg-active)={!bannerTitleEnabled}>
						<div class="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200"
							 class:left-0.5={!bannerTitleEnabled}
							 class:left-5={bannerTitleEnabled}></div>
					</div>
				</button>
				{/if}
				<!-- Banner Carousel Switch -->
				{#if isBannerCarouselSwitchable}
				<button
					class="w-full btn-regular rounded-md py-2 px-3 flex items-center gap-3 text-left active:scale-95 transition-all relative overflow-hidden"
					class:bg-(--btn-regular-bg-hover)={bannerCarouselEnabled}
					onclick={toggleBannerCarouselEnabled}
				>
					<Icon icon="material-symbols:view-carousel-outline" class="text-[1.25rem] shrink-0"></Icon>
					<span class="text-sm flex-1">{i18n(I18nKey.wallpaperCarousel)}</span>
					<div class="w-10 h-5 rounded-full transition-all duration-200 relative"
						 class:bg-(--primary)={bannerCarouselEnabled}
						 class:bg-(--btn-regular-bg-active)={!bannerCarouselEnabled}>
						<div class="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200"
							 class:left-0.5={!bannerCarouselEnabled}
							 class:left-5={bannerCarouselEnabled}></div>
					</div>
				</button>
				{/if}
				<!-- Waves Animation Switch（横幅模式和 classic 全屏模式） -->
				{#if isWavesSwitchable && (wallpaperMode === WALLPAPER_BANNER || (wallpaperMode === WALLPAPER_FULLSCREEN && fullscreenLayout === "classic"))}
				<button
					class="w-full btn-regular rounded-md py-2 px-3 flex items-center gap-3 text-left active:scale-95 transition-all relative overflow-hidden"
					class:bg-(--btn-regular-bg-hover)={wavesEnabled}
					onclick={toggleWavesEnabled}
				>
					<Icon icon="material-symbols:airwave-rounded" class="text-[1.25rem] shrink-0"></Icon>
					<span class="text-sm flex-1">{i18n(I18nKey.wavesAnimation)}</span>
					<div class="w-10 h-5 rounded-full transition-all duration-200 relative"
						 class:bg-(--primary)={wavesEnabled}
						 class:bg-(--btn-regular-bg-active)={!wavesEnabled}>
						<div class="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200"
							 class:left-0.5={!wavesEnabled}
							 class:left-5={wavesEnabled}></div>
					</div>
				</button>
				{/if}
				<!-- Gradient Transition Switch（横幅模式和 classic 全屏模式） -->
				{#if isGradientSwitchable && (wallpaperMode === WALLPAPER_BANNER || (wallpaperMode === WALLPAPER_FULLSCREEN && fullscreenLayout === "classic"))}
				<button
					class="w-full btn-regular rounded-md py-2 px-3 flex items-center gap-3 text-left active:scale-95 transition-all relative overflow-hidden"
					class:bg-(--btn-regular-bg-hover)={gradientEnabled}
					onclick={toggleGradientEnabled}
				>
					<Icon icon="material-symbols:gradient" class="text-[1.25rem] shrink-0"></Icon>
					<span class="text-sm flex-1">{i18n(I18nKey.gradientTransition)}</span>
					<div class="w-10 h-5 rounded-full transition-all duration-200 relative"
						 class:bg-(--primary)={gradientEnabled}
						 class:bg-(--btn-regular-bg-active)={!gradientEnabled}>
						<div class="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200"
							 class:left-0.5={!gradientEnabled}
							 class:left-5={gradientEnabled}></div>
					</div>
				</button>
				{/if}
			</div>
		</div>
		{/if}
	{/if}

	<!-- Effects Tab: Sakura -->
	{#if activeTab === "effects"}
		{#if isSakuraSwitchable}
		<div class="">
			<div class="section-title">
				{i18n(I18nKey.effectsSettings)}
				<button aria-label="Reset to Default" class="btn-regular rounded-md active:scale-90"
						class:opacity-0={sakuraEnabled === defaultSakuraEnabled} class:pointer-events-none={sakuraEnabled === defaultSakuraEnabled}
						disabled={sakuraEnabled === defaultSakuraEnabled} aria-hidden={sakuraEnabled === defaultSakuraEnabled ? "true" : undefined}
						onclick={() => { sakuraEnabled = defaultSakuraEnabled; setSakuraEnabled(defaultSakuraEnabled); }}>
					<div class="text-(--btn-content)">
						<Icon icon="fa7-solid:arrow-rotate-left" class="text-[0.75rem]"></Icon>
					</div>
				</button>
			</div>
			<button
				class="w-full btn-regular rounded-md py-2 px-3 flex items-center gap-3 text-left active:scale-95 transition-all relative overflow-hidden"
				class:bg-(--btn-regular-bg-hover)={sakuraEnabled}
				onclick={toggleSakuraEnabled}
			>
				<Icon icon="mdi:flower-poppy" class="text-[1.25rem] shrink-0"></Icon>
				<span class="text-sm flex-1">{i18n(I18nKey.sakuraEffect)}</span>
				<div class="w-10 h-5 rounded-full transition-all duration-200 relative"
					 class:bg-(--primary)={sakuraEnabled}
					 class:bg-(--btn-regular-bg-active)={!sakuraEnabled}>
					<div class="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all duration-200"
						 class:left-0.5={!sakuraEnabled}
						 class:left-5={sakuraEnabled}></div>
				</div>
			</button>
		</div>
		{/if}
	{/if}
</div>
{/if}
