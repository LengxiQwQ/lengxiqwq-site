import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const built = await build({ entryPoints: ["src/index.ts"], bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["cloudflare:workers", "node:*"] });
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: built.outputFiles[0].text, compatibilityDate: "2026-06-03", compatibilityFlags: ["nodejs_compat"], durableObjects: { CHAT_ROOMS: { className: "RoomDO", useSQLite: true } }, bindings: { DEFAULT_ROOMS: "chat,interconnect", MATRIX_ENABLED: "false", CHAT_GUEST_SECRET: "test-secret", STREAM_SIGN_SECRET: "test-secret" } }));

try {
	const ns = await mf.getDurableObjectNamespace("CHAT_ROOMS");
	const chat = ns.get(ns.idFromName("chat"));
	const other = ns.get(ns.idFromName("interconnect"));
	const user = { userKey: "waline:test", authType: "waline", name: "Tester", avatar: "", url: "", badge: "", badgeType: "tag", isAdmin: true };
	async function call(stub, path, room, body) {
		const response = await stub.fetch(`https://room.internal/${path}?room=${room}`, { method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json", "X-Chat-User": JSON.stringify(user) } : {}, body: body ? JSON.stringify(body) : undefined });
		const json = await response.json();
		if (!response.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
		return json;
	}
	const payload = (title, sourceUrl) => ({ title, sourceUrl, platform: "external", tracks: [{ title: "test song", artist: "test artist", sourcePlatform: "external", sourceTrackId: "1" }] });
	const old = await call(chat, "playlists/import", "chat", payload("old", "same"));
	const initial = await call(chat, "playlist-export", "chat");
	await call(chat, "fallback-selection", "chat", { playlist: initial.playlists.find((p) => p.id === old.playlist.id), tracks: [] });
	await new Promise((resolve) => setTimeout(resolve, 10));
	await call(other, "playlists/import", "interconnect", payload("new", "same"));
	await call(other, "playlists/import", "interconnect", payload("other", "other"));
	await call(chat, "playlist-migrate", "chat");
	let exported = await call(chat, "playlist-export", "chat");
	assert.equal(exported.playlists.length, 2);
	const merged = exported.playlists.find((p) => p.source_url === "same");
	assert.equal(merged.title, "new");
	assert.equal(merged.is_fallback, 1);
	assert.equal(exported.tracks.filter((t) => t.playlist_id === merged.id).length, 1);
	const choice = exported.playlists.find((p) => p.source_url === "other");
	await call(other, "fallback-selection", "interconnect", { playlist: choice, tracks: [] });
	assert.equal((await call(other, "fallback-selection", "interconnect")).selected.source_url, "other");
	exported = await call(chat, "playlist-export", "chat");
	assert.equal(exported.playlists.find((p) => p.source_url === "same").is_fallback, 1);
	assert.equal(exported.playlists.find((p) => p.source_url === "other").is_fallback, 0);
	await call(chat, "playlist-migrate", "chat");
	assert.equal((await call(chat, "playlist-export", "chat")).playlists.length, 2);
	const first = await mf.dispatchFetch("https://example.test/ws?room=chat", { headers: { Upgrade: "websocket" } });
	const second = await mf.dispatchFetch("https://example.test/ws?room=interconnect", { headers: { Upgrade: "websocket" } });
	assert.equal(first.status, 101);
	assert.equal(second.status, 101);
	first.webSocket.accept();
	second.webSocket.accept();
	const presence = await (await mf.dispatchFetch("https://example.test/api/presence")).json();
	assert.equal(presence.observerCount, 2);
	assert.equal(presence.totalCount, 2);
	first.webSocket.close();
	second.webSocket.close();
	console.log("PASS: migration, newest tracks, separate fallback, repeated migration");
	console.log("PASS: shared presence includes both rooms");
} finally {
	await mf.dispose();
}
