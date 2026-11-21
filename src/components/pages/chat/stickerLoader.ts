export type StickerCategory = "qq" | "emoji" | "sticker";

export interface StickerItem {
	code: string;
	name: string;
	url: string;
	category: StickerCategory;
	lottie?: string;
}

export interface StickerPack {
	id: string;
	name: string;
	iconUrl: string;
	category: StickerCategory;
	items: StickerItem[];
}

export type ChatContentSegment =
	| { kind: "text"; text: string }
	| { kind: "mention"; text: string; userKey: string }
	| {
			kind: "sticker";
			code: string;
			url: string;
			alt: string;
			category: StickerCategory;
			lottie?: string;
	  };

export const LOTTIE_LABELS: Record<string, string> = {
	// 27 精选动态表情
	aini: "爱你",
	bianpao: "鞭炮",
	bixin: "比心",
	caigou: "菜狗",
	cool: "酷",
	daku: "大哭",
	exin: "恶心",
	fan: "烦",
	foxi: "佛系",
	gandong: "感动",
	gongzuo: "工作",
	huang: "慌",
	jingxia: "惊吓",
	jiong: "囧",
	kaixin: "开心",
	meiku: "美哭",
	meishi: "美食",
	re: "热",
	shengqi: "生气",
	shengri: "生日",
	shuijiao: "睡觉",
	tietie: "贴贴",
	wangpan: "网盘",
	wenhao: "问号",
	wuzui: "捂嘴",
	xiaoku: "笑哭",
	yanhua: "烟花",
	// 84 QQ 超级表情
	"qq-5-5": "流泪",
	"qq-181-181": "戳一戳",
	"qq-311-311": "打call",
	"qq-314-314": "仔细分析",
	"qq-317-317": "菜汪",
	"qq-318-318": "崇拜",
	"qq-320-320": "庆祝",
	"qq-337-337": "花朵脸",
	"qq-338-338": "我想开了",
	"qq-341-341": "打招呼",
	"qq-342-342": "酸Q",
	"qq-343-343": "我方了",
	"qq-344-344": "大怨种",
	"qq-346-346": "你真棒棒",
	"qq-349-349": "坚强",
	"qq-351-351": "敲敲",
	"qq-360-360": "亲亲",
	"qq-361-361": "狗狗笑哭",
	"qq-363-363": "狗狗可怜",
	"qq-364-364": "超级赞",
	"qq-365-365": "狗狗生气",
	"qq-367-367": "狗狗疑问",
	"qq-371-371": "冒泡",
	"qq-372-372": "气呼呼",
	"qq-373-373": "忙",
	"qq-375-375": "超级鼓掌",
	"qq-377-377": "嗨",
	"qq-378-378": "企鹅笑哭",
	"qq-379-379": "企鹅流泪",
	"qq-380-380": "真棒",
	"qq-381-381": "路过",
	"qq-382-382": "emo",
	"qq-383-383": "企鹅爱心",
	"qq-384-384": "晚安",
	"qq-385-385": "太气了",
	"qq-387-387": "太好笑",
	"qq-388-388": "太头疼",
	"qq-390-390": "太头秃",
	"qq-391-391": "太沧桑",
	"qq-395-395": "略略略",
	"qq-397-397": "抛媚眼",
	"qq-398-398": "超级ok",
	"qq-400-400": "快乐",
	"qq-402-402": "别说话",
	"qq-403-403": "出去玩",
	"qq-404-404": "闪亮登场",
	"qq-405-405": "好运来",
	"qq-407-407": "我听听",
	"qq-408-408": "臭美",
	"qq-409-409": "送你花花",
	"qq-410-410": "么么哒",
	"qq-412-412": "开心",
	"qq-425-425": "求放过",
	"qq-427-427": "偷感",
	"qq-450-450": "委屈巴巴",
	"qq-451-451": "花痴流口水",
	"qq-452-452": "微笑",
	"qq-453-453": "气哭了",
	"qq-454-454": "墨镜酷",
	"qq-455-455": "星星眼",
	"qq-456-456": "擦鼻涕",
	"qq-457-457": "睡着了",
	"qq-458-458": "流口水",
	"qq-460-460": "无语",
	"qq-461-461": "晕头转向",
	"qq-462-462": "笑出汗",
	"qq-468-468": "探头围观",
	"qq-469-469": "嘘",
	"qq-472-472": "脸红心跳",
	"qq-474-474": "加油",
	"qq-475-475": "干饭",
	"qq-476-476": "努力工作",
	"qq-477-477": "偷笑",
	"qq-478-478": "可以",
	"qq-479-479": "不可以",
	"qq-481-481": "认真学习",
	"qq-482-482": "热化了",
	"qq-483-483": "拜托了",
	"qq-484-484": "满满爱心",
	"qq-489-489": "惊呆了",
	"qq-490-490": "满心期待",
	"qq-491-491": "认真敲代码",
	"qq-492-492": "仔细查找",
	"qq-493-493": "睡觉啦",
};

