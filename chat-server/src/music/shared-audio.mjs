import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetchAudio, identifyAudio } from "./audio-source.mjs";
import { openCompletedTrack, parseRange } from "./stream-cache.mjs";
import { idleWatchdog } from "./stream-timeouts.mjs";

const SHARED_DIR =
	process.env.CHAT_SHARED_MUSIC_DIR || "/opt/chat-server/data/shared_music";
const SHARED_TTL_MS = 8 * 24 * 60 * 60 * 1000; // 8 days
const MAX_FILE_BYTES = 24 * 1024 * 1024; // 24 MB per track
const MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB total budget
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const FETCH_TIMEOUT_MS = 14_000;

const inFlight = new Map();
let cleanupTimer = null;
let cleanupPending;

function mimeToExt(mimeType) {
	if (mimeType === "audio/mp4" || mimeType === "audio/aac") return "m4a";
	if (mimeType === "audio/flac") return "flac";
	if (mimeType === "audio/ogg") return "ogg";
	if (mimeType === "audio/webm") return "webm";
	return "mp3";
}

function getShareId(trackKey) {
	return createHash("sha256").update(String(trackKey)).digest("hex").slice(0, 16);
}

function getPaths(shareId) {
	return {
		audio: path.join(SHARED_DIR, `${shareId}.audio`),
		meta: path.join(SHARED_DIR, `${shareId}.meta.json`),
	};
}

async function removeEntry(shareId, observedAt) {
	if (inFlight.has(shareId)) return false;
	const files = getPaths(shareId);
	const remove = (async () => {
		const stat = await fs.stat(files.meta).catch(() => null);
		if (stat && stat.mtimeMs >= observedAt) return false;
		await Promise.all([files.audio, files.meta].map(file => fs.unlink(file).catch(() => {})));
		return true;
	})();
	// A writer that arrives during eviction waits and rechecks the disk.
	inFlight.set(shareId, remove.then(() => null));
	try { return await remove; } finally { inFlight.delete(shareId); }
}

async function readValidEntry(shareId) {
	if (!/^[a-f0-9]{16}$/i.test(shareId)) return null;
	const files = getPaths(shareId);
	try {
		const meta = JSON.parse(await fs.readFile(files.meta, "utf8"));
		if (!meta || !meta.complete || typeof meta.expiresAt !== "number") return null;
		if (meta.expiresAt <= Date.now()) {
			return { expired: true };
		}
		const file = await fs.open(files.audio, "r");
		let stat;
		try {
			stat = await file.stat();
			if (stat.size <= 1024 || stat.size !== meta.size) return null;
			const prefix = Buffer.alloc(16);
			const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
			const type = identifyAudio(prefix.subarray(0, bytesRead));
			if (!type || mimeToExt(type) !== meta.ext) return null;
		} finally {
			await file.close();
		}
		return {
			expired: false,
			shareId,
			audioPath: files.audio,
			metaPath: files.meta,
			meta,
			size: stat.size,
		};
	} catch {
		return null;
	}
}

export function cleanupExpiredSharedAudio() {
	cleanupPending ??= trimSharedAudio().finally(() => { cleanupPending = undefined; });
	return cleanupPending;
}

async function trimSharedAudio() {
	try {
		await fs.mkdir(SHARED_DIR, { recursive: true });
		const names = await fs.readdir(SHARED_DIR);
		const now = Date.now();
		const validEntries = [];

		for (const name of names) {
			if (!name.endsWith(".meta.json")) continue;
			const shareId = name.slice(0, -".meta.json".length);
			if (inFlight.has(shareId)) continue;
			const files = getPaths(shareId);
			try {
				const meta = JSON.parse(await fs.readFile(files.meta, "utf8"));
				if (!meta?.complete || typeof meta.expiresAt !== "number" || meta.expiresAt <= now) {
					await removeEntry(shareId, now);
					continue;
				}
				const stat = await fs.stat(files.audio).catch(() => null);
				if (!stat || stat.size <= 0) {
					await removeEntry(shareId, now);
					continue;
				}
				validEntries.push({
					shareId,
					size: stat.size,
					expiresAt: meta.expiresAt,
				});
			} catch {
				await removeEntry(shareId, now);
			}
		}

		const validIds = new Set(names.filter(name => name.endsWith(".meta.json")).map(name => name.slice(0, -10)));
		for (const name of names) {
			if (name.endsWith(".tmp")) {
				const full = path.join(SHARED_DIR, name);
				const st = await fs.stat(full).catch(() => null);
				if (st && now - st.mtimeMs > 10 * 60 * 1000) {
					await fs.unlink(full).catch(() => {});
				}
			} else if (name.endsWith(".audio")) {
				const shareId = name.slice(0, -".audio".length);
				if (!validIds.has(shareId) && !inFlight.has(shareId)) {
					await removeEntry(shareId, now);
				}
			}
		}

		let totalBytes = validEntries.reduce((sum, e) => sum + e.size, 0);
		if (totalBytes > MAX_TOTAL_BYTES) {
			validEntries.sort((a, b) => a.expiresAt - b.expiresAt);
			for (const entry of validEntries) {
				if (totalBytes <= MAX_TOTAL_BYTES) break;
				if (inFlight.has(entry.shareId)) continue;
				if (await removeEntry(entry.shareId, now)) totalBytes -= entry.size;
			}
		}
	} catch (err) {
		console.warn("[SharedAudio] cleanup error:", err?.message || err);
	}
}

