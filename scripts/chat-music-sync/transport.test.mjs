// Entire filesystem and upstream are in memory; no test server or production request.

import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import vm from "node:vm";

async function fixture() {
	const files = new Map();
	let fetches = 0;
	const media = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(4093, 7)]);
	const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
	const fs = {
		mkdir: async () => {},
		readdir: async () => [],
		utimes: async () => {},
		readFile: async (name) => {
			if (!files.has(name)) throw missing();
			return files.get(name).toString();
		},
		writeFile: async (name, data) => {
			files.set(name, Buffer.from(data));
		},
		rename: async (from, to) => {
			files.set(to, files.get(from));
			files.delete(from);
		},
		unlink: async (name) => {
			files.delete(name);
		},
		open: async (name) => {
			const data = files.get(name);
			if (!data) throw missing();
			return {
				stat: async () => ({ size: data.length }),
				close: async () => {},
				read: async (buffer, offset, length, position) => ({
					bytesRead: data.copy(buffer, offset, position, position + length),
				}),
				createReadStream: ({ start = 0, end = data.length - 1 }) =>
					Readable.from([data.subarray(start, end + 1)]),
			};
		},
	};
	const context = vm.createContext({
		Buffer,
		AbortController,
		AbortSignal,
		setTimeout,
		clearTimeout,
		console,
		process: { env: { CHAT_MUSIC_CACHE_DIR: "/memory" } },
	});
	const synthetic = (values) =>
		new vm.SyntheticModule(
			Object.keys(values),
			function () {
				for (const [key, value] of Object.entries(values))
					this.setExport(key, value);
			},
			{ context },
		);
	const deps = {
		"node:crypto": synthetic({ createHash: crypto.createHash }),
		"node:path": synthetic({ default: path }),
		"node:stream": synthetic({ Readable, Transform }),
		"node:stream/promises": synthetic({ pipeline }),
		"node:fs": synthetic({
			promises: fs,
			createReadStream() {},
			createWriteStream(name) {
				const chunks = [];
				return new Writable({
					write(chunk, _, done) {
						chunks.push(chunk);
						done();
					},
					final(done) {
						files.set(name, Buffer.concat(chunks));
						done();
					},
				});
			},
		}),
		"./audio-source.mjs": synthetic({
			identifyAudio: () => "audio/mpeg",
			fetchAudio: async (url, opts = {}) => {
				fetches++;
				if (url.includes("terminate-once")) {
					if (!opts.range) {
						// First connection drops ('terminated') after delivering 1024 bytes out of 4096
						let sent = false;
						const stream = new ReadableStream({
							async pull(controller) {
								if (!sent) {
									sent = true;
									await new Promise((resolve) => setTimeout(resolve, 10));
									controller.enqueue(media.subarray(0, 1024));
									return;
								}
								await new Promise((resolve) => setTimeout(resolve, 10));
								controller.error(new TypeError("terminated"));
							},
						});
						return new Response(stream, {
							status: 200,
							headers: {
								"Content-Length": String(media.length),
								"Content-Type": "audio/mpeg",
							},
						});
					}
					// Resume connection with Range: bytes=1024-4095 succeeds
					const m = /^bytes=(\d+)-(\d+)$/.exec(opts.range);
					const start = Number(m[1]);
					const end = Number(m[2]);
					const slice = media.subarray(start, end + 1);
					return new Response(Readable.toWeb(Readable.from([slice])), {
						status: 206,
						headers: {
							"Content-Length": String(slice.length),
							"Content-Range": `bytes ${start}-${end}/${media.length}`,
							"Content-Type": "audio/mpeg",
						},
					});
				}
				// Simulate progressive multi-chunk upstream delivery (first chunk at 15ms, second chunk at 60ms)
				const stream = new ReadableStream({
					async start(controller) {
						await new Promise((resolve) => setTimeout(resolve, 15));
						controller.enqueue(media.subarray(0, 1024));
						await new Promise((resolve) => setTimeout(resolve, 45));
						controller.enqueue(media.subarray(1024));
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: {
						"Content-Length": String(media.length),
						"Content-Type": "audio/mpeg",
					},
				});
			},
		}),
	};
	deps["./stream-timeouts.mjs"] = new vm.SourceTextModule(
		await readFile(
			new URL("./candidate/src/music/stream-timeouts.mjs", import.meta.url),
			"utf8",
		),
		{ context },
	);
	const module = new vm.SourceTextModule(
		await readFile(
			new URL("./candidate/src/music/stream-cache.mjs", import.meta.url),
			"utf8",
		),
		{ context },
	);
	await module.link((name) => deps[name]);
	await module.evaluate();
	const request = async (
		range,
		method = "GET",
		url = "https://example.invalid/audio",
		trackKey = "qq:test1",
	) => {
		const chunks = [];
		const res = new Writable({
			write(chunk, _, done) {
				chunks.push(chunk);
				done();
			},
		});
		res.writeHead = (status, headers) => {
			res.status = status;
			res.headers = headers;
			res.headersSent = true;
			return res;
		};
		await module.namespace.handleStreamProxyRequest(
			{ method, headers: range ? { range } : {} },
			res,
			url,
			"",
			"audio/mpeg",
			trackKey,
		);
		return {
			status: res.status,
			headers: res.headers,
			body: Buffer.concat(chunks),
		};
	};
	return { request, media, fetches: () => fetches };
}

