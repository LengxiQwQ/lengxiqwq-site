import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function stableTrack(track) {
	const { streamUrl, lrcUrl, url, lrc, ...identity } = track;
	return identity;
}

function durationOf(value) {
	return Number.isFinite(value) && value > 0 && value <= 86400 ? value : 0;
}

export function computeVoteThreshold(
	onlineMemberCount,
	isFallback,
	requesterOnline,
) {
	if (isFallback) return 1;
	return 2;
}

function writeJsonAtomic(filePath, data) {
	const tmpPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
	try {
		writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
		renameSync(tmpPath, filePath);
	} catch (err) {
		console.error(`[Data] Failed atomic write for ${filePath}:`, err.message);
	}
}

const PREPARED_REUSE_TTL_MS = 25 * 60_000;

export class MusicManager {
	constructor({
		roomId = "chat",
		dataDir,
		musicRegistry,
		signSecret,
		serverOrigin,
		onStateChanged,
		onPrefetchTrack,
		onUnavailable,
		getListeners = () => [],
	}) {
		this.roomId = roomId;
		this.dataDir = dataDir;
		this.musicRegistry = musicRegistry;
		this.signSecret = signSecret;
		this.serverOrigin = serverOrigin;
		this.onStateChanged = onStateChanged || (() => {});
		this.onPrefetchTrack = onPrefetchTrack || (() => {});
		this.onUnavailable = onUnavailable;
		this.getListeners = getListeners;
		this.stateVersion = 0;

		this.current = null;
		this.queue = [];
		this.queueVotes = new Map();
		this.queueVotePlayUid = null;
		this.historyMap = new Map(); // trackId -> MusicHistoryEntry
		this.historyLogs = []; // Array of MusicHistoryLogEntry
		this.fallbackTracks = [];
		this.fallbackPlaylistId = null;
		this.fallbackPlaylistName = null;
		this._nextLogId = 1;
		this._advanceTimer = null;
		this._refreshPreparedTimer = null;
		this.preparedFallback = null;
		this.preparedFallbackPool = [];
		this._fillingPool = null;
		this.preparedQueue = null;
		this._prepareFallbackTimer = null;
		this._actorLastErrorAt = new Map();

		this.generation = 0;
		this.fallbackGeneration = 0;
		this.statePath = join(this.dataDir, "music_state_" + roomId + ".json");
		this.loadData();
		try {
			const state = JSON.parse(readFileSync(this.statePath, "utf8"));
			if (Array.isArray(state.queue))
				this.queue = state.queue.filter(
					(item) => item?.track?.provider === "qq",
				);
			const current = state.current;
			if (current?.track?.provider === "qq" && !current.isFallback) {
				this.queue.unshift({
					uid: current.requestUid || current.uid,
					track: current.track,
					requesterKey: current.requesterKey,
					requesterName: current.requesterName,
					requesterAvatar: current.requesterAvatar,
					startedAt: current.startedAt,
				});
			}
		} catch (error) {
			if (error.code !== "ENOENT")
				console.warn("[Music] restore", this.roomId, error.message);
		}
	}

	loadData() {
		const histFileName = this.roomId
			? `music_history_${this.roomId}.json`
			: "music_history.json";
		const logsFileName = this.roomId
			? `music_request_logs_${this.roomId}.json`
			: "music_request_logs.json";

		let histPath = join(this.dataDir, histFileName);
		if (this.roomId === "chat" && !existsSync(histPath)) {
			histPath = join(this.dataDir, "music_history.json");
		}
		if (existsSync(histPath)) {
			try {
				const arr = JSON.parse(readFileSync(histPath, "utf8"));
				if (Array.isArray(arr)) {
					for (const item of arr) {
						if (item && item.track && item.track.id) {
							this.historyMap.set(item.track.id, {
								...item,
								track: stableTrack(item.track),
							});
						}
					}
				}
			} catch (e) {
				console.error(
					`[Music:${this.roomId}] Error loading ${histFileName}:`,
					e.message,
				);
			}
		}

		let logsPath = join(this.dataDir, logsFileName);
		if (this.roomId === "chat" && !existsSync(logsPath)) {
			logsPath = join(this.dataDir, "music_request_logs.json");
		}
		if (existsSync(logsPath)) {
			try {
				const arr = JSON.parse(readFileSync(logsPath, "utf8"));
				if (Array.isArray(arr)) {
					this.historyLogs = arr
						.filter((item) => item?.track)
						.map((item) => ({ ...item, track: stableTrack(item.track) }));
					for (const item of arr) {
						if (item.id && item.id >= this._nextLogId) {
							this._nextLogId = item.id + 1;
						}
					}
				}
			} catch (e) {
				console.error(
					`[Music:${this.roomId}] Error loading ${logsFileName}:`,
					e.message,
				);
			}
		}
	}

