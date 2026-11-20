import assert from "node:assert/strict";
import { getMaxListeners, setMaxListeners } from "node:events";
import test from "node:test";
import { MusicClock } from "../../src/components/pages/chat/musicClock.ts";
import {
	correctionForDrift,
	RoomAudioPlayer,
} from "../../src/components/pages/chat/roomAudioPlayer.ts";
import { MusicManager } from "./candidate/src/music/music-manager.mjs";
import { parseRange } from "./candidate/src/music/stream-cache.mjs";
import {
	signStreamProxyUrl,
	verifyStreamProxyToken,
} from "./candidate/src/music/stream-signer.mjs";
import {
	idleWatchdog,
	waitBounded,
} from "./candidate/src/music/stream-timeouts.mjs";

function manager({ healthy = false, resolved = null, listeners = [] } = {}) {
	const m = Object.create(MusicManager.prototype);
	Object.assign(m, {
		current: {
			uid: "p1",
			track: { id: "qq:1", streamUrl: "https://example.invalid/song" },
			sourceRevision: 0,
		},
		generation: 1,
		fallbackGeneration: 1,
		_actorLastErrorAt: new Map(),
		getListeners: () => listeners,
		events: { changed: 0, advance: 0, resolve: 0 },
		musicRegistry: { isHealthy: async () => healthy },
		resolve: async () => {
			m.events.resolve++;
			return resolved;
		},
		onStateChanged: () => m.events.changed++,
		advanceNext: () => m.events.advance++,
		savePlayback() {},
		scheduleAdvance() {},
		onPrefetchTrack() {},
		prepareNext() {},
	});
	return m;
}

test("one weak device cannot replace a healthy source or skip the room", async () => {
	const m = manager({ healthy: true });
	await m.reportError("p1", "a", 0);
	assert.deepEqual(m.events, { changed: 0, advance: 0, resolve: 0 });
});

test("resolver outage does not skip; same-URL recovery increments revision", async () => {
	const failed = manager();
	await failed.reportError("p1", "a", 0);
	assert.equal(failed.events.advance, 0);
	const m = manager({
		resolved: { streamUrl: "https://example.invalid/song" },
	});
	await m.reportError("p1", "a", 0);
	assert.equal(m.current.sourceRevision, 1);
	assert.equal(m.events.changed, 1);
	await m.reportError("p1", "b", 0);
	assert.equal(
		m.events.resolve,
		1,
		"obsolete revision cannot initiate another recovery",
	);
});

test("old recovery cannot overwrite a newer track", async () => {
	const m = manager();
	let complete;
	m.resolve = () =>
		new Promise((resolve) => {
			complete = resolve;
		});
	const pending = m.reportError("p1", "a", 0);
	await new Promise((resolve) => setImmediate(resolve));
	m.current = { uid: "p2" };
	m.generation++;
	complete({ streamUrl: "https://example.invalid/new" });
	await pending;
	assert.equal(m.current.uid, "p2");
	assert.equal(m.events.changed, 0);
});

test("playTrack starts immediately with authoritative startedAt timestamp and increments fallbackGeneration to invalidate stale prepared tracks", () => {
	const m = manager();
	m.preparedFallback = {
		key: 1,
		playable: { id: "qq:stale" },
		checkedAt: Date.now(),
	};
	const beforeGen = m.fallbackGeneration;
	const t0 = Date.now();
	m.playTrack({ id: "qq:new", streamUrl: "x" }, { userKey: "a" });
	assert.equal(m.current.phase, "playing");
	assert.ok(
		m.current.startedAt >= t0 && m.current.startedAt <= Date.now() + 50,
	);
	assert.equal(m.fallbackGeneration, beforeGen + 1);
	assert.equal(
		m.preparedFallback,
		null,
		"stale preparedFallback must be cleared on every track switch",
	);
	clearTimeout(m._prepareFallbackTimer);
});