function resolveStickerCategory(
	baseUrl: string,
	prefix: string,
): StickerCategory {
	const lowerUrl = baseUrl.toLowerCase();
	const lowerPrefix = prefix.toLowerCase();
	if (lowerUrl.endsWith("/qq") || lowerPrefix === "qq_") {
		return "qq";
	}
	if (lowerUrl.endsWith("/bmoji") || lowerPrefix === "bmoji_") {
		return "emoji";
	}
	return "sticker";
}

interface RawStickerManifest {
	name?: string;
	prefix?: string;
	type?: string;
	icon?: string;
	items?: string[];
}

const STICKER_TOKEN_PATTERN =
	":[A-Za-z0-9_.-]+_[^:\\s<>\"']+?:|\\[lottie:[a-zA-Z0-9-]+\\]|\\[sticker:[a-zA-Z0-9/_-]+\\]";

export function buildStickerTokenRegex(): RegExp {
	return new RegExp(STICKER_TOKEN_PATTERN, "g");
}

export function resolveExternalOrLocalSticker(
	token: string,
	stickerMap: Map<string, StickerItem>,
): StickerItem | null {
	const local = stickerMap.get(token);
	if (local) return local;

	const lottieMatch =
		/^\[lottie:([a-z0-9-]+)\]$/i.exec(token) ||
		/^:lottie_([a-z0-9-]+):$/i.exec(token);
	if (lottieMatch) {
		const lottie = lottieMatch[1].toLowerCase();
		return {
			code: token,
			name: LOTTIE_LABELS[lottie] || lottie,
			url: "",
			category: "sticker",
			lottie,
		};
	}

	const stickerTokenMatch = /^\[sticker:([a-z0-9/_-]+)\]$/i.exec(token);
	if (stickerTokenMatch) {
		const id = stickerTokenMatch[1];
		const fallbackName = id.split("/").pop() || "贴纸";
		const qfaceStatic = /^qqface\/static\/([a-z0-9_-]+)$/i.exec(id);
		if (qfaceStatic) {
			return {
				code: token,
				name: qfaceStatic[1],
				url: `https://fastly.jsdelivr.net/gh/koishijs/QFace@master/public/static/${encodeURIComponent(qfaceStatic[1])}.png`,
				category: "sticker",
			};
		}
		const qfaceGif = /^qqface\/gif\/([a-z0-9_-]+)$/i.exec(id);
		if (qfaceGif) {
			return {
				code: token,
				name: qfaceGif[1],
				url: `https://fastly.jsdelivr.net/gh/koishijs/QFace@master/public/gif/${encodeURIComponent(qfaceGif[1])}.gif`,
				category: "qq",
			};
		}
		const qfaceAsset = /^qqface\/assets\/(.+)$/i.exec(id);
		if (qfaceAsset) {
			return {
				code: token,
				name: fallbackName,
				url: `https://fastly.jsdelivr.net/gh/koishijs/QFace@master/public/assets/${qfaceAsset[1]}`,
				category: "sticker",
			};
		}
		return {
			code: token,
			name: fallbackName,
			url: `https://somoe.xyz/stickers/${id}.webp`,
			category: "sticker",
		};
	}

	const rainztMatch = /^:(anbao|younuo|bb)_([^:\s<>"']+):$/i.exec(token);
	if (rainztMatch) {
		const pack = rainztMatch[1].toLowerCase();
		const itemName = rainztMatch[2];
		if (pack === "anbao") {
			return {
				code: token,
				name: itemName,
				url: `https://rainzt.cn/assets/waline-emojis/anbao/anbao_${encodeURIComponent(itemName)}.webp`,
				category: "sticker",
			};
		}
		if (pack === "younuo") {
			return {
				code: token,
				name: itemName,
				url: `https://rainzt.cn/assets/waline-emojis/younuo/younuo_${encodeURIComponent(itemName)}.webp`,
				category: "sticker",
			};
		}
		return {
			code: token,
			name: itemName,
			url: `https://rainzt.cn/assets/waline-emojis/bilibili/bb_${encodeURIComponent(itemName)}.png`,
			category: "emoji",
		};
	}

	return null;
}

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

				const category = resolveStickerCategory(baseUrl, prefix);
				const items: StickerItem[] = itemsRaw.map((itemName) => ({
					code: `:${prefix}${itemName}:`,
					name: itemName,
					url: `${baseUrl}/${encodeURIComponent(`${prefix}${itemName}`)}.${ext}`,
					category,
				}));

				const iconName = manifest.icon || itemsRaw[0];
				const iconUrl = `${baseUrl}/${encodeURIComponent(`${prefix}${iconName}`)}.${ext}`;
				loaded.push({
					id: baseUrl,
					name: manifest.name || "表情包",
					iconUrl,
					category,
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

export function parseChatSegments(
	content: string,
	stickerMap: Map<string, StickerItem>,
): ChatContentSegment[] {
	const segments: ChatContentSegment[] = [];
	let end = 0;
	for (const match of content.matchAll(buildStickerTokenRegex())) {
		const token = match[0];
		const start = match.index;
		if (start > end) segments.push({ kind: "text", text: content.slice(end, start) });
		const sticker = resolveExternalOrLocalSticker(token, stickerMap);
		if (sticker) {
			segments.push({
				kind: "sticker",
				code: sticker.code,
				url: sticker.url,
				alt: sticker.name,
				category: sticker.category,
				...(sticker.lottie ? { lottie: sticker.lottie } : {}),
			});
		} else {
			segments.push({ kind: "text", text: token });
		}
		end = start + token.length;
	}
	if (end < content.length) segments.push({ kind: "text", text: content.slice(end) });
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
		.replace(/\[lottie:([a-zA-Z0-9-]+)\]/g, (_full, name) => {
			const key = String(name).toLowerCase();
			return `[${LOTTIE_LABELS[key] || name}]`;
		})
		.replace(/\[sticker:([a-zA-Z0-9/_-]+)\]/g, (_full, id) => {
			const label = String(id).split("/").pop() || "贴纸";
			return `[${label}]`;
		})
		.replace(/:[A-Za-z0-9_.-]+_([^:\s<>"]+?):/g, (full, fallbackName) => {
			const matched = stickerMap?.get(full);
			if (matched) return `[${matched.name}]`;
			const lottieMatch = /^:lottie_([a-z0-9-]+):$/i.exec(full);
			if (lottieMatch) {
				const key = lottieMatch[1].toLowerCase();
				return `[${LOTTIE_LABELS[key] || lottieMatch[1]}]`;
			}
			return `[${fallbackName}]`;
		})
		.replace(/\s+/g, " ")
		.trim();
	if (!readable) {
		return hasImage ? "[图片]" : "[消息]";
	}
	return hasImage ? `[图片] ${readable}` : readable;
}

export function formatStickerAttachmentAlt(rawName?: string): string {
	const text = (rawName || "").trim();
	if (!text) return "贴纸";
	const lottieMatch =
		/^\[lottie:([a-z0-9-]+)\]$/i.exec(text) ||
		/^:lottie_([a-z0-9-]+):$/i.exec(text);
	if (lottieMatch) {
		const key = lottieMatch[1].toLowerCase();
		return LOTTIE_LABELS[key] || lottieMatch[1];
	}
	const stickerMatch = /^\[sticker:([a-z0-9/_-]+)\]$/i.exec(text);
	if (stickerMatch) {
		return stickerMatch[1].split("/").pop() || "贴纸";
	}
	if (/^mx-sticker:/i.test(text)) {
		return text.replace(/^mx-sticker:/i, "").trim() || "贴纸";
	}
	return text;
}

const INLINE_STICKER_PATH_RE =
	/(?:\/assets\/stickers\/(?:qq|bmoji)\/|\/chat-api\/emoji\/|\/waline-emojis\/|qface)/i;

export function isChatInlineSticker(
	url?: string,
	alt?: string,
	stickerMap?: Map<string, StickerItem>,
): boolean {
	const rawUrl = (url || "").trim();
	const rawAlt = (alt || "").trim();
	if (!rawUrl && !rawAlt) return false;

	if (rawUrl) {
		if (INLINE_STICKER_PATH_RE.test(rawUrl)) {
			return true;
		}
		if (stickerMap) {
			for (const item of stickerMap.values()) {
				if (item.url && item.url === rawUrl) {
					return item.category === "qq" || item.category === "emoji";
				}
			}
		}
	}

	if (rawAlt) {
		const lowerAlt = rawAlt.toLowerCase();
		if (
			lowerAlt.startsWith("emoji:") ||
			lowerAlt.startsWith("qq:") ||
			rawAlt.startsWith("表情：") ||
			rawAlt.startsWith("表情:") ||
			/^:(?:qq|bmoji)_[a-zA-Z0-9_.-]+:$/.test(rawAlt)
		) {
			return true;
		}
		if (stickerMap) {
			for (const item of stickerMap.values()) {
				if (item.name && item.name === rawAlt) {
					return item.category === "qq" || item.category === "emoji";
				}
			}
		}
	}

	return false;
}

export function resolveInlineStickerCategory(
	url: string,
	alt?: string,
): StickerCategory {
	const lowerUrl = url.toLowerCase();
	const lowerAlt = (alt || "").toLowerCase();
	if (
		lowerUrl.includes("/qq/") ||
		lowerAlt.includes("qq") ||
		lowerUrl.includes("qface")
	) {
		return "qq";
	}
	if (
		lowerUrl.includes("/bmoji/") ||
		lowerUrl.includes("/emoji/") ||
		lowerUrl.includes("/bilibili/")
	) {
		return "emoji";
	}
	return "sticker";
}
