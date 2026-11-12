<script lang="ts">
import { onMount } from "svelte";
import { getHue } from "@/utils/setting-utils";

interface Props {
	open: boolean;
	onClose: () => void;
}

const { open, onClose }: Props = $props();

export type ChatColorScheme = "follow" | "light" | "dark";

export interface ChatAppearanceSettings {
	bgBlur: number;
	panelBlur: number;
	panelOpacity: number;
	bgDim: number;
	panelRadius: number;
	chatScheme: ChatColorScheme;
	chatHue: number | null;
}

const STORAGE_KEY = "fireflyChatAppearance";

const DEFAULT_SETTINGS: ChatAppearanceSettings = {
	bgBlur: 8,
	panelBlur: 12,
	panelOpacity: 45,
	bgDim: 0,
	panelRadius: 16,
	chatScheme: "follow",
	chatHue: null,
};

const PRESETS: {
	id: string;
	label: string;
	values: Pick<
		ChatAppearanceSettings,
		"bgBlur" | "panelBlur" | "panelOpacity" | "bgDim" | "panelRadius"
	>;
}[] = [
	{
		id: "default",
		label: "当前默认",
		values: {
			bgBlur: 8,
			panelBlur: 12,
			panelOpacity: 45,
			bgDim: 0,
			panelRadius: 16,
		},
	},
	{
		id: "same-blur",
		label: "同频全模糊",
		values: {
			bgBlur: 12,
			panelBlur: 12,
			panelOpacity: 48,
			bgDim: 8,
			panelRadius: 16,
		},
	},
	{
		id: "airy",
		label: "清透原图",
		values: {
			bgBlur: 2,
			panelBlur: 16,
			panelOpacity: 42,
			bgDim: 4,
			panelRadius: 16,
		},
	},
	{
		id: "readable",
		label: "高对比护眼",
		values: {
			bgBlur: 10,
			panelBlur: 20,
			panelOpacity: 72,
			bgDim: 14,
			panelRadius: 16,
		},
	},
];

type GlassSliderKey =
	| "bgBlur"
	| "panelBlur"
	| "panelOpacity"
	| "bgDim"
	| "panelRadius";

const SLIDER_SPECS: {
	key: GlassSliderKey;
	label: string;
	min: number;
	max: number;
	step: number;
	unit: string;
}[] = [
	{
		key: "bgBlur",
		label: "背景壁纸模糊",
		min: 0,
		max: 24,
		step: 1,
		unit: "px",
	},
	{
		key: "panelBlur",
		label: "面板毛玻璃模糊",
		min: 0,
		max: 32,
		step: 1,
		unit: "px",
	},
	{
		key: "panelOpacity",
		label: "面板遮罩浓度",
		min: 15,
		max: 95,
		step: 1,
		unit: "%",
	},
	{ key: "bgDim", label: "背景压暗遮罩", min: 0, max: 60, step: 2, unit: "%" },
	{
		key: "panelRadius",
		label: "面板圆角弧度",
		min: 8,
		max: 24,
		step: 2,
		unit: "px",
	},
];

let activeTab = $state<"glass" | "theme">("glass");
let settings = $state<ChatAppearanceSettings>({ ...DEFAULT_SETTINGS });
let globalHue = $state(355);
let popoverEl: HTMLDivElement | null = $state(null);

const displayedHue = $derived(settings.chatHue ?? globalHue);

const isGlassDefault = $derived(
	settings.bgBlur === DEFAULT_SETTINGS.bgBlur &&
		settings.panelBlur === DEFAULT_SETTINGS.panelBlur &&
		settings.panelOpacity === DEFAULT_SETTINGS.panelOpacity &&
		settings.bgDim === DEFAULT_SETTINGS.bgDim &&
		settings.panelRadius === DEFAULT_SETTINGS.panelRadius,
);

const isThemeDefault = $derived(
	settings.chatScheme === DEFAULT_SETTINGS.chatScheme &&
		settings.chatHue === DEFAULT_SETTINGS.chatHue,
);

function clampInt(
	val: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	const num = Number(val);
	if (!Number.isFinite(num)) return fallback;
	return Math.min(max, Math.max(min, Math.round(num)));
}