test("deterministic CDN-friendly stream signer includes static extension and preserves trackKey", () => {
	const urlA = signStreamProxyUrl(
		"https://chat-server.lengxiqwq.com",
		"https://ws.stream.qqmusic.qq.com/song.mp3",
		"secret",
		"https://y.qq.com/",
		"audio/mpeg",
		"qq:004IM0wx49gYJq",
	);
	const urlB = signStreamProxyUrl(
		"https://chat-server.lengxiqwq.com",
		"https://ws.stream.qqmusic.qq.com/song.mp3",
		"secret",
		"https://y.qq.com/",
		"audio/mpeg",
		"qq:004IM0wx49gYJq",
	);
	assert.equal(urlA, urlB);
	assert.match(
		new URL(urlA).pathname,
		/^\/api\/music\/stream\/qq_004IM0wx49gYJq\.mp3$/,
	);
	const token = new URL(urlA).searchParams.get("token");
	const verified = verifyStreamProxyToken(token, "secret");
	assert.equal(verified.trackKey, "qq:004IM0wx49gYJq");
	assert.equal(verified.mimeType, "audio/mpeg");
});

test("sync snapshot preserves newly deployed queue votes", () => {
	const m = manager();
	Object.assign(m, {
		historyMap: new Map(),
		historyLogs: [],
		queue: [{ uid: "q1", track: { id: "t1" } }],
		queueVotes: new Map([["listener", "q1"]]),
		queueVotePlayUid: "p1",
		stateVersion: 0,
	});
	Object.assign(m.current, {
		skipVotes: [],
		startedAt: Date.now(),
		phase: "playing",
	});
	const snapshot = m.getSnapshot();
	assert.equal(snapshot.protocolVersion, 2);
	assert.equal(snapshot.current.phase, "playing");
	assert.deepEqual(snapshot.queue[0].playVotes, ["listener"]);
});

test("slow but progressing transfer survives; truly idle transfer aborts", async () => {
	const controller = new AbortController();
	const watchdog = idleWatchdog(controller, 80);
	for (let i = 0; i < 6; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		watchdog.touch();
		assert.equal(controller.signal.aborted, false);
	}
	await new Promise((resolve) => setTimeout(resolve, 110));
	assert.equal(controller.signal.aborted, true);
	watchdog.stop();
});

test("cache wait is bounded and cancellation releases the waiter", async () => {
	const controller = new AbortController();
	const wait = waitBounded(new Promise(() => {}), 60_000, controller.signal);
	controller.abort();
	await wait;
	await waitBounded(new Promise(() => {}), 10);
});

test("Range handling preserves suffix, open ranges and unsatisfiable ranges", () => {
	assert.deepEqual(parseRange("bytes=-20", 100), { start: 80, end: 99 });
	assert.deepEqual(parseRange("bytes=20-", 100), { start: 20, end: 99 });
	assert.equal(parseRange("bytes=100-", 100), false);
	assert.equal(parseRange("bytes=0-1,4-5", 100), false);
});

test("clock ignores wall-clock changes and filters high-latency outliers", () => {
	let now = 100;
	const c = new MusicClock(() => now);
	c.seed(10000);
	now = 200;
	assert.equal(c.now(), 10100);
	c.sample(10150, 100); // midpoint 150 => offset 10000
	now = 300;
	assert.equal(c.now(), 10300);
	now = 1600;
	c.sample(50000, 300);
	assert.equal(c.now(), 11600, "lower RTT sample wins");
	now = 6000;
	assert.equal(c.sample(90000, 1600), false);
	c.resetSamples();
	now = 6100;
	c.sample(100000, 6000);
	assert.equal(c.now(), 100050, "resume discards pre-sleep samples");
});

test("drift control keeps rate locked at 1.0 (iPad safe) and only seeks when drift >= 2.2s", () => {
	assert.deepEqual(correctionForDrift(0.08), { seek: false, rate: 1 });
	assert.deepEqual(correctionForDrift(0.5), { seek: false, rate: 1 });
	assert.deepEqual(correctionForDrift(1.5), { seek: false, rate: 1 });
	assert.deepEqual(correctionForDrift(2.5), { seek: true, rate: 1 });
});

