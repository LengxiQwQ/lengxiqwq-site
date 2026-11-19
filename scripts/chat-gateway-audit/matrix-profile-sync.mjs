// Deploy as src/matrix/matrix-profile-sync.mjs with the companion gateway patch.
// Matrix profile writes can create federated room events, even for identical values.
export function createMatrixProfileSync({
	fetchImpl = fetch,
	baseUrl,
	roomId,
}) {
	const pending = new Map();
	const request = async (url, token, options = {}) => {
		const response = await fetchImpl(url, {
			...options,
			headers: {
				Authorization: `Bearer ${token}`,
				...(options.body ? { "Content-Type": "application/json" } : {}),
			},
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) throw new Error(`Matrix profile HTTP ${response.status}`);
		return response.json();
	};

	return function syncProfile({ userId, token, displayname, avatarUrl }) {
		if (!userId || !token)
			return Promise.reject(new Error("Missing Matrix credentials"));
		const previous = pending.get(userId) || Promise.resolve();
		const current = previous
			.catch(() => {})
			.then(async () => {
				const root = `${baseUrl}/_matrix/client/v3`;
				const profileUrl = `${root}/profile/${encodeURIComponent(userId)}`;
				const memberUrl = `${root}/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`;
				const profile = await request(profileUrl, token);
				let member = await request(memberUrl, token);
				const changes = [];
				for (const [field, desired] of [
					["displayname", displayname],
					["avatar_url", avatarUrl],
				]) {
					if (typeof desired !== "string" || (profile[field] || "") === desired)
						continue;
					await request(`${profileUrl}/${field}`, token, {
						method: "PUT",
						body: JSON.stringify({ [field]: desired }),
					});
					changes.push(field);
				}
				// Profile writes usually update room membership automatically; read it again
				// before considering a separate state write, and preserve unrelated fields.
				if (changes.length) member = await request(memberUrl, token);
				const next = { ...member };
				if (typeof displayname === "string") next.displayname = displayname;
				if (typeof avatarUrl === "string") next.avatar_url = avatarUrl;
				const roomChanged =
					member.membership === "join" &&
					((typeof displayname === "string" &&
						(member.displayname || "") !== displayname) ||
						(typeof avatarUrl === "string" &&
							(member.avatar_url || "") !== avatarUrl));
				if (roomChanged)
					await request(memberUrl, token, {
						method: "PUT",
						body: JSON.stringify(next),
					});
				return { profileChanged: changes, roomChanged };
			});
		pending.set(userId, current);
		current
			.finally(() => {
				if (pending.get(userId) === current) pending.delete(userId);
			})
			.catch(() => {});
		return current;
	};
}

export async function ensureMatrixRoomJoined({
	fetchImpl = fetch,
	baseUrl,
	roomId,
	userId,
	userToken,
	adminToken,
}) {
	const root = `${baseUrl}/_matrix/client/v3`;
	const stateUrl = `${root}/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`;
	const state = await fetchImpl(stateUrl, {
		headers: { Authorization: `Bearer ${adminToken}` },
		signal: AbortSignal.timeout(8000),
	});
	if (state.ok && (await state.json()).membership === "join") return false;
	if (!state.ok && state.status !== 404)
		throw new Error(`Matrix member HTTP ${state.status}`);
	const joined = await fetchImpl(`${root}/join/${encodeURIComponent(roomId)}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${userToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			server_name: ["detached.online", "matrix.rainzt.cn", "chat.gbk.ink"],
		}),
		signal: AbortSignal.timeout(8000),
	});
	if (!joined.ok) throw new Error(`Matrix join HTTP ${joined.status}`);
	return true;
}