	savePlayback() {
		writeJsonAtomic(this.statePath, {
			current: this.current && {
				...this.current,
				track: stableTrack(this.current.track),
			},
			queue: this.queue.map((item) => ({
				...item,
				track: stableTrack(item.track),
			})),
		});
	}

	resume() {
		if (this.queue.length || this.fallbackTracks.length)
			return this.advanceNext();
	}

	setFallbackPlaylist(
		playlistId,
		tracks,
		playlistName,
		{ start = true, all = false } = {},
	) {
		this.fallbackPlaylistId = playlistId;
		this.fallbackPlaylistName = playlistName;
		this.fallbackTracks = playlistId || all ? tracks : [];
		this.fallbackGeneration++;
		this.preparedFallback = null;
		this.preparedFallbackPool = [];
		if (start && (!this.current || this.current.isFallback)) {
			this.generation++;
			void this.advanceNext();
		} else if (this.current && !this.queue.length) {
			void this.prepareNext();
		}
	}

	saveDataDebounced() {
		clearTimeout(this._saveTimer);
		this._saveTimer = setTimeout(() => {
			const histFileName = this.roomId
				? `music_history_${this.roomId}.json`
				: "music_history.json";
			const logsFileName = this.roomId
				? `music_request_logs_${this.roomId}.json`
				: "music_request_logs.json";

			const histPath = join(this.dataDir, histFileName);
			const logsPath = join(this.dataDir, logsFileName);

			const histArr = Array.from(this.historyMap.values())
				.sort(
					(a, b) =>
						b.lastRequestedAt - a.lastRequestedAt ||
						b.requestCount - a.requestCount,
				)
				.slice(0, 300);

			const logsArr = this.historyLogs.slice(-500);

			writeJsonAtomic(histPath, histArr);
			writeJsonAtomic(logsPath, logsArr);
		}, 2000);
	}

	getSnapshot(onlineKeys = new Set()) {
		const requesterOnline = this.current
			? onlineKeys.has(this.current.requesterKey)
			: false;
		const voteCount = this.current ? this.current.skipVotes.length : 0;
		const voteThreshold = this.current
			? computeVoteThreshold(
					onlineKeys.size,
					this.current.isFallback,
					requesterOnline,
				)
			: 1;

		const histList = Array.from(this.historyMap.values())
			.sort(
				(a, b) =>
					b.lastRequestedAt - a.lastRequestedAt ||
					b.requestCount - a.requestCount,
			)
			.slice(0, 100);

		const logsList = this.historyLogs.slice(-80).reverse();

		const prepared = this.queue.length
			? this.preparedQueue
			: this.preparedFallback;
		const next = prepared?.playable
			? {
					uid: String(prepared.key),
					track: prepared.playable,
					startedAt: 0,
					durationSec: prepared.playable.durationSec || 0,
					requesterKey: "",
					requesterName: "",
					isFallback: !this.queue.length,
					skipVotes: [],
				}
			: null;
		return {
			protocolVersion: 2,
			stateVersion: ++this.stateVersion,
			next,
			current: this.current && {
				...this.current,
				phase:
					(this.current.phase === "scheduled" ||
						this.current.phase === "preparing") &&
					Date.now() >= this.current.startedAt
						? "playing"
						: this.current.phase || "playing",
			},
			queue: this.queue.map((item) => ({
				...item,
				playVotes:
					this.queueVotePlayUid === this.current?.uid
						? [...this.queueVotes.entries()]
								.filter(([, target]) => target === item.uid)
								.map(([key]) => key)
						: [],
			})),
			history: histList,
			historyLogs: logsList,
			requesterOnline,
			voteCount,
			voteThreshold,
			skipVoteNames: this.current ? this.current.skipVoteNames || [] : [],
			serverTime: Date.now(),
		};
	}

