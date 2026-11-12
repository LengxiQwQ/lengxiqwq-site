import { marked, type Token } from "marked";
import type { ChatContentSegment, StickerItem } from "./stickerLoader";

export interface ChatMarkdownAst {
	tokens: Token[];
	stickers: StickerItem[];
	mentions: Array<{ text: string; target: string }>;
}

const CODE_SPLIT_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;
const PLACEHOLDER_RE = /\uE000(STK|MNT)(\d+)\uE001/g;

function escapeRegexLiteral(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMentionRegex(mentions: string[]): RegExp {
	const clean = Array.from(
		new Set(mentions.map((m) => m.trim()).filter(Boolean)),
	).sort((a, b) => b.length - a.length);

	if (clean.length > 0) {
		return new RegExp(
			`(:[A-Za-z0-9_.-]+_[^:\\s<>"]+?:|@(?:${clean.map(escapeRegexLiteral).join("|")})|@[^\\s@]{1,16})`,
			"g",
		);
	}
	return /(:[A-Za-z0-9_.-]+_[^:\s<>"']+?:|@[^\s@]{1,16})/g;
}

export function isSafeLinkUrl(raw?: string): string {
	const trimmed = (raw || "").trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
		return trimmed;
	}
	try {
		const parsed = new URL(trimmed);
		if (
			parsed.protocol === "http:" ||
			parsed.protocol === "https:" ||
			parsed.protocol === "mailto:"
		) {
			return parsed.toString();
		}
	} catch {
		// Invalid URL
	}
	return "";
}

export function isSafeImageUrl(raw?: string): string {
	const trimmed = (raw || "").trim();
	if (!trimmed) return "";
	if (trimmed.startsWith("/assets/") && !trimmed.startsWith("//")) {
		return trimmed;
	}
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") {
			return parsed.toString();
		}
	} catch {
		// Invalid URL
	}
	return "";
}

export function parseChatMarkdown(
	content: string,
	stickerMap: Map<string, StickerItem>,
	mentions: string[] = [],
): ChatMarkdownAst {
	const stickers: StickerItem[] = [];
	const mentionEntries: Array<{ text: string; target: string }> = [];

	if (!content) {
		return { tokens: [], stickers, mentions: mentionEntries };
	}

	const tokenMatcher = buildMentionRegex(mentions);
	const parts = content.split(CODE_SPLIT_RE);

	const protectedContent = parts
		.map((part, idx) => {
			// Odd indices match CODE_SPLIT_RE: preserve literal code blocks/spans untouched
			if (idx % 2 === 1) return part;
			tokenMatcher.lastIndex = 0;
			return part.replace(tokenMatcher, (token) => {
				if (token.startsWith(":") && token.endsWith(":")) {
					const sticker = stickerMap.get(token);
					if (sticker) {
						const slot = stickers.length;
						stickers.push(sticker);
						return `\uE000STK${slot}\uE001`;
					}
					return token;
				}
				if (token.startsWith("@") && token.length > 1) {
					const slot = mentionEntries.length;
					mentionEntries.push({ text: token, target: token.slice(1) });
					return `\uE000MNT${slot}\uE001`;
				}
				return token;
			});
		})
		.join("");

	const tokens = marked.lexer(protectedContent, {
		gfm: true,
		breaks: true,
	});

	return { tokens, stickers, mentions: mentionEntries };
}

export function restoreTextSegments(
	text: string,
	ast: ChatMarkdownAst,
): ChatContentSegment[] {
	if (!text) return [];
	const out: ChatContentSegment[] = [];
	let lastIndex = 0;
	PLACEHOLDER_RE.lastIndex = 0;

	let match = PLACEHOLDER_RE.exec(text);
	while (match !== null) {
		if (match.index > lastIndex) {
			out.push({ kind: "text", text: text.slice(lastIndex, match.index) });
		}
		const kind = match[1];
		const slot = Number(match[2]);
		if (kind === "STK") {
			const sticker = ast.stickers[slot];
			if (sticker) {
				out.push({
					kind: "sticker",
					code: sticker.code,
					url: sticker.url,
					alt: sticker.name,
					category: sticker.category,
				});
			}
		} else if (kind === "MNT") {
			const mention = ast.mentions[slot];
			if (mention) {
				out.push({
					kind: "mention",
					text: mention.text,
					target: mention.target,
				});
			}
		}
		lastIndex = match.index + match[0].length;
		match = PLACEHOLDER_RE.exec(text);
	}

	if (lastIndex < text.length) {
		out.push({ kind: "text", text: text.slice(lastIndex) });
	}
	return out;
}
