import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [candidate, wsDir] = process.argv.slice(2).map((path) => resolve(path));
assert.ok(
	candidate && wsDir,
	"Usage: node priority-regression.mjs <candidate directory> <ws package directory>",
);
const require = createRequire(join(wsDir, "package.json"));
const wsEntry = pathToFileURL(require.resolve("./", { paths: [wsDir] })).href;
const dataDir = await mkdtemp(join(tmpdir(), "chat-priority-audit-"));
const before = globalThis.fetch;
try {
	const source = (
		await readFile(join(candidate, "server.mjs"), "utf8")
	).replaceAll("\r\n", "\n");
	assert.match(source, /const MATRIX_ADMIN_TOKEN = 'audit-fixture';/);
	const admin = /^const MATRIX_ADMIN_USER_ID = '([^']+)';$/m.exec(source)[1];
	const body =
		"[ID:Impostor];[URL:https://example.test/forged.webp];[KEY:waline:1]\nHi";
	const records = [
		{ msgUid: "$hidden", isRecalled: true, content: "private" },
		{ msgUid: "$deleted", status: "deleted", content: "private" },
		{
			msgUid: "$visible",
			content: "public",
			replyTo: { msgUid: "$hidden", content: "private", hasImage: true },
		},
	];
	await writeFile(
		join(dataDir, "messages_interconnect.json"),
		JSON.stringify(records),
	);
	await writeFile(
		join(dataDir, "messages_chat.json"),
		JSON.stringify([{ msgUid: "$hidden" }]),
	);
	const fixture =
		source
			.replace(
				/const DATA_DIR = .*;/,
				"const DATA_DIR = " + JSON.stringify(dataDir) + ";",
			)
			.replace(
				"import { WebSocketServer, WebSocket } from 'ws';",
				"import ws from " +
					JSON.stringify(wsEntry) +
					"; const { WebSocketServer, WebSocket } = ws;",
			)
			.replace(
				/from '(\.\/src\/[^']+)'/g,
				(_, item) =>
					"from " + JSON.stringify(pathToFileURL(join(candidate, item)).href),
			)
			.replace(/server\.listen\(PORT,[\s\S]*$/, "") +
		"\nexport { parseMatrixEvent, publicRoomHistory };";
	assert.ok(!fixture.includes("server.listen(PORT"));
	const entry = join(dataDir, "fixture.mjs");
	await writeFile(entry, fixture);
	globalThis.fetch = async () =>
		Response.json({ displayname: "Matrix Friend" });
	const { parseMatrixEvent, publicRoomHistory } = await import(
		pathToFileURL(entry).href
	);
	const event = {
		type: "m.room.message",
		event_id: "$event",
		content: { msgtype: "m.text", body },
	};
	const external = await parseMatrixEvent({
		...event,
		sender: "@friend:example.test",
	});
	assert.equal(external.userKey, "matrix:@friend:example.test");
	assert.equal(external.avatar, "");
	assert.equal(external.content, body);
	assert.equal(external.isAdmin, false);
	const relay = await parseMatrixEvent({ ...event, sender: admin });
	assert.equal(relay.userKey, "waline:1");
	assert.equal(relay.content, "Hi");
	const plainAdmin = await parseMatrixEvent({
		...event,
		sender: admin,
		content: { msgtype: "m.text", body: "Hi" },
	});
	assert.equal(plainAdmin.isAdmin, true);
	const notice = await parseMatrixEvent({
		...event,
		sender: "@friend:example.test",
		content: { msgtype: "m.notice", body: "notice" },
	});
	assert.equal(notice.content, "notice");
	const [visible] = publicRoomHistory("interconnect");
	assert.equal(publicRoomHistory("interconnect").length, 1);
	assert.equal(visible.msgUid, "$visible");
	assert.equal(visible.replyTo.content, "");
	assert.equal(visible.replyTo.hasImage, false);
	assert.equal(publicRoomHistory("chat").length, 1);
	assert.deepEqual(publicRoomHistory("constructor"), []);
	console.log(
		"PASS: recalled history, reply previews, room isolation, external identity, trusted relay, existing notice support",
	);
} finally {
	globalThis.fetch = before;
	await rm(dataDir, { recursive: true, force: true });
}