	async enqueueTrack(rawTrack, requester) {
		const requesterKey = requester.userKey;
		const requesterName = requester.name;
		const requesterAvatar = requester.avatar || "";
		const check = () => {
			if (
				this.current?.track.id === rawTrack.id ||
				this.queue.some((item) => item.track.id === rawTrack.id)
			) {
				return "歌曲已在播放或排队";
			}
			if (
				this.queue.length >= 100 ||
				(!requester.isAdmin &&
					this.queue.filter((item) => item.requesterKey === requesterKey)
						.length >= 10)
			) {
				return "待播队列已满，请稍后再点歌";
			}
			return null;
		};
		const before = check();
		if (before) return { ok: false, error: before };
		const playable = await this.resolve(rawTrack);
		const after = check();
		if (after) return { ok: false, error: after };
		if (!playable) return { ok: false, error: "歌曲暂时没有可用音源" };
		const track = stableTrack(playable);

		// Record into historyMap
		const now = Date.now();
		let histEntry = this.historyMap.get(playable.id);
		if (!histEntry) {
			histEntry = {
				track,
				requestCount: 1,
				lastRequesterName: requesterName,
				firstRequestedAt: now,
				lastRequestedAt: now,
			};
			this.historyMap.set(playable.id, histEntry);
		} else {
			histEntry.requestCount += 1;
			histEntry.lastRequesterName = requesterName;
			histEntry.lastRequestedAt = now;
			histEntry.track = { ...histEntry.track, ...track };
		}

		// Record into historyLogs
		const uid = "q_" + now + "_" + Math.random().toString(36).slice(2, 9);
		const logEntry = {
			requestUid: uid,
			outcome: "queued",
			id: this._nextLogId++,
			track,
			requesterKey,
			requesterName,
			requesterAvatar,
			requestedAt: now,
			requestCount: histEntry.requestCount,
		};
		this.historyLogs.push(logEntry);
		if (this.historyLogs.length > 500) this.historyLogs.shift();
		if (this.historyMap.size > 300) {
			const oldest = [...this.historyMap.entries()].reduce((a, b) =>
				a[1].lastRequestedAt <= b[1].lastRequestedAt ? a : b,
			);
			this.historyMap.delete(oldest[0]);
		}
		this.saveDataDebounced();

		// If nothing playing or currently playing fallback, play immediately!
		if ((!this.current || this.current.isFallback) && this.queue.length === 0) {
			await Promise.resolve(
				this.onPrefetchTrack(playable.streamUrl, "warm"),
			).catch(() => {});
			if (
				(!this.current || this.current.isFallback) &&
				this.queue.length === 0
			) {
				clearTimeout(this._advanceTimer);
				this.playTrack(
					playable,
					{
						userKey: requesterKey,
						name: requesterName,
						avatar: requesterAvatar,
					},
					false,
					Date.now(),
					uid,
				);
				this.markOutcome(uid, "played");
				this.onStateChanged();
				return { ok: true, playImmediately: true, track: playable };
			}
		}

		// Otherwise add to queue
		const queueItem = {
			uid,
			track,
			requesterKey,
			requesterName,
			requesterAvatar,
			enqueuedAt: now,
		};
		this.queue.push(queueItem);
		if (this.queue[0] === queueItem) {
			void this.prepareNext(playable);
		} else if (this.queue[1] === queueItem) {
			this.onPrefetchTrack(playable.streamUrl, false);
		}
		this.savePlayback();
		this.onStateChanged();

		return {
			ok: true,
			playImmediately: false,
			position: this.queue.length,
			track: playable,
		};
	}

	markOutcome(uid, outcome) {
		const entry = this.historyLogs.findLast((log) => log.requestUid === uid);
		if (entry) {
			entry.outcome = outcome;
			this.saveDataDebounced();
		}
	}

	scheduleAdvance() {
		clearTimeout(this._advanceTimer);
		clearTimeout(this._refreshPreparedTimer);
		const play = this.current;
		if (!play) return;
		const remaining = Math.max(
			0,
			play.startedAt + play.durationSec * 1000 - Date.now(),
		);
		this._advanceTimer = setTimeout(() => {
			if (this.current === play) void this.advanceNext();
		}, remaining);
		if (remaining > 30_000) {
			this._refreshPreparedTimer = setTimeout(() => {
				if (this.current === play) void this.prepareNext(undefined, true);
			}, remaining - 25_000);
		}
	}