class FakeAudio extends EventTarget {
	src = "";
	currentTime = 0;
	readyState = 4;
	duration = 180;
	paused = true;
	seeking = false;
	ended = false;
	muted = true;
	volume = 1;
	playbackRate = 1;
	buffered = { length: 1, start: () => 0, end: () => 20 };
	loads = 0;
	plays = 0;
	reject = false;
	getAttribute() {
		return this.src;
	}
	removeAttribute() {
		this.src = "";
	}
	load() {
		this.loads++;
		this.currentTime = 0;
	}
	play() {
		this.plays++;
		if (this.reject)
			return Promise.reject(new DOMException("blocked", "NotAllowedError"));
		this.paused = false;
		return Promise.resolve();
	}
	pause() {
		this.paused = true;
	}
}

test("multiple tabs on the same device get distinct _cid stream URLs and align directly to (serverNow - startedAt)/1000", async () => {
	const doc = new EventTarget();
	doc.hidden = false;
	const win = new EventTarget();
	Object.defineProperty(globalThis, "document", {
		value: doc,
		configurable: true,
	});
	Object.defineProperty(globalThis, "window", {
		value: win,
		configurable: true,
	});
	Object.defineProperty(globalThis, "navigator", {
		value: { onLine: true },
		configurable: true,
	});

	const now = 10800; // 0.8s after startedAt (10000)
	const audio1 = new FakeAudio();
	const audio2 = new FakeAudio();
	const p1 = new RoomAudioPlayer(audio1, {
		now: () => now,
		status() {},
		ready() {},
		error() {},
		ended() {},
		duration() {},
	});
	const p2 = new RoomAudioPlayer(audio2, {
		now: () => now,
		status() {},
		ready() {},
		error() {},
		ended() {},
		duration() {},
	});

	const play = {
		uid: "p1",
		track: {
			streamUrl:
				"https://chat-server.lengxiqwq.com/api/music/stream/qq_1.mp3?token=abc",
		},
		startedAt: 10000,
		phase: "playing",
		sourceRevision: 0,
	};

	try {
		p1.setTrack(play);
		p1.listen();
		p2.setTrack(play);
		p2.listen();
		await Promise.resolve();

		// Crucial: distinct URLs per tab prevent Chromium HttpCache exclusive media lock deadlocks!
		assert.notEqual(audio1.src, audio2.src);
		assert.ok(audio1.src.includes("_cid="));
		assert.ok(audio2.src.includes("_cid="));

		// Both tabs immediately align to (10800 - 10000) / 1000 = 0.8s and unmute
		assert.equal(audio1.currentTime, 0.8);
		assert.equal(audio2.currentTime, 0.8);
		assert.equal(audio1.muted, false);
		assert.equal(audio2.muted, false);
		assert.equal(audio1.playbackRate, 1);
		assert.equal(audio2.playbackRate, 1);
	} finally {
		p1.destroy();
		p2.destroy();
	}
});

test("slow buffering device does not prematurely lock initialAligned during early metadata/progress events before play() resolves", async () => {
	let now = 10000;
	const audio = new FakeAudio();
	let resolvePlay;
	audio.play = () => {
		audio.paused = false; // HTML5 spec: play() sets paused=false synchronously before resolving
		audio.readyState = 2; // HAVE_CURRENT_DATA at t=100ms
		return new Promise((resolve) => {
			resolvePlay = resolve;
		});
	};
	const player = new RoomAudioPlayer(audio, {
		now: () => now,
		status() {},
		ready() {},
		error() {},
		ended() {},
		duration() {},
	});
	try {
		player.setTrack({
			uid: "slow-ipad",
			track: {
				streamUrl:
					"https://chat-server.lengxiqwq.com/api/music/stream/qq_2.mp3?token=xyz",
			},
			startedAt: 10000,
			phase: "playing",
			sourceRevision: 0,
		});
		player.listen();
		// At t=100ms (now=10100), early progress/loadedmetadata arrives while play() is still pending
		now = 10100;
		audio.dispatchEvent(new Event("loadedmetadata"));
		audio.dispatchEvent(new Event("progress"));
		assert.equal(audio.currentTime, 0);

		// At t=1200ms (now=11200), buffering finishes and play() finally resolves
		now = 11200;
		audio.readyState = 4;
		resolvePlay();
		await Promise.resolve();

		// Must align to 1.2s instead of being stuck at 0.0s!
		assert.equal(audio.currentTime, 1.2);
	} finally {
		player.destroy();
	}
});