function loadStoredSettings(): ChatAppearanceSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<ChatAppearanceSettings>;
		const scheme: ChatColorScheme =
			parsed.chatScheme === "light" || parsed.chatScheme === "dark"
				? parsed.chatScheme
				: "follow";
		const chatHue =
			typeof parsed.chatHue === "number" && Number.isFinite(parsed.chatHue)
				? clampInt(parsed.chatHue, 0, 360, 0)
				: null;

		return {
			bgBlur: clampInt(parsed.bgBlur, 0, 24, DEFAULT_SETTINGS.bgBlur),
			panelBlur: clampInt(parsed.panelBlur, 0, 32, DEFAULT_SETTINGS.panelBlur),
			panelOpacity: clampInt(
				parsed.panelOpacity,
				15,
				95,
				DEFAULT_SETTINGS.panelOpacity,
			),
			bgDim: clampInt(parsed.bgDim, 0, 60, DEFAULT_SETTINGS.bgDim),
			panelRadius: clampInt(
				parsed.panelRadius,
				8,
				24,
				DEFAULT_SETTINGS.panelRadius,
			),
			chatScheme: scheme,
			chatHue,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

function applySettingsToChatOnly(next: ChatAppearanceSettings, persist = true) {
	if (typeof document === "undefined") return;
	const root = document.documentElement;

	root.style.setProperty("--chat-bg-blur", `${next.bgBlur}px`);
	root.style.setProperty("--chat-bg-dim", String(next.bgDim / 100));
	root.style.setProperty("--chat-panel-blur", `${next.panelBlur}px`);
	root.style.setProperty("--chat-panel-opacity", `${next.panelOpacity}%`);
	root.style.setProperty("--chat-panel-radius", `${next.panelRadius}px`);

	if (next.chatScheme === "follow") {
		root.removeAttribute("data-chat-scheme");
	} else {
		root.setAttribute("data-chat-scheme", next.chatScheme);
	}

	if (next.chatHue === null) {
		root.removeAttribute("data-chat-custom-hue");
		root.style.removeProperty("--chat-hue");
	} else {
		root.setAttribute("data-chat-custom-hue", "true");
		root.style.setProperty("--chat-hue", String(next.chatHue));
	}

	if (persist) {
		try {
			const isAllDefault =
				next.bgBlur === DEFAULT_SETTINGS.bgBlur &&
				next.panelBlur === DEFAULT_SETTINGS.panelBlur &&
				next.panelOpacity === DEFAULT_SETTINGS.panelOpacity &&
				next.bgDim === DEFAULT_SETTINGS.bgDim &&
				next.panelRadius === DEFAULT_SETTINGS.panelRadius &&
				next.chatScheme === DEFAULT_SETTINGS.chatScheme &&
				next.chatHue === DEFAULT_SETTINGS.chatHue;
			if (isAllDefault) {
				localStorage.removeItem(STORAGE_KEY);
			} else {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			}
		} catch {
			// 忽略存储限制
		}
	}
}

function updateSetting<K extends keyof ChatAppearanceSettings>(
	key: K,
	value: ChatAppearanceSettings[K],
) {
	settings = { ...settings, [key]: value };
	applySettingsToChatOnly(settings, true);
}

function applyPreset(
	values: Pick<
		ChatAppearanceSettings,
		"bgBlur" | "panelBlur" | "panelOpacity" | "bgDim" | "panelRadius"
	>,
) {
	settings = { ...settings, ...values };
	applySettingsToChatOnly(settings, true);
}

function resetGlass() {
	settings = {
		...settings,
		bgBlur: DEFAULT_SETTINGS.bgBlur,
		panelBlur: DEFAULT_SETTINGS.panelBlur,
		panelOpacity: DEFAULT_SETTINGS.panelOpacity,
		bgDim: DEFAULT_SETTINGS.bgDim,
		panelRadius: DEFAULT_SETTINGS.panelRadius,
	};
	applySettingsToChatOnly(settings, true);
}

function resetTheme() {
	settings = {
		...settings,
		chatScheme: DEFAULT_SETTINGS.chatScheme,
		chatHue: DEFAULT_SETTINGS.chatHue,
	};
	applySettingsToChatOnly(settings, true);
}

function isPresetActive(
	values: Pick<
		ChatAppearanceSettings,
		"bgBlur" | "panelBlur" | "panelOpacity" | "bgDim" | "panelRadius"
	>,
): boolean {
	return (
		settings.bgBlur === values.bgBlur &&
		settings.panelBlur === values.panelBlur &&
		settings.panelOpacity === values.panelOpacity &&
		settings.bgDim === values.bgDim &&
		settings.panelRadius === values.panelRadius
	);
}

function rangeRatio(value: number, min: number, max: number): string {
	const ratio = (value - min) / (max - min);
	return Math.min(1, Math.max(0, ratio)).toFixed(4);
}

onMount(() => {
	globalHue = getHue();
	settings = loadStoredSettings();
	applySettingsToChatOnly(settings, false);

	const syncGlobalHue = () => {
		requestAnimationFrame(() => {
			globalHue = getHue();
		});
	};

	const handlePointerDown = (e: PointerEvent) => {
		if (!open) return;
		const target = e.target as HTMLElement | null;
		if (!target) return;
		if (popoverEl?.contains(target)) return;
		if (target.closest("[data-chat-settings-trigger]")) return;
		onClose();
	};

	const handleKeydown = (e: KeyboardEvent) => {
		if (open && e.key === "Escape") {
			onClose();
		}
	};

	window.addEventListener("wallpaperChange", syncGlobalHue);
	window.addEventListener("themeHueModeChange", syncGlobalHue);
	document.addEventListener("pointerdown", handlePointerDown);
	document.addEventListener("keydown", handleKeydown);

	return () => {
		window.removeEventListener("wallpaperChange", syncGlobalHue);
		window.removeEventListener("themeHueModeChange", syncGlobalHue);
		document.removeEventListener("pointerdown", handlePointerDown);
		document.removeEventListener("keydown", handleKeydown);
	};
});
</script>

{#if open}
  <div
    bind:this={popoverEl}
    class="chat-settings-popover"
    role="dialog"
    aria-label="聊天室外观设置（仅当前页面生效）"
  >
    <div class="flex gap-1 border-b border-black/5 dark:border-white/10 pt-3 pb-1 mb-2">
      <button
        type="button"
        class="flex-1 flex items-center justify-center gap-1.5 py-2 px-2 text-xs font-medium transition-colors rounded-lg cursor-pointer border-none
          {activeTab === 'glass'
            ? 'bg-(--btn-plain-bg-hover) text-(--primary)'
            : 'bg-transparent text-neutral-500 dark:text-neutral-400 hover:bg-(--btn-plain-bg-hover) hover:text-neutral-700 dark:hover:text-neutral-300'}"
        onclick={() => (activeTab = "glass")}
      >
        <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="M9 3v18" />
        </svg>
        <span>玻璃与模糊</span>
      </button>
      <button
        type="button"
        class="flex-1 flex items-center justify-center gap-1.5 py-2 px-2 text-xs font-medium transition-colors rounded-lg cursor-pointer border-none
          {activeTab === 'theme'
            ? 'bg-(--btn-plain-bg-hover) text-(--primary)'
            : 'bg-transparent text-neutral-500 dark:text-neutral-400 hover:bg-(--btn-plain-bg-hover) hover:text-neutral-700 dark:hover:text-neutral-300'}"
        onclick={() => (activeTab = "theme")}
      >
        <svg class="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
          <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
          <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
          <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
        </svg>
        <span>主题配色</span>
      </button>
    </div>

    {#if activeTab === "glass"}
      <div>
        <div class="chat-settings-section-title">
          <span>风格预设</span>
          {#if !isGlassDefault}
            <button
              type="button"
              aria-label="恢复默认参数"
              title="恢复默认参数"
              class="btn-regular chat-settings-reset-btn rounded-md active:scale-90 cursor-pointer border-none"
              onclick={resetGlass}
            >
              <svg class="w-3 h-3 text-(--btn-content)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          {/if}
          <span class="ml-auto text-[0.6875rem] font-normal text-(--content-meta)">仅作用于聊天页</span>
        </div>

        <div class="grid grid-cols-2 gap-1.5 mb-2">
          {#each PRESETS as preset (preset.id)}
            {@const active = isPresetActive(preset.values)}
            <button
              type="button"
              class="btn-regular rounded-md py-2 px-2.5 text-xs font-medium active:scale-95 transition-all cursor-pointer border-none
                {active ? 'bg-(--btn-regular-bg-hover) text-(--primary) font-semibold' : 'opacity-75'}"
              onclick={() => applyPreset(preset.values)}
            >
              {preset.label}
            </button>
          {/each}
        </div>
      </div>

      <div>
        <div class="chat-settings-section-title">
          <span>模糊与遮罩</span>
        </div>
        <div class="rounded-xl bg-(--btn-regular-bg) px-3 py-2.5 space-y-2.5">
          {#each SLIDER_SPECS as spec (spec.key)}
            {@const value = settings[spec.key]}
            <div>
              <div class="flex items-center justify-between mb-1">
                <span class="text-xs font-medium text-(--btn-content) opacity-85">{spec.label}</span>
                <span class="text-xs font-mono text-(--btn-content)">{value}{spec.unit}</span>
              </div>
              <div class="chat-slider-control" style="--ratio: {rangeRatio(value, spec.min, spec.max)};">
                <div class="chat-slider-track">
                  <div class="chat-slider-fill"></div>
                </div>
                <div class="chat-slider-thumb"></div>
                <input
                  aria-label={spec.label}
                  type="range"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step}
                  value={value}
                  class="chat-slider-native"
                  oninput={(e) => updateSetting(spec.key, Number(e.currentTarget.value))}
                />
              </div>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <div>
        <div class="chat-settings-section-title">
          <span>聊天主题色</span>
          {#if !isThemeDefault}
            <button
              type="button"
              aria-label="重置聊天室主题色"
              title="重置聊天室主题色"
              class="btn-regular chat-settings-reset-btn rounded-md active:scale-90 cursor-pointer border-none"
              onclick={resetTheme}
            >
              <svg class="w-3 h-3 text-(--btn-content)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          {/if}
          <div class="ml-auto px-2 h-6 bg-(--btn-regular-bg) rounded-md flex items-center justify-center text-xs font-bold text-(--btn-content)">
            {settings.chatHue === null ? `随全站 (${displayedHue})` : displayedHue}
          </div>
        </div>

        <div class="w-full rounded-md bg-(--btn-regular-bg) px-2.5 py-2 select-none mb-2">
          <div class="chat-slider-control" style="--ratio: {rangeRatio(displayedHue, 0, 360)};">
            <div class="chat-slider-track chat-slider-track--hue"></div>
            <div class="chat-slider-thumb chat-slider-thumb--hue"></div>
            <input
              aria-label="聊天室主题色相"
              type="range"
              min="0"
              max="360"
              step="5"
              value={displayedHue}
              class="chat-slider-native"
              oninput={(e) => updateSetting("chatHue", Number(e.currentTarget.value))}
            />
          </div>
        </div>

        {#if settings.chatHue !== null}
          <button
            type="button"
            class="w-full btn-regular rounded-md py-1.5 px-3 text-xs font-medium active:scale-95 transition-all cursor-pointer border-none mb-1"
            onclick={() => updateSetting("chatHue", null)}
          >
            恢复跟随全站色相
          </button>
        {/if}
      </div>

      <div>
        <div class="chat-settings-section-title">
          <span>玻璃明暗风格</span>
        </div>
        <div class="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            class="btn-regular rounded-md py-2 px-2 text-xs font-medium active:scale-95 transition-all cursor-pointer border-none
              {settings.chatScheme === 'follow' ? 'bg-(--btn-regular-bg-hover) text-(--primary) font-semibold' : 'opacity-70'}"
            onclick={() => updateSetting("chatScheme", "follow")}
          >
            跟随全站
          </button>
          <button
            type="button"
            class="btn-regular rounded-md py-2 px-2 text-xs font-medium active:scale-95 transition-all cursor-pointer border-none
              {settings.chatScheme === 'light' ? 'bg-(--btn-regular-bg-hover) text-(--primary) font-semibold' : 'opacity-70'}"
            onclick={() => updateSetting("chatScheme", "light")}
          >
            浅色玻璃
          </button>
          <button
            type="button"
            class="btn-regular rounded-md py-2 px-2 text-xs font-medium active:scale-95 transition-all cursor-pointer border-none
              {settings.chatScheme === 'dark' ? 'bg-(--btn-regular-bg-hover) text-(--primary) font-semibold' : 'opacity-70'}"
            onclick={() => updateSetting("chatScheme", "dark")}
          >
            深色玻璃
          </button>
        </div>
      </div>
    {/if}
  </div>
{/if}
