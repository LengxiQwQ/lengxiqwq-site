<script lang="ts">
import { onDestroy } from "svelte";
import { useChatMediaRetry } from "./chatMediaRetry";
import type { ChatAttachment } from "./chatTypes";

const { attachment }: { attachment: ChatAttachment } = $props();
let link = $state<HTMLAnchorElement>();
let request: AbortController | undefined;
let failed = $state(false);
const retry = useChatMediaRetry(() => { link?.click(); });

async function checkDownload() {
	request?.abort();
	const attempt = new AbortController();
	request = attempt;
	failed = false;
	try {
		const response = await fetch(attachment.url, {
			method: "HEAD",
			cache: "no-store",
			signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(10_000)]),
		});
		if (attempt.signal.aborted) return;
		if (response.ok) retry.clear();
		else {
			// Some file hosts allow a browser download but do not implement HEAD.
			failed = response.status !== 405 && response.status !== 501;
			retry.fail();
		}
	} catch {
		// A cross-origin download can work even when the browser hides its HTTP status.
		if (!attempt.signal.aborted) retry.fail();
	}
}

onDestroy(() => { request?.abort(); });
</script>

<a
  bind:this={link}
  href={attachment.url}
  download={attachment.name || "下载文件"}
  target="_blank"
  rel="noopener noreferrer"
  class="chat-file-card"
  onclick={checkDownload}
>
  <div class="w-8 h-8 rounded-lg bg-[var(--skin-accent)]/15 text-[var(--skin-accent)] flex items-center justify-center shrink-0">
    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
      <polyline points="14 2 14 8 20 8"/>
    </svg>
  </div>
  <div class="flex flex-col min-w-0 flex-1">
    <span class="text-xs font-medium truncate">{attachment.name || "文件附件"}</span>
    {#if failed}
      <span class="text-[0.6875rem] text-[var(--chat-meta-color)]" role="status">文件暂时无法下载</span>
    {:else if attachment.size}
      <span class="text-[0.6875rem] text-[var(--chat-meta-color)]">
        {attachment.size > 1024 * 1024 ? `${(attachment.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(attachment.size / 1024)} KB`}
      </span>
    {/if}
  </div>
</a>