	ready() {
		return true;
	}

	recheckReady() {}

	playTrack(
		track,
		requester,
		isFallback = false,
		startedAt = Date.now(),
		requestUid,
	) {
		this.generation++;
		this.fallbackGeneration++;
		this.preparedFallback = null;
		if (Array.isArray(this.preparedFallbackPool)) {
			this.preparedFallbackPool = this.preparedFallbackPool.filter(
				(item) => item?.playable?.id && item.playable.id !== track.id,
			);
		}
		this.current = {
			uid: "play_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9),
			track,
			requesterKey: requester.userKey,
			requesterName: requester.name,
			requesterAvatar: requester.avatar || "",
			startedAt,
			phase: "playing",
			durationSec: durationOf(track.durationSec) || 240,
			isFallback,
			requestUid,
			sourceRevision: 0,
			skipVotes: [],
			skipVoteNames: [],
		};
		this.onPrefetchTrack(track.streamUrl, true);
		this.savePlayback();
		this.scheduleAdvance();

		// Warm the next track in the background so the next switch hits VPS cache immediately.
		clearTimeout(this._prepareFallbackTimer);
		this._prepareFallbackTimer = setTimeout(() => void this.prepareNext(), 20);
	}

	async resolveFallbackTrackPlayable(excludeIds = new Set()) {
		if (this.fallbackTracks.length === 0) return null;
		const tracks = this.fallbackTracks;
		const currentId = this.current?.track?.id || "";
		const currentSourceId = this.current?.track?.sourceId || "";

		// Pick up to 8 distinct candidate indices, skipping known-unplayable and already-queued tracks
		const candidateIndices = [];
		const tried = new Set();
		const maxAttempts = Math.min(tracks.length * 3, 24);
		for (
			let i = 0;
			i < maxAttempts && candidateIndices.length < Math.min(8, tracks.length);
			i++
		) {
			const idx = Math.floor(Math.random() * tracks.length);
			if (tried.has(idx)) continue;
			tried.add(idx);
			const item = tracks[idx];
			if (!item) continue;
			if (item._unmatchedAt && Date.now() - item._unmatchedAt < 30 * 60_000)
				continue;
			const itemSourceId =
				item.matchedTrack?.sourceId || item.sourceTrackId || "";
			const itemId =
				item.matchedTrack?.id || (itemSourceId ? `qq:${itemSourceId}` : "");
			if (itemId && this.musicRegistry?.isKnownUnplayable?.(itemId)) continue;
			if (
				tracks.length > 1 &&
				itemSourceId &&
				(itemSourceId === currentSourceId || itemId === currentId)
			) {
				continue;
			}
			if (
				tracks.length > excludeIds.size + 1 &&
				itemId &&
				excludeIds.has(itemId)
			) {
				continue;
			}
			candidateIndices.push(idx);
		}
		if (candidateIndices.length === 0 && tracks.length > 0) {
			candidateIndices.push(Math.floor(Math.random() * tracks.length));
		}

		// Resolve sequentially (1 candidate at a time) so we never burst-throttle upstream APIs
		for (const index of candidateIndices) {
			const chosen = tracks[index];
			if (!chosen) continue;
			try {
				const track = await this.musicRegistry.resolvePlaylistTrack(chosen);
				if (!track) continue;
				if (
					tracks.length > 1 &&
					(track.id === currentId || excludeIds.has(track.id))
				)
					continue;
				if (this.musicRegistry?.isKnownUnplayable?.(track.id)) continue;
				const playable = await this.resolve(track);
				if (playable) return playable;
			} catch (err) {
				console.warn(
					`[Music:${this.roomId}] Error resolving fallback track:`,
					err.message,
				);
			}
		}
		return null;
	}

