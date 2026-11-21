<script lang="ts">
import { currentPlaybackDiagnostic } from "@/components/pages/chat/musicTrace";
import { getPlaybackDiagnosticsCopy } from "@/i18n/playbackDiagnostics";

let { lang }: { lang: string } = $props();
const copy = $derived(getPlaybackDiagnosticsCopy(lang));
const play = $derived($currentPlaybackDiagnostic);
const original = $derived(play?.selection?.original ?? play?.legacyOriginal);
const originalPlatform = $derived(play?.selection?.original.platform);
const mode = $derived(play?.selection?.mode);
const channel = $derived(play?.source?.channel);
const local = $derived(play?.local);
const matchLabel = $derived(
	(mode && copy.mode[mode]) || (play?.legacyOriginal ? copy.legacyReplacement : copy.unknown),
);
const needsAttention = $derived(mode === "automatic-alternative" || Boolean(!mode && play?.legacyOriginal));
const localIssue = $derived(local?.status === "error" || local?.status === "blocked");

function platformLabel(platform?: string): string {
	switch (platform) {
		case "qq":
		case "qqmusic": return lang.toLowerCase().startsWith("zh") ? "QQ 音乐" : "QQ Music";
		case "netease": return lang.toLowerCase().startsWith("zh") ? "网易云音乐" : "NetEase Cloud Music";
		case "kugou": return lang.toLowerCase().startsWith("zh") ? "酷狗音乐" : "KuGou Music";
		case "apple_music":
		case "applemusic": return "Apple Music";
		case "spotify": return "Spotify";
		case "youtube":
		case "youtube_music":
		case "ytmusic":
		case "youtubemusic": return "YouTube Music";
		case "external":
		case undefined:
		case "": return copy.unknown;
		default: return platform;
	}
}
</script>

<section class="rounded-lg border border-(--line-divider) text-(--deep-text)" aria-label={copy.title}>
	<div class="px-3.5 py-3">
		<h3 class="m-0 text-sm font-semibold">{copy.title}</h3>
		{#if play}
			<p class="m-0 mt-2 text-lg leading-tight font-semibold wrap-anywhere">{play.title}</p>
			{#if play.artist}
				<p class="m-0 mt-0.5 text-sm leading-snug text-(--content-meta) wrap-anywhere">{play.artist}</p>
			{/if}
		{:else}
			<p class="m-0 mt-1.5 text-sm text-(--content-meta)">{copy.empty}</p>
		{/if}
	</div>
	{#if play}
		{#if !play.roomConnected}
			<p class="m-0 px-3.5 pb-3 text-xs text-(--content-meta)">{copy.disconnected}</p>
		{/if}
		<dl class="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 border-t border-(--line-divider) px-3.5 py-3 text-sm">
			<dt class="text-xs text-(--content-meta)">{copy.source}</dt>
			<dd class="m-0 font-medium wrap-anywhere">{platformLabel(play.provider)}</dd>
			<dt class="text-xs text-(--content-meta)">{copy.match}</dt>
			<dd class="m-0">
				<span class={[
					"inline-block max-w-full rounded-md px-2 py-0.5 text-xs leading-relaxed font-semibold wrap-anywhere",
					needsAttention
						? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
						: "bg-(--btn-regular-bg) text-(--btn-content)",
				]}>{matchLabel}</span>
			</dd>
			<dt class="text-xs text-(--content-meta)">{copy.device}</dt>
			<dd class="m-0 wrap-anywhere">
				<span class={localIssue ? "font-semibold text-red-700 dark:text-red-300" : "font-medium"} role="status">
					{local ? copy.status[local.status] : copy.unconfirmed}
				</span>
				{#if local?.status === "blocked"}
					<p class="m-0 mt-0.5 text-xs text-(--content-meta)">{copy.blockedHint}</p>
				{/if}
			</dd>
		</dl>
		<details class="group border-t border-(--line-divider)">
			<summary class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2 text-sm font-medium text-(--btn-content) hover:bg-(--btn-regular-bg) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--primary) [&::-webkit-details-marker]:hidden">
				{copy.details}
				<span class="mr-1 size-2 shrink-0 -translate-y-0.5 rotate-45 border-r border-b border-current motion-safe:transition-transform group-open:translate-y-0.5 group-open:rotate-225" aria-hidden="true"></span>
			</summary>
			<div class="px-3.5 pt-1 pb-3">
				<dl class="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs [&>dd]:wrap-anywhere [&>dt]:text-(--content-meta)">
					<dt>{copy.original}</dt>
					<dd class="m-0">
						{#if original}
							<span class="font-medium">{original.title || copy.unknown}</span>
							{#if original.artist || originalPlatform}
								<span class="mt-0.5 block text-(--content-meta)">{[original.artist, originalPlatform && platformLabel(originalPlatform)].filter(Boolean).join(" · ")}</span>
							{/if}
						{:else}
							{copy.unknown}
						{/if}
					</dd>
					{#if mode && copy.reason[mode]}
						<dt>{copy.reasonLabel}</dt>
						<dd class="m-0">{copy.reason[mode]}</dd>
					{/if}
					{#if play.album}
						<dt>{copy.album}</dt>
						<dd class="m-0">{play.album}</dd>
					{/if}
				</dl>
				<dl class="m-0 mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-(--line-divider) pt-3 text-xs [&>dd]:wrap-anywhere [&>dt]:text-(--content-meta)">
					<dt>{copy.server}</dt>
					<dd class="m-0">{play.source ? (play.source.checked ? copy.readable : copy.unconfirmed) : copy.unknown}</dd>
					<dt>{copy.channel}</dt>
					<dd class="m-0">{channel === "vkeys-128" ? `${copy.primary} · vkeys` : channel === "cyapi" ? `${copy.secondary} · cyapi` : channel ? platformLabel(channel) : copy.unknown}</dd>
					<dt>{copy.transport}</dt>
					<dd class="m-0">{local?.transport ? copy[local.transport] : copy.unconfirmed}</dd>
					<dt>{copy.trigger}</dt>
					<dd class="m-0">{[play.rotation ? copy.rotation : copy.request, play.room].filter(Boolean).join(" · ")}</dd>
					<dt>{copy.format}</dt>
					<dd class="m-0">{play.source?.mimeType || copy.unknown}</dd>
					<dt>{copy.revision}</dt>
					<dd class="m-0 tabular-nums">{play.revision}</dd>
				</dl>
			</div>
		</details>
	{/if}
</section>
