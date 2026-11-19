<script lang="ts">
import type { Token, Tokens } from "marked";
import {
	getCachedChatImageDims,
	openChatImageLightbox,
	rememberChatImageDims,
} from "./chatLightbox";
import {
	type ChatMarkdownAst,
	isSafeImageUrl,
	isSafeLinkUrl,
	parseChatMarkdown,
	restoreTextSegments,
} from "./chatMarkdown";
import LottieSticker from "./LottieSticker.svelte";
import type { StickerItem } from "./stickerLoader";

interface Props {
	content: string;
	stickerMap: Map<string, StickerItem>;
	mentions?: string[];
	currentUserName?: string;
	currentUserSite?: string;
	canRoomHighlight?: boolean;
	chatServerUrl?: string;
	onMentionClick?: (target: string) => void;
}

const {
	content = "",
	stickerMap,
	mentions = [],
	currentUserName = "",
	currentUserSite = "",
	canRoomHighlight = false,
	chatServerUrl,
	onMentionClick,
}: Props = $props();

const ast: ChatMarkdownAst = $derived(
	parseChatMarkdown(content, stickerMap, mentions, canRoomHighlight),
);

function isSelfMentionTarget(target: string): boolean {
	const cleaned = target.trim().toLowerCase();
	if (
		canRoomHighlight &&
		(cleaned === "room" || cleaned === "all" || target.trim() === "所有人")
	) {
		return true;
	}
	if (!currentUserName) return false;

	const myNameClean = currentUserName.trim().toLowerCase();
	const myParts = myNameClean.split(/\s*[·•・]\s*/);
	const myBase = myParts[0]?.trim() || myNameClean;
	const mySiteClean = (currentUserSite || myParts.slice(1).join(" · ") || "")
		.trim()
		.toLowerCase();

	const targetParts = cleaned.split(/\s*[·•・]\s*/);
	const targetBase = targetParts[0]?.trim() || "";
	const targetSite = targetParts.slice(1).join(" · ").trim();

	// 1. 基础名字必须严格相等
	if (targetBase !== myBase) {
		return false;
	}

	// 2. 如果提及的目标明确指定了站点后缀（例如 "AIOVTUE-雪"）
	if (targetSite) {
		if (mySiteClean) {
			return targetSite === mySiteClean;
		}
		// 若自身没有站点信息，但目标明确带了外部站点名，不判定为自己
		return false;
	}

	// 3. 如果提及目标没有指定站点名，纯纯的 @昵称，则匹配自己
	return true;
}

function getInlineChildren(token: Token): Token[] | undefined {
	if ("tokens" in token && Array.isArray(token.tokens)) {
		return token.tokens as Token[];
	}
	return undefined;
}
</script>

