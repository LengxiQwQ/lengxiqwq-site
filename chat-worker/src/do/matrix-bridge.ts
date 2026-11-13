import { createHash } from "node:crypto";
import type { Env } from "../env.js";
import type { ChatMessageRecord, ChatReplyRef } from "./room.js";

export const INTERCONNECT_ROOM = "interconnect";
const RELAY_FIELD = "com.aiovtue.chat.relay";
const MEDIA_LIMIT = 5 * 1024 * 1024;
const STICKER_PACKS = ["miku", "qq"] as const;
const STICKER_TOKEN = /:(miku|qq)_[^:\s<>"']+:/g;
export const FIRST_STICKER_PART = 4;
const STICKER_CACHE_MS = 300_000;

export function stickerTokenFromUrl(image: string): string {
	const filename = new URL(image).pathname.split("/").pop() ?? "";
	return `:${decodeURIComponent(filename).replace(/\.[^.]+$/, "")}:`;
}
const IMAGE_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"image/avif",
]);
const PREFIX =
	/^\[ID:(?<name>[^\]\r\n]+)\];\[URL:(?<avatar>[^\]\r\n]+)\](?:\r?\n)?(?<text>[\s\S]*)$/;

export function parseBridgeBody(body: string) {
	return PREFIX.exec(body)?.groups;
}

export function publicImageUrl(raw: string, base?: string): string {
	try {
		const url = new URL(raw, base);
		return url.protocol === "https:" && !url.username && !url.password
			? url.href
			: "";
	} catch {
		return "";
	}
}

export function bridgePrefix(
	name: string,
	avatar: string,
	site: string,
): string {
	const safeName = name.replace(/[\]\r\n]/g, " ").trim() || "访客";
	const safeAvatar =
		publicImageUrl(avatar || "/avatar-64.webp", site) ||
		new URL("/avatar-64.webp", site).href;
	return `[ID:${safeName}];[URL:${safeAvatar.replaceAll("]", "%5D")}]\n`;
}

export function matrixMediaPath(uri: string): string | undefined {
	const match = /^mxc:\/\/([a-z0-9.-]+(?::[0-9]+)?)\/([a-z0-9_-]+)$/i.exec(uri);
	return match && match[1] !== "." && match[1] !== ".."
		? `${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`
		: undefined;
}

type Event = {
	event_id: string;
	sender: string;
	type: string;
	state_key?: string;
	redacts?: string;
	content?: Record<string, unknown>;
	unsigned?: { redacted_because?: unknown };
};

type MessageRelation = {
	rel_type?: unknown;
	"m.in_reply_to"?: { event_id?: unknown };
};

function compactEvent(event: Event): Event {
	const content = event.content;
	const body = content?.body;
	return {
		event_id: event.event_id,
		sender: event.sender,
		type: event.type,
		state_key: event.state_key,
		redacts: event.redacts,
		unsigned: event.unsigned?.redacted_because
			? { redacted_because: true }
			: undefined,
		content: {
			body: typeof body === "string" ? body.slice(0, 9500) : undefined,
			msgtype: content?.msgtype,
			filename: content?.filename,
			url: content?.url,
			displayname: content?.displayname,
			avatar_url: content?.avatar_url,
			redacts: content?.redacts,
			"m.relates_to": content?.["m.relates_to"],
		},
	};
}

type Timeline = { events?: Event[]; limited?: boolean; prev_batch?: string };
type Sync = {
	next_batch: string;
	rooms?: {
		join?: Record<
			string,
			{ timeline?: Timeline; state?: { events?: Event[] } }
		>;
		leave?: Record<string, unknown>;
	};
};
type Gap = {
	from: string;
	to: string;
	next: string;
	timeline: Event[];
	state: Event[];
};
type Job = {
	id: string;
	uid: string;
	part: number;
	body: string;
	relay_user_id: string;
	reply_uid: string;
	reply_event_id: string;
	image: string;
	mxc: string;
	attempts: number;
	delete_requested: number;
	started: number;
	event_id: string;
};
type Mapping = { uid: string; part: number; image: string; redacted: number };
type Update = { uid: string; part: number; image: string };

class MatrixError extends Error {
	constructor(
		readonly status: number,
		readonly retryMs = 0,
	) {
		super(`Matrix HTTP ${status}`);
	}
}

export function nextPollDelay(emptyPolls: number): number {
	return emptyPolls >= 4 ? 15_000 : 3_000;
}

