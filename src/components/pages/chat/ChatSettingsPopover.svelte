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
	chatScheme: ChatColorScheme;
	chatHue: number | null;
}

const STORAGE_KEY = "fireflyChatAppearance";

const DEFAULT_SETTINGS: ChatAppearanceSettings = {
	chatScheme: "follow",
	chatHue: null,
};

let settings = $state<ChatAppearanceSettings>({ ...DEFAULT_SETTINGS });
let globalHue = $state(350);
let popoverEl: HTMLDivElement | null = $state(null);

const displayedHue = $derived(settings.chatHue ?? globalHue);

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

	// 清理旧版毛玻璃专属遗留 CSS 变量
	root.style.removeProperty("--chat-bg-blur");
	root.style.removeProperty("--chat-bg-dim");
	root.style.removeProperty("--chat-panel-blur");
	root.style.removeProperty("--chat-panel-opacity");
	root.style.removeProperty("--chat-panel-radius");

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
			localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch {}
	}
}

function updateSetting<K extends keyof ChatAppearanceSettings>(
	key: K,
	value: ChatAppearanceSettings[K],
) {
	const next = { ...settings, [key]: value };
	settings = next;
	applySettingsToChatOnly(next, true);
}

function resetTheme() {
	const next: ChatAppearanceSettings = {
		...settings,
		chatScheme: "follow",
		chatHue: null,
	};
	settings = next;
	applySettingsToChatOnly(next, true);
}

function rangeRatio(val: number, min: number, max: number): string {
	if (max <= min) return "0%";
	const clamped = Math.min(max, Math.max(min, val));
	return `${(((clamped - min) / (max - min)) * 100).toFixed(1)}%`;
}

onMount(() => {
	globalHue = getHue();
	settings = loadStoredSettings();
	applySettingsToChatOnly(settings, false);

	const handleHueChange = () => {
		globalHue = getHue();
	};
	window.addEventListener("hue-change", handleHueChange);

	const handlePointerDownOutside = (e: PointerEvent) => {
		if (!open) return;
		const target = e.target as HTMLElement | null;
		if (!target) return;
		if (target.closest("[data-chat-settings-trigger]")) return;
		if (popoverEl && !popoverEl.contains(target)) {
			onClose();
		}
	};
	window.addEventListener("pointerdown", handlePointerDownOutside, true);

	return () => {
		window.removeEventListener("hue-change", handleHueChange);
		window.removeEventListener("pointerdown", handlePointerDownOutside, true);
	};
});
</script>

{#if open}
  <div
    bind:this={popoverEl}
    class="chat-settings-popover"
    role="dialog"
    aria-label="聊天室外观与主题设置"
  >
    <div class="flex items-center justify-between pb-2 mb-2 border-b border-[var(--skin-line)]">
      <div class="flex items-center gap-1.5 font-semibold text-sm text-[var(--skin-text)]">
        <svg class="w-4 h-4 text-[var(--skin-accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>聊天室外观</span>
      </div>
      <button
        type="button"
        class="w-6 h-6 rounded-md hover:bg-[var(--btn-plain-bg-hover)] text-[var(--skin-text-mute)] hover:text-[var(--skin-text)] inline-flex items-center justify-center transition-colors border-none bg-transparent cursor-pointer"
        aria-label="关闭设置面板"
        onclick={onClose}
      >
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>

    <div class="space-y-3.5">
      <!-- 1. 外观明暗风格 -->
      <div>
        <div class="chat-settings-section-title">
          <span>外观明暗</span>
        </div>
        <div class="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            class="btn-regular rounded-lg py-1.5 px-2 text-xs font-medium active:scale-95 transition-all cursor-pointer border-none
              {settings.chatScheme === 'follow' ? 'bg-[var(--skin-accent-soft)] text-[var(--skin-accent)] font-semibold' : 'text-[var(--skin-text-dim)]'}"
            onclick={() => updateSetting("chatScheme", "follow")}
          >
            跟随全站
          </button>
          <button
            type="button"
            class="btn-regular rounded-lg py-1.5 px-2 text-xs font-medium active:scale-95 transition-all cursor-pointer border-none
              {settings.chatScheme === 'light' ? 'bg-[var(--skin-accent-soft)] text-[var(--skin-accent)] font-semibold' : 'text-[var(--skin-text-dim)]'}"
            onclick={() => updateSetting("chatScheme", "light")}
          >
            浅色奶灰
          </button>
          <button
            type="button"
            class="btn-regular rounded-lg py-1.5 px-2 text-xs font-medium active:scale-95 transition-all cursor-pointer border-none
              {settings.chatScheme === 'dark' ? 'bg-[var(--skin-accent-soft)] text-[var(--skin-accent)] font-semibold' : 'text-[var(--skin-text-dim)]'}"
            onclick={() => updateSetting("chatScheme", "dark")}
          >
            深色石墨
          </button>
        </div>
      </div>

      <!-- 2. 主题色彩 -->
      <div>
        <div class="chat-settings-section-title">
          <span>主题色彩</span>
          {#if !isThemeDefault}
            <button
              type="button"
              aria-label="重置聊天室主题色"
              class="btn-regular chat-settings-reset-btn rounded-md active:scale-90 cursor-pointer border-none"
              onclick={resetTheme}
            >
              <svg class="w-3 h-3 text-[var(--skin-text-dim)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          {/if}
          <div class="ml-auto px-2 h-5.5 bg-[var(--btn-regular-bg)] rounded-md flex items-center justify-center text-[0.6875rem] font-bold text-[var(--skin-text)]">
            {settings.chatHue === null ? `随全站 (${displayedHue})` : displayedHue}
          </div>
        </div>

        <div class="w-full rounded-lg bg-[var(--btn-regular-bg)] px-2.5 py-2 select-none mb-2">
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
            class="w-full btn-regular rounded-lg py-1.5 px-3 text-xs font-medium active:scale-95 transition-all cursor-pointer border-none text-[var(--skin-text-dim)] hover:text-[var(--skin-accent)]"
            onclick={() => updateSetting("chatHue", null)}
          >
            恢复跟随全站色相
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
