// Exercise the real MusicPanel controls using silent MP3 data and isolated browser profiles.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
const { chromium, webkit } = await import(
	process.env.PLAYWRIGHT_MODULE || "playwright"
);
const bundle = JSON.parse(
	execFileSync(
		process.execPath,
		["scripts/chat-music-sync/browser-fixture.mjs"],
		{ encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
	),
);
const audio = execFileSync(
	"ffmpeg",
	[
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"anullsrc=r=44100:cl=mono:d=60",
		"-b:a",
		"128k",
		"-f",
		"mp3",
		"pipe:1",
	],
	{ maxBuffer: 2_000_000 },
);
const requests = [];
const media = createServer((req, res) => {
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
			"Access-Control-Allow-Headers": "Range",
		});
		return res.end();
	}
	const u = new URL(req.url, "http://localhost");
	const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
	const start = Number(range?.[1] || 0),
		end = Math.min(Number(range?.[2] || audio.length - 1), audio.length - 1);
	requests.push({ song: u.pathname, start, end, at: Date.now() });
	res.writeHead(range ? 206 : 200, {
		"Content-Type": "audio/mpeg",
		"Content-Length": end - start + 1,
		"Accept-Ranges": "bytes",
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Expose-Headers": "Content-Range, Content-Length",
		...(range && { "Content-Range": `bytes ${start}-${end}/${audio.length}` }),
	});
	let pos = start;
	const send = () => {
		const next = Math.min(end + 1, pos + 16384);
		res.write(audio.subarray(pos, next));
		pos = next;
		if (pos > end) res.end();
		else timer = setTimeout(send, 22);
	};
	let timer;
	res.on("close", () => clearTimeout(timer));
	send();
});
await new Promise((r) => media.listen(0, "127.0.0.1", r));
const pageServer = createServer((req, res) => {
	if (req.url === "/player.js") {
		res.setHeader("Content-Type", "text/javascript");
		res.end(bundle);
	} else {
		res.setHeader("Content-Type", "text/html");
		res.end('<meta charset="utf-8"><script defer src="/player.js"></script>');
	}
});
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
const browsers = [],
	devices = [];
const song = (uid, startedAt) => ({
	uid,
	phase: startedAt > Date.now() ? "scheduled" : "playing",
	startedAt,
	durationSec: 60,
	requesterName: "测试",
	requesterKey: "test",
	skipVotes: [],
	track: {
		id: uid,
		title: uid,
		artist: "测试",
		durationSec: 60,
		streamUrl: `http://127.0.0.1:${media.address().port}/api/music/stream/${uid}.mp3`,
	},
});
const broadcast = (play, next = null) =>
	Promise.all(
		devices.map((tab) =>
			tab.evaluate(([p, n]) => musicFixture.setTrack(p, n), [play, next]),
		),
	);
