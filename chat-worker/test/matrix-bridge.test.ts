import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	bridgePrefix,
	DEFAULT_BRIDGE_AVATAR,
	FIRST_STICKER_PART,
	MatrixBridge,
	matrixMediaPath,
	nextPollDelay,
	parseBridgeBody,
	publicImageUrl,
} from "../src/do/matrix-bridge.js";
import type { ChatMessageRecord } from "../src/do/room.js";
import type { Env } from "../src/env.js";

const ROOM = "!test:example.org";
const BOT = "@bridge:example.org";
const OTHER = "@guest:example.org";
const png = "mxc://example.org/image1";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function setup() {
	const db = new DatabaseSync(":memory:");
	const sql = {
		exec(query: string, ...args: Array<string | number | null>) {
			if (args.length === 0 && query.trimStart().startsWith("CREATE")) {
				db.exec(query);
				return [];
			}
			const rows = db.prepare(query).all(...args);
			return Object.assign(rows, {
				toArray: () => rows,
				one: () => rows[0],
			});
		},
	};
	const storage = {
		sql,
		transactionSync<T>(fn: () => T): T {
			db.exec("BEGIN");
			try {
				const result = fn();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as DurableObjectStorage;
	const env = {
		MATRIX_ENABLED: "true",
		MATRIX_HOMESERVER: "https://example.org",
		MATRIX_BOT_USER_ID: BOT,
		MATRIX_ROOM_ID: ROOM,
		MATRIX_ACCESS_TOKEN: "test",
	} as Env;
	const records: ChatMessageRecord[] = [];
	const publish = vi.fn();
	const removePart = vi.fn(() => "deleted" as const);
	let online = true;
	const createBridge = () =>
		new MatrixBridge(storage, env, {
			online: () => online,
			origin: () => "https://chat.example.com",
			resolveReply: (uid) => {
				const record = records.find((message) => message.msgUid === uid);
				return record
					? {
							msgUid: uid,
							userKey: record.userKey,
							name: record.name,
							content: record.content,
						}
					: null;
			},
			append(record) {
				const id = records.length + 1;
				const saved = { ...record, id, msgUid: String(id), createdAt: 0 };
				records.push(saved);
				return saved;
			},
			removePart,
			publish,
		});
	return {
		createBridge,
		publish,
		removePart,
		records,
		db,
		setOnline: (value: boolean) => {
			online = value;
		},
	};
}

function event(id: string, body: string, sender = OTHER) {
	return {
		type: "m.room.message",
		event_id: id,
		sender,
		content: { msgtype: "m.text", body },
	};
}

function sync(next_batch: string, events: unknown[] = [], extra = {}) {
	return Response.json({
		next_batch,
		rooms: { join: { [ROOM]: { timeline: { events, ...extra } } } },
	});
}

describe("互联茶室", () => {
	it("preserves replies to mapped messages in both directions", async () => {
		const { createBridge, records, db } = setup();
		const bridge = createBridge();
		const relation = (event_id: string) => ({ "m.in_reply_to": { event_id } });
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(sync("s1"))
			.mockResolvedValueOnce(sync("s2", [event("$original", "原消息")]))
			.mockResolvedValueOnce(Response.json({ event_id: "$outgoing" }))
			.mockResolvedValueOnce(
				sync("s3", [
					{
						...event("$incoming", ""),
						content: {
							msgtype: "m.text",
							body: "> 旧客户端引用\n> 原文\n\n[ID:茶友];[URL:https://example.org/avatar.png]\n回信",
							"m.relates_to": relation("$original"),
						},
					},
				]),
			);
		vi.stubGlobal("fetch", fetch);
		await bridge.poll();
		bridge.wake();
		await bridge.poll();
		const original = records[0];
		bridge.enqueue({
			...original,
			msgUid: "outgoing",
			content: "本站回复",
			replyTo: {
				msgUid: original.msgUid,
				userKey: original.userKey,
				name: original.name,
				content: original.content,
			},
		});
		await bridge.drain();
		expect(JSON.parse(fetch.mock.calls[2][1].body)["m.relates_to"]).toEqual(
			relation("$original"),
		);
		bridge.wake();
		await bridge.poll();
		expect(records[1]).toMatchObject({
			name: "茶友",
			content: "回信",
			replyTo: { msgUid: original.msgUid, content: "原消息" },
		});
		db.close();
	});

	it("uses the shared prefix and preserves multiline content", () => {
		const prefix = bridgePrefix(
			"茶友]\n",
			"/avatar.webp",
			"https://chat.example.com",
		);
		expect(parseBridgeBody(`${prefix}一行\n二行`)).toMatchObject({
			name: "茶友",
			avatar: "https://chat.example.com/avatar.webp",
			text: "一行\n二行",
		});
		expect(
			parseBridgeBody("[ID:茶友];[URL:https://example.org/a]\r\n正文")?.text,
		).toBe("正文");
		expect(
			parseBridgeBody("[ID:茶友];[URL:https://example.org/a]正文")?.text,
		).toBe("正文");
		expect(parseBridgeBody("普通正文")).toBeUndefined();
		expect(
			publicImageUrl("http://thirdqq.qlogo.cn/ek_qqapp/test/100"),
		).toBe("https://thirdqq.qlogo.cn/ek_qqapp/test/100");
		expect(
			publicImageUrl("http://example.org/avatar.jpg"),
		).toBe("http://example.org/avatar.jpg");
		const defaultPrefix = bridgePrefix("访客", "", "https://lengxiqwq.com");
		expect(defaultPrefix).toContain(DEFAULT_BRIDGE_AVATAR);
		expect(defaultPrefix).not.toContain("avatar-64.webp");
		expect(matrixMediaPath("mxc://example.org/../../secret")).toBeUndefined();
		expect(nextPollDelay(3)).toBe(3000);
		expect(nextPollDelay(4)).toBe(15000);
	});

	it("establishes a baseline, resumes a paginated gap, filters echoes and deduplicates", async () => {
		const { createBridge, records, publish, setOnline, db } = setup();
		let bridge = createBridge();
		const first = event("$one", "[ID:茶友];[URL:https://example.org/a]\n你好");
		const second = {
			...event("$two", "a.png"),
			content: { msgtype: "m.image", body: "a.png", url: png },
		};
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(sync("s1", [event("$history", "旧记录")]))
			.mockResolvedValueOnce(
				sync("s2", [second, event("$echo", "回声", BOT)], {
					limited: true,
					prev_batch: "edge",
				}),
			)
			.mockResolvedValueOnce(Response.json({ chunk: [first], end: "gap-page" }))
			.mockResolvedValueOnce(Response.json({ chunk: [first], end: "edge" }))
			.mockResolvedValueOnce(sync("s3", [second, first]));
		vi.stubGlobal("fetch", fetch);
		await bridge.poll();
		expect(records).toHaveLength(0);
		bridge.wake();
		await bridge.poll();
		expect(records.map((m) => m.content)).toEqual(["你好"]);
		setOnline(false);
		expect(bridge.due()).toBeNull();
		await bridge.poll();
		expect(fetch).toHaveBeenCalledTimes(3);
		setOnline(true);
		bridge = createBridge();
		bridge.wake();
		await bridge.poll();
		expect(records).toHaveLength(2);
		expect(records[1]).toMatchObject({
			source: "matrix",
			name: OTHER,
			content: "",
		});
		expect(records[1].attachments[0]?.url).toMatch(
			/^https:\/\/chat.example.com\/api\/interconnect\/media\//,
		);
		bridge.wake();
		await bridge.poll();
		expect(publish).toHaveBeenCalledTimes(2);
		expect(new URL(fetch.mock.calls[3][0]).searchParams.get("from")).toBe(
			"gap-page",
		);
		db.close();
	});

	it("maps each part and applies a foreign redaction only to its mapped part", async () => {
		const { createBridge, removePart, publish, db } = setup();
		const bridge = createBridge();
		const sent: ChatMessageRecord = {
			id: 1,
			msgUid: "out",
			kind: "user",
			userKey: "guest:test",
			name: "访客",
			avatar: "",
			url: "",
			badge: "",
			badgeType: "tag",
			isAdmin: false,
			content: "文字",
			attachments: [
				{ type: "image", url: "https://img.lengxiqwq.com/example.png" },
			],
			mentions: [],
			createdAt: 0,
		};
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(sync("s1"))
			.mockResolvedValueOnce(Response.json({ event_id: "$text" }))
			.mockResolvedValueOnce(
				new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
					headers: { "Content-Type": "image/png" },
				}),
			)
			.mockResolvedValueOnce(Response.json({ content_uri: png }))
			.mockResolvedValueOnce(Response.json({ event_id: "$image" }))
			.mockResolvedValueOnce(
				sync("s2", [
					{
						type: "m.room.redaction",
						sender: OTHER,
						event_id: "$redaction",
						content: { redacts: "$image" },
					},
				]),
			);
		vi.stubGlobal("fetch", fetch);
		await bridge.poll();
		bridge.enqueue(sent);
		await bridge.drain();
		const text = JSON.parse(fetch.mock.calls[1][1].body);
		const image = JSON.parse(fetch.mock.calls[4][1].body);
		expect(text["com.aiovtue.chat.relay"]?.userId).toMatch(/^[a-f0-9]{64}$/);
		expect(image["com.aiovtue.chat.relay"]).toEqual(
			text["com.aiovtue.chat.relay"],
		);
		expect(image).toMatchObject({
			msgtype: "m.image",
			url: png,
		});
		bridge.wake();
		await bridge.poll();
		expect(removePart).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				uid: "out",
				part: 1,
				image: sent.attachments[0].url,
			}),
		);
		expect(publish).toHaveBeenCalledTimes(1);
		db.close();
	});

	it("sends a known sticker as an image and preserves unknown sticker codes", async () => {
		const { createBridge, db } = setup();
		const bridge = createBridge();
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(sync("s1"))
			.mockResolvedValueOnce(
				Response.json({ prefix: "miku_", type: "webp", items: ["仰望"] }),
			)
			.mockResolvedValueOnce(
				new Response("sticker bytes", {
					headers: { "Content-Type": "image/webp" },
				}),
			)
			.mockResolvedValueOnce(Response.json({ content_uri: png }))
			.mockResolvedValueOnce(Response.json({ event_id: "$sticker" }));
		vi.stubGlobal("fetch", fetch);
		await bridge.poll();
		const content = ":miku_仰望:";
		const resolved = await bridge.resolveStickers(content);
		expect(await bridge.resolveStickers("你好 :miku_不存在:")).toEqual({
			text: "你好 :miku_不存在:",
			stickers: [],
		});
		bridge.enqueue(
			{
				id: 1,
				msgUid: "sticker",
				kind: "user",
				userKey: "guest:test",
				name: "访客",
				avatar: "",
				url: "",
				badge: "",
				badgeType: "tag",
				isAdmin: false,
				content,
				attachments: [],
				mentions: [],
				createdAt: 0,
			},
			resolved,
		);
		await bridge.drain();
		expect(fetch).toHaveBeenCalledTimes(5);
		expect(fetch.mock.calls[2][0]).toContain(
			"/assets/stickers/miku/miku_%E4%BB%B0%E6%9C%9B.webp",
		);
		expect(JSON.parse(fetch.mock.calls[4][1].body)).toMatchObject({
			msgtype: "m.image",
			url: png,
		});
		expect(
			db
				.prepare("SELECT part FROM matrix_events WHERE event = ?")
				.get("$sticker"),
		).toMatchObject({ part: FIRST_STICKER_PART });
		db.close();
	});
});