test("superseded play rejection cannot put the latest track into a blocked state", async () => {
	const audio = new FakeAudio();
	let rejectOld;
	const states = [];
	const player = new RoomAudioPlayer(audio, {
		now: () => 10000,
		status: (s) => states.push(s),
		ready() {},
		error() {},
		ended() {},
		duration() {},
	});
	try {
		player.setTrack({
			uid: "old",
			track: { streamUrl: "https://example.invalid/old" },
			startedAt: 10000,
		});
		audio.play = () =>
			new Promise((_, reject) => {
				rejectOld = reject;
			});
		player.listen();
		audio.play = () => {
			audio.paused = false;
			return Promise.resolve();
		};
		player.setTrack({
			uid: "new",
			track: { streamUrl: "https://example.invalid/new" },
			startedAt: 10000,
		});
		await Promise.resolve();
		rejectOld(new DOMException("late rejection", "NotAllowedError"));
		await Promise.resolve();
		assert.equal(states.at(-1), "playing");
		assert.equal(audio.src, "https://example.invalid/new");
	} finally {
		player.destroy();
	}
});

test("mid-song listen() seeks before emitting sound (zero 0.0s audio blip) and never double-seeks when Range seek takes 700ms", async () => {
	let now = 55000; // 45.0s into the song (startedAt = 10000)
	const audio = new FakeAudio();
	audio.readyState = 0;
	let currentTimeAtPlay = -1;
	let volumeAtPlay = -1;
	let seekCount = 0;
	let _ct = 0;
	Object.defineProperty(audio, "currentTime", {
		get() {
			return _ct;
		},
		set(val) {
			if (val !== 0) {
				seekCount++;
				this.seeking = true;
			}
			_ct = val;
		},
	});
	let resolvePlay;
	audio.play = () => {
		audio.paused = false;
		currentTimeAtPlay = audio.currentTime;
		volumeAtPlay = audio.volume;
		return new Promise((resolve) => {
			resolvePlay = resolve;
		});
	};
	const player = new RoomAudioPlayer(audio, {
		now: () => now,
		status() {},
		ready() {},
		error() {},
		ended() {},
		duration() {},
	});
	try {
		player.setTrack({
			uid: "mid-song",
			track: {
				streamUrl:
					"https://chat-server.lengxiqwq.com/api/music/stream/qq_3.mp3?token=mid",
			},
			startedAt: 10000,
			phase: "playing",
			sourceRevision: 0,
		});
		seekCount = 0;
		player.listen();
		// While readyState is 0 at play(), volume MUST be held at 0 so frame 0 is never audible!
		assert.equal(volumeAtPlay, 0);

		// Metadata arrives at t=45.1s while play() is still pending
		now = 55100;
		audio.readyState = 1;
		audio.dispatchEvent(new Event("loadedmetadata"));
		assert.equal(audio.currentTime, 45.1);
		assert.equal(seekCount, 1);
		assert.equal(audio.volume, 0, "must remain silent while seeking");

		// Range request completes 700ms later (now = 55800 => target = 45.8s, currentTime = 45.1s, drift = 0.7s)
		now = 55800;
		audio.seeking = false;
		audio.readyState = 4;
		resolvePlay();
		await Promise.resolve();
		audio.dispatchEvent(new Event("seeked"));

		// Must unmute/restore volume immediately with ONLY 1 seek (no second stutter seek!)
		assert.equal(seekCount, 1);
		assert.equal(audio.volume, 1);
		assert.equal(audio.muted, false);
	} finally {
		player.destroy();
	}
});