export function startSharedAudioCleanup() {
	void cleanupExpiredSharedAudio();
	if (!cleanupTimer) {
		cleanupTimer = setInterval(() => {
			void cleanupExpiredSharedAudio();
		}, CLEANUP_INTERVAL_MS);
		cleanupTimer.unref?.();
	}
}

export async function cacheSharedAudio(options) {
	const { trackKey, cacheOnly = false } = options;
	const shareId = getShareId(trackKey);
	const running = inFlight.get(shareId);
	if (running) {
		const result = await running;
		if (result || cacheOnly) return result;
		return cacheSharedAudio(options);
	}
	if (inFlight.size >= 12) throw new Error("分享缓存繁忙");
	const pending = prepareSharedFile(shareId, options).finally(() => inFlight.delete(shareId));
	inFlight.set(shareId, pending);
	return pending;
}

async function prepareSharedFile(shareId, { origin, trackKey, sourceUrl, title, artist, cacheOnly, signal }) {
	signal?.throwIfAborted();
	await fs.mkdir(SHARED_DIR, { recursive: true });
	const files = getPaths(shareId);
	const existing = await readValidEntry(shareId);
	const expiresAt = Date.now() + SHARED_TTL_MS;
	const tmpAudio = files.audio + ".tmp";
	const tmpMeta = files.meta + ".tmp";
	let meta = existing?.meta;
	let cached;
	try {
		if (!meta) {
			cached = await openCompletedTrack(trackKey + ":128");
			if (!cached && cacheOnly) return null;
			if (!cached && !sourceUrl) throw new Error("播放缓存已更新");
			const controller = new AbortController();
			const signals = [controller.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)];
			if (signal) signals.push(signal);
			const downloadSignal = AbortSignal.any(signals);
			let expectedSize = cached?.size || 0;
			let input;
			if (cached) {
				input = cached.file.createReadStream({ autoClose: false, start: 0 });
			} else {
				const upstream = await fetchAudio(sourceUrl, { signal: downloadSignal });
				if (!upstream.ok || !upstream.body) {
					await upstream.body?.cancel();
					throw new Error("音频下载暂时失败");
				}
				expectedSize = Number(upstream.headers.get("content-length") || 0);
				if (upstream.status === 206) {
					const range = /^bytes 0-(\d+)\/(\d+)$/.exec(upstream.headers.get("content-range") || "");
					if (!range || Number(range[1]) + 1 !== Number(range[2]) || (expectedSize && expectedSize !== Number(range[2]))) {
						await upstream.body.cancel();
						throw new Error("只收到部分音频");
					}
					expectedSize = Number(range[2]);
				}
				if (expectedSize > MAX_FILE_BYTES) {
					await upstream.body.cancel();
					throw new Error("分享音频超过大小限制");
				}
				input = Readable.fromWeb(upstream.body);
			}
			let size = 0;
			let prefix = Buffer.alloc(0);
			const watchdog = idleWatchdog(controller, 4500);
			const meter = new Transform({
				transform(chunk, _, cb) {
					watchdog.touch();
					size += chunk.length;
					if (size > MAX_FILE_BYTES) return cb(new Error("分享音频超过大小限制"));
					if (prefix.length < 16) prefix = Buffer.concat([prefix, chunk.subarray(0, 16 - prefix.length)]);
					cb(null, chunk);
				}
			});
			try {
				await pipeline(input, meter, createWriteStream(tmpAudio), { signal: downloadSignal });
			} finally {
				watchdog.stop();
			}
			const mimeType = identifyAudio(prefix);
			if (!mimeType || size <= 1024 || (expectedSize && size !== expectedSize)) {
				throw new Error("音频文件不完整");
			}
			meta = { shareId, trackKey, title, artist, mimeType, ext: mimeToExt(mimeType),
				size, complete: true, createdAt: Date.now() };
			await fs.rename(tmpAudio, files.audio);
		}
		meta = { ...meta, expiresAt, updatedAt: Date.now() };
		await fs.writeFile(tmpMeta, JSON.stringify(meta));
		await fs.rename(tmpMeta, files.meta);
		if (!existing?.meta) void cleanupExpiredSharedAudio();
		return { shareId, sharedAudioUrl: origin.replace(/\/+$/, "") + "/api/music/shared/" + shareId + "." + meta.ext,
			expiresAt, mimeType: meta.mimeType, size: meta.size, cached: Boolean(existing?.meta || cached) };
	} finally {
		await cached?.file.close();
		await Promise.all([tmpAudio, tmpMeta].map(file => fs.unlink(file).catch(() => {})));
	}
}