async function readImage(response: Response) {
	const type =
		response.headers.get("Content-Type")?.split(";", 1)[0]?.toLowerCase() ?? "";
	if (
		!IMAGE_TYPES.has(type) ||
		Number(response.headers.get("Content-Length")) > MEDIA_LIMIT ||
		!response.body
	) {
		throw new MatrixError(415);
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.byteLength;
			if (length > MEDIA_LIMIT) {
				await reader.cancel();
				throw new MatrixError(413);
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, type };
}

interface RoomHooks {
	append: (
		record: Omit<ChatMessageRecord, "id" | "msgUid" | "createdAt">,
	) => ChatMessageRecord;
	resolveReply: (uid: string) => ChatReplyRef | null;
	removePart: (update: Update) => ChatMessageRecord | "deleted" | undefined;
	publish: (
		kind: "message" | "updated" | "deleted",
		message: ChatMessageRecord | string,
	) => void;
	origin: () => string;
	online: () => boolean;
}

export class MatrixBridge {
	private readonly sql: SqlStorage;
	private readonly namespace: string;
	private readonly base: string;
	private readonly room: string;
	private readonly bot: string;
	private readonly token: string;
	private nextPoll = 0;
	private emptyPolls = 0;
	private failures = 0;
	private polling = false;
	private sending = false;
	private readonly stickerPacks = new Map<
		string,
		{
			expires: number;
			images: Promise<Map<string, string>>;
		}
	>();
	private readonly mediaInFlight = new Map<
		string,
		Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string }>
	>();

	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly env: Env,
		private readonly hooks: RoomHooks,
	) {
		this.sql = storage.sql;
		this.base = env.MATRIX_HOMESERVER ?? "";
		this.room = env.MATRIX_ROOM_ID?.trim() ?? "";
		this.bot = env.MATRIX_BOT_USER_ID ?? "";
		this.token = env.MATRIX_ACCESS_TOKEN ?? "";
		this.namespace = JSON.stringify([this.base, this.bot, this.room]);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS matrix_state (scope TEXT, key TEXT, value TEXT, PRIMARY KEY(scope,key));
			CREATE TABLE IF NOT EXISTS matrix_seen (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, event TEXT, UNIQUE(scope,event));
			CREATE TABLE IF NOT EXISTS matrix_events (scope TEXT, event TEXT, uid TEXT, part INTEGER, image TEXT, redacted INTEGER DEFAULT 0, PRIMARY KEY(scope,event));
			CREATE INDEX IF NOT EXISTS matrix_events_uid ON matrix_events(scope,uid);
			CREATE TABLE IF NOT EXISTS matrix_jobs (
				seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT, id TEXT UNIQUE, uid TEXT, part INTEGER,
				body TEXT, image TEXT, mxc TEXT DEFAULT '', event_id TEXT DEFAULT '', delete_requested INTEGER DEFAULT 0,
				relay_user_id TEXT NOT NULL DEFAULT '',
				reply_uid TEXT NOT NULL DEFAULT '', reply_event_id TEXT NOT NULL DEFAULT '',
				started INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, due INTEGER, error INTEGER DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS matrix_jobs_due ON matrix_jobs(scope,error,due);
			CREATE TABLE IF NOT EXISTS matrix_media (id TEXT PRIMARY KEY, mxc TEXT UNIQUE);
		`);
		const jobColumns = this.sql
			.exec<{ name: string }>("PRAGMA table_info(matrix_jobs)")
			.toArray();
		if (!jobColumns.some(({ name }) => name === "relay_user_id")) {
			this.sql.exec(
				"ALTER TABLE matrix_jobs ADD COLUMN relay_user_id TEXT NOT NULL DEFAULT ''",
			);
		}
		for (const column of ["reply_uid", "reply_event_id"]) {
			if (!jobColumns.some(({ name }) => name === column)) {
				this.sql.exec(
					`ALTER TABLE matrix_jobs ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`,
				);
			}
		}
		const schedule = this.get<{ due: number; empty: number; failures: number }>(
			"poll-schedule",
		);
		if (schedule) {
			this.nextPoll = schedule.due;
			this.emptyPolls = schedule.empty;
			this.failures = schedule.failures;
		}
	}

	get enabled() {
		return (
			this.env.MATRIX_ENABLED === "true" &&
			Boolean(
				this.token &&
					this.bot.startsWith("@") &&
					this.room.startsWith("!") &&
					publicImageUrl(this.base),
			)
		);
	}

	wake() {
		if (this.failures === 0) this.nextPoll = 0;
		this.emptyPolls = 0;
		this.savePollSchedule();
	}

	due(): number | null {
		if (!this.enabled) return null;
		const jobDue = this.sending
			? null
			: this.sql
					.exec<{ due: number | null }>(
						"SELECT MIN(due) AS due FROM matrix_jobs WHERE scope = ? AND error = 0",
						this.namespace,
					)
					.one().due;
		const pollDue =
			this.hooks.online() && !this.polling
				? Math.max(Date.now(), this.nextPoll)
				: null;
		return jobDue === null
			? pollDue
			: pollDue === null
				? jobDue
				: Math.min(jobDue, pollDue);
	}

	resolveStickers(
		content: string,
	): Promise<{ text: string; stickers: string[] }> | undefined {
		const tokens = Array.from(content.matchAll(STICKER_TOKEN));
		if (!tokens.length) return;
		return Promise.all(
			[...new Set(tokens.map((token) => token[1]))].map(
				async (pack) => [pack, await this.getStickerPack(pack)] as const,
			),
		).then((entries) => {
			const packs = new Map(entries);
			const stickers: string[] = [];
			const text = content
				.replace(STICKER_TOKEN, (token, pack: string) => {
					const image = packs.get(pack)?.get(token);
					if (!image || stickers.length >= 3) return token;
					stickers.push(image);
					return "";
				})
				.trim();
			return { text, stickers };
		});
	}

	private stickerBase(pack: string): URL {
		return new URL(
			`/assets/stickers/${pack}/`,
			this.env.SITE_URL || "https://lengxiqwq.com",
		);
	}

	private getStickerPack(pack: string): Promise<Map<string, string>> {
		const cached = this.stickerPacks.get(pack);
		if (cached && cached.expires > Date.now()) return cached.images;
		const entry = {
			expires: Date.now() + STICKER_CACHE_MS,
			images: this.loadStickerPack(pack).catch((error: unknown) => {
				console.warn(
					"[interconnect] sticker pack unavailable",
					pack,
					error instanceof MatrixError
						? error.status
						: error instanceof Error
							? error.name
							: "unknown",
				);
				entry.expires = Date.now() + 15_000;
				return new Map<string, string>();
			}),
		};
		this.stickerPacks.set(pack, entry);
		return entry.images;
	}

	private async loadStickerPack(pack: string): Promise<Map<string, string>> {
		const base = this.stickerBase(pack);
		const response = await fetch(new URL("info.json", base), {
			redirect: "manual",
			signal: AbortSignal.timeout(3000),
		});
		if (!response.ok) throw new MatrixError(response.status);
		const manifest = await response.json<{
			prefix?: string;
			type?: string;
			items?: unknown[];
		}>();
		const extension = manifest.type ?? "png";
		const images = new Map<string, string>();
		if (
			manifest.prefix !== `${pack}_` ||
			!/^(?:gif|png|jpe?g|webp|avif)$/i.test(extension)
		)
			return images;
		for (const item of manifest.items ?? []) {
			if (typeof item !== "string" || !item || /[:\s<>"'\\/]/u.test(item))
				continue;
			const name = `${manifest.prefix}${item}`;
			images.set(
				`:${name}:`,
				new URL(`${encodeURIComponent(name)}.${extension}`, base).href,
			);
		}
		return images;
	}

	enqueue(
		message: ChatMessageRecord,
		resolved?: { text: string; stickers: string[] },
	) {
		if (!this.enabled) return;
		const relayUserId = this.relayUserId(message.userKey);
		const prefix = bridgePrefix(
			message.name,
			message.avatar,
			this.env.SITE_URL || "https://lengxiqwq.com",
		);
		const add = (part: number, body: string, image: string) =>
			this.sql.exec(
				"INSERT INTO matrix_jobs(scope,id,uid,part,body,image,due,relay_user_id,reply_uid) VALUES (?,?,?,?,?,?,?,?,?)",
				this.namespace,
				`${message.msgUid}-${part}`,
				message.msgUid,
				part,
				body,
				image,
				Date.now(),
				relayUserId,
				message.replyTo?.msgUid ?? "",
			);
		const text = resolved?.text ?? message.content;
		if (text) add(0, prefix + text, "");
		for (const [index, image] of message.attachments.entries())
			add(index + 1, prefix, image.url);
		for (const [index, image] of (resolved?.stickers ?? []).entries())
			add(FIRST_STICKER_PART + index, prefix, image);
	}

	private relayUserId(userKey: string): string {
		return createHash("sha256")
			.update(JSON.stringify([this.bot, userKey]))
			.digest("hex");
	}

	private getJobRelayUserId(job: Job): string {
		if (job.relay_user_id) return job.relay_user_id;
		const previous = this.sql
			.exec<{ user_key: string }>(
				"SELECT user_key FROM messages WHERE msg_uid = ?",
				job.uid,
			)
			.toArray()[0];
		return this.relayUserId(previous?.user_key || job.uid);
	}

	enqueueDeletion(uid: string) {
		this.sql.exec(
			"DELETE FROM matrix_jobs WHERE scope = ? AND uid = ? AND started = 0",
			this.namespace,
			uid,
		);
		this.sql.exec(
			"UPDATE matrix_jobs SET delete_requested = 1 WHERE scope = ? AND uid = ? AND started = 1",
			this.namespace,
			uid,
		);
		for (const item of this.sql.exec<{ event: string; part: number }>(
			"SELECT event,part FROM matrix_events WHERE scope = ? AND uid = ? AND part >= 0 AND redacted = 0",
			this.namespace,
			uid,
		)) {
			this.sql.exec(
				`INSERT OR IGNORE INTO matrix_jobs(scope,id,uid,part,body,image,event_id,delete_requested,started,due)
				VALUES (?,?,?,?, '', '', ?,1,1,?)`,
				this.namespace,
				`redact-${item.event}`,
				uid,
				item.part,
				item.event,
				Date.now(),
			);
		}
	}

	private async request(path: string, init?: RequestInit): Promise<Response> {
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${this.token}`);
		const response = await fetch(new URL(path, this.base), {
			...init,
			headers,
			redirect: "manual",
			signal: AbortSignal.timeout(8000),
		});
		if (!response.ok) {
			const retry =
				response.status === 429
					? await response
							.json<{ retry_after_ms?: number }>()
							.catch(() => ({}) as { retry_after_ms?: number })
					: {};
			throw new MatrixError(
				response.status,
				Math.max(
					retry.retry_after_ms || 0,
					(Number(response.headers.get("Retry-After")) || 0) * 1000,
				),
			);
		}
		return response;
	}

	private roomPath(path: string) {
		return `/_matrix/client/v3/rooms/${encodeURIComponent(this.room)}/${path}`;
	}

	private get<T>(key: string): T | undefined {
		const row = this.sql
			.exec<{ value: string }>(
				"SELECT value FROM matrix_state WHERE scope = ? AND key = ?",
				this.namespace,
				key,
			)
			.toArray()[0];
		return row ? (JSON.parse(row.value) as T) : undefined;
	}

	private put(key: string, value: unknown) {
		this.sql.exec(
			`INSERT INTO matrix_state(scope,key,value) VALUES (?,?,?)
			ON CONFLICT(scope,key) DO UPDATE SET value = excluded.value WHERE value <> excluded.value`,
			this.namespace,
			key,
			JSON.stringify(value),
		);
	}

	private mediaUrl(mxc: string) {
		if (!matrixMediaPath(mxc)) return "";
		let id = this.sql
			.exec<{ id: string }>("SELECT id FROM matrix_media WHERE mxc = ?", mxc)
			.toArray()[0]?.id;
		if (!id) {
			id = crypto.randomUUID();
			this.sql.exec("INSERT INTO matrix_media(id,mxc) VALUES (?,?)", id, mxc);
		}
		return `${this.hooks.origin()}/api/interconnect/media/${id}`;
	}

	async media(id: string): Promise<Response> {
		if (!this.enabled) return new Response(null, { status: 404 });
		const row = this.sql
			.exec<{ mxc: string }>("SELECT mxc FROM matrix_media WHERE id = ?", id)
			.toArray()[0];
		const path = row && matrixMediaPath(row.mxc);
		const suffix = `/api/interconnect/media/${id}`;
		const visible = () =>
			this.sql
				.exec(
					`SELECT 1 FROM messages WHERE is_recalled = 0 AND source = 'matrix' AND
			(substr(avatar, -length(?1)) = ?1 OR EXISTS (SELECT 1 FROM json_each(attachments_json) WHERE substr(json_extract(value, '$.url'), -length(?1)) = ?1)) LIMIT 1`,
					suffix,
				)
				.toArray().length > 0;
		if (!path || !visible()) return new Response(null, { status: 404 });
		const cacheKey = new Request(
			`${this.hooks.origin()}/api/interconnect/media/${id}`,
		);
		const cache = typeof caches === "undefined" ? undefined : caches.default;
		try {
			const cached = await cache?.match(cacheKey);
			if (cached && visible()) return this.revalidateImage(cached);
			const { bytes, type } = await this.downloadImage(id, path);
			if (!visible()) return new Response(null, { status: 404 });
			const image = new Response(bytes, {
				headers: {
					"Content-Type": type,
					"X-Content-Type-Options": "nosniff",
					"Cache-Control": "public, max-age=300",
				},
			});
			await cache?.put(cacheKey, image.clone()).catch(() => undefined);
			return this.revalidateImage(image);
		} catch (error) {
			return new Response(null, {
				status:
					error instanceof MatrixError && [404, 413, 415].includes(error.status)
						? error.status
						: 502,
			});
		}
	}

	private async downloadImage(id: string, path: string) {
		const pending = this.mediaInFlight.get(id);
		if (pending) return pending;
		const download = this.request(
			`/_matrix/client/v1/media/download/${path}`,
		).then(readImage);
		this.mediaInFlight.set(id, download);
		try {
			return await download;
		} finally {
			this.mediaInFlight.delete(id);
		}
	}

	private revalidateImage(response: Response): Response {
		const headers = new Headers(response.headers);
		headers.set("Cache-Control", "no-cache");
		return new Response(response.body, { headers });
	}

	private apply(events: Event[], state: Event[], finish: () => void): number {
		const changes: Array<
			["message" | "updated" | "deleted", ChatMessageRecord | string]
		> = [];
		this.storage.transactionSync(() => {
			for (const event of state) this.updateProfile(event);
			for (const event of events) {
				if (event.sender === this.bot) continue;
				if (!event.event_id || !event.sender) continue;
				if (event.type === "m.room.member") this.updateProfile(event);
				if (
					event.type !== "m.room.message" &&
					event.type !== "m.room.redaction"
				)
					continue;
				const seen = this.sql
					.exec(
						"SELECT 1 FROM matrix_seen WHERE scope = ? AND event = ?",
						this.namespace,
						event.event_id,
					)
					.toArray().length;
				if (seen) continue;
				const content = event.content ?? {};
				const redacts =
					event.type === "m.room.redaction"
						? (content.redacts ?? event.redacts)
						: undefined;
				if (typeof redacts === "string") {
					const mapping = this.sql
						.exec<Mapping>(
							"SELECT uid,part,image,redacted FROM matrix_events WHERE scope = ? AND event = ?",
							this.namespace,
							redacts,
						)
						.toArray()[0];
					if (mapping && !mapping.redacted) {
						this.sql.exec(
							"UPDATE matrix_events SET redacted = 1 WHERE scope = ? AND event = ?",
							this.namespace,
							redacts,
						);
						const updated = this.hooks.removePart(mapping);
						if (updated === "deleted") changes.push(["deleted", mapping.uid]);
						else if (updated) changes.push(["updated", updated]);
					} else if (!mapping) {
						this.sql.exec(
							"INSERT OR IGNORE INTO matrix_events(scope,event,uid,part,image,redacted) VALUES (?,?,'',-1,'',1)",
							this.namespace,
							redacts,
						);
					}
				} else if (
					event.type === "m.room.message" &&
					!event.unsigned?.redacted_because
				) {
					const record = this.importMessage(event);
					if (record) changes.push(["message", record]);
				}
				this.sql.exec(
					"INSERT OR IGNORE INTO matrix_seen(scope,event) VALUES (?,?)",
					this.namespace,
					event.event_id,
				);
			}
			if (events.length)
				this.sql.exec(
					`DELETE FROM matrix_seen WHERE scope = ? AND seq < COALESCE((
				SELECT seq FROM matrix_seen WHERE scope = ? ORDER BY seq DESC LIMIT 1 OFFSET 499), 0)`,
					this.namespace,
					this.namespace,
				);
			finish();
		});
		for (const [kind, message] of changes) this.hooks.publish(kind, message);
		return changes.length;
	}

	private updateProfile(event: Event) {
		if (
			event.sender === this.bot ||
			event.type !== "m.room.member" ||
			!event.state_key
		)
			return;
		const profile = {
			name:
				typeof event.content?.displayname === "string"
					? event.content.displayname
					: "",
			avatar:
				typeof event.content?.avatar_url === "string"
					? event.content.avatar_url
					: "",
		};
		this.put(`profile:${event.state_key}`, profile);
	}

	private importMessage(event: Event): ChatMessageRecord | undefined {
		const content = event.content ?? {};
		if (content.msgtype !== "m.text" && content.msgtype !== "m.image") return;
		const relation = content["m.relates_to"] as MessageRelation | undefined;
		if (relation?.rel_type === "m.replace" || typeof content.body !== "string")
			return;
		if (
			this.sql
				.exec(
					"SELECT 1 FROM matrix_events WHERE scope = ? AND event = ?",
					this.namespace,
					event.event_id,
				)
				.toArray().length
		)
			return;
		const replyEvent = relation?.["m.in_reply_to"]?.event_id;
		const plainBody =
			typeof replyEvent === "string"
				? content.body.replace(/^(?:>[^\S\r\n][^\r\n]*\r?\n)+\r?\n/, "")
				: content.body;
		const prefix = parseBridgeBody(plainBody);
		const target =
			typeof replyEvent === "string"
				? this.sql
						.exec<{ uid: string }>(
							"SELECT uid FROM matrix_events WHERE scope = ? AND event = ? AND redacted = 0",
							this.namespace,
							replyEvent,
						)
						.toArray()[0]
				: undefined;
		const profile = this.get<{ name: string; avatar: string }>(
			`profile:${event.sender}`,
		);
		const name =
			(prefix?.name || profile?.name || event.sender).trim().slice(0, 80) ||
			event.sender;
		const rawAvatar = prefix?.avatar || profile?.avatar || "";
		const avatar = rawAvatar.startsWith("mxc://")
			? this.mediaUrl(rawAvatar)
			: publicImageUrl(rawAvatar);
		const image =
			content.msgtype === "m.image" && typeof content.url === "string"
				? this.mediaUrl(content.url)
				: "";
		const body = (
			prefix?.text ??
			(content.msgtype === "m.image" &&
			(!content.filename || content.filename === content.body)
				? ""
				: plainBody)
		).slice(0, 8000);
		if (!body.trim() && !image) return;
		const record = this.hooks.append({
			kind: "user",
			source: "matrix",
			userKey: `matrix:${event.sender}`,
			name,
			avatar,
			url: "",
			badge: "互联茶友",
			badgeType: "tag",
			isAdmin: false,
			content: body,
			attachments: image ? [{ type: "image", url: image }] : [],
			mentions: [],
			replyTo: target ? this.hooks.resolveReply(target.uid) : null,
		});
		this.sql.exec(
			"INSERT INTO matrix_events(scope,event,uid,part,image) VALUES (?,?,?,-1,?)",
			this.namespace,
			event.event_id,
			record.msgUid,
			image,
		);
		return record;
	}

	async poll() {
		if (
			!this.enabled ||
			!this.hooks.online() ||
			this.polling ||
			Date.now() < this.nextPoll
		)
			return;
		this.polling = true;
		try {
			const changes = await this.sync();
			this.failures = 0;
			this.emptyPolls = changes ? 0 : this.emptyPolls + 1;
			this.nextPoll = Date.now() + nextPollDelay(this.emptyPolls);
		} catch (error) {
			this.failures += 1;
			const status = error instanceof MatrixError ? error.status : 0;
			this.nextPoll =
				Date.now() +
				Math.max(
					error instanceof MatrixError ? error.retryMs : 0,
					status === 401 || status === 403
						? 300_000
						: Math.min(120_000, 3000 * 2 ** Math.min(this.failures, 6)),
				);
			console.warn("[interconnect] sync failed", status);
		} finally {
			this.polling = false;
			this.savePollSchedule();
		}
	}

	private savePollSchedule() {
		this.put("poll-schedule", {
			due: this.nextPoll,
			empty: Math.min(this.emptyPolls, 4),
			failures: this.failures,
		});
	}

	private async sync(): Promise<number> {
		const since = this.get<string>("since");
		const gap = this.get<Gap | null>("gap");
		if (gap) return this.fillGap(gap);
		const query = new URLSearchParams({
			timeout: "0",
			set_presence: "offline",
			filter: JSON.stringify({
				presence: { types: [] },
				room: {
					rooms: [this.room],
					ephemeral: { types: [] },
					account_data: { types: [] },
					timeline: {
						types: [
							"m.room.message",
							"m.room.redaction",
							"m.room.member",
							"m.room.encryption",
						],
						limit: 50,
					},
					state: {
						types: ["m.room.member", "m.room.encryption"],
						lazy_load_members: true,
					},
				},
			}),
		});
		if (since) query.set("since", since);
		const result = await (
			await this.request(`/_matrix/client/v3/sync?${query}`)
		).json<Sync>();
		if (!this.hooks.online()) return 0;
		if (typeof result.next_batch !== "string" || !result.next_batch)
			throw new MatrixError(502);
		const joined = result.rooms?.join?.[this.room];
		if ((!since && !joined) || result.rooms?.leave?.[this.room])
			throw new MatrixError(403);
		const state = joined?.state?.events ?? [];
		const timeline = joined?.timeline;
		const events = timeline?.events ?? [];
		if (
			[...state, ...events].some((event) => event.type === "m.room.encryption")
		) {
			this.put("encrypted", true);
			throw new MatrixError(403);
		}
		if (!since) {
			return this.apply([], [...state, ...events], () =>
				this.put("since", result.next_batch),
			);
		}
		if (timeline?.limited) {
			if (!timeline.prev_batch) throw new MatrixError(502);
			const pending = {
				from: since,
				to: timeline.prev_batch,
				next: result.next_batch,
				timeline: events.map(compactEvent),
				state: state.map(compactEvent),
			};
			this.put("gap", pending);
			return this.fillGap(pending);
		}
		return this.apply(events, state, () =>
			this.put("since", result.next_batch),
		);
	}

	private async fillGap(gap: Gap): Promise<number> {
		const query = new URLSearchParams({
			from: gap.from,
			to: gap.to,
			dir: "f",
			limit: "100",
			filter: JSON.stringify({
				types: [
					"m.room.message",
					"m.room.redaction",
					"m.room.member",
					"m.room.encryption",
				],
				lazy_load_members: true,
			}),
		});
		const page = await (
			await this.request(this.roomPath(`messages?${query}`))
		).json<{ chunk: Event[]; state?: Event[]; end?: string }>();
		if (!this.hooks.online()) return 0;
		if (page.chunk.some((event) => event.type === "m.room.encryption")) {
			this.put("encrypted", true);
			throw new MatrixError(403);
		}
		if (page.end === gap.from && gap.from !== gap.to)
			throw new MatrixError(502);
		if (page.end && page.end !== gap.to) {
			return (
				1 +
				this.apply(page.chunk, page.state ?? [], () =>
					this.put("gap", { ...gap, from: page.end }),
				)
			);
		}
		const count = this.apply(page.chunk, page.state ?? [], () => undefined);
		return (
			count +
			this.apply(gap.timeline, gap.state, () => {
				this.put("since", gap.next);
				this.put("gap", null);
			})
		);
	}

	async drain() {
		if (!this.enabled || this.sending) return;
		this.sending = true;
		try {
			const jobs = this.sql
				.exec<Job>(
					"SELECT * FROM matrix_jobs WHERE scope = ? AND error = 0 AND due <= ? ORDER BY seq LIMIT 4",
					this.namespace,
					Date.now(),
				)
				.toArray();
			for (const job of jobs) {
				try {
					await this.sendJob(job);
				} catch (error) {
					const status = error instanceof MatrixError ? error.status : 0;
					const temporary = status === 0 || status === 429 || status >= 500;
					const delay = Math.max(
						error instanceof MatrixError ? error.retryMs : 0,
						Math.min(300_000, 3000 * 2 ** Math.min(job.attempts, 7)),
					);
					this.sql.exec(
						"UPDATE matrix_jobs SET attempts = attempts + 1, due = ?, error = ? WHERE id = ?",
						Date.now() + delay,
						temporary ? 0 : status,
						job.id,
					);
					console.warn(
						"[interconnect] outbox failed",
						status,
						error instanceof Error &&
							["image-origin", "image-body"].includes(error.message)
							? error.message
							: undefined,
					);
					if (status === 429) {
						this.sql.exec(
							"UPDATE matrix_jobs SET due = MAX(due, ?) WHERE scope = ? AND error = 0",
							Date.now() + delay,
							this.namespace,
						);
						break;
					}
				}
			}
		} finally {
			this.sending = false;
		}
	}

	private async sendJob(snapshot: Job) {
		const job = this.sql
			.exec<Job>("SELECT * FROM matrix_jobs WHERE id = ?", snapshot.id)
			.toArray()[0];
		if (!job) return;
		if (!job.event_id && this.get<boolean>("encrypted"))
			throw new MatrixError(403);
		if (!this.get<string>("since")) {
			this.sql.exec(
				"UPDATE matrix_jobs SET due = ? WHERE id = ?",
				Date.now() + 15_000,
				job.id,
			);
			return;
		}
		if (job.event_id) {
			await this.request(
				this.roomPath(
					`redact/${encodeURIComponent(job.event_id)}/${encodeURIComponent(job.id)}-delete`,
				),
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: "{}",
				},
			);
			this.storage.transactionSync(() => {
				this.sql.exec(
					"UPDATE matrix_events SET redacted = 1 WHERE scope = ? AND event = ?",
					this.namespace,
					job.event_id,
				);
				this.sql.exec("DELETE FROM matrix_jobs WHERE id = ?", job.id);
			});
			return;
		}
		const relay = { [RELAY_FIELD]: { userId: this.getJobRelayUserId(job) } };
		const reply = job.started
			? job.reply_event_id
			: this.findReplyEvent(job.reply_uid);
		if (
			!job.started &&
			!reply &&
			job.reply_uid &&
			this.sql
				.exec(
					"SELECT 1 FROM matrix_jobs WHERE scope = ? AND uid = ? AND error = 0 AND delete_requested = 0 LIMIT 1",
					this.namespace,
					job.reply_uid,
				)
				.toArray().length
		) {
			this.sql.exec(
				"UPDATE matrix_jobs SET due = ? WHERE id = ?",
				Date.now() + 3000,
				job.id,
			);
			return;
		}
		const relation = reply
			? { "m.relates_to": { "m.in_reply_to": { event_id: reply } } }
			: {};
		let body: object = {
			msgtype: "m.text",
			body: job.body,
			...relay,
			...relation,
		};
		if (job.image) {
			let uri = job.mxc;
			let info: { mimetype: string; size: number } | undefined;
			if (!uri) {
				const url = publicImageUrl(job.image);
				const trusted = (
					this.env.TRUSTED_IMAGE_ORIGINS || "https://img.lengxiqwq.com"
				)
					.split(",")
					.map((origin) => origin.trim().replace(/\/+$/, ""));
				const isSticker =
					job.part >= FIRST_STICKER_PART &&
					STICKER_PACKS.some((pack) => {
						const base = this.stickerBase(pack).href;
						return (
							url.startsWith(base) &&
							/^[^/?#]+\.(?:gif|png|jpe?g|webp|avif)$/i.test(
								url.slice(base.length),
							)
						);
					});
				if (
					!url ||
					(!isSticker &&
						!trusted.some((origin) => url.startsWith(`${origin}/`)))
				)
					throw new MatrixError(415);
				const response = await fetch(url, {
					redirect: "manual",
					signal: AbortSignal.timeout(8000),
				}).catch((error: unknown) => {
					throw new Error("image-origin", { cause: error });
				});
				if (!response.ok) throw new MatrixError(response.status);
				const { bytes, type } = await readImage(response).catch(
					(error: unknown) => {
						if (error instanceof MatrixError) throw error;
						throw new Error("image-body", { cause: error });
					},
				);
				if (
					!this.sql
						.exec("SELECT 1 FROM matrix_jobs WHERE id = ?", job.id)
						.toArray().length
				)
					return;
				const upload = await (
					await this.request("/_matrix/media/v3/upload", {
						method: "POST",
						headers: { "Content-Type": type },
						body: bytes,
					})
				).json<{ content_uri: string }>();
				if (!matrixMediaPath(upload.content_uri ?? ""))
					throw new MatrixError(502);
				uri = upload.content_uri;
				info = { mimetype: type, size: bytes.byteLength };
				this.sql.exec(
					"UPDATE matrix_jobs SET mxc = ? WHERE id = ?",
					uri,
					job.id,
				);
			}
			body = {
				msgtype: "m.image",
				body: job.body,
				filename: "图片",
				url: uri,
				info,
				...relay,
				...relation,
			};
		}
		const updated = this.sql
			.exec(
				"UPDATE matrix_jobs SET started = 1, reply_event_id = ? WHERE id = ? RETURNING id",
				reply,
				job.id,
			)
			.toArray();
		if (!updated.length) return;
		const result = await (
			await this.request(
				this.roomPath(`send/m.room.message/${encodeURIComponent(job.id)}`),
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
			)
		).json<{ event_id: string }>();
		if (typeof result.event_id !== "string" || !result.event_id)
			throw new MatrixError(502);
		const changed = this.storage.transactionSync(() => {
			const tombstone = this.sql
				.exec<{ redacted: number }>(
					"SELECT redacted FROM matrix_events WHERE scope = ? AND event = ?",
					this.namespace,
					result.event_id,
				)
				.toArray()[0];
			this.sql.exec(
				"INSERT OR REPLACE INTO matrix_events(scope,event,uid,part,image,redacted) VALUES (?,?,?,?,?,?)",
				this.namespace,
				result.event_id,
				job.uid,
				job.part,
				job.image,
				tombstone?.redacted ?? 0,
			);
			const current = this.sql
				.exec<Job>("SELECT * FROM matrix_jobs WHERE id = ?", job.id)
				.one();
			if (current.delete_requested && !tombstone?.redacted) {
				this.sql.exec(
					"UPDATE matrix_jobs SET event_id = ?, attempts = 0, due = ? WHERE id = ?",
					result.event_id,
					Date.now(),
					job.id,
				);
			} else {
				this.sql.exec("DELETE FROM matrix_jobs WHERE id = ?", job.id);
			}
			return tombstone?.redacted ? this.hooks.removePart(job) : undefined;
		});
		if (changed === "deleted") this.hooks.publish("deleted", job.uid);
		else if (changed) this.hooks.publish("updated", changed);
	}

	private findReplyEvent(uid: string): string {
		if (!uid) return "";
		return (
			this.sql
				.exec<{ event: string }>(
					"SELECT event FROM matrix_events WHERE scope = ? AND uid = ? AND redacted = 0 ORDER BY part LIMIT 1",
					this.namespace,
					uid,
				)
				.toArray()[0]?.event ?? ""
		);
	}
}