test("fresh track switch (< 500ms) plays from 0.0s immediately with zero seek and full volume", async () => {
	const now = 10250; // 250ms after startedAt (10000)
	const audio = new FakeAudio();
	let seekCount = 0;
	let _ct = 0;
	Object.defineProperty(audio, "currentTime", {
		get() {
			return _ct;
		},
		set(val) {
			if (val !== 0) {
				seekCount++;
				this.seeking = true;
			}
			_ct = val;
		},
	});
	const player = new RoomAudioPlayer(audio, {
		now: () => now,
		status() {},
		ready() {},
		error() {},
		ended() {},
		duration() {},
	});
	try {
		player.setTrack({
			uid: "fresh-song",
			track: {
				streamUrl:
					"https://chat-server.lengxiqwq.com/api/music/stream/qq_4.mp3?token=fresh",
			},
			startedAt: 10000,
			phase: "playing",
			sourceRevision: 0,
		});
		seekCount = 0;
		player.listen();
		await Promise.resolve();
		assert.equal(seekCount, 0, "fresh track start within 500ms must not seek");
		assert.equal(audio.currentTime, 0);
		assert.equal(audio.volume, 1);
		assert.equal(audio.muted, false);
	} finally {
		player.destroy();
	}
});

test("3-track fallback pool enables 3 consecutive 0ms skips and awaits warm first-chunk before stamping startedAt", async () => {
	const warmDelayMs = 35;
	let warmCalls = 0;
	const tracks = [
		{
			id: "qq:t1",
			sourceId: "t1",
			sourcePlatform: "qqmusic",
			sourceTrackId: "t1",
			title: "Song 1",
			artist: "A",
			durationSec: 200,
		},
		{
			id: "qq:t2",
			sourceId: "t2",
			sourcePlatform: "qqmusic",
			sourceTrackId: "t2",
			title: "Song 2",
			artist: "A",
			durationSec: 200,
		},
		{
			id: "qq:t3",
			sourceId: "t3",
			sourcePlatform: "qqmusic",
			sourceTrackId: "t3",
			title: "Song 3",
			artist: "A",
			durationSec: 200,
		},
		{
			id: "qq:t4",
			sourceId: "t4",
			sourcePlatform: "qqmusic",
			sourceTrackId: "t4",
			title: "Song 4",
			artist: "A",
			durationSec: 200,
		},
	];
	const m = Object.create(MusicManager.prototype);
	Object.assign(m, {
		roomId: "test",
		current: {
			uid: "p0",
			track: {
				id: "qq:t1",
				sourceId: "t1",
				streamUrl: "https://example.invalid/t1",
			},
			sourceRevision: 0,
			isFallback: true,
		},
		queue: [],
		fallbackTracks: tracks,
		fallbackPlaylistName: "TestList",
		generation: 1,
		fallbackGeneration: 1,
		preparedFallback: null,
		preparedFallbackPool: [],
		_fillingPool: null,
		musicRegistry: {
			isKnownUnplayable: () => false,
			resolvePlaylistTrack: async (item) => ({
				id: "qq:" + item.sourceTrackId,
				provider: "qq",
				sourceId: item.sourceTrackId,
				title: item.title,
				artist: item.artist,
				durationSec: 200,
			}),
			resolvePlayable: async (track) => ({
				...track,
				streamUrl: "https://example.invalid/" + track.sourceId,
			}),
		},
		onPrefetchTrack: (_url, mode) => {
			if (mode === "warm") {
				warmCalls++;
				return new Promise((resolve) =>
					setTimeout(() => resolve(true), warmDelayMs),
				);
			}
		},
		onStateChanged() {},
		savePlayback() {},
		scheduleAdvance() {},
	});

	try {
		await m.prepareNext();
		await m._fillingPool;
		assert.ok(m.preparedFallback?.playable, "primary fallback prepared");
		assert.equal(
			m.preparedFallbackPool.length,
			2,
			"2 additional backup tracks pre-warmed in pool",
		);

		// When a skip occurs and warm takes 35ms, startedAt must be stamped AFTER warm finishes (not 35ms earlier!)
		const playedIds = [m.current.track.id];
		for (let i = 0; i < 3; i++) {
			const beforeSkip = Date.now();
			await m.advanceNext();
			clearTimeout(m._prepareFallbackTimer);
			assert.ok(
				m.current.startedAt >= beforeSkip + 25,
				"startedAt must be stamped after warm first-chunk completes",
			);
			assert.ok(
				!playedIds.slice(-1).includes(m.current.track.id),
				"consecutive skips must never repeat the same track",
			);
			playedIds.push(m.current.track.id);
		}
		assert.equal(warmCalls, 3);
	} finally {
		clearTimeout(m._prepareFallbackTimer);
	}
});

