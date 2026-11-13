/**
 * 房间 ID 约定。
 *
 * `library` 是一个保留 ID：它不是可进入的聊天室，而是存放"共享歌单库"的
 * Durable Object 实例。所有个人歌单 / 分享歌单都只存在这一份，各聊天室通过
 * `room_featured` 表决定"本房展示哪些精选歌单"。
 */
export const LIBRARY_ROOM_ID = "library";

export const RESERVED_ROOM_IDS: ReadonlySet<string> = new Set([LIBRARY_ROOM_ID]);

export function isValidRoomId(raw: string | null | undefined): boolean {
	const id = (raw || "").trim().toLowerCase();
	return /^[a-z0-9_-]{1,24}$/.test(id) && !RESERVED_ROOM_IDS.has(id);
}

export function parseDefaultRooms(raw: string | null | undefined): string[] {
	const seen = new Set<string>();
	const rooms: string[] = [];
	for (const part of (raw || "chat").split(",")) {
		const id = part.trim().toLowerCase();
		if (!isValidRoomId(id) || seen.has(id)) continue;
		seen.add(id);
		rooms.push(id);
	}
	return rooms.length > 0 ? rooms : ["chat"];
}
