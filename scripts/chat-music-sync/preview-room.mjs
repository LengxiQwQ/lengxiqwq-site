import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { MusicManager } from "./candidate/src/music/music-manager.mjs";
let bundle,
	room,
	opening,
	refreshAt = 0;
const listeners = new Set(),
	tracks = new Map();
async function collect() {
	const ws = new WebSocket(
		"wss://chat-server.lengxiqwq.com/ws?room=interconnect&focused=0",
	);
	try {
		const music = await new Promise((ok, fail) => {
			const t = setTimeout(() => fail(Error("音源暂不可用")), 8000);
			ws.onmessage = (e) => {
				const m = JSON.parse(e.data).music;
				if (m) {
					clearTimeout(t);
					ok(m);
				}
			};
			ws.onerror = () => {
				clearTimeout(t);
				fail(Error("音源连接失败"));
			};
		});
		for (const p of [music.current, music.next]) {
			const v = p?.track;
			if (
				v?.id &&
				v.streamUrl &&
				new URL(v.streamUrl).hostname === "chat-server.lengxiqwq.com"
			)
				tracks.set(v.id, { ...v, seen: Date.now() });
		}
		for (const [id, v] of tracks)
			if (Date.now() - v.seen > 3600000) tracks.delete(id);
	} finally {
		ws.close();
	}
}
const playlist = () =>
	[...tracks.values()].map((track) => ({
		id: track.id,
		sourceTrackId: track.sourceId,
		matchedTrack: track,
	}));
async function getRoom() {
	if (room && Date.now() < refreshAt) return room;
	if (opening) return opening;
	opening = (async () => {
		await collect();
		if (tracks.size < 2) throw Error("测试房暂缺两首可播曲目");
		if (!room) {
			room = new MusicManager({
				roomId: "preview",
				dataDir: mkdtempSync(join(tmpdir(), "radio-preview-")),
				musicRegistry: {
					resolvePlaylistTrack: async (t) => tracks.get(t.id),
					resolvePlayable: async (t) => tracks.get(t.id),
				},
				onStateChanged() {
					const data = JSON.stringify(room.getSnapshot());
					for (const send of listeners) send(data);
				},
				onPrefetchTrack: async (url, mode) => {
					if (mode !== "warm" || !listeners.size) return;
					const r = await fetch(url, {
						headers: { Range: "bytes=0-65535" },
						signal: AbortSignal.timeout(5000),
					});
					if (r.status !== 206) {
						await r.body?.cancel();
						return false;
					}
					return (await r.arrayBuffer()).byteLength > 0;
				},
			});
			room.setFallbackPlaylist("preview", playlist(), "联测", { start: false });
			await room.resume();
		} else
			room.setFallbackPlaylist("preview", playlist(), "联测", { start: false });
		refreshAt = Date.now() + 600000;
		return room;
	})().finally(() => (opening = null));
	return opening;
}
const headers = { "cache-control": "no-store" };
const client = `const address=new URL(location.href);address.search="";
const endpoint=a=>new URL("../"+a+"/",address);
window.roomPreview={skip(uid){if(uid)fetch(endpoint("skip"),{method:"PUT"})}};
const state=document.querySelector("#connection");
const source=new EventSource(endpoint("events"));
source.onmessage=e=>{const m=JSON.parse(e.data);musicFixture.receive(m);state.textContent="已连接独立测试房"};
source.onerror=()=>state.textContent="正在重连";
async function ping(){const t=performance.now();try{const r=await fetch(endpoint("clock"));musicFixture.clock.sample(await r.json(),t)}catch{}}
ping();setInterval(ping,5000);window.addEventListener("pageshow",ping);`;
export async function handle(request, url) {
	const part = url.searchParams.get("part");
	if (request.method === "PUT" && part !== "skip")
		return new Response(null, { status: 405 });
	if (!part)
		return new Response(
			'<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>点歌台联测</title><link rel=stylesheet href="/src/styles/main.css?direct"><link rel=stylesheet href="/src/styles/pages/chat.css?direct"><style>body{max-width:760px;margin:auto;padding:12px;font:16px system-ui}svg{max-width:2em;max-height:2em}button{cursor:pointer}header{padding:.7em}</style><header>点歌台联测 · <span id=connection>连接中</span></header><script src="../bundle/"></script><script src="../client/"></script>',
			{ headers: { ...headers, "content-type": "text/html;charset=utf-8" } },
		);
	if (part === "clock") return Response.json(Date.now(), { headers });
	if (part === "bundle") {
		bundle ??= JSON.parse(
			execFileSync(
				process.execPath,
				["scripts/chat-music-sync/browser-fixture.mjs"],
				{ encoding: "utf8", maxBuffer: 8e6 },
			),
		);
		return new Response(bundle, {
			headers: { ...headers, "content-type": "text/javascript;charset=utf-8" },
		});
	}
	if (part === "client")
		return new Response(client, {
			headers: { ...headers, "content-type": "text/javascript;charset=utf-8" },
		});
	if (!["events", "skip", "snapshot"].includes(part))
		return new Response(null, { status: 404 });
	const mgr = await getRoom();
	if (part === "snapshot") return Response.json(mgr.getSnapshot(), { headers });
	if (part === "skip") {
		if (request.method !== "PUT") return new Response(null, { status: 405 });
		if (!mgr.current || mgr.current.startedAt > Date.now())
			return new Response(null, { status: 409 });
		return Response.json(
			mgr.skip({ userKey: "preview" }, listeners.size, listeners.size),
			{ headers },
		);
	}
	let cleanup;
	const body = new ReadableStream({
		start(c) {
			const enc = new TextEncoder();
			const emit = (s) => {
				try {
					c.enqueue(enc.encode(s));
				} catch {
					cleanup();
				}
			};
			const send = (s) => emit("data: " + s + "\n\n");
			listeners.add(send);
			const heartbeat = setInterval(() => emit(": ping\n\n"), 12000);
			cleanup = () => {
				clearInterval(heartbeat);
				listeners.delete(send);
				request.signal.removeEventListener("abort", cleanup);
			};
			request.signal.addEventListener("abort", cleanup, { once: true });
			send(JSON.stringify(mgr.getSnapshot()));
		},
		cancel() {
			cleanup?.();
		},
	});
	return new Response(body, {
		headers: {
			...headers,
			"content-type": "text/event-stream",
			"x-accel-buffering": "no",
		},
	});
}
