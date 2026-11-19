import assert from "node:assert/strict";
import {
	createMatrixProfileSync,
	ensureMatrixRoomJoined,
} from "./matrix-profile-sync.mjs";

function fixture({
	profile = { displayname: "小明", avatar_url: "mxc://a" },
	member = {
		membership: "join",
		displayname: "小明",
		avatar_url: "mxc://a",
		custom: "keep",
	},
	propagate = true,
	fail = "",
} = {}) {
	const writes = [];
	const fetchImpl = async (url, options = {}) => {
		const method = options.method || "GET";
		const isMember = url.includes("/state/m.room.member/");
		const isJoin = url.includes("/join/");
		if (fail === `${method}:${isMember ? "member" : "profile"}`)
			return new Response("{}", { status: 503 });
		if (method === "GET") return Response.json(isMember ? member : profile);
		writes.push({ url, method, body: JSON.parse(options.body) });
		if (isJoin) member.membership = "join";
		else if (isMember) member = JSON.parse(options.body);
		else {
			Object.assign(profile, JSON.parse(options.body));
			if (propagate) Object.assign(member, JSON.parse(options.body));
		}
		return Response.json({});
	};
	const sync = createMatrixProfileSync({
		fetchImpl,
		baseUrl: "https://example.invalid",
		roomId: "!room",
	});
	const run = (displayname = "小明", avatarUrl = "mxc://a") =>
		sync({
			userId: "@user:example.invalid",
			token: "test",
			displayname,
			avatarUrl,
		});
	return { run, writes, fetchImpl, member: () => member };
}

let f = fixture();
await Promise.all([f.run(), f.run(), f.run()]);
assert.equal(
	f.writes.length,
	0,
	"unchanged profiles, including concurrent calls, must never write",
);
f = fixture();
await Promise.all([f.run("新名字"), f.run("新名字")]);
assert.equal(
	f.writes.length,
	1,
	"a changed name is written once even under concurrency",
);
assert.equal(f.member().displayname, "新名字");
f = fixture();
await Promise.all([f.run("先改"), f.run("后改")]);
assert.equal(
	f.member().displayname,
	"后改",
	"distinct changes must retain their order",
);
f = fixture();
await f.run("小明", "mxc://b");
assert.equal(f.writes.length, 1);
assert.equal(f.member().avatar_url, "mxc://b");
f = fixture({
	member: {
		membership: "join",
		displayname: "旧名字",
		avatar_url: "mxc://a",
		custom: "keep",
	},
});
await f.run();
assert.equal(f.writes.length, 1);
assert.equal(
	f.writes[0].body.custom,
	"keep",
	"room repair preserves other fields",
);
f = fixture({ propagate: false });
await f.run("新名字");
assert.equal(
	f.writes.length,
	2,
	"repair room state only if profile propagation did not do it",
);
f = fixture({ fail: "GET:member" });
await assert.rejects(f.run());
assert.equal(f.writes.length, 0, "an unreadable state must not be overwritten");
f = fixture();
await f.run("新名字", null);
assert.equal(
	f.member().avatar_url,
	"mxc://a",
	"name-only changes preserve the avatar",
);
f = fixture();
const joinArgs = {
	fetchImpl: f.fetchImpl,
	baseUrl: "https://example.invalid",
	roomId: "!room",
	userId: "@user:example.invalid",
	userToken: "test",
	adminToken: "test",
};
assert.equal(await ensureMatrixRoomJoined(joinArgs), false);
assert.equal(f.writes.length, 0, "already joined users do not join again");
f = fixture({ member: { membership: "leave" } });
assert.equal(
	await ensureMatrixRoomJoined({ ...joinArgs, fetchImpl: f.fetchImpl }),
	true,
);
assert.equal(f.writes.length, 1);
f = fixture({ fail: "GET:member" });
await assert.rejects(
	ensureMatrixRoomJoined({ ...joinArgs, fetchImpl: f.fetchImpl }),
);
assert.equal(f.writes.length, 0);
console.log("Matrix profile synchronization tests passed");