	async fillFallbackPool() {
		if (this._fillingPool) return this._fillingPool;
		if (!this.current || this.queue.length > 0 || !this.fallbackTracks?.length)
			return;
		if (!Array.isArray(this.preparedFallbackPool))
			this.preparedFallbackPool = [];

		const promise = (async () => {
			while (
				this.current &&
				this.queue.length === 0 &&
				this.fallbackTracks.length > 0 &&
				this.preparedFallbackPool.length < 2
			) {
				const gen = this.fallbackGeneration;
				const exclude = new Set();
				if (this.current?.track?.id) exclude.add(this.current.track.id);
				if (this.preparedFallback?.playable?.id)
					exclude.add(this.preparedFallback.playable.id);
				for (const item of this.preparedFallbackPool) {
					if (item?.playable?.id) exclude.add(item.playable.id);
				}
				const playable = await this.resolveFallbackTrackPlayable(exclude);
				if (!playable || !this.current || this.queue.length > 0) break;
				if (this.fallbackTracks.length === 0) break;
				// Even if fallbackGeneration advanced while resolving, as long as the track is distinct, keep it!
				if (playable.id === this.current?.track?.id) continue;
				if (this.preparedFallback?.playable?.id === playable.id) continue;
				if (
					this.preparedFallbackPool.some(
						(item) => item?.playable?.id === playable.id,
					)
				)
					continue;
				this.onPrefetchTrack(playable.streamUrl, false);
				this.preparedFallbackPool.push({
					key: this.fallbackGeneration || gen,
					playable,
					checkedAt: Date.now(),
				});
			}
		})().finally(() => {
			if (this._fillingPool === promise) this._fillingPool = null;
		});
		this._fillingPool = promise;
		return promise;
	}

	async prepareNext(resolved, refresh = false) {
		if (!this.current) return;
		const queued = this.queue[0];
		const slot = queued ? "preparedQueue" : "preparedFallback";
		const key = queued?.uid ?? this.fallbackGeneration;
		const previous = this[slot]?.key === key ? this[slot] : null;
		if (previous) {
			if (!refresh || !previous.checkedAt) return;
			const usable = await this.usePrepared(previous);
			if (usable && this[slot] === previous) {
				this.onPrefetchTrack(usable.streamUrl, false);
				return;
			}
		}
		if (
			queued
				? this.queue[0] !== queued
				: this.queue.length || this.fallbackGeneration !== key
		)
			return;
		if (!queued && !this.fallbackTracks.length) return;

		// Fast promote from pre-warmed fallback pool if available
		if (
			!queued &&
			!resolved &&
			!refresh &&
			Array.isArray(this.preparedFallbackPool)
		) {
			while (this.preparedFallbackPool.length > 0) {
				const pooled = this.preparedFallbackPool.shift();
				const usable = await this.usePrepared(pooled);
				if (usable && usable.id !== this.current?.track?.id) {
					if (this.queue.length || this.fallbackGeneration !== key) return;
					this.preparedFallback = {
						key,
						playable: usable,
						checkedAt: pooled.checkedAt || Date.now(),
					};
					this.onPrefetchTrack(usable.streamUrl, false);
					if (this.advancing?.generation !== this.generation) {
						this.onStateChanged();
					}
					void this.fillFallbackPool();
					return;
				}
			}
		}

		const record = { key };
		this[slot] = record;
		record.pending = Promise.resolve(
			resolved ||
				(queued
					? this.resolve(queued.track)
					: previous?.playable
						? this.resolve(previous.playable)
						: this.resolveFallbackTrackPlayable()),
		);
		const playable = await record.pending;
		if (this[slot] !== record) return;
		if (!playable) {
			this[slot] = null;
			return;
		}
		record.playable = playable;
		record.checkedAt = Date.now();
		if (queued || !this.queue.length) {
			this.onPrefetchTrack(playable.streamUrl, false);
		}
		if (this.queue[1]?.track) {
			void this.resolve(this.queue[1].track)
				.then((second) => {
					if (second?.streamUrl) this.onPrefetchTrack(second.streamUrl, false);
				})
				.catch(() => {});
		} else if (!queued) {
			void this.fillFallbackPool();
		}
		if (this.advancing?.generation !== this.generation) {
			this.onStateChanged();
		}
	}

	async usePrepared(record) {
		if (!record) return null;
		if (!record.checkedAt) {
			if (!record.pending) return null;
			let timer;
			const playable = await Promise.race([
				record.pending,
				new Promise((resolve) => {
					timer = setTimeout(() => resolve(null), 2500);
				}),
			]).finally(() => clearTimeout(timer));
			return playable || null;
		}
		if (Date.now() - record.checkedAt < PREPARED_REUSE_TTL_MS)
			return record.playable;
		const cached = await this.musicRegistry
			.isCached?.(record.playable, this.signSecret)
			.catch(() => false);
		return cached ? record.playable : null;
	}

