import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
	createMatrixCustomStatusSync,
	normalizeChatStatus,
} from "../src/matrix-custom-status.mjs";

const user = { userKey: "waline:1", isAdmin: true };
const credentials = { token: "test-token", userId: "@site:example.org" };
const quietLogger = { warn() {} };

function response(status = 200, body = {}) {
	return new Response(JSON.stringify(body), { status });
}

test("writes website text into the MSC4426 Matrix status field", async () => {
	const requests = [];
	const sync = createMatrixCustomStatusSync({
		baseUrl: "http://matrix.test/",
		getCredentials: async () => credentials,
		fetchImpl: async (url, options) => {
			requests.push({ url, options });
			return response();
		},
		logger: quietLogger,
	});

	assert.equal((await sync(user, "摸鱼中")).outcome, "synced");
	assert.equal(
		requests[0].url,
		"http://matrix.test/_matrix/client/v3/profile/%40site%3Aexample.org/org.matrix.msc4426.status",
	);
	assert.equal(requests[0].options.method, "PUT");
	assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
	assert.deepEqual(JSON.parse(requests[0].options.body), {
		"org.matrix.msc4426.status": { text: "摸鱼中", emoji: "💬" },
	});
});

test("deletes a cleared status and treats an already absent field as success", async () => {
	const requests = [];
	const sync = createMatrixCustomStatusSync({
		baseUrl: "http://matrix.test",
		getCredentials: async () => credentials,
		fetchImpl: async (_url, options) => {
			requests.push(options);
			return response(404, { errcode: "M_NOT_FOUND" });
		},
		logger: quietLogger,
	});

	assert.equal((await sync(user, "")).outcome, "synced");
	assert.equal(requests[0].method, "DELETE");
	assert.equal("body" in requests[0], false);
});

test("retries Matrix rate limits and does not cache a failed write", async () => {
	let calls = 0;
	const waits = [];
	const sync = createMatrixCustomStatusSync({
		baseUrl: "http://matrix.test",
		getCredentials: async () => credentials,
		fetchImpl: async () =>
			++calls === 1 ? response(429, { retry_after_ms: 37 }) : response(),
		sleep: async (ms) => waits.push(ms),
		logger: quietLogger,
	});

	assert.equal((await sync(user, "忙碌")).outcome, "synced");
	assert.equal(calls, 2);
	assert.deepEqual(waits, [37]);

	let failureCalls = 0;
	const failureSync = createMatrixCustomStatusSync({
		baseUrl: "http://matrix.test",
		getCredentials: async () => credentials,
		fetchImpl: async () => (++failureCalls <= 2 ? response(503) : response()),
		sleep: async () => {},
		maxRetries: 1,
		logger: quietLogger,
	});
	assert.equal((await failureSync(user, "失败后重试")).outcome, "failed");
	assert.equal((await failureSync(user, "失败后重试")).outcome, "synced");
});

test("coalesces a newer status behind an in-flight request", async () => {
	const requests = [];
	let releaseFirst;
	const sync = createMatrixCustomStatusSync({
		baseUrl: "http://matrix.test",
		getCredentials: async () => credentials,
		fetchImpl: (url, options) => {
			requests.push({ url, options });
			if (requests.length === 1) {
				return new Promise((resolve) => {
					releaseFirst = resolve;
				});
			}
			return Promise.resolve(response());
		},
		sleep: async () => {},
		logger: quietLogger,
	});

	const first = sync(user, "旧状态");
	while (!releaseFirst) await new Promise((resolve) => setImmediate(resolve));
	const latest = sync(user, "新状态");
	releaseFirst(response(503));
	assert.equal((await first).outcome, "superseded");
	assert.equal((await latest).outcome, "synced");
	assert.equal(requests.length, 2);
	assert.deepEqual(
		requests.map(
			({ options }) =>
				options.body &&
				JSON.parse(options.body)["org.matrix.msc4426.status"].text,
		),
		["旧状态", "新状态"],
	);
});

test("does not write a non-admin user's proxy credentials", async () => {
	let calls = 0;
	const sync = createMatrixCustomStatusSync({
		baseUrl: "http://matrix.test",
		getCredentials: async () => ({ ...credentials, isProxy: true }),
		fetchImpl: async () => {
			calls += 1;
			return response();
		},
		logger: quietLogger,
	});

	assert.equal(
		(await sync({ userKey: "guest:1", isAdmin: false }, "摸鱼中")).outcome,
		"failed",
	);
	assert.equal(calls, 0);
});

test("uses a fresh timeout signal on each attempt", async () => {
	const signals = [];
	const sync = createMatrixCustomStatusSync({
		baseUrl: "http://matrix.test",
		getCredentials: async () => credentials,
		fetchImpl: async (_url, { signal }) => {
			signals.push(signal);
			if (signals.length === 1) throw new Error("The request timed out");
			return response();
		},
		sleep: async () => {},
		logger: quietLogger,
	});
	assert.equal((await sync(user, "摸鱼中")).outcome, "synced");
	assert.equal(signals.length, 2);
	assert.notEqual(signals[0], signals[1]);
});

test("drops outdated work when a newer state arrives during rate limit backoff", async () => {
	const methods = [];
	let backoffStarted;
	const enteredBackoff = new Promise((resolve) => {
		backoffStarted = resolve;
	});
	let endBackoff;
	const sync = createMatrixCustomStatusSync({
		baseUrl: "http://matrix.test",
		getCredentials: async () => credentials,
		fetchImpl: async (_url, options) => {
			methods.push(options.method);
			return methods.length === 1 ? response(429) : response();
		},
		sleep: (delay) =>
			new Promise((resolve) => {
				endBackoff = resolve;
				backoffStarted(delay);
			}),
		logger: quietLogger,
	});
	const previous = sync(user, "摸鱼中");
	assert.equal(await enteredBackoff, 500);
	const intermediate = sync(user, "思考中");
	const latest = sync(user, "");
	endBackoff();
	assert.equal((await previous).outcome, "superseded");
	assert.equal((await intermediate).outcome, "superseded");
	assert.equal((await latest).outcome, "synced");
	assert.deepEqual(methods, ["PUT", "DELETE"]);
});