async function button(tab, label) {
	const match = tab.getByRole("button", { name: label, exact: true }).first();
	await match.click({ timeout: 5000 });
}
try {
	for (const exe of process.argv.slice(2)) {
		const browser =
			exe === "webkit"
				? await webkit.launch()
				: await chromium.launch({
						executablePath: exe,
						args: ["--mute-audio"],
					});
		browsers.push(browser);
		const tab = await browser.newPage();
		await tab.route(/https?:\/\/(?!127\.0\.0\.1:)/, (route) => route.abort());
		await tab.addInitScript(() => {
			window.audios = new Set();
			window.preloaded = {};
			const load = HTMLMediaElement.prototype.load;
			HTMLMediaElement.prototype.load = function () {
				if (this.src && this.preload === "auto") {
					preloaded[new URL(this.src).pathname.split("/").pop()] = this;
				}
				return load.call(this);
			};
			window.first = {};
			const play = HTMLMediaElement.prototype.play;
			HTMLMediaElement.prototype.play = function () {
				audios.add(this);
				return play.call(this);
			};
			setInterval(() => {
				for (const el of audios) {
					if (el.paused || el.muted || !el.currentSrc || el.currentTime <= 0)
						continue;
					const key = new URL(el.currentSrc).pathname.split("/").pop();
					first[key] ??= [Date.now(), el.currentTime];
				}
			}, 10);
		});
		tab.on("pageerror", (e) => console.error(e.message));
		await tab.goto(`http://127.0.0.1:${pageServer.address().port}/chat/`);
		devices.push(tab);
	}
	assert.ok(devices.length);
	let current = song("seed", Date.now());
	await broadcast(current);
	await Promise.all(devices.map((tab) => button(tab, "开始收听")));
	await Promise.all(
		devices.map((tab) => tab.waitForFunction(() => first["seed.mp3"])),
	);
	const skew = [],
		offsets = [];
	const rounds = Number(process.env.HANDOFF_ROUNDS || 30);
	for (let i = 0; i < rounds; i++) {
		const next = song("song" + i, 0);
		await broadcast(current, next);
		const file = next.uid + ".mp3";
		await Promise.all(devices.map(tab => tab.waitForFunction(k => {
			const el = preloaded[k];
			return el && el.paused && el.buffered.length && el.buffered.end(0) > 0;
		}, file, { timeout: 5000 })));
		current = { ...next, uid: "play-" + next.uid, startedAt: Date.now() + 500, phase: "scheduled" };
		await broadcast(current);
		const key = file;
		await Promise.all(
			devices.map((tab) =>
				tab.waitForFunction((k) => !!first[k], key, { timeout: 10000 }),
			),
		);
		for (const tab of devices) {
			assert.ok(await tab.evaluate(k => audios.has(preloaded[k]) && !preloaded[k].paused, key),
				"the buffered element itself must play");
		}
		const obs = await Promise.all(
			devices.map((tab) => tab.evaluate((k) => first[k], key)),
		);
		assert.ok(obs.every(([firstAt]) => firstAt >= current.startedAt), "started before shared deadline");
		offsets.push(...obs.map((v) => v[1]));
		skew.push(
			Math.max(...obs.map((v) => v[0])) - Math.min(...obs.map((v) => v[0])),
		);
		assert.ok(skew.at(-1) <= 1200, "switch exceeded sync tolerance");
		assert.ok(
			obs.every((v) => v[1] < 2),
			"missed opening " + key,
		);
		const loads = requests.filter(
			(r) => r.song.endsWith("/" + key) && r.start === 0 && r.end > 65536,
		);
		assert.ok(
			loads.length === devices.length,
			"duplicate media start " + key + " " + loads.length,
		);
	}
	await Promise.all(devices.map((tab) => button(tab, "正在收听（点击停止）")));
	const muted = song("muted", Date.now());
	await broadcast(muted, song("idle-next", 0));
	await new Promise((r) => setTimeout(r, 2600));
	assert.ok(!requests.some(r => /\/(muted|idle-next)\.mp3$/.test(r.song)), "idle client downloaded music");
	const count = requests.length;
	await Promise.all(devices.map((tab) => button(tab, "开始收听")));
	await Promise.all(
		devices.map((tab) =>
			tab.waitForFunction(
				() =>
					first["muted.mp3"] &&
					[...audios].some(
						(a) =>
							!a.paused &&
							!a.muted &&
							a.currentTime > first["muted.mp3"][1] + 0.25,
					),
				null,
				{ timeout: 4000 },
			),
		),
	);
	console.log(
		JSON.stringify({
			devices: devices.length,
			switches: rounds,
			p95ProgressSkewMs: skew.sort((a, b) => a - b)[
				Math.ceil(rounds * 0.95) - 1
			],
			maxFirstPosition: Math.max(...offsets),
			resumeRequests: requests.length - count,
		}),
	);
} finally {
	await Promise.allSettled(browsers.map((b) => b.close()));
	media.closeAllConnections();
	pageServer.closeAllConnections();
	media.close();
	pageServer.close();
}