	async resolve(track, options) {
		try {
			return await this.musicRegistry.resolvePlayable(
				track,
				this.serverOrigin,
				this.signSecret,
				options,
			);
		} catch (error) {
			console.warn("[Music] resolve", this.roomId, track.id, error.message);
			return null;
		}
	}

	advanceNext() {
		const generation = this.generation;
		if (this.advancing?.generation === generation)
			return this.advancing.promise;
		clearTimeout(this._advanceTimer);
		clearTimeout(this._refreshPreparedTimer);
		clearTimeout(this._prepareFallbackTimer);
		const promise = this.selectNext(generation).finally(() => {
			if (this.advancing?.promise === promise) this.advancing = null;
		});
		this.advancing = { generation, promise };
		return promise;
	}

	async selectNext(generation) {
		while (this.queue.length) {
			const next = this.queue[0];
			const prepared =
				this.preparedQueue?.key === next.uid ? this.preparedQueue : null;
			const playable =
				(await this.usePrepared(prepared)) || (await this.resolve(next.track));
			if (generation !== this.generation) return;
			if (this.queue[0] !== next) continue;
			if (playable) {
				await Promise.resolve(
					this.onPrefetchTrack(playable.streamUrl, "warm"),
				).catch(() => {});
				if (generation !== this.generation) return;
				if (this.queue[0] !== next) continue;
				this.queue.shift();
				this.preparedQueue = null;
				const duration = durationOf(playable.durationSec) || 240;
				const startedAt =
					next.startedAt && Date.now() - next.startedAt < (duration - 2) * 1000
						? next.startedAt
						: Date.now();
				this.playTrack(
					playable,
					{
						userKey: next.requesterKey,
						name: next.requesterName,
						avatar: next.requesterAvatar,
					},
					false,
					startedAt,
					next.uid,
				);
				this.markOutcome(next.uid, "played");
				this.onStateChanged();
				return;
			}
			this.queue.shift();
			this.preparedQueue = null;
			this.markOutcome(next.uid, "unavailable");
			this.onUnavailable?.(next);
			this.current = null;
			this.savePlayback();
			this.onStateChanged();
		}

		const fallbackGeneration = this.fallbackGeneration;
		const prepared =
			this.preparedFallback?.key === fallbackGeneration
				? this.preparedFallback
				: null;
		this.preparedFallback = null;
		let known = await this.usePrepared(prepared);
		if (known && known.id === this.current?.track?.id) known = null;
		while (
			!known &&
			Array.isArray(this.preparedFallbackPool) &&
			this.preparedFallbackPool.length > 0
		) {
			const pooled = this.preparedFallbackPool.shift();
			const candidate = await this.usePrepared(pooled);
			if (candidate && candidate.id !== this.current?.track?.id) {
				known = candidate;
			}
		}
		const playable = known || (await this.resolveFallbackTrackPlayable());
		if (generation !== this.generation) return;
		if (this.queue.length || fallbackGeneration !== this.fallbackGeneration)
			return this.selectNext(generation);
		if (playable) {
			await Promise.resolve(
				this.onPrefetchTrack(playable.streamUrl, "warm"),
			).catch(() => {});
			if (generation !== this.generation) return;
			if (this.queue.length || fallbackGeneration !== this.fallbackGeneration)
				return this.selectNext(generation);
			this.playTrack(
				playable,
				{
					userKey: "system:fallback",
					name: this.fallbackPlaylistName + " (轮播)",
				},
				true,
			);
		} else {
			this.current = null;
			this.savePlayback();
			if (this.fallbackTracks.length) {
				this._advanceTimer = setTimeout(() => void this.advanceNext(), 30_000);
			}
		}
		this.onStateChanged();
	}

	skip(actor, onlineCount, listeningCount = 0) {
		if (!this.current) return { ok: false, error: "当前没有正在播放的歌曲" };

		const isOwner = actor.userKey === this.current.requesterKey;
		const isAdmin = Boolean(actor.isAdmin);
		const isFallback = Boolean(this.current.isFallback);

		// 轮播歌单、自己点的歌、站长：随时直接切！
		// 有效听歌人数 <= 2：随时直接切！
		const canDirect = isFallback || isOwner || isAdmin || listeningCount <= 2;

		if (canDirect) {
			this.advanceNext();
			return { ok: true, skipped: true };
		}

		return this.voteSkip(actor, onlineCount, listeningCount);
	}