test("uses the target Matrix ID when deduplicating, and can force explicit writes", async () => {
	let account = credentials;
	const requests = [];
	const sync = createMatrixCustomStatusSync({
		baseUrl: "http://matrix.test",
		getCredentials: async () => account,
		fetchImpl: async (url) => {
			requests.push(url);
			return response();
		},
		logger: quietLogger,
	});
	const status = "摸鱼中";
	assert.equal((await sync(user, status)).httpStatus, 200);
	assert.equal((await sync(user, status)).cached, true);
	account = { ...account, userId: "@another:example.org" };
	assert.equal((await sync(user, status)).userId, account.userId);
	assert.equal((await sync(user, status, { force: true })).httpStatus, 200);
	assert.equal(requests.length, 3);
});

const gatewayPatch = readFileSync(
	new URL("../gateway-matrix-custom-status-receipts.patch", import.meta.url),
	"utf8",
);
const gatewayStatusHandler = gatewayPatch
	.slice(
		gatewayPatch.indexOf("+const statusRequests"),
		gatewayPatch.indexOf(" function resolveExternalStatusSnapshot"),
	)
	.split("\n")
	.filter((line) => line.startsWith("+"))
	.map((line) => line.slice(1))
	.join("\n");

test("the gateway saves before syncing and replays receipts without writing again", async () => {
	const member = { userKey: user.userKey, status: "听歌中" };
	const writes = [];
	const requests = [];
	const replies = [];
	const resumed = [];
	const rejected = [];
	const unrelated = [];
	const makeSocket = (key, packets) => ({
		readyState: 1,
		user: { userKey: key, status: member.status },
		send: (raw) => packets.push(JSON.parse(raw)),
	});
	const socket = makeSocket(user.userKey, replies);
	const reconnect = makeSocket(user.userKey, resumed);
	const otherSocket = makeSocket("guest:other", unrelated);
	let canSave = true;
	let finishSync;
	const handleUpdate = runInNewContext(
		`${gatewayStatusHandler}\nupdateChatStatus;`,
		{
			WebSocket: { OPEN: 1 },
			DATA_DIR: "/fake",
			join: (...parts) => parts.join("/"),
			membersStore: [member],
			clients: [socket, otherSocket],
			console: { info() {}, warn() {} },
			writeJsonAtomic: (_path, [record]) => {
				if (canSave) writes.push(record.status);
				return canSave;
			},
			saveStoreDebounced() {},
			broadcastPresenceAll() {},
			syncMatrixCustomStatus: (_user, status) => {
				requests.push(status);
				return new Promise((resolve) => {
					finishSync = resolve;
				});
			},
		},
	);
	const packet = {
		requestId: "status-1",
		expectedUserKey: user.userKey,
		status: " 摸鱼中 ",
	};
	handleUpdate(socket, packet);
	assert.deepEqual(writes, ["摸鱼中"]);
	assert.deepEqual(requests, ["摸鱼中"]);
	assert.equal(replies[0].user.status, "摸鱼中");
	assert.equal(replies[1].stage, "saved");
	assert.deepEqual(unrelated, []);

	handleUpdate(reconnect, { ...packet, resumeOnly: true });
	assert.equal(resumed[0].stage, "saved");
	finishSync({
		outcome: "synced",
		userId: credentials.userId,
		httpStatus: 200,
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(replies[2].stage, "synced");
	assert.equal(resumed[1].stage, "synced");
	assert.deepEqual(writes, ["摸鱼中"]);
	assert.deepEqual(requests, ["摸鱼中"]);

	canSave = false;
	const socketWithFailedWrite = makeSocket(user.userKey, rejected);
	handleUpdate(socketWithFailedWrite, {
		...packet,
		requestId: "status-2",
		status: "",
	});
	assert.equal(rejected[0].stage, "save_failed");
	assert.equal(member.status, "摸鱼中");
	assert.deepEqual(requests, ["摸鱼中"]);

	handleUpdate(reconnect, {
		...packet,
		requestId: "status-3",
		resumeOnly: true,
	});
	assert.equal(resumed[2].stage, "sync_unknown");
	handleUpdate(otherSocket, { ...packet, requestId: "status-4" });
	assert.equal(unrelated[0].stage, "save_failed");
	assert.deepEqual(writes, ["摸鱼中"]);
});

test("keeps twenty visible characters and preserves emoji sequences", async () => {
	const twenty = "一".repeat(18) + "e\u0301👩‍💻";
	assert.equal(normalizeChatStatus("  " + twenty + "多  "), twenty);
	assert.equal(
		normalizeChatStatus("👨‍👩‍👧‍👦".repeat(20)),
		"👨‍👩‍👧‍👦".repeat(10),
	);

	let body;
	const sync = createMatrixCustomStatusSync({
		baseUrl: "http://matrix.test",
		getCredentials: async () => credentials,
		fetchImpl: async (_url, options) => {
			body = JSON.parse(options.body);
			return response();
		},
		logger: quietLogger,
	});
	assert.equal((await sync(user, twenty)).outcome, "synced");
	assert.equal(body["org.matrix.msc4426.status"].text, twenty);
});
