<script lang="ts">
import { onMount } from "svelte";
import type { InterconnectSite } from "@/types/chatConfig";
import ChatAvatar from "./ChatAvatar.svelte";

interface Props {
	open: boolean;
	sites?: InterconnectSite[];
	onClose: () => void;
}

const { open, sites = [], onClose }: Props = $props();

let popoverEl: HTMLDivElement | null = $state(null);

onMount(() => {
	const handlePointerDown = (e: PointerEvent) => {
		if (!open) return;
		const target = e.target as HTMLElement | null;
		if (!target) return;
		if (popoverEl?.contains(target)) return;
		if (target.closest("[data-chat-interconnect-trigger]")) return;
		onClose();
	};

	const handleKeydown = (e: KeyboardEvent) => {
		if (open && e.key === "Escape") {
			onClose();
		}
	};

	document.addEventListener("pointerdown", handlePointerDown);
	document.addEventListener("keydown", handleKeydown);

	return () => {
		document.removeEventListener("pointerdown", handlePointerDown);
		document.removeEventListener("keydown", handleKeydown);
	};
});
</script>

{#if open}
  <div
    bind:this={popoverEl}
    class="chat-settings-popover chat-interconnect-popover"
    role="dialog"
    aria-label="互联茶室友站列表"
  >
    <!-- 顶栏标题 -->
    <div class="flex items-center justify-between pt-3 pb-2 mb-2 border-b border-black/5 dark:border-white/10">
      <div class="flex items-center gap-1.5 font-bold text-sm text-[var(--deep-text)] dark:text-white/90">
        <span class="text-base">🍵</span>
        <span>互联茶室</span>
      </div>
      <button
        type="button"
        class="w-6 h-6 rounded-md flex items-center justify-center border-none bg-transparent text-[var(--chat-meta-color)] hover:text-[var(--deep-text)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer text-sm"
        aria-label="关闭"
        onclick={onClose}
      >
        ✕
      </button>
    </div>

    <!-- 简明说明（拒绝花里胡哨，讲人话） -->
    <div class="px-1 text-xs text-[var(--chat-meta-color)] leading-relaxed mb-3">
      这个房间和下面几个博客是连通的，发消息大家都能看到，也可以去他们的小站坐坐：
    </div>

    <!-- 友站卡片列表 -->
    <div class="space-y-2 max-h-[60vh] overflow-y-auto custom-scrollbar pr-0.5">
      {#if sites.length === 0}
        <div class="py-6 text-center text-xs text-[var(--chat-meta-color)]">
          暂未配置互联友站，可在内容仓配置中添加~
        </div>
      {:else}
        {#each sites as site (site.url || site.name)}
          <div class="rounded-xl bg-black/4 dark:bg-white/5 border border-black/5 dark:border-white/10 p-2.5 flex flex-col gap-2 transition-all hover:bg-black/6 dark:hover:bg-white/8">
            <div class="flex items-center justify-between gap-2 min-w-0">
              <div class="flex items-center gap-2 min-w-0 flex-1">
                <ChatAvatar
                  src={site.avatar}
                  name={site.owner || site.name}
                  size="sm"
                />
                <div class="min-w-0 flex-1">
                  <div class="font-semibold text-xs text-[var(--deep-text)] dark:text-white/90 truncate">
                    {site.name}
                  </div>
                  {#if site.owner}
                    <div class="text-[0.6875rem] text-[var(--chat-meta-color)] truncate">
                      站长: {site.owner}
                    </div>
                  {/if}
                </div>
              </div>

              {#if site.url}
                <a
                  href={site.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="btn-regular py-1 px-2.5 rounded-lg text-xs font-medium text-[var(--primary)] hover:bg-[var(--btn-plain-bg-hover)] transition-all shrink-0 inline-flex items-center gap-1 no-underline"
                  title={`前往 ${site.name} 的茶室`}
                >
                  <span>去串门</span>
                  <svg class="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </a>
              {/if}
            </div>

            {#if site.desc}
              <div class="text-[0.6875rem] text-[var(--chat-meta-color)] bg-black/3 dark:bg-white/4 rounded-md px-2 py-1 leading-normal line-clamp-2">
                “{site.desc}”
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}