{#snippet renderInlineList(tokens: Token[])}
  {#each tokens as tok, i (`${i}-${tok.type}`)}
    {#if tok.type === "strong"}
      <strong>{@render renderInlineList((tok as Tokens.Strong).tokens)}</strong>
    {:else if tok.type === "em"}
      <em>{@render renderInlineList((tok as Tokens.Em).tokens)}</em>
    {:else if tok.type === "del"}
      <del class="opacity-70">{@render renderInlineList((tok as Tokens.Del).tokens)}</del>
    {:else if tok.type === "codespan"}
      <code class="chat-md-code">{(tok as Tokens.Codespan).text}</code>
    {:else if tok.type === "br"}
      <br />
    {:else if tok.type === "link"}
      {@const linkTok = tok as Tokens.Link}
      {@const safeHref = isSafeLinkUrl(linkTok.href)}
      {#if safeHref}
        <a
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
          class="chat-md-link"
        >
          {#if linkTok.tokens && linkTok.tokens.length > 0}
            {@render renderInlineList(linkTok.tokens)}
          {:else}
            {#each restoreTextSegments(linkTok.text, ast) as seg, sIdx (`${sIdx}-${seg.kind}`)}
              {#if seg.kind === "text"}{seg.text}{:else if seg.kind === "mention"}{seg.text}{/if}
            {/each}
          {/if}
        </a>
      {:else}
        {linkTok.raw}
      {/if}
    {:else if tok.type === "image"}
      {@const imgTok = tok as Tokens.Image}
      {@const safeSrc = isSafeImageUrl(imgTok.href)}
      {#if safeSrc}
        {@const cachedDims = getCachedChatImageDims(safeSrc)}
        <a
          href={safeSrc}
          data-chat-image={safeSrc}
          class="inline-flex max-w-full align-top my-1 overflow-hidden rounded-lg border border-black/10 dark:border-white/10 cursor-zoom-in"
          onclick={(e) => {
            e.preventDefault();
            void openChatImageLightbox(safeSrc, e.currentTarget);
          }}
        >
          <img
            src={safeSrc}
            alt={imgTok.text || "图片"}
            loading="lazy"
            decoding="async"
            width={cachedDims?.w}
            height={cachedDims?.h}
            style:--chat-image-width={cachedDims ? `${cachedDims.w}px` : undefined}
            style:--chat-image-ratio={cachedDims ? cachedDims.w / cachedDims.h : undefined}
            onload={(e) => rememberChatImageDims(safeSrc, e.currentTarget)}
            class="chat-msg-image"
          />
        </a>
      {:else}
        {imgTok.raw}
      {/if}
    {:else if tok.type === "escape"}
      {(tok as Tokens.Escape).text}
    {:else if tok.type === "html"}
      {tok.raw}
    {:else if tok.type === "text"}
      {@const children = getInlineChildren(tok)}
      {#if children && children.length > 0}
        {@render renderInlineList(children)}
      {:else}
        {#each restoreTextSegments((tok as Tokens.Text).text, ast) as seg, sIdx (`${sIdx}-${seg.kind}`)}
          {#if seg.kind === "sticker"}
            {#if seg.lottie}
              <LottieSticker
                name={seg.lottie}
                alt={seg.alt}
                className="chat-sticker chat-sticker--lottie {seg.category === 'sticker' ? 'is-large' : ''}"
                chatServerUrl={chatServerUrl}
              />
            {:else}
              <img src={seg.url} alt={seg.alt} class="chat-sticker chat-sticker--{seg.category}" loading="lazy" />
            {/if}
          {:else if seg.kind === "mention"}
            {@const isClickable = Boolean(onMentionClick && seg.target && seg.target !== "所有人" && seg.target.toLowerCase() !== "room" && seg.target.toLowerCase() !== "all")}
            <span
              class="chat-mention-pill {isSelfMentionTarget(seg.target) ? 'self' : ''} {isClickable ? 'clickable select-none' : ''}"
              role={isClickable ? "button" : undefined}
              tabindex={isClickable ? 0 : undefined}
              title={isClickable ? `查看 @${seg.target} 的资料` : undefined}
              onclick={isClickable ? (e) => {
                e.stopPropagation();
                onMentionClick?.(seg.target);
              } : undefined}
              onkeydown={isClickable ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation();
                  e.preventDefault();
                  onMentionClick?.(seg.target);
                }
              } : undefined}
            >{seg.text}</span>
          {:else}
            {seg.text}
          {/if}
        {/each}
      {/if}
    {:else}
      {tok.raw}
    {/if}
  {/each}
{/snippet}

{#snippet renderBlockList(tokens: Token[])}
  {#each tokens as tok, i (`${i}-${tok.type}`)}
    {#if tok.type === "space"}
      <!-- spacing handled by container gap -->
    {:else if tok.type === "paragraph"}
      {@const pTok = tok as Tokens.Paragraph}
      <p class="chat-md-p">{@render renderInlineList(pTok.tokens)}</p>
    {:else if tok.type === "text"}
      {@const children = getInlineChildren(tok)}
      {#if children && children.length > 0}
        <p class="chat-md-p">{@render renderInlineList(children)}</p>
      {:else}
        <p class="chat-md-p">{@render renderInlineList([tok])}</p>
      {/if}
    {:else if tok.type === "heading"}
      {@const hTok = tok as Tokens.Heading}
      <div class="chat-md-heading chat-md-h{Math.min(3, hTok.depth)}">
        {@render renderInlineList(hTok.tokens)}
      </div>
    {:else if tok.type === "code"}
      {@const codeTok = tok as Tokens.Code}
      <div class="chat-md-pre-wrap">
        {#if codeTok.lang}
          <div class="chat-md-pre-lang">{codeTok.lang}</div>
        {/if}
        <pre class="chat-md-pre custom-scrollbar"><code>{codeTok.text}</code></pre>
      </div>
    {:else if tok.type === "blockquote"}
      {@const qTok = tok as Tokens.Blockquote}
      <blockquote class="chat-md-quote">
        {@render renderBlockList(qTok.tokens)}
      </blockquote>
    {:else if tok.type === "list"}
      {@const listTok = tok as Tokens.List}
      {#if listTok.ordered}
        <ol class="chat-md-list chat-md-ol" start={typeof listTok.start === "number" ? listTok.start : 1}>
          {#each listTok.items as item, li (`${li}-ol`)}
            <li class="chat-md-li">
              {#if item.task}
                <span class="chat-md-task {item.checked ? 'checked' : ''}" aria-hidden="true">
                  {item.checked ? "✓" : ""}
                </span>
              {/if}
              <div class="min-w-0 flex-1">{@render renderBlockList(item.tokens)}</div>
            </li>
          {/each}
        </ol>
      {:else}
        <ul class="chat-md-list chat-md-ul">
          {#each listTok.items as item, li (`${li}-ul`)}
            <li class="chat-md-li">
              {#if item.task}
                <span class="chat-md-task {item.checked ? 'checked' : ''}" aria-hidden="true">
                  {item.checked ? "✓" : ""}
                </span>
              {/if}
              <div class="min-w-0 flex-1">{@render renderBlockList(item.tokens)}</div>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if tok.type === "table"}
      {@const tblTok = tok as Tokens.Table}
      <div class="chat-md-table-wrap custom-scrollbar">
        <table class="chat-md-table">
          <thead>
            <tr>
              {#each tblTok.header as cell, ci (`${ci}-th`)}
                <th style={tblTok.align[ci] ? `text-align:${tblTok.align[ci]}` : ""}>
                  {@render renderInlineList(cell.tokens)}
                </th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each tblTok.rows as row, ri (`${ri}-tr`)}
              <tr>
                {#each row as cell, ci (`${ri}-${ci}-td`)}
                  <td style={tblTok.align[ci] ? `text-align:${tblTok.align[ci]}` : ""}>
                    {@render renderInlineList(cell.tokens)}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if tok.type === "hr"}
      <hr class="chat-md-hr" />
    {:else if tok.type === "html"}
      <p class="chat-md-p">{tok.raw}</p>
    {:else}
      <p class="chat-md-p">{tok.raw}</p>
    {/if}
  {/each}
{/snippet}

{#if ast.tokens.length > 0}
  <div class="chat-msg-text chat-md-body">
    {@render renderBlockList(ast.tokens)}
  </div>
{/if}