test("20 listeners wait for the same deadline and resume in place after muting", async () => {
	let now = 10000;
	const windowLimit = getMaxListeners(window);
	const documentLimit = getMaxListeners(document);
	setMaxListeners(20, window, document);
	const clients = Array.from({ length: 20 }, () => {
		const audio = new FakeAudio();
		const player = new RoomAudioPlayer(audio, {
			now: () => now,
			status() {},
			ready() {},
			error() {},
			ended() {},
			duration() {},
		});
		return { audio, player };
	});
	try {
		for (const { player } of clients) {
			player.listen();
			player.setTrack({
				uid: "new",
				startedAt: 11200,
				phase: "scheduled",
				track: { streamUrl: "https://example.invalid/new" },
			});
		}
		assert.ok(clients.every(({ audio }) => audio.plays === 0));
		now = 11200;
		for (const { audio } of clients) audio.dispatchEvent(new Event("canplay"));
		await Promise.resolve();
		for (const { audio, player } of clients) {
			assert.equal(audio.plays, 1);
			assert.equal(audio.muted, false);
			assert.equal(audio.currentTime, 0);
			player.stop();
			assert.equal(audio.paused, false);
			assert.equal(audio.muted, true);
		}
		now += 60000;
		for (const { audio, player } of clients) {
			audio.currentTime = 60;
			player.listen();
			assert.equal(audio.muted, false);
			assert.equal(audio.plays, 1);
			assert.equal(audio.loads, 1);
		}
	} finally {
		for (const { player } of clients) player.destroy();
		setMaxListeners(windowLimit, window);
		setMaxListeners(documentLimit, document);
	}
});

test("a prepared next song becomes the media source without another network load", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () =>
		new Response(new Uint8Array(256), {
			headers: { "content-length": "256", "content-type": "audio/mpeg" },
		});
	const audio = new FakeAudio();
	const player = new RoomAudioPlayer(audio, {
		now: () => 10000,
		status() {},
		ready() {},
		error() {},
		ended() {},
		duration() {},
	});
	try {
		player.setTrack({
			uid: "one",
			startedAt: 10000,
			track: { streamUrl: "one" },
		});
		const next = { uid: "two", startedAt: 11000, track: { streamUrl: "two" } };
		player.preloadNext(next);
		await new Promise((resolve) => setImmediate(resolve));
		player.setTrack(next);
		assert.match(audio.src, /^blob:/);
	} finally {
		player.destroy();
		globalThis.fetch = originalFetch;
	}
});

test("a progressing mid-song download survives twenty seconds without resetting the source", () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "performance");
	let mono = 1000;
	Object.defineProperty(globalThis, "performance", {
		configurable: true,
		value: { now: () => mono },
	});
	const audio = new FakeAudio();
	audio.readyState = 1;
	audio.play = () => new Promise(() => {});
	let end = 0;
	audio.buffered = { length: 1, start: () => 0, end: () => end };
	const player = new RoomAudioPlayer(audio, {
		now: () => mono + 50000,
		status() {},
		ready() {},
		error() {},
		ended() {},
		duration() {},
	});
	try {
		player.setTrack({
			uid: "slow",
			startedAt: 1000,
			track: { streamUrl: "slow" },
		});
		player.listen();
		for (let second = 1; second <= 20; second++) {
			mono += 1000;
			end++;
			audio.dispatchEvent(new Event("progress"));
		}
		assert.equal(audio.loads, 1);
	} finally {
		player.destroy();
		Object.defineProperty(globalThis, "performance", original);
	}
});
