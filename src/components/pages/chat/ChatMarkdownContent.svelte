<script lang="ts">
import type { Token, Tokens } from "marked";
import {
	type ChatMarkdownAst,
	isSafeImageUrl,
	isSafeLinkUrl,
	parseChatMarkdown,
	restoreTextSegments,
} from "./chatMarkdown";
import type { StickerItem } from "./stickerLoader";

interface Props {
	content: string;
	stickerMap: Map<string, StickerItem>;
	mentions?: string[];
	currentUserName?: string;
}

const {
	content = "",
	stickerMap,
	mentions = [],
	currentUserName = "",
}: Props = $props();

const ast: ChatMarkdownAst = $derived(
	parseChatMarkdown(content, stickerMap, mentions),
);

function isSelfMentionTarget(target: string): boolean {
	if (!currentUserName) return false;
	return target.trim().toLowerCase() === currentUserName.trim().toLowerCase();
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
        <a
          href={safeSrc}
          data-fancybox="chat-images"
          class="inline-block my-1 overflow-hidden rounded-lg border border-black/10 dark:border-white/10"
        >
          <img
            src={safeSrc}
            alt={imgTok.text || "图片"}
            loading="lazy"
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
            <img src={seg.url} alt={seg.alt} title={seg.alt} class="chat-sticker" loading="lazy" />
          {:else if seg.kind === "mention"}
            <span class="chat-mention-pill {isSelfMentionTarget(seg.target) ? 'self' : ''}">{seg.text}</span>
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