test("progressive stream-tee delivers early range slices before full download finishes and shares trackKey cache across rotating URLs", async () => {
	const f = await fixture();
	const t0 = Date.now();
	const [safariProbe, firstSlice, fullRange] = await Promise.all([
		f.request("bytes=0-1"),
		f.request("bytes=0-99"),
		f.request("bytes=100-199"),
	]);
	assert.equal(f.fetches(), 1);
	assert.equal(safariProbe.status, 206);
	assert.equal(safariProbe.body.length, 2);
	assert.equal(safariProbe.headers["Content-Range"], "bytes 0-1/4096");
	for (const response of [firstSlice, fullRange]) {
		assert.equal(response.status, 206);
		assert.equal(response.headers["X-Audio-Cache"], "HIT");
		assert.equal(response.body.length, 100);
	}
	assert.deepEqual(firstSlice.body, f.media.subarray(0, 100));
	assert.equal(fullRange.headers["Content-Range"], "bytes 100-199/4096");

	// Even when the upstream URL vkey changes, the same trackKey hits the existing cache with 0 extra fetches
	const rotatedUrlReq = await f.request(
		"bytes=0-99",
		"GET",
		"https://example.invalid/audio?vkey=new_vkey_2",
		"qq:test1",
	);
	assert.equal(rotatedUrlReq.status, 206);
	assert.equal(rotatedUrlReq.body.length, 100);
	assert.equal(f.fetches(), 1);

	const head = await f.request(undefined, "HEAD");
	assert.equal(head.status, 200);
	assert.equal(head.body.length, 0);
	assert.equal(head.headers["Content-Length"], 4096);
	assert.equal(f.fetches(), 1);
	const invalid = await f.request("bytes=99999-");
	assert.equal(invalid.status, 416);
	assert.equal(invalid.headers["Content-Range"], "bytes */4096");
	assert.equal(
		head.headers["Cache-Control"],
		"public, max-age=86400, immutable, no-transform",
	);

	// Mid-stream upstream 'terminated' error transparently resumes via Range without dropping connected clients
	const [clientTab1, clientTab2] = await Promise.all([
		f.request(
			undefined,
			"GET",
			"https://example.invalid/terminate-once",
			"qq:term1",
		),
		f.request(
			"bytes=0-4095",
			"GET",
			"https://example.invalid/terminate-once",
			"qq:term1",
		),
	]);
	assert.equal(clientTab1.status, 200);
	assert.equal(clientTab1.body.length, 4096);
	assert.deepEqual(clientTab1.body, f.media);
	assert.equal(clientTab2.status, 206);
	assert.equal(clientTab2.body.length, 4096);
	assert.deepEqual(clientTab2.body, f.media);
});