	voteSkip(actor, onlineCount, listeningCount = 0) {
		if (!this.current) return { ok: false, error: "当前没有正在播放的歌曲" };
		if (
			this.current.isFallback ||
			actor.isAdmin ||
			actor.userKey === this.current.requesterKey ||
			listeningCount < 3
		) {
			this.advanceNext();
			return { ok: true, skipped: true };
		}

		// 取消投票 (Toggle)
		const idx = this.current.skipVotes.indexOf(actor.userKey);
		if (idx >= 0) {
			this.current.skipVotes.splice(idx, 1);
			if (Array.isArray(this.current.skipVoteNames)) {
				const nameIdx = this.current.skipVoteNames.indexOf(actor.name);
				if (nameIdx >= 0) this.current.skipVoteNames.splice(nameIdx, 1);
			}
			this.onStateChanged();
			return {
				ok: true,
				skipped: false,
				unvoted: true,
				votes: this.current.skipVotes.length,
			};
		}

		// 首次投票
		this.current.skipVotes.push(actor.userKey);
		if (!this.current.skipVoteNames) this.current.skipVoteNames = [];
		this.current.skipVoteNames.push(actor.name);

		const threshold = computeVoteThreshold(
			onlineCount,
			this.current.isFallback,
			true,
		);
		if (this.current.skipVotes.length >= threshold) {
			this.advanceNext();
			return { ok: true, skipped: true };
		}

		this.onStateChanged();
		return {
			ok: true,
			skipped: false,
			votes: this.current.skipVotes.length,
			threshold,
		};
	}

	removeQueue(uid, actor) {
		const idx = this.queue.findIndex((q) => q.uid === uid);
		if (idx < 0) return { ok: false, error: "排队曲目不存在" };

		const item = this.queue[idx];
		if (item.requesterKey !== actor.userKey && !actor.isAdmin) {
			return { ok: false, error: "无权移除他人点歌" };
		}

		this.queue.splice(idx, 1);
		for (const [key, target] of this.queueVotes)
			if (target === uid) this.queueVotes.delete(key);
		this.markOutcome(uid, "cancelled");
		if (idx === 0) {
			this.preparedQueue = null;
			void this.prepareNext();
		}
		this.savePlayback();
		this.onStateChanged();
		return { ok: true };
	}

	async playQueued(uid, actor, listeningCount = 0, playUid) {
		if (playUid && playUid !== this.current?.uid)
			return { ok: false, error: "歌曲已切换，请重试" };
		const item = this.queue.find((entry) => entry.uid === uid);
		if (!item) return { ok: false, error: "排队曲目不存在" };
		const currentUid = this.current?.uid ?? null;
		if (this.queueVotePlayUid !== currentUid) {
			this.queueVotes.clear();
			this.queueVotePlayUid = currentUid;
		}
		const canDirect =
			!this.current ||
			this.current.isFallback ||
			actor.isAdmin ||
			actor.userKey === this.current.requesterKey ||
			listeningCount < 3;
		if (!canDirect) {
			if (this.queueVotes.get(actor.userKey) === uid) {
				this.queueVotes.delete(actor.userKey);
				this.onStateChanged();
				return { ok: true, unvoted: true };
			}
			this.queueVotes.set(actor.userKey, uid);
			const votes = [...this.queueVotes.values()].filter(
				(target) => target === uid,
			).length;
			if (votes < 2) {
				this.onStateChanged();
				return { ok: true, votes, threshold: 2 };
			}
		}
		const generation = this.generation;
		const prepared =
			this.preparedQueue?.key === uid ? this.preparedQueue : null;
		const playable =
			(await this.usePrepared(prepared)) || (await this.resolve(item.track));
		if (
			generation !== this.generation ||
			this.current?.uid !== (currentUid ?? undefined)
		) {
			return { ok: false, error: "播放状态已更新，请重试" };
		}
		const index = this.queue.indexOf(item);
		if (index < 0) return { ok: false, error: "排队曲目已变更" };
		if (!playable) {
			this.queueVotes.clear();
			this.onStateChanged();
			return { ok: false, error: "歌曲暂时没有可用音源" };
		}
		await Promise.resolve(
			this.onPrefetchTrack(playable.streamUrl, "warm"),
		).catch(() => {});
		if (
			generation !== this.generation ||
			this.current?.uid !== (currentUid ?? undefined)
		) {
			return { ok: false, error: "播放状态已更新，请重试" };
		}
		const afterWarmIndex = this.queue.indexOf(item);
		if (afterWarmIndex < 0) return { ok: false, error: "排队曲目已变更" };
		this.queueVotes.clear();
		this.queue.splice(afterWarmIndex, 1);
		if (afterWarmIndex === 0) this.preparedQueue = null;
		this.playTrack(
			playable,
			{
				userKey: item.requesterKey,
				name: item.requesterName,
				avatar: item.requesterAvatar,
			},
			false,
			Date.now(),
			item.uid,
		);
		this.markOutcome(uid, "played");
		this.onStateChanged();
		return { ok: true };
	}

