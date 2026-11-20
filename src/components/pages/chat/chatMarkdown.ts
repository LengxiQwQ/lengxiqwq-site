import { marked, type Token } from "marked";
import { mentionRanges } from "./chatMentions";
import type { ChatMentionEntity } from "./chatTypes";
import {
	buildStickerTokenRegex,
	type ChatContentSegment,
	resolveExternalOrLocalSticker,
	type StickerItem,
} from "./stickerLoader";

export interface ChatMarkdownAst {
	tokens: Token[];
	inlineTokens: { source: string; segment: ChatContentSegment }[];
	placeholderPattern: string;
}

const CODE_SPLIT_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;

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
	mentionEntities: ChatMentionEntity[] = [],
): ChatMarkdownAst {
	const inlineTokens: ChatMarkdownAst["inlineTokens"] = [];
	let markerIndex = 0;
	let prefix = `\uE000chat${markerIndex}:`;
	while (content.includes(prefix)) prefix = `\uE000chat${++markerIndex}:`;
	const placeholderPattern = `${prefix}(\\d+)\\uE001`;
	function protect(source: string, segment: ChatContentSegment): string {
		const slot = inlineTokens.length;
		inlineTokens.push({ source, segment });
		return `${prefix}${slot}\uE001`;
	}

	let end = 0;
	let withMentions = "";
	for (const entity of mentionRanges(content, mentionEntities)) {
		withMentions += content.slice(end, entity.offset);
		end = entity.offset + entity.length;
		const text = content.slice(entity.offset, end);
		withMentions += protect(text, {
			kind: "mention",
			text,
			userKey: entity.userKey,
		});
	}
	withMentions += content.slice(end);
	const tokenMatcher = buildStickerTokenRegex();
	const parts = withMentions.split(CODE_SPLIT_RE);

	const protectedContent = parts
		.map((part, idx) => {
			// Odd indices match CODE_SPLIT_RE: preserve literal code blocks/spans untouched
			if (idx % 2 === 1) return part;
			tokenMatcher.lastIndex = 0;
			return part.replace(tokenMatcher, (token) => {
				const sticker = resolveExternalOrLocalSticker(token, stickerMap);
				if (!sticker) return token;
				return protect(token, {
					kind: "sticker",
					code: sticker.code,
					url: sticker.url,
					alt: sticker.name,
					category: sticker.category,
					...(sticker.lottie ? { lottie: sticker.lottie } : {}),
				});
			});
		})
		.join("");

	const tokens = marked.lexer(protectedContent, {
		gfm: true,
		breaks: true,
	});

	return { tokens, inlineTokens, placeholderPattern };
}

export function restoreTextSegments(
	text: string,
	ast: ChatMarkdownAst,
): ChatContentSegment[] {
	if (!text) return [];
	const out: ChatContentSegment[] = [];
	let lastIndex = 0;
	for (const match of text.matchAll(new RegExp(ast.placeholderPattern, "g"))) {
		const token = ast.inlineTokens[Number(match[1])];
		if (!token) continue;
		if (match.index > lastIndex) {
			out.push({ kind: "text", text: text.slice(lastIndex, match.index) });
		}
		out.push(token.segment);
		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < text.length) {
		out.push({ kind: "text", text: text.slice(lastIndex) });
	}
	return out;
}

export function restoreChatMarkdownLiterals(
	text: string,
	ast: ChatMarkdownAst,
): string {
	return text.replace(
		new RegExp(ast.placeholderPattern, "g"),
		(raw, slot) => ast.inlineTokens[Number(slot)]?.source ?? raw,
	);
}
