export interface StickerItem {
	code: string;
	name: string;
	url: string;
}

export interface StickerPack {
	id: string;
	name: string;
	iconUrl: string;
	items: StickerItem[];
}

export type ChatContentSegment =
	| { kind: "text"; text: string }
	| { kind: "mention"; text: string; target: string }
	| { kind: "sticker"; code: string; url: string; alt: string };

interface RawStickerManifest {
	name?: string;
	prefix?: string;
	type?: string;
	icon?: string;
	items?: string[];
}

const TOKEN_OR_MENTION_RE = /(:[A-Za-z0-9_.-]+_[^:\s<>"']+?:|@[^\s@]{1,16})/g;

let cachedPacksPromise: Promise<StickerPack[]> | null = null;
let cachedPackUrlsKey = "";

export async function loadStickerPacks(
	packBaseUrls: string[],
): Promise<StickerPack[]> {
	const cleanUrls = packBaseUrls
		.map((u) => u.trim().replace(/\/+$/, ""))
		.filter(Boolean);
	const cacheKey = cleanUrls.join("|");
	if (cachedPacksPromise && cachedPackUrlsKey === cacheKey) {
		return cachedPacksPromise;
	}

	cachedPackUrlsKey = cacheKey;
	cachedPacksPromise = (async () => {
		const loaded: StickerPack[] = [];
		for (const baseUrl of cleanUrls) {
			try {
				const resp = await fetch(`${baseUrl}/info.json`);
				if (!resp.ok) continue;
				const manifest = (await resp.json()) as RawStickerManifest;
				const prefix = manifest.prefix || "";
				const ext = manifest.type || "png";
				const itemsRaw = Array.isArray(manifest.items) ? manifest.items : [];
				if (itemsRaw.length === 0) continue;

				const items: StickerItem[] = itemsRaw.map((itemName) => ({
					code: `:${prefix}${itemName}:`,
					name: itemName,
					url: `${baseUrl}/${encodeURIComponent(`${prefix}${itemName}`)}.${ext}`,
				}));

				const iconName = manifest.icon || itemsRaw[0];
				const iconUrl = `${baseUrl}/${encodeURIComponent(`${prefix}${iconName}`)}.${ext}`;
				loaded.push({
					id: baseUrl,
					name: manifest.name || "表情包",
					iconUrl,
					items,
				});
			} catch {
				// Ignore failed sticker pack manifest
			}
		}
		return loaded;
	})();

	return cachedPacksPromise;
}

export function buildStickerLookup(
	packs: StickerPack[],
): Map<string, StickerItem> {
	const map = new Map<string, StickerItem>();
	for (const pack of packs) {
		for (const item of pack.items) {
			map.set(item.code, item);
		}
	}
	return map;
}

function escapeRegexLiteral(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseChatSegments(
	content: string,
	stickerMap: Map<string, StickerItem>,
	mentions: string[] = [],
): ChatContentSegment[] {
	if (!content) return [];
	const segments: ChatContentSegment[] = [];
	let lastIndex = 0;

	const cleanMentions = Array.from(
		new Set(mentions.map((m) => m.trim()).filter(Boolean)),
	).sort((a, b) => b.length - a.length);

	const matcher =
		cleanMentions.length > 0
			? new RegExp(
					`(:[A-Za-z0-9_.-]+_[^:\\s<>"]+?:|@(?:${cleanMentions.map(escapeRegexLiteral).join("|")})|@[^\\s@]{1,16})`,
					"g",
				)
			: TOKEN_OR_MENTION_RE;
	matcher.lastIndex = 0;

	let match = matcher.exec(content);
	while (match !== null) {
		const token = match[0];
		const start = match.index;
		if (start > lastIndex) {
			segments.push({
				kind: "text",
				text: content.slice(lastIndex, start),
			});
		}

		if (token.startsWith(":") && token.endsWith(":")) {
			const sticker = stickerMap.get(token);
			if (sticker) {
				segments.push({
					kind: "sticker",
					code: sticker.code,
					url: sticker.url,
					alt: sticker.name,
				});
			} else {
				segments.push({ kind: "text", text: token });
			}
		} else if (token.startsWith("@") && token.length > 1) {
			segments.push({
				kind: "mention",
				text: token,
				target: token.slice(1),
			});
		} else {
			segments.push({ kind: "text", text: token });
		}

		lastIndex = start + token.length;
		match = matcher.exec(content);
	}

	if (lastIndex < content.length) {
		segments.push({
			kind: "text",
			text: content.slice(lastIndex),
		});
	}

	return segments;
}

export function formatChatReplyPreview(
	content: string,
	stickerMap?: Map<string, StickerItem>,
	hasImage = false,
	isRecalled = false,
): string {
	if (isRecalled) return "原消息已撤回";
	const readable = content
		.replace(/:[A-Za-z0-9_.-]+_([^:\s<>"]+?):/g, (full, fallbackName) => {
			const matched = stickerMap?.get(full);
			return `[${matched?.name || fallbackName}]`;
		})
		.replace(/\s+/g, " ")
		.trim();
	if (!readable) {
		return hasImage ? "[图片]" : "[消息]";
	}
	return hasImage ? `[图片] ${readable}` : readable;
}