export async function isReadyShare(url, origin) {
	try {
		const parsed = new URL(url);
		if (parsed.origin !== new URL(origin).origin) return false;
		const match = /^\/api\/music\/shared\/([a-f0-9]{16})\.(mp3|m4a|flac|ogg|webm)$/.exec(parsed.pathname);
		if (!match) return false;
		const entry = await readValidEntry(match[1]);
		return Boolean(entry?.meta?.ext === match[2]);
	} catch {
		return false;
	}
}

export async function handleSharedAudioRequest(req, res, pathname) {
	const rawName = pathname.slice("/api/music/shared/".length);
	const match = /^([a-f0-9]{16})\.(mp3|m4a|flac|ogg|webm)$/i.exec(rawName);
	if (!match) {
		res.writeHead(400, {
			"Content-Type": "application/json; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
		});
		res.end(JSON.stringify({ ok: false, error: "无效的分享音频标识" }));
		return;
	}

	const shareId = match[1].toLowerCase();
	const entry = await readValidEntry(shareId);
	if (!entry) {
		res.writeHead(404, {
			"Content-Type": "application/json; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
		});
		res.end(JSON.stringify({ ok: false, expired: true, error: "分享音频不存在或已清理" }));
		return;
	}

	if (entry.expired) {
		res.writeHead(410, {
			"Content-Type": "application/json; charset=utf-8",
			"Access-Control-Allow-Origin": "*",
		});
		res.end(
			JSON.stringify({
				ok: false,
				expired: true,
				error: "该分享音频已超过 8 天有效期并已清理",
			}),
		);
		return;
	}

	const { size, audioPath, meta } = entry;
	const contentType = meta.mimeType || "audio/mpeg";
	const range = parseRange(req.headers.range, size);

	if (range === false) {
		res.writeHead(416, {
			"Content-Range": `bytes */${size}`,
			"Access-Control-Allow-Origin": "*",
		});
		res.end();
		return;
	}

	const commonHeaders = {
		"Content-Type": contentType,
		"Accept-Ranges": "bytes",
		"Access-Control-Allow-Origin": "*",
		"Cache-Control": "public, max-age=86400",
		"X-Shared-Audio-Expires": String(meta.expiresAt),
	};

	if (range) {
		const chunkLen = range.end - range.start + 1;
		res.writeHead(206, {
			...commonHeaders,
			"Content-Range": `bytes ${range.start}-${range.end}/${size}`,
			"Content-Length": String(chunkLen),
		});
		if (req.method === "HEAD") {
			res.end();
			return;
		}
		const stream = createReadStream(audioPath, { start: range.start, end: range.end });
		stream.on("error", () => {
			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
		stream.pipe(res);
		return;
	}

	res.writeHead(200, {
		...commonHeaders,
		"Content-Length": String(size),
	});
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	const stream = createReadStream(audioPath);
	stream.on("error", () => {
		if (!res.headersSent) res.writeHead(500);
		res.end();
	});
	stream.pipe(res);
}
