const LABEL_MAX = 240;
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;

function label(value, fallback = "") {
	return typeof value === "string"
		? value.trim().slice(0, LABEL_MAX) || fallback
		: fallback;
}

function coverUrl(value) {
	if (typeof value !== "string" || value.length > 1024) return "";
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? url.href : "";
	} catch {
		return "";
	}
}

export function normalizeMusicTrack(input) {
	if (input?.provider !== "qq") return null;
	const sourceId =
		input.sourceId ||
		(typeof input.id === "string" && input.id.startsWith("qq:")
			? input.id.slice(3)
			: "");
	if (typeof sourceId !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(sourceId))
		return null;
	const durationSec = Number(input.durationSec);
	return {
		id: "qq:" + sourceId,
		sourceId,
		provider: "qq",
		title: label(input.title, "未知曲目"),
		artist: label(input.artist, "未知歌手"),
		album: label(input.album) || undefined,
		cover: coverUrl(input.cover),
		durationSec:
			Number.isFinite(durationSec) && durationSec > 0 && durationSec <= 86400
				? durationSec
				: 0,
	};
}

export async function readPlaylistJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req.iterator({ destroyOnReturn: false })) {
		size += chunk.length;
		if (size > MAX_PLAYLIST_BYTES) {
			req.resume();
			throw Object.assign(new Error("playlist body too large"), {
				statusCode: 413,
			});
		}
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