	reportDuration(playUid, value) {
		const play = this.current;
		const duration = durationOf(value);
		if (!play || play.uid !== playUid || !duration || play.measuredDuration)
			return;
		if (
			play.track.durationSec &&
			Math.abs(duration - play.durationSec) >
				Math.max(15, play.durationSec * 0.25)
		)
			return;
		if (duration < (Date.now() - play.startedAt) / 1000 - 2) return;
		play.measuredDuration = true;
		play.durationSec = duration;
		play.track.durationSec = duration;
		const history = this.historyMap.get(play.track.id);
		if (history) history.track.durationSec = duration;
		if (this.advancing?.generation !== this.generation) {
			this.scheduleAdvance();
			this.onStateChanged();
		}
		this.savePlayback();
		this.saveDataDebounced();
	}

	async reportError(playUid, actorKey, revision) {
		const play = this.current;
		if (
			!play ||
			play.uid !== playUid ||
			(revision !== undefined && revision !== play.sourceRevision) ||
			this.recovering === play
		)
			return;
		if (
			Date.now() - (play.lastRecoveryAt || 0) < 20_000 ||
			(play.recoveryCount || 0) >= 2
		)
			return;
		const lastError = this._actorLastErrorAt.get(actorKey) || 0;
		if (Date.now() - lastError < 12_000) return;
		this._actorLastErrorAt.set(actorKey, Date.now());
		if (this._actorLastErrorAt.size > 256)
			this._actorLastErrorAt.delete(this._actorLastErrorAt.keys().next().value);
		this.recovering = play;
		const generation = this.generation;
		const stale = () =>
			this.current !== play ||
			generation !== this.generation ||
			this.advancing?.generation === generation;
		try {
			play.lastRecoveryAt = Date.now();
			// A client timeout is not evidence that the shared source is broken.
			const healthy = await this.musicRegistry
				.isHealthy(play.track, this.signSecret)
				.catch(() => false);
			if (stale() || healthy) return;
			const playable = await this.resolve(play.track, { fresh: true });
			if (stale()) return;
			play.recoveryCount = (play.recoveryCount || 0) + 1;
			if (playable) {
				// Notify even for the same address: clients must actually reload that resource.
				play.track = playable;
				play.sourceRevision++;
				this.onPrefetchTrack(playable.streamUrl, true);
				this.onStateChanged();
			}
		} finally {
			if (this.recovering === play) this.recovering = null;
		}
	}

	ended(playUid) {
		const play = this.current;
		if (
			play?.uid === playUid &&
			Date.now() - play.startedAt >= Math.max(0, play.durationSec - 3) * 1000
		) {
			void this.advanceNext();
		}
	}

	getMemberTracks(userKey, beforeId = 0, limit = 50) {
		let list = this.historyLogs.filter((l) => l.requesterKey === userKey);
		if (beforeId > 0) {
			list = list.filter((l) => l.id < beforeId);
		}
		const safeLimit = Math.min(100, Math.max(1, limit));
		const slice = list.slice(-safeLimit).reverse();
		const hasMore = list.length > slice.length;
		const nextBeforeId = slice.length > 0 ? slice[slice.length - 1].id : 0;

		return {
			ok: true,
			tracks: slice,
			hasMore,
			nextBeforeId,
		};
	}
}
