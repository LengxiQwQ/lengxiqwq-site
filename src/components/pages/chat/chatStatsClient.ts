import { DEFAULT_CHAT_SERVER_URL } from "./chatReactions";
import type {
	ChatStatsRange,
	ChatStatsResponse,
	ChatStatsRoomScope,
} from "./chatStatsTypes";

export interface FetchChatStatsParams {
	room: ChatStatsRoomScope;
	range: ChatStatsRange;
	date?: string;
	site?: string;
	tzOffset?: number;
}

interface CacheEntry {
	expiresAt: number;
	data: ChatStatsResponse;
}

const statsCache = new Map<string, CacheEntry>();
const inflightRequests = new Map<string, Promise<ChatStatsResponse>>();
const MAX_CACHE_ENTRIES = 40;

export function getLocalDayKey(ts: number = Date.now()): string {
	const d = new Date(ts);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function shiftDayKeyLocal(dayKey: string, deltaDays: number): string {
	const [y, m, d] = dayKey.split("-").map(Number);
	if (!y || !m || !d) return dayKey;
	const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
	return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function buildCacheKey(
	serverUrl: string,
	params: FetchChatStatsParams,
): string {
	const tz = params.tzOffset ?? -new Date().getTimezoneOffset();
	return `${serverUrl}|${params.room}|${params.site || "all"}|${params.range}|${params.date || ""}|${tz}`;
}

export function getCachedChatStats(
	chatServerUrl: string,
	params: FetchChatStatsParams,
): ChatStatsResponse | null {
	const base = (chatServerUrl || DEFAULT_CHAT_SERVER_URL).replace(/\/+$/, "");
	const key = buildCacheKey(base, params);
	const entry = statsCache.get(key);
	if (!entry) return null;
	if (Date.now() > entry.expiresAt) {
		statsCache.delete(key);
		return null;
	}
	return entry.data;
}

export async function fetchChatStats(
	chatServerUrl: string,
	params: FetchChatStatsParams,
	options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<ChatStatsResponse> {
	const base = (chatServerUrl || DEFAULT_CHAT_SERVER_URL).replace(/\/+$/, "");
	const tz = params.tzOffset ?? -new Date().getTimezoneOffset();
	const key = buildCacheKey(base, { ...params, tzOffset: tz });

	if (!options.force) {
		const cached = statsCache.get(key);
		if (cached && Date.now() <= cached.expiresAt) {
			return cached.data;
		}
		const existing = inflightRequests.get(key);
		if (existing) return existing;
	}

	const query = new URLSearchParams({
		room: params.room,
		range: params.range,
		tzOffset: String(tz),
	});
	if (params.date) query.set("date", params.date);
	if (params.site && params.site !== "all") query.set("site", params.site);

	const task = (async () => {
		const resp = await fetch(`${base}/api/chat/stats?${query.toString()}`, {
			signal: options.signal,
		});
		if (!resp.ok) {
			throw new Error(`统计接口返回异常 (${resp.status})`);
		}
		const payload = (await resp.json()) as ChatStatsResponse;
		if (!payload?.ok) {
			throw new Error(payload?.error || "获取统计数据失败");
		}
		const ttlMs = payload.dateRange?.isLive ? 15_000 : 5 * 60_000;
		if (statsCache.size >= MAX_CACHE_ENTRIES) {
			const oldestKey = statsCache.keys().next().value;
			if (oldestKey) statsCache.delete(oldestKey);
		}
		statsCache.set(key, {
			expiresAt: Date.now() + ttlMs,
			data: payload,
		});
		return payload;
	})().finally(() => {
		inflightRequests.delete(key);
	});

	if (!options.force) {
		inflightRequests.set(key, task);
	}
	return task;
}

export function formatDeltaBadge(
	current: number,
	previous: number | undefined | null,
): { text: string; direction: "up" | "down" | "flat" } | null {
	if (previous === null || previous === undefined) return null;
	if (previous === 0 && current === 0)
		return { text: "持平", direction: "flat" };
	if (previous === 0) return { text: "+100%", direction: "up" };
	const pct = Math.round(((current - previous) / previous) * 100);
	if (pct === 0) return { text: "持平", direction: "flat" };
	return {
		text: `${pct > 0 ? "+" : ""}${pct}%`,
		direction: pct > 0 ? "up" : "down",
	};
}

export function formatStatNumber(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (n >= 100_000) return `${(n / 10_000).toFixed(1)}w`;
	return n.toLocaleString("zh-CN");
}
