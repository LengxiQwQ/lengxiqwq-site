import { DurableObject } from "cloudflare:workers";
import {
	computeGuestUserKey,
	isAdminEmail,
	isIsolatedGuestUserKey,
	isReservedGuestName,
	resolveRoleBadge,
	sanitizeAvatarUrl,
	sanitizeBio,
	sanitizeDisplayName,
	sanitizeStatus,
	sanitizeWebsiteUrl,
	shouldBlockGuestByWaline,
	type VerifiedUser,
	verifyGuestTokenWithEmail,
	verifyWalineTokenWithEmail,
} from "../auth/verify.js";
import type { Env } from "../env.js";
import {
	extractPrimaryArtist,
	isLikelyQQSongMid,
	MAX_PLAYLISTS_PER_USER,
	MAX_SHARED_PLAYLISTS_PER_USER,
	type PlaylistDetail,
	type PlaylistSummary,
	pickBestMatchedTrack,
	type SanitizedPlaylistPayload,
	type StoredPlaylistTrack,
	sanitizePlaylistPayload,
} from "../music/playlist-store.js";
import { createMusicRegistry } from "../music/registry.js";
import type { StandardTrack } from "../music/types.js";
import {
	FIRST_STICKER_PART,
	INTERCONNECT_ROOM,
	MatrixBridge,
	stickerTokenFromUrl,
} from "./matrix-bridge.js";
import {
	pickEarliestPositiveTimestamp,
	pickLatestPositiveTimestamp,
	remapPlaybackUserKeys,
	remapReplyRefJson,
	remapUserKeyList,
	resolveEffectiveMemberProfile,
	resolveMergedMemberMetadata,
} from "./member-merge.js";
import {
	buildRecallNoticeContent,
	canDirectSkipTrack,
	canRecallMessage,
	canSilentDeleteMessage,
	computeNextAlarmTimestamp,
	computeVoteThreshold,
	formatReplyPreview,
	getMentionCooldownMs,
	type MentionCandidateRecord,
	mergeNotificationTargets,
	resolveMentionTargets,
	SOLO_COOLDOWN_MS,
	shouldPlayEnqueuedImmediately,
} from "./rules.js";

export interface ImageAttachment {
	type: "image";
	url: string;
}

export interface ChatReplyRef {
	msgUid: string;
	userKey: string;
	name: string;
	content: string;
	hasImage?: boolean;
	isRecalled?: boolean;
}

export interface ChatMessageRecord {
	source?: "matrix";
	id: number;
	msgUid: string;
	kind: "user" | "system";
	userKey: string;
	name: string;
	avatar: string;
	url: string;
	badge: string;
	badgeType: "host" | "accent" | "tag";
	isAdmin: boolean;
	content: string;
	attachments: ImageAttachment[];
	mentions: string[];
	mentionKeys?: string[];
	replyTo?: ChatReplyRef | null;
	createdAt: number;
}

export interface AdminChatMessageRecord extends ChatMessageRecord {
	isRecalled: boolean;
	status: "normal" | "recalled" | "deleted";
	recallTag: string;
	recalledAt: number;
	recalledBy: string;
	recalledByName: string;
}

export interface QueueEntry {
	uid: string;
	track: StandardTrack;
	requesterKey: string;
	requesterName: string;
	createdAt: number;
}

export interface MusicHistoryEntry {
	track: StandardTrack;
	requestCount: number;
	lastRequesterName: string;
	firstRequestedAt: number;
	lastRequestedAt: number;
}

export interface MusicHistoryLogEntry {
	id: number;
	track: StandardTrack;
	requesterKey: string;
	requesterName: string;
	requesterAvatar: string;
	requestedAt: number;
	requestCount: number;
}

export interface CurrentPlayback {
	uid: string;
	track: StandardTrack & {
		streamUrl: string;
		lrcUrl: string;
		quality?: string;
	};
	requesterKey: string;
	requesterName: string;
	isFallback: boolean;
	startedAt: number;
	durationSec: number;
	skipVotes: string[];
	errorReports: string[];
}

export interface OnlineMember {
	userKey: string;
	authType: "waline" | "guest";
	name: string;
	avatar: string;
	url: string;
	badge: string;
	badgeType: "host" | "accent" | "tag";
	isAdmin: boolean;
	status: string;
	bio?: string;
	isMuted?: boolean;
}

export interface MentionDirectoryMember {
	userKey: string;
	authType: "waline" | "guest";
	name: string;
	avatar: string;
	url?: string;
	badge: string;
	badgeType: "host" | "accent" | "tag";
	isAdmin: boolean;
	online: boolean;
	status?: string;
	bio?: string;
	lastSeenAt: number;
}

type RoomMemberRow = {
	user_key: string;
	auth_type: string;
	name: string;
	email: string;
	avatar: string;
	url: string;
	badge: string;
	badge_type: string;
	is_admin: number;
	notify_email: number;
	allow_auto_merge?: number;
	bio?: string;
	status?: string;
	first_seen_at?: number;
	last_seen_at: number;
	last_notified_at: number;
	cooldown_until: number;
	last_read_at?: number;
};

type PendingMentionEmailRow = {
	id: number;
	target_user_key: string;
	msg_uid: string;
	sender_name: string;
	sender_badge: string;
	content: string;
	attachments_json: string;
	reply_to_json: string;
	created_at: number;
};

interface WsAttachment {
	connId: string;
	roomId: string;
	user: VerifiedUser | null;
	baseName?: string;
	baseAvatar?: string;
	baseUrl?: string;
	connectedAt: number;
	isMuted?: boolean;
}

const MAX_STORED_MESSAGES = 500;
const MAX_RECALLED_AUDIT_MESSAGES = 1500;
const INITIAL_HISTORY_LIMIT = 80;
const MAX_MUSIC_HISTORY = 200;
const MAX_MUSIC_REQUEST_LOGS = 5000;
const INITIAL_MUSIC_LOG_LIMIT = 150;
const MAX_QUEUE_LENGTH = 30;
const MAX_QUEUE_PER_USER = 3;
const MAX_TRACK_DURATION_GUEST = 900; // 15 minutes
const UNKNOWN_DURATION_FALLBACK_MS = 10 * 60 * 1000;
const MAX_MENTION_DIRECTORY = 500;

type MsgSqlRow = {
	source: string;
	id: number;
	msg_uid: string;
	kind: string;
	user_key: string;
	name: string;
	avatar: string;
	url: string;
	badge: string;
	badge_type: string;
	is_admin: number;
	content: string;
	attachments_json: string;
	mentions_json: string;
	mention_keys_json: string;
	reply_to_uid: string;
	reply_to_json: string;
	is_recalled: number;
	status: string;
	recalled_at: number;
	recalled_by: string;
	recalled_by_name: string;
	created_at: number;
};

const MESSAGE_SELECT_COLS =
	"id, msg_uid, kind, user_key, name, avatar, url, badge, badge_type, is_admin, content, attachments_json, mentions_json, mention_keys_json, reply_to_uid, reply_to_json, is_recalled, status, recalled_at, recalled_by, recalled_by_name, created_at, source";

export class RoomDO extends DurableObject<Env> {
	private readonly msgTimestamps = new Map<string, number[]>();
	private playbackChain: Promise<void> = Promise.resolve();
	private startupMergesRan = false;
	private cachedWorkerOrigin = "";
	private cachedRoomId = "";
	private matrix: MatrixBridge | undefined;

	private getMatrix(): MatrixBridge | undefined {
		if (this.getRoomId() !== INTERCONNECT_ROOM) return undefined;
		this.matrix ??= new MatrixBridge(this.ctx.storage, this.env, {
			append: (record) => this.appendMessage(record),
			resolveReply: (uid) => this.resolveReplyTarget(uid),
			removePart: (update) => this.removeMatrixPart(update),
			origin: () => this.getWorkerOrigin(),
			online: () => this.hasConnectedSockets(),
			publish: (kind, record) => {
				this.broadcast(
					typeof record === "string"
						? { type: "chat:deleted", roomId: INTERCONNECT_ROOM, msgUid: record }
						: { type: `chat:${kind}`, roomId: INTERCONNECT_ROOM, message: record },
				);
			},
		});
		return this.matrix;
	}

	private removeMatrixPart({
		uid,
		part,
		image,
	}: {
		uid: string;
		part: number;
		image: string;
	}): ChatMessageRecord | "deleted" | undefined {
		const sql = this.ctx.storage.sql;
		const row = sql.exec<MsgSqlRow>(
			`SELECT ${MESSAGE_SELECT_COLS} FROM messages WHERE msg_uid = ? AND is_recalled = 0`, uid,
		).toArray()[0];
		if (!row) return;
		const message = this.mapMessageRow(row);
		if (part === 0) {
			message.content = sql.exec<{ image: string }>(
				`SELECT image FROM (
					SELECT part, image FROM matrix_events WHERE uid = ?1 AND part >= ?2 AND redacted = 0
					UNION
					SELECT part, image FROM matrix_jobs WHERE uid = ?1 AND part >= ?2 AND error = 0 AND delete_requested = 0
				) ORDER BY part`,
				uid, FIRST_STICKER_PART,
			).toArray().map(({ image }) => stickerTokenFromUrl(image)).join(" ");
		}
		if (part < 0) message.content = "";
		if (part < 0) message.attachments = [];
		if (part >= FIRST_STICKER_PART) {
			message.content = message.content
				.replace(stickerTokenFromUrl(image), "")
				.trim();
		} else if (part > 0) {
			const index = message.attachments.findIndex((item) => item.url === image);
			if (index >= 0) message.attachments.splice(index, 1);
		}
		const deleted = !message.content.trim() && !message.attachments.length;
		sql.exec(
			"UPDATE messages SET content = ?, attachments_json = ?, is_recalled = ?, status = ?, recalled_at = ? WHERE msg_uid = ?",
			message.content, JSON.stringify(message.attachments), deleted ? 1 : 0,
			deleted ? "deleted" : "normal", deleted ? Date.now() : 0, uid,
		);
		for (const reply of sql.exec<{ msg_uid: string; reply_to_json: string }>(
			"SELECT msg_uid,reply_to_json FROM messages WHERE reply_to_uid = ?", uid,
		).toArray()) {
			const ref = parseReplyRef(reply.reply_to_json);
			if (!ref) continue;
			ref.content = formatReplyPreview(message.content);
			ref.hasImage = message.attachments.length > 0;
			ref.isRecalled = deleted;
			sql.exec("UPDATE messages SET reply_to_json = ? WHERE msg_uid = ?", JSON.stringify(ref), reply.msg_uid);
		}
		return deleted ? "deleted" : message;
	}

	private hasConnectedSockets(excludeWs?: WebSocket): boolean {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) return true;
		}
		return false;
	}

	private withPlaybackLock<T>(task: () => Promise<T>): Promise<T> {
		const run = this.playbackChain.then(task, task);
		this.playbackChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			this.initSchema();
		});
	}

	private initSchema(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS messages (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				msg_uid TEXT UNIQUE NOT NULL,
				kind TEXT NOT NULL,
				user_key TEXT NOT NULL DEFAULT '',
				name TEXT NOT NULL DEFAULT '',
				avatar TEXT NOT NULL DEFAULT '',
				url TEXT NOT NULL DEFAULT '',
				badge TEXT NOT NULL DEFAULT '',
				badge_type TEXT NOT NULL DEFAULT 'tag',
				is_admin INTEGER NOT NULL DEFAULT 0,
				content TEXT NOT NULL DEFAULT '',
				attachments_json TEXT NOT NULL DEFAULT '[]',
				mentions_json TEXT NOT NULL DEFAULT '[]',
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_messages_id_desc ON messages (id DESC);

			CREATE TABLE IF NOT EXISTS music_queue (
				uid TEXT PRIMARY KEY,
				track_json TEXT NOT NULL,
				requester_key TEXT NOT NULL,
				requester_name TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);

			CREATE TABLE IF NOT EXISTS music_history (
				track_id TEXT PRIMARY KEY,
				track_json TEXT NOT NULL,
				request_count INTEGER NOT NULL DEFAULT 1,
				last_requester_key TEXT NOT NULL DEFAULT '',
				last_requester_name TEXT NOT NULL DEFAULT '',
				first_requested_at INTEGER NOT NULL,
				last_requested_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_music_history_recent ON music_history (last_requested_at DESC, request_count DESC);
			CREATE INDEX IF NOT EXISTS idx_music_history_top ON music_history (request_count DESC, last_requested_at DESC);

			CREATE TABLE IF NOT EXISTS music_request_logs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				track_id TEXT NOT NULL,
				track_json TEXT NOT NULL,
				requester_key TEXT NOT NULL DEFAULT '',
				requester_name TEXT NOT NULL DEFAULT '',
				requester_avatar TEXT NOT NULL DEFAULT '',
				requested_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_music_request_logs_id_desc ON music_request_logs (id DESC);
			CREATE INDEX IF NOT EXISTS idx_music_request_logs_requester ON music_request_logs (requester_key, id DESC);

			CREATE TABLE IF NOT EXISTS room_state (
				key TEXT PRIMARY KEY,
				value_json TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS room_members (
				user_key TEXT PRIMARY KEY,
				auth_type TEXT NOT NULL DEFAULT 'guest',
				name TEXT NOT NULL DEFAULT '',
				email TEXT NOT NULL DEFAULT '',
				avatar TEXT NOT NULL DEFAULT '',
				url TEXT NOT NULL DEFAULT '',
				badge TEXT NOT NULL DEFAULT '',
				badge_type TEXT NOT NULL DEFAULT 'tag',
				is_admin INTEGER NOT NULL DEFAULT 0,
				notify_email INTEGER NOT NULL DEFAULT 1,
				last_seen_at INTEGER NOT NULL DEFAULT 0,
				last_notified_at INTEGER NOT NULL DEFAULT 0,
				cooldown_until INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS idx_room_members_seen ON room_members (last_seen_at DESC);

			CREATE TABLE IF NOT EXISTS pending_mention_emails (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				target_user_key TEXT NOT NULL,
				msg_uid TEXT NOT NULL,
				sender_name TEXT NOT NULL,
				sender_badge TEXT NOT NULL DEFAULT '',
				content TEXT NOT NULL DEFAULT '',
				attachments_json TEXT NOT NULL DEFAULT '[]',
				reply_to_json TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_pending_mention_target ON pending_mention_emails (target_user_key, id ASC);
		`);

		try {
			this.ctx.storage.sql.exec(
				"ALTER TABLE pending_mention_emails ADD COLUMN reply_to_json TEXT NOT NULL DEFAULT ''",
			);
		} catch {
			// Column already exists
		}

		try {
			this.ctx.storage.sql.exec(
				"ALTER TABLE messages ADD COLUMN mention_keys_json TEXT NOT NULL DEFAULT '[]'",
			);
		} catch {
			// Column already exists
		}

		for (const ddl of [
			"ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT ''",
			"ALTER TABLE messages ADD COLUMN is_recalled INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'normal'",
			"ALTER TABLE messages ADD COLUMN recalled_at INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE messages ADD COLUMN recalled_by TEXT NOT NULL DEFAULT ''",
			"ALTER TABLE messages ADD COLUMN recalled_by_name TEXT NOT NULL DEFAULT ''",
			"ALTER TABLE messages ADD COLUMN reply_to_uid TEXT NOT NULL DEFAULT ''",
			"ALTER TABLE messages ADD COLUMN reply_to_json TEXT NOT NULL DEFAULT ''",
		]) {
			try {
				this.ctx.storage.sql.exec(ddl);
			} catch {
				// Column already exists
			}
		}

		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS idx_messages_recalled_id ON messages (is_recalled, id DESC)",
		);

		for (const ddl of [
			"ALTER TABLE room_members ADD COLUMN last_read_at INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE room_members ADD COLUMN bio TEXT NOT NULL DEFAULT ''",
			"ALTER TABLE room_members ADD COLUMN status TEXT NOT NULL DEFAULT '在线'",
			"ALTER TABLE room_members ADD COLUMN first_seen_at INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE room_members ADD COLUMN custom_name TEXT NOT NULL DEFAULT ''",
			"ALTER TABLE room_members ADD COLUMN custom_avatar TEXT NOT NULL DEFAULT ''",
			"ALTER TABLE room_members ADD COLUMN custom_url TEXT NOT NULL DEFAULT ''",
			"ALTER TABLE room_members ADD COLUMN has_custom_url INTEGER NOT NULL DEFAULT 0",
			"ALTER TABLE room_members ADD COLUMN allow_auto_merge INTEGER NOT NULL DEFAULT 1",
		]) {
			try {
				this.ctx.storage.sql.exec(ddl);
			} catch {
				// Column already exists
			}
		}

		this.ctx.storage.sql.exec(
			"UPDATE room_members SET first_seen_at = last_seen_at WHERE first_seen_at = 0 AND last_seen_at > 0",
		);
		this.ctx.storage.sql.exec(
			"CREATE INDEX IF NOT EXISTS idx_room_members_email ON room_members (email)",
		);

		// Backfill older 1-time / pre-migration songs from music_history into music_request_logs
		this.ctx.storage.sql.exec(`
			INSERT INTO music_request_logs (
				track_id, track_json, requester_key, requester_name, requester_avatar, requested_at
			)
			SELECT
				h.track_id,
				h.track_json,
				h.last_requester_key,
				h.last_requester_name,
				'',
				h.last_requested_at
			FROM music_history h
			WHERE NOT EXISTS (
				SELECT 1 FROM music_request_logs l WHERE l.track_id = h.track_id
			);
		`);

		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS user_playlists (
				id TEXT PRIMARY KEY,
				owner_key TEXT NOT NULL,
				owner_name TEXT NOT NULL DEFAULT '',
				title TEXT NOT NULL,
				platform TEXT NOT NULL,
				source_url TEXT NOT NULL,
				cover_url TEXT NOT NULL DEFAULT '',
				creator TEXT NOT NULL DEFAULT '',
				track_count INTEGER NOT NULL DEFAULT 0,
				retrieval_mode TEXT NOT NULL DEFAULT 'full',
				is_public INTEGER NOT NULL DEFAULT 0,
				is_featured INTEGER NOT NULL DEFAULT 0,
				is_fallback INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_user_playlists_owner ON user_playlists (owner_key, updated_at DESC);
			CREATE INDEX IF NOT EXISTS idx_user_playlists_featured ON user_playlists (is_featured, updated_at DESC);
		`);

		try {
			this.ctx.storage.sql.exec(
				"ALTER TABLE user_playlists ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0",
			);
		} catch {
			// Column already exists
		}

		this.ctx.storage.sql.exec(`
			CREATE INDEX IF NOT EXISTS idx_user_playlists_public ON user_playlists (is_public, updated_at DESC);

			CREATE TABLE IF NOT EXISTS user_playlist_tracks (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				playlist_id TEXT NOT NULL,
				position INTEGER NOT NULL,
				source_platform TEXT NOT NULL,
				source_track_id TEXT NOT NULL DEFAULT '',
				title TEXT NOT NULL,
				artist TEXT NOT NULL,
				album TEXT NOT NULL DEFAULT '',
				cover TEXT NOT NULL DEFAULT '',
				duration_sec INTEGER NOT NULL DEFAULT 0,
				source_url TEXT NOT NULL DEFAULT '',
				matched_track_json TEXT NOT NULL DEFAULT ''
			);
			CREATE INDEX IF NOT EXISTS idx_user_playlist_tracks_pid ON user_playlist_tracks (playlist_id, position ASC);
		`);
	}

	private runStartupMergesIfNeeded(): void {
		if (this.startupMergesRan) return;
		this.startupMergesRan = true;
		try {
			this.reconcileLegacyGuestMerges();
		} catch (err) {
			console.error("[startup merge error]", err);
		}
	}

	private getStateValue<T>(key: string): T | null {
		const rows = this.ctx.storage.sql
			.exec<{ value_json: string }>(
				"SELECT value_json FROM room_state WHERE key = ?",
				key,
			)
			.toArray();
		if (rows.length === 0) return null;
		try {
			return JSON.parse(rows[0].value_json) as T;
		} catch {
			return null;
		}
	}

	private setStateValue(key: string, value: unknown): void {
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO room_state (key, value_json) VALUES (?, ?)",
			key,
			JSON.stringify(value),
		);
	}

	private getWorkerOrigin(): string {
		return (
			this.getStateValue<string>("worker_origin") ||
			"https://chat-api.lengxiqwq.com"
		);
	}

	private getRoomId(): string {
		this.cachedRoomId ||= this.getStateValue<string>("room_id") || "chat";
		return this.cachedRoomId;
	}

	private getFallbackTracks(): StandardTrack[] {
		const saved = this.getStateValue<StandardTrack[]>("fallback_tracks");
		if (Array.isArray(saved) && saved.length > 0) {
			return saved;
		}
		return [];
	}

	private hasFallbackPlaylistTracks(): boolean {
		const row = this.ctx.storage.sql
			.exec<{ cnt: number }>(
				`SELECT COUNT(*) AS cnt
				 FROM user_playlists p
				 JOIN user_playlist_tracks t ON t.playlist_id = p.id
				 WHERE p.is_fallback = 1`,
			)
			.toArray()[0];
		return (row?.cnt ?? 0) > 0;
	}

	private hasAnyFallbackSource(): boolean {
		return (
			this.hasFallbackPlaylistTracks() || this.getFallbackTracks().length > 0
		);
	}

	private mapPlaylistSummaryRow(row: {
		id: string;
		owner_key: string;
		owner_name: string;
		owner_avatar: string;
		title: string;
		platform: string;
		source_url: string;
		cover_url: string;
		creator: string;
		track_count: number;
		retrieval_mode: string;
		is_public: number;
		is_featured: number;
		is_fallback: number;
		created_at: number;
		updated_at: number;
	}): PlaylistSummary {
		return {
			id: row.id,
			ownerKey: row.owner_key,
			ownerName: row.owner_name,
			ownerAvatar: row.owner_avatar || "",
			title: row.title,
			platform: row.platform,
			sourceUrl: row.source_url,
			coverUrl: row.cover_url,
			creator: row.creator,
			trackCount: row.track_count,
			retrievalMode: row.retrieval_mode === "preview" ? "preview" : "full",
			isPublic: row.is_public === 1,
			isFeatured: row.is_featured === 1,
			isFallback: row.is_fallback === 1,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	private queryPlaylistSummaries(
		whereAndOrderSql: string,
		...bindings: unknown[]
	): PlaylistSummary[] {
		const rows = this.ctx.storage.sql
			.exec<{
				id: string;
				owner_key: string;
				owner_name: string;
				owner_avatar: string;
				title: string;
				platform: string;
				source_url: string;
				cover_url: string;
				creator: string;
				track_count: number;
				retrieval_mode: string;
				is_public: number;
				is_featured: number;
				is_fallback: number;
				created_at: number;
				updated_at: number;
			}>(
				`SELECT p.id, p.owner_key,
				        COALESCE(NULLIF(m.name, ''), p.owner_name) AS owner_name,
				        COALESCE(m.avatar, '') AS owner_avatar,
				        p.title, p.platform, p.source_url, p.cover_url, p.creator,
				        p.track_count, p.retrieval_mode, p.is_public, p.is_featured, p.is_fallback,
				        p.created_at, p.updated_at
				 FROM user_playlists p
				 LEFT JOIN room_members m ON m.user_key = p.owner_key
				 ${whereAndOrderSql}`,
				...bindings,
			)
			.toArray();
		return rows.map((r) => this.mapPlaylistSummaryRow(r));
	}

	private mapPlaylistTrackRow(row: {
		position: number;
		source_platform: string;
		source_track_id: string;
		title: string;
		artist: string;
		album: string;
		cover: string;
		duration_sec: number;
		source_url: string;
		matched_track_json: string;
	}): StoredPlaylistTrack {
		let matchedTrack: StandardTrack | null = null;
		if (row.matched_track_json) {
			try {
				matchedTrack = JSON.parse(row.matched_track_json) as StandardTrack;
			} catch {
				matchedTrack = null;
			}
		}
		return {
			position: row.position,
			sourcePlatform: row.source_platform,
			sourceTrackId: row.source_track_id,
			title: row.title,
			artist: row.artist,
			album: row.album,
			cover: row.cover,
			durationSec: row.duration_sec,
			sourceUrl: row.source_url,
			matchedTrack,
		};
	}

	private listPlaylistsForUser(
		user: VerifiedUser | null,
		includeTracks = false,
	): {
		featured: PlaylistSummary[];
		mine: PlaylistSummary[];
		shared: PlaylistSummary[];
		details?: Record<string, PlaylistDetail>;
	} {
		const featured = this.queryPlaylistSummaries(
			"WHERE p.is_featured = 1 ORDER BY p.is_fallback DESC, p.updated_at DESC",
		);
		const shared = this.queryPlaylistSummaries(
			"WHERE p.is_public = 1 ORDER BY p.updated_at DESC",
		);
		if (user?.authType !== "waline") {
			return { featured, mine: [], shared };
		}

		const mine = this.queryPlaylistSummaries(
			"WHERE p.owner_key = ? ORDER BY p.updated_at DESC",
			user.userKey,
		);

		if (!includeTracks) {
			return {
				featured,
				mine,
				shared,
			};
		}

		const MAX_BUNDLED_TRACKS = 1500;
		const summaryById = new Map<string, PlaylistSummary>();
		for (const item of [...featured, ...mine, ...shared]) {
			if (!summaryById.has(item.id)) {
				summaryById.set(item.id, item);
			}
		}

		const selectedIds: string[] = [];
		let totalTracks = 0;
		for (const item of summaryById.values()) {
			if (totalTracks + item.trackCount > MAX_BUNDLED_TRACKS) continue;
			selectedIds.push(item.id);
			totalTracks += item.trackCount;
		}

		const details: Record<string, PlaylistDetail> = {};
		if (selectedIds.length > 0) {
			const placeholders = selectedIds.map(() => "?").join(", ");
			const trackRows = this.ctx.storage.sql
				.exec<{
					playlist_id: string;
					position: number;
					source_platform: string;
					source_track_id: string;
					title: string;
					artist: string;
					album: string;
					cover: string;
					duration_sec: number;
					source_url: string;
					matched_track_json: string;
				}>(
					`SELECT playlist_id, position, source_platform, source_track_id, title, artist, album, cover, duration_sec, source_url, matched_track_json
					 FROM user_playlist_tracks
					 WHERE playlist_id IN (${placeholders})
					 ORDER BY playlist_id ASC, position ASC`,
					...selectedIds,
				)
				.toArray();

			const tracksByPlaylist = new Map<string, StoredPlaylistTrack[]>();
			for (const row of trackRows) {
				let list = tracksByPlaylist.get(row.playlist_id);
				if (!list) {
					list = [];
					tracksByPlaylist.set(row.playlist_id, list);
				}
				list.push(this.mapPlaylistTrackRow(row));
			}

			for (const pid of selectedIds) {
				const summary = summaryById.get(pid);
				if (!summary) continue;
				details[pid] = {
					...summary,
					tracks: tracksByPlaylist.get(pid) || [],
				};
			}
		}

		return {
			featured,
			mine,
			shared,
			details,
		};
	}

	private getPlaylistDetailForUser(
		playlistId: string,
		user: VerifiedUser | null,
	):
		| { ok: true; playlist: PlaylistDetail }
		| { ok: false; status: number; error: string } {
		const summary = this.queryPlaylistSummaries(
			"WHERE p.id = ? LIMIT 1",
			playlistId,
		)[0];

		if (!summary) {
			return { ok: false, status: 404, error: "歌单不存在或已被删除" };
		}

		const isOwner = Boolean(
			user && user.authType === "waline" && summary.ownerKey === user.userKey,
		);
		const isAdmin = Boolean(user?.isAdmin);
		if (!summary.isFeatured && !summary.isPublic && !isOwner && !isAdmin) {
			return { ok: false, status: 403, error: "无权查看该私人歌单" };
		}

		const trackRows = this.ctx.storage.sql
			.exec<{
				position: number;
				source_platform: string;
				source_track_id: string;
				title: string;
				artist: string;
				album: string;
				cover: string;
				duration_sec: number;
				source_url: string;
				matched_track_json: string;
			}>(
				`SELECT position, source_platform, source_track_id, title, artist, album, cover, duration_sec, source_url, matched_track_json
				 FROM user_playlist_tracks
				 WHERE playlist_id = ?
				 ORDER BY position ASC`,
				playlistId,
			)
			.toArray();

		return {
			ok: true,
			playlist: {
				...summary,
				tracks: trackRows.map((t) => this.mapPlaylistTrackRow(t)),
			},
		};
	}

	private replacePlaylistTracks(
		playlistId: string,
		tracks: StoredPlaylistTrack[],
	): void {
		this.ctx.storage.transactionSync(() => {
			const existingMatched = new Map<string, string>();
			const prevRows = this.ctx.storage.sql
				.exec<{
					source_platform: string;
					source_track_id: string;
					title: string;
					artist: string;
					matched_track_json: string;
				}>(
					"SELECT source_platform, source_track_id, title, artist, matched_track_json FROM user_playlist_tracks WHERE playlist_id = ? AND matched_track_json != ''",
					playlistId,
				)
				.toArray();
			for (const prev of prevRows) {
				const sig = `${prev.source_platform}|${prev.source_track_id}|${prev.title}|${prev.artist}`;
				existingMatched.set(sig, prev.matched_track_json);
			}

			this.ctx.storage.sql.exec(
				"DELETE FROM user_playlist_tracks WHERE playlist_id = ?",
				playlistId,
			);

			for (const track of tracks) {
				const sig = `${track.sourcePlatform}|${track.sourceTrackId}|${track.title}|${track.artist}`;
				const matchedJson = track.matchedTrack
					? JSON.stringify(track.matchedTrack)
					: existingMatched.get(sig) || "";
				this.ctx.storage.sql.exec(
					`INSERT INTO user_playlist_tracks (
						playlist_id, position, source_platform, source_track_id, title, artist, album, cover, duration_sec, source_url, matched_track_json
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					playlistId,
					track.position,
					track.sourcePlatform,
					track.sourceTrackId,
					track.title,
					track.artist,
					track.album,
					track.cover,
					track.durationSec,
					track.sourceUrl,
					matchedJson,
				);
			}
		});
	}

	private importPlaylistForUser(
		user: VerifiedUser,
		payload: SanitizedPlaylistPayload,
	):
		| { ok: true; playlist: PlaylistSummary; updatedExisting: boolean }
		| { ok: false; status: number; error: string } {
		if (user.authType !== "waline") {
			return { ok: false, status: 401, error: "请先登录账号后再导入歌单" };
		}

		const now = Date.now();
		const existing = this.ctx.storage.sql
			.exec<{
				id: string;
				is_public: number;
				is_featured: number;
			}>(
				"SELECT id, is_public, is_featured FROM user_playlists WHERE owner_key = ? AND source_url = ? LIMIT 1",
				user.userKey,
				payload.sourceUrl,
			)
			.toArray()[0];

		if (existing) {
			this.ctx.storage.sql.exec(
				`UPDATE user_playlists
				 SET owner_name = ?, title = ?, platform = ?, cover_url = ?, creator = ?,
				     track_count = ?, retrieval_mode = ?, updated_at = ?
				 WHERE id = ?`,
				user.name,
				payload.title,
				payload.platform,
				payload.coverUrl,
				payload.creator,
				payload.tracks.length,
				payload.retrievalMode,
				now,
				existing.id,
			);
			this.replacePlaylistTracks(existing.id, payload.tracks);
			const updated = this.queryPlaylistSummaries(
				"WHERE p.id = ? LIMIT 1",
				existing.id,
			)[0];
			if (existing.is_featured === 1 || existing.is_public === 1) {
				this.broadcast({
					type: "playlist:updated",
					roomId: this.getRoomId(),
				});
			}
			return {
				ok: true,
				playlist: updated,
				updatedExisting: true,
			};
		}

		const countRow = this.ctx.storage.sql
			.exec<{ cnt: number }>(
				"SELECT COUNT(*) AS cnt FROM user_playlists WHERE owner_key = ?",
				user.userKey,
			)
			.toArray()[0];
		const limit = user.isAdmin ? 30 : MAX_PLAYLISTS_PER_USER;
		if ((countRow?.cnt ?? 0) >= limit) {
			return {
				ok: false,
				status: 400,
				error: `每个账号最多保存 ${limit} 张歌单，请先删除不常用的歌单`,
			};
		}

		const id = crypto.randomUUID();
		this.ctx.storage.sql.exec(
			`INSERT INTO user_playlists (
				id, owner_key, owner_name, title, platform, source_url, cover_url, creator,
				track_count, retrieval_mode, is_public, is_featured, is_fallback, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
			id,
			user.userKey,
			user.name,
			payload.title,
			payload.platform,
			payload.sourceUrl,
			payload.coverUrl,
			payload.creator,
			payload.tracks.length,
			payload.retrievalMode,
			now,
			now,
		);
		this.replacePlaylistTracks(id, payload.tracks);

		const created = this.queryPlaylistSummaries(
			"WHERE p.id = ? LIMIT 1",
			id,
		)[0];

		return {
			ok: true,
			playlist: created,
			updatedExisting: false,
		};
	}

	private refreshPlaylistForUser(
		user: VerifiedUser,
		playlistId: string,
		payload: SanitizedPlaylistPayload,
	):
		| { ok: true; playlist: PlaylistSummary }
		| { ok: false; status: number; error: string } {
		const row = this.ctx.storage.sql
			.exec<{
				id: string;
				owner_key: string;
				is_public: number;
				is_featured: number;
			}>(
				"SELECT id, owner_key, is_public, is_featured FROM user_playlists WHERE id = ?",
				playlistId,
			)
			.toArray()[0];
		if (!row) {
			return { ok: false, status: 404, error: "歌单不存在或已被删除" };
		}
		if (!user.isAdmin && row.owner_key !== user.userKey) {
			return {
				ok: false,
				status: 403,
				error: "仅歌单创建者或站长可刷新该歌单",
			};
		}

		const now = Date.now();
		this.ctx.storage.sql.exec(
			`UPDATE user_playlists
			 SET title = ?, platform = ?, source_url = ?, cover_url = ?, creator = ?,
			     track_count = ?, retrieval_mode = ?, updated_at = ?
			 WHERE id = ?`,
			payload.title,
			payload.platform,
			payload.sourceUrl,
			payload.coverUrl,
			payload.creator,
			payload.tracks.length,
			payload.retrievalMode,
			now,
			playlistId,
		);
		this.replacePlaylistTracks(playlistId, payload.tracks);

		const updated = this.queryPlaylistSummaries(
			"WHERE p.id = ? LIMIT 1",
			playlistId,
		)[0];

		if (row.is_featured === 1 || row.is_public === 1) {
			this.broadcast({
				type: "playlist:updated",
				roomId: this.getRoomId(),
			});
		}

		return {
			ok: true,
			playlist: updated,
		};
	}

	private updatePlaylistFlagsForUser(
		user: VerifiedUser,
		playlistId: string,
		flags: { isPublic?: boolean; isFeatured?: boolean; isFallback?: boolean },
	):
		| { ok: true; playlist: PlaylistSummary }
		| { ok: false; status: number; error: string } {
		const row = this.ctx.storage.sql
			.exec<{
				id: string;
				owner_key: string;
				is_public: number;
				is_featured: number;
				is_fallback: number;
			}>(
				"SELECT id, owner_key, is_public, is_featured, is_fallback FROM user_playlists WHERE id = ?",
				playlistId,
			)
			.toArray()[0];
		if (!row) {
			return { ok: false, status: 404, error: "歌单不存在" };
		}

		const wantsAdminFlag =
			typeof flags.isFeatured === "boolean" ||
			typeof flags.isFallback === "boolean";
		if (wantsAdminFlag && !user.isAdmin) {
			return {
				ok: false,
				status: 403,
				error: "仅站长可设置房间精选或轮播歌单",
			};
		}

		const isOwner =
			user.authType === "waline" && row.owner_key === user.userKey;
		if (typeof flags.isPublic === "boolean" && !user.isAdmin && !isOwner) {
			return {
				ok: false,
				status: 403,
				error: "仅歌单创建者或站长可调整共享状态",
			};
		}

		const nextPublic =
			typeof flags.isPublic === "boolean"
				? flags.isPublic
				: row.is_public === 1;

		if (nextPublic && row.is_public !== 1 && !user.isAdmin) {
			const sharedCountRow = this.ctx.storage.sql
				.exec<{ cnt: number }>(
					"SELECT COUNT(*) AS cnt FROM user_playlists WHERE owner_key = ? AND is_public = 1",
					row.owner_key,
				)
				.toArray()[0];
			if ((sharedCountRow?.cnt ?? 0) >= MAX_SHARED_PLAYLISTS_PER_USER) {
				return {
					ok: false,
					status: 400,
					error: `每位成员最多共享 ${MAX_SHARED_PLAYLISTS_PER_USER} 张歌单，请先取消其他共享歌单`,
				};
			}
		}

		let nextFeatured =
			typeof flags.isFeatured === "boolean"
				? flags.isFeatured
				: row.is_featured === 1;
		const nextFallback =
			typeof flags.isFallback === "boolean"
				? flags.isFallback
				: row.is_fallback === 1;

		if (nextFallback) {
			nextFeatured = true;
			this.ctx.storage.sql.exec(
				"UPDATE user_playlists SET is_fallback = 0 WHERE id != ?",
				playlistId,
			);
		}

		this.ctx.storage.sql.exec(
			"UPDATE user_playlists SET is_public = ?, is_featured = ?, is_fallback = ?, updated_at = ? WHERE id = ?",
			nextPublic ? 1 : 0,
			nextFeatured ? 1 : 0,
			nextFallback ? 1 : 0,
			Date.now(),
			playlistId,
		);

		const updated = this.queryPlaylistSummaries(
			"WHERE p.id = ? LIMIT 1",
			playlistId,
		)[0];

		this.broadcast({
			type: "playlist:updated",
			roomId: this.getRoomId(),
		});

		return {
			ok: true,
			playlist: updated,
		};
	}

	private deletePlaylistForUser(
		user: VerifiedUser,
		playlistId: string,
	): { ok: true } | { ok: false; status: number; error: string } {
		const row = this.ctx.storage.sql
			.exec<{
				id: string;
				owner_key: string;
				is_public: number;
				is_featured: number;
			}>(
				"SELECT id, owner_key, is_public, is_featured FROM user_playlists WHERE id = ?",
				playlistId,
			)
			.toArray()[0];
		if (!row) {
			return { ok: false, status: 404, error: "歌单不存在或已被删除" };
		}
		if (!user.isAdmin && row.owner_key !== user.userKey) {
			return { ok: false, status: 403, error: "无权删除该歌单" };
		}

		this.ctx.storage.sql.exec(
			"DELETE FROM user_playlist_tracks WHERE playlist_id = ?",
			playlistId,
		);
		this.ctx.storage.sql.exec(
			"DELETE FROM user_playlists WHERE id = ?",
			playlistId,
		);

		if (row.is_featured === 1 || row.is_public === 1) {
			this.broadcast({
				type: "playlist:updated",
				roomId: this.getRoomId(),
			});
		}

		return { ok: true };
	}

	private async resolveExternalTrackToStandardTrack(
		target: {
			sourcePlatform: string;
			sourceTrackId: string;
			title: string;
			artist: string;
			album?: string;
			cover?: string;
			durationSec?: number;
		},
		cacheRef?: { playlistId: string; position: number },
	): Promise<StandardTrack | null> {
		if (cacheRef) {
			const cachedRow = this.ctx.storage.sql
				.exec<{ matched_track_json: string }>(
					"SELECT matched_track_json FROM user_playlist_tracks WHERE playlist_id = ? AND position = ? LIMIT 1",
					cacheRef.playlistId,
					cacheRef.position,
				)
				.toArray()[0];
			if (cachedRow?.matched_track_json) {
				try {
					const parsed = JSON.parse(
						cachedRow.matched_track_json,
					) as StandardTrack;
					if (parsed?.id && parsed?.provider && parsed?.sourceId) {
						return parsed;
					}
				} catch {
					// Ignore corrupted cache
				}
			}
		}

		if (
			target.sourcePlatform === "qqmusic" &&
			isLikelyQQSongMid(target.sourceTrackId)
		) {
			const direct: StandardTrack = {
				id: `qq:${target.sourceTrackId}`,
				provider: "qq",
				sourceId: target.sourceTrackId,
				title: target.title,
				artist: target.artist || "未知歌手",
				album: target.album || undefined,
				cover: target.cover || "",
				durationSec: target.durationSec ?? 0,
			};
			if (cacheRef) {
				this.ctx.storage.sql.exec(
					"UPDATE user_playlist_tracks SET matched_track_json = ? WHERE playlist_id = ? AND position = ?",
					JSON.stringify(direct),
					cacheRef.playlistId,
					cacheRef.position,
				);
			}
			return direct;
		}

		const registry = createMusicRegistry(this.env);
		const primaryArtist = extractPrimaryArtist(target.artist);
		const primaryQuery = primaryArtist
			? `${target.title} ${primaryArtist}`
			: target.title;

		let candidates = await registry.search(primaryQuery, 6);
		let matched = pickBestMatchedTrack(candidates, {
			title: target.title,
			artist: target.artist,
			durationSec: target.durationSec,
		});

		if (!matched && primaryArtist) {
			candidates = await registry.search(target.title, 6);
			matched = pickBestMatchedTrack(candidates, {
				title: target.title,
				artist: target.artist,
				durationSec: target.durationSec,
			});
		}

		if (!matched) return null;

		const enriched: StandardTrack = {
			...matched,
			cover: matched.cover || target.cover || "",
			durationSec:
				matched.durationSec > 0
					? matched.durationSec
					: (target.durationSec ?? 0),
		};

		if (cacheRef) {
			this.ctx.storage.sql.exec(
				"UPDATE user_playlist_tracks SET matched_track_json = ? WHERE playlist_id = ? AND position = ?",
				JSON.stringify(enriched),
				cacheRef.playlistId,
				cacheRef.position,
			);
		}

		return enriched;
	}

	private async pickNextFallbackPlaylistTrack(): Promise<StandardTrack | null> {
		const playlistRow = this.ctx.storage.sql
			.exec<{ id: string }>(
				"SELECT id FROM user_playlists WHERE is_fallback = 1 ORDER BY updated_at DESC LIMIT 1",
			)
			.toArray()[0];
		if (!playlistRow) return null;

		const rows = this.ctx.storage.sql
			.exec<{
				position: number;
				source_platform: string;
				source_track_id: string;
				title: string;
				artist: string;
				album: string;
				cover: string;
				duration_sec: number;
				matched_track_json: string;
			}>(
				`SELECT position, source_platform, source_track_id, title, artist, album, cover, duration_sec, matched_track_json
				 FROM user_playlist_tracks
				 WHERE playlist_id = ?
				 ORDER BY position ASC`,
				playlistRow.id,
			)
			.toArray();
		if (rows.length === 0) return null;

		const cursor = this.getStateValue<{ playlistId: string; position: number }>(
			"fallback_playlist_cursor",
		);
		let startIdx = 0;
		if (cursor && cursor.playlistId === playlistRow.id) {
			const prevIdx = rows.findIndex((r) => r.position === cursor.position);
			if (prevIdx >= 0) {
				startIdx = (prevIdx + 1) % rows.length;
			}
		}

		const registry = createMusicRegistry(this.env);
		const signSecret = this.env.STREAM_SIGN_SECRET || "dev-stream-secret";
		const origin = this.getWorkerOrigin();
		const maxAttempts = Math.min(rows.length, 6);

		for (let i = 0; i < maxAttempts; i += 1) {
			const row = rows[(startIdx + i) % rows.length];
			const resolved = await this.resolveExternalTrackToStandardTrack(
				{
					sourcePlatform: row.source_platform,
					sourceTrackId: row.source_track_id,
					title: row.title,
					artist: row.artist,
					album: row.album,
					cover: row.cover,
					durationSec: row.duration_sec,
				},
				{ playlistId: playlistRow.id, position: row.position },
			);
			if (!resolved) continue;

			const playable = await registry.resolvePlayable(
				resolved,
				origin,
				signSecret,
			);
			if (playable) {
				this.setStateValue("fallback_playlist_cursor", {
					playlistId: playlistRow.id,
					position: row.position,
				});
				return resolved;
			}
		}

		return null;
	}

	private getQueue(): QueueEntry[] {
		const rows = this.ctx.storage.sql
			.exec<{
				uid: string;
				track_json: string;
				requester_key: string;
				requester_name: string;
				created_at: number;
			}>(
				"SELECT uid, track_json, requester_key, requester_name, created_at FROM music_queue ORDER BY created_at ASC, rowid ASC",
			)
			.toArray();

		const entries: QueueEntry[] = [];
		for (const row of rows) {
			try {
				entries.push({
					uid: row.uid,
					track: JSON.parse(row.track_json) as StandardTrack,
					requesterKey: row.requester_key,
					requesterName: row.requester_name,
					createdAt: row.created_at,
				});
			} catch {
				// Skip corrupted entry
			}
		}
		return entries;
	}

	private getCurrentPlayback(): CurrentPlayback | null {
		return this.getStateValue<CurrentPlayback>("current_playback");
	}

	private recordMusicHistory(
		track: StandardTrack,
		requesterKey: string,
		requesterName: string,
		requesterAvatar = "",
		requestedAt = Date.now(),
	): void {
		const trackJson = JSON.stringify(track);
		this.ctx.storage.sql.exec(
			`INSERT INTO music_request_logs (
				track_id, track_json, requester_key, requester_name, requester_avatar, requested_at
			) VALUES (?, ?, ?, ?, ?, ?)`,
			track.id,
			trackJson,
			requesterKey,
			requesterName,
			requesterAvatar,
			requestedAt,
		);

		this.ctx.storage.sql.exec(
			`DELETE FROM music_request_logs
			 WHERE id NOT IN (
				SELECT id FROM music_request_logs
				ORDER BY id DESC
				LIMIT ?
			 )`,
			MAX_MUSIC_REQUEST_LOGS,
		);

		this.ctx.storage.sql.exec(
			`INSERT INTO music_history (
				track_id, track_json, request_count, last_requester_key, last_requester_name, first_requested_at, last_requested_at
			) VALUES (?, ?, 1, ?, ?, ?, ?)
			ON CONFLICT(track_id) DO UPDATE SET
				track_json = excluded.track_json,
				request_count = music_history.request_count + 1,
				last_requester_key = excluded.last_requester_key,
				last_requester_name = excluded.last_requester_name,
				last_requested_at = excluded.last_requested_at`,
			track.id,
			trackJson,
			requesterKey,
			requesterName,
			requestedAt,
			requestedAt,
		);

		this.ctx.storage.sql.exec(
			`DELETE FROM music_history
			 WHERE track_id NOT IN (
				SELECT track_id FROM music_history
				ORDER BY last_requested_at DESC, request_count DESC
				LIMIT ?
			 )`,
			MAX_MUSIC_HISTORY,
		);
	}

	private updateHistoryTrackDuration(
		trackId: string,
		durationSec: number,
	): void {
		const rows = this.ctx.storage.sql
			.exec<{ track_json: string }>(
				"SELECT track_json FROM music_history WHERE track_id = ?",
				trackId,
			)
			.toArray();
		if (rows.length === 0) return;
		try {
			const parsed = JSON.parse(rows[0].track_json) as StandardTrack;
			if (parsed.durationSec > 0) return;
			parsed.durationSec = durationSec;
			const updatedJson = JSON.stringify(parsed);
			this.ctx.storage.sql.exec(
				"UPDATE music_history SET track_json = ? WHERE track_id = ?",
				updatedJson,
				trackId,
			);
			this.ctx.storage.sql.exec(
				"UPDATE music_request_logs SET track_json = ? WHERE track_id = ?",
				updatedJson,
				trackId,
			);
		} catch {
			// Ignore malformed json
		}
	}

	private getHistoryLogsSnapshot(
		limit = INITIAL_MUSIC_LOG_LIMIT,
	): MusicHistoryLogEntry[] {
		const rows = this.ctx.storage.sql
			.exec<{
				id: number;
				track_json: string;
				requester_key: string;
				requester_name: string;
				requester_avatar: string;
				requested_at: number;
				request_count: number | null;
			}>(
				`SELECT l.id, l.track_json, l.requester_key, l.requester_name, l.requester_avatar, l.requested_at, h.request_count
				 FROM music_request_logs l
				 LEFT JOIN music_history h ON h.track_id = l.track_id
				 ORDER BY l.id DESC
				 LIMIT ?`,
				limit,
			)
			.toArray();

		const entries: MusicHistoryLogEntry[] = [];
		for (const row of rows) {
			try {
				entries.push({
					id: row.id,
					track: JSON.parse(row.track_json) as StandardTrack,
					requesterKey: row.requester_key,
					requesterName: row.requester_name,
					requesterAvatar: row.requester_avatar,
					requestedAt: row.requested_at,
					requestCount: Math.max(1, row.request_count ?? 1),
				});
			} catch {
				// Skip corrupted entry
			}
		}
		return entries;
	}

	private getHistorySnapshot(limit = MAX_MUSIC_HISTORY): MusicHistoryEntry[] {
		const rows = this.ctx.storage.sql
			.exec<{
				track_json: string;
				request_count: number;
				last_requester_name: string;
				first_requested_at: number;
				last_requested_at: number;
			}>(
				`SELECT track_json, request_count, last_requester_name, first_requested_at, last_requested_at
				 FROM music_history
				 ORDER BY last_requested_at DESC, request_count DESC
				 LIMIT ?`,
				limit,
			)
			.toArray();

		const entries: MusicHistoryEntry[] = [];
		for (const row of rows) {
			try {
				entries.push({
					track: JSON.parse(row.track_json) as StandardTrack,
					requestCount: row.request_count,
					lastRequesterName: row.last_requester_name,
					firstRequestedAt: row.first_requested_at,
					lastRequestedAt: row.last_requested_at,
				});
			} catch {
				// Skip corrupted entry
			}
		}
		return entries;
	}

	private mapMessageRow(r: MsgSqlRow): ChatMessageRecord {
		const replyTo = parseReplyRef(r.reply_to_json);
		return {
			id: r.id,
			msgUid: r.msg_uid,
			source: r.source === "matrix" ? "matrix" : undefined,
			kind: r.kind === "system" ? "system" : "user",
			userKey: r.user_key,
			name: r.name,
			avatar: r.avatar,
			url: r.url,
			badge: r.badge,
			badgeType:
				r.badge_type === "host" || r.badge_type === "accent"
					? r.badge_type
					: "tag",
			isAdmin: r.is_admin === 1,
			content: r.content,
			attachments: safeParseArray<ImageAttachment>(r.attachments_json),
			mentions: safeParseArray<string>(r.mentions_json),
			mentionKeys: safeParseArray<string>(r.mention_keys_json),
			replyTo,
			createdAt: r.created_at,
		};
	}

	private redactRecalledReplyTargets(
		messages: ChatMessageRecord[],
	): ChatMessageRecord[] {
		const replyUids = Array.from(
			new Set(
				messages
					.map((m) => m.replyTo?.msgUid)
					.filter((uid): uid is string => Boolean(uid)),
			),
		);
		if (replyUids.length === 0) return messages;

		const placeholders = replyUids.map(() => "?").join(", ");
		const recalledRows = this.ctx.storage.sql
			.exec<{ msg_uid: string }>(
				`SELECT msg_uid FROM messages WHERE msg_uid IN (${placeholders}) AND is_recalled = 1`,
				...replyUids,
			)
			.toArray();
		if (recalledRows.length === 0) return messages;

		const recalledSet = new Set(recalledRows.map((r) => r.msg_uid));
		return messages.map((m) =>
			m.replyTo && recalledSet.has(m.replyTo.msgUid)
				? {
						...m,
						replyTo: {
							msgUid: m.replyTo.msgUid,
							userKey: m.replyTo.userKey || "",
							name: m.replyTo.name,
							content: "",
							hasImage: false,
							isRecalled: true,
						},
					}
				: m,
		);
	}

	private getRecentMessages(
		limit = INITIAL_HISTORY_LIMIT,
	): ChatMessageRecord[] {
		const rows = this.ctx.storage.sql
			.exec<MsgSqlRow>(
				`SELECT ${MESSAGE_SELECT_COLS} FROM messages WHERE is_recalled = 0 ORDER BY id DESC LIMIT ?`,
				limit,
			)
			.toArray();

		return this.redactRecalledReplyTargets(
			rows.reverse().map((r) => this.mapMessageRow(r)),
		);
	}

	private hasMessagesBefore(oldestId: number): boolean {
		if (!oldestId) return false;
		const row = this.ctx.storage.sql
			.exec<{ id: number }>(
				"SELECT id FROM messages WHERE id < ? AND is_recalled = 0 LIMIT 1",
				oldestId,
			)
			.toArray()[0];
		return Boolean(row);
	}

	private getMessagesBefore(params: {
		beforeId: number;
		limit?: number;
		sinceCreatedAt?: number;
	}): { messages: ChatMessageRecord[]; hasMoreHistory: boolean } {
		let collected: MsgSqlRow[] = [];
		if (params.sinceCreatedAt && params.sinceCreatedAt > 0) {
			const rangeRows = this.ctx.storage.sql
				.exec<MsgSqlRow>(
					`SELECT ${MESSAGE_SELECT_COLS} FROM messages WHERE id < ? AND is_recalled = 0 AND created_at >= ? ORDER BY id ASC LIMIT ?`,
					params.beforeId,
					params.sinceCreatedAt,
					MAX_STORED_MESSAGES,
				)
				.toArray();

			const firstRangeId = rangeRows[0]?.id ?? params.beforeId;
			const contextRows = this.ctx.storage.sql
				.exec<MsgSqlRow>(
					`SELECT ${MESSAGE_SELECT_COLS} FROM messages WHERE id < ? AND is_recalled = 0 ORDER BY id DESC LIMIT 12`,
					firstRangeId,
				)
				.toArray()
				.reverse();

			collected = [...contextRows, ...rangeRows];
		} else {
			const pageLimit = Math.min(200, Math.max(20, params.limit ?? 80));
			collected = this.ctx.storage.sql
				.exec<MsgSqlRow>(
					`SELECT ${MESSAGE_SELECT_COLS} FROM messages WHERE id < ? AND is_recalled = 0 ORDER BY id DESC LIMIT ?`,
					params.beforeId,
					pageLimit,
				)
				.toArray()
				.reverse();
		}

		const messages = this.redactRecalledReplyTargets(
			collected.map((r) => this.mapMessageRow(r)),
		);
		const earliestId = messages[0]?.id ?? params.beforeId;
		return {
			messages,
			hasMoreHistory: this.hasMessagesBefore(earliestId),
		};
	}

	private getAdminMessages(params: {
		filter?: "all" | "recalled" | "normal";
		limit?: number;
		beforeId?: number;
	}): AdminChatMessageRecord[] {
		const limit = Math.min(500, Math.max(1, params.limit ?? 100));
		const whereParts: string[] = [];
		const args: unknown[] = [];

		if (params.filter === "recalled") {
			whereParts.push("is_recalled = 1");
		} else if (params.filter === "normal") {
			whereParts.push("is_recalled = 0");
		}
		if (params.beforeId && params.beforeId > 0) {
			whereParts.push("id < ?");
			args.push(params.beforeId);
		}
		const whereSql =
			whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

		const rows = this.ctx.storage.sql
			.exec<MsgSqlRow>(
				`SELECT ${MESSAGE_SELECT_COLS} FROM messages ${whereSql} ORDER BY id DESC LIMIT ?`,
				...args,
				limit,
			)
			.toArray();

		return rows.map((r) => {
			const base = this.mapMessageRow(r);
			const isRecalled = r.is_recalled === 1;
			const status = isRecalled
				? r.status === "deleted"
					? "deleted"
					: "recalled"
				: "normal";
			return {
				...base,
				isRecalled,
				status,
				recallTag:
					status === "deleted" ? "删除" : status === "recalled" ? "撤回" : "",
				recalledAt: r.recalled_at || 0,
				recalledBy: r.recalled_by || "",
				recalledByName: r.recalled_by_name || "",
			};
		});
	}

	private resolveReplyTarget(replyToUid: string): ChatReplyRef | null {
		const cleanUid = replyToUid.trim();
		if (!cleanUid) return null;
		const row = this.ctx.storage.sql
			.exec<{
				msg_uid: string;
				kind: string;
				user_key: string;
				name: string;
				content: string;
				attachments_json: string;
				is_recalled: number;
			}>(
				"SELECT msg_uid, kind, user_key, name, content, attachments_json, is_recalled FROM messages WHERE msg_uid = ?",
				cleanUid,
			)
			.toArray()[0];
		if (row?.kind !== "user" || row.is_recalled === 1) {
			return null;
		}
		return {
			msgUid: row.msg_uid,
			userKey: row.user_key,
			name: row.name,
			content: formatReplyPreview(row.content),
			hasImage:
				safeParseArray<ImageAttachment>(row.attachments_json).length > 0,
		};
	}

	private countMessagesSince(
		sinceCreatedAt: number,
		includeSystem: boolean,
	): number {
		if (!sinceCreatedAt || sinceCreatedAt <= 0) return 0;
		const row = includeSystem
			? this.ctx.storage.sql
					.exec<{ cnt: number }>(
						"SELECT COUNT(*) AS cnt FROM messages WHERE created_at > ? AND is_recalled = 0",
						sinceCreatedAt,
					)
					.toArray()[0]
			: this.ctx.storage.sql
					.exec<{ cnt: number }>(
						"SELECT COUNT(*) AS cnt FROM messages WHERE created_at > ? AND kind = 'user' AND is_recalled = 0",
						sinceCreatedAt,
					)
					.toArray()[0];
		return row?.cnt ?? 0;
	}

	private getMemberLastReadAt(userKey: string): number {
		const row = this.ctx.storage.sql
			.exec<{ last_read_at: number }>(
				"SELECT last_read_at FROM room_members WHERE user_key = ?",
				userKey,
			)
			.toArray()[0];
		return row?.last_read_at ?? 0;
	}

	private updateMemberLastReadAt(userKey: string, timestamp: number): void {
		if (!userKey || !Number.isFinite(timestamp) || timestamp <= 0) return;
		this.ctx.storage.sql.exec(
			`UPDATE room_members
			 SET last_read_at = CASE WHEN ? > last_read_at THEN ? ELSE last_read_at END
			 WHERE user_key = ?`,
			timestamp,
			timestamp,
			userKey,
		);
	}

	private appendMessage(
		record: Omit<ChatMessageRecord, "id" | "msgUid" | "createdAt">,
	): ChatMessageRecord {
		const msgUid = crypto.randomUUID();
		const createdAt = Date.now();
		const replyToUid = record.replyTo?.msgUid ?? "";
		const replyToJson = record.replyTo ? JSON.stringify(record.replyTo) : "";

		this.ctx.storage.sql.exec(
			`INSERT INTO messages (msg_uid, kind, user_key, name, avatar, url, badge, badge_type, is_admin, content, attachments_json, mentions_json, mention_keys_json, reply_to_uid, reply_to_json, is_recalled, status, recalled_at, recalled_by, recalled_by_name, created_at, source)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'normal', 0, '', '', ?, ?)`,
			msgUid,
			record.kind,
			record.userKey,
			record.name,
			record.avatar,
			record.url,
			record.badge,
			record.badgeType,
			record.isAdmin ? 1 : 0,
			record.content,
			JSON.stringify(record.attachments),
			JSON.stringify(record.mentions),
			JSON.stringify(record.mentionKeys ?? []),
			replyToUid,
			replyToJson,
			createdAt,
			record.source ?? "",
		);

		const inserted = this.ctx.storage.sql
			.exec<{ id: number }>("SELECT last_insert_rowid() as id")
			.toArray();
		const id = inserted[0]?.id ?? Date.now();

		// Keep newest active messages and preserve recalled records separately for audit queries
		this.ctx.storage.sql.exec(
			`DELETE FROM messages
			 WHERE is_recalled = 0
			   AND id NOT IN (
				SELECT id FROM messages WHERE is_recalled = 0 ORDER BY id DESC LIMIT ?
			   )`,
			MAX_STORED_MESSAGES,
		);
		this.ctx.storage.sql.exec(
			`DELETE FROM messages
			 WHERE is_recalled = 1
			   AND id NOT IN (
				SELECT id FROM messages WHERE is_recalled = 1 ORDER BY id DESC LIMIT ?
			   )`,
			MAX_RECALLED_AUDIT_MESSAGES,
		);

		return {
			...record,
			id,
			msgUid,
			createdAt,
		};
	}

	private getPresenceSnapshot(excludeWs?: WebSocket): {
		members: OnlineMember[];
		observerCount: number;
		totalCount: number;
	} {
		const sockets = this.ctx.getWebSockets();
		const membersMap = new Map<string, OnlineMember>();
		let observerCount = 0;

		for (const ws of sockets) {
			if (excludeWs && ws === excludeWs) continue;
			if (
				ws.readyState !== WebSocket.OPEN &&
				ws.readyState !== WebSocket.CONNECTING
			) {
				continue;
			}
			const att = ws.deserializeAttachment() as WsAttachment | null;
			if (!att) continue;
			if (att.user) {
				const existing = membersMap.get(att.user.userKey);
				const socketMuted = att.isMuted !== false;
				membersMap.set(att.user.userKey, {
					userKey: att.user.userKey,
					authType: att.user.authType,
					name: att.user.name,
					avatar: att.user.avatar,
					url: att.user.url,
					badge: att.user.badge,
					badgeType: att.user.badgeType,
					isAdmin: att.user.isAdmin,
					status: att.user.status || "在线",
					bio: att.user.bio || "",
					isMuted: existing ? existing.isMuted && socketMuted : socketMuted,
				});
			} else {
				observerCount += 1;
			}
		}

		const members = Array.from(membersMap.values()).sort((a, b) => {
			if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
			return a.name.localeCompare(b.name, "zh-CN");
		});

		return {
			members,
			observerCount,
			totalCount: members.length + observerCount,
		};
	}

	private getSoloCooldownUntil(): number {
		const raw = this.getStateValue<number>("solo_cooldown_until") ?? 0;
		return raw > Date.now() ? raw : 0;
	}

	private reconcilePresenceTransition(
		memberCount: number,
		unmutedCount = memberCount,
	): boolean {
		const prev = this.getStateValue<number>("prev_member_count") ?? 0;
		const prevUnmuted = this.getStateValue<number>("prev_unmuted_count") ?? 0;
		let cooldownChanged = false;
		if (prev >= 2 && memberCount === 1 && prevUnmuted >= 2) {
			this.setStateValue("solo_cooldown_until", Date.now() + SOLO_COOLDOWN_MS);
			cooldownChanged = true;
		} else if (memberCount >= 2) {
			const existing = this.getStateValue<number>("solo_cooldown_until") ?? 0;
			if (existing !== 0) {
				this.setStateValue("solo_cooldown_until", 0);
				cooldownChanged = true;
			}
		}
		if (prev !== memberCount) {
			this.setStateValue("prev_member_count", memberCount);
			cooldownChanged = true;
		}
		if (prevUnmuted !== unmutedCount) {
			this.setStateValue("prev_unmuted_count", unmutedCount);
			cooldownChanged = true;
		}
		return cooldownChanged;
	}

	private getMusicSnapshot(excludeWs?: WebSocket) {
		const current = this.getCurrentPlayback();
		const queue = this.getQueue();
		const { members } = this.getPresenceSnapshot(excludeWs);
		const onlineKeys = new Set(members.map((m) => m.userKey));
		const unmutedMembers = members.filter((m) => m.isMuted === false);
		const unmutedKeys = new Set(unmutedMembers.map((m) => m.userKey));

		const requesterOnline = current
			? onlineKeys.has(current.requesterKey)
			: false;
		const requesterActive = current
			? unmutedKeys.has(current.requesterKey)
			: false;
		const effectiveVoteCount =
			unmutedMembers.length >= 2 ? unmutedMembers.length : members.length;
		const voteCount = current ? current.skipVotes.length : 0;
		const voteThreshold = computeVoteThreshold(
			effectiveVoteCount,
			Boolean(current?.isFallback),
			unmutedMembers.length >= 2 ? requesterActive : requesterOnline,
		);
		const memberNamesByKey = new Map(members.map((m) => [m.userKey, m.name]));
		const skipVoteNames = current
			? current.skipVotes.map((k) => {
					const onlineName = memberNamesByKey.get(k);
					if (onlineName) return onlineName;
					const row = this.ctx.storage.sql
						.exec<{ name: string }>(
							"SELECT name FROM room_members WHERE user_key = ?",
							k,
						)
						.toArray()[0];
					return row?.name || "房友";
				})
			: [];

		return {
			current,
			queue,
			history: this.getHistorySnapshot(),
			historyLogs: this.getHistoryLogsSnapshot(),
			requesterOnline,
			voteCount,
			voteThreshold,
			skipVoteNames,
			soloCooldownUntil: this.getSoloCooldownUntil(),
			serverTime: Date.now(),
		};
	}

	private broadcast(payload: unknown, excludeWs?: WebSocket): void {
		const serialized = JSON.stringify(payload);
		for (const ws of this.ctx.getWebSockets()) {
			if (excludeWs && ws === excludeWs) continue;
			try {
				ws.send(serialized);
			} catch {
				// Ignore closed socket; webSocketClose/webSocketError will clean up
			}
		}
	}

	private send(ws: WebSocket, payload: unknown): void {
		try {
			ws.send(JSON.stringify(payload));
		} catch {
			// Ignore broken socket
		}
	}

	private upsertRoomMember(
		user: VerifiedUser,
		email: string,
		notifyEmailOverride?: boolean,
		bioOverride?: string,
		customProfile?: {
			customName: string;
			customAvatar: string;
			customUrl: string;
			hasCustomUrl: boolean;
		},
	): VerifiedUser {
		return this.upsertRoomMemberWithMerge(
			user,
			email,
			notifyEmailOverride,
			bioOverride,
			customProfile,
		).user;
	}

	private upsertRoomMemberWithMerge(
		user: VerifiedUser,
		email: string,
		notifyEmailOverride?: boolean,
		bioOverride?: string,
		customProfile?: {
			customName: string;
			customAvatar: string;
			customUrl: string;
			hasCustomUrl: boolean;
		},
	): { user: VerifiedUser; mergedFromKeys: string[]; musicChanged: boolean } {
		const now = Date.now();
		const cleanEmail = email.trim().toLowerCase();
		const isIsolatedGuest =
			user.authType === "guest" &&
			(Boolean(user.isolated) || isIsolatedGuestUserKey(user.userKey));
		const effectiveNotifyOverride = isIsolatedGuest
			? false
			: notifyEmailOverride;
		const allowAutoMergeInt = isIsolatedGuest ? 0 : 1;

		return this.ctx.storage.transactionSync(() => {
			const existing = this.ctx.storage.sql
				.exec<{
					notify_email: number;
					bio: string;
					status: string;
					first_seen_at: number;
					last_seen_at: number;
					last_notified_at: number;
					last_read_at: number;
					custom_name: string;
					custom_avatar: string;
					custom_url: string;
					has_custom_url: number;
				}>(
					`SELECT notify_email, bio, status, first_seen_at, last_seen_at, last_notified_at, last_read_at,
					        custom_name, custom_avatar, custom_url, has_custom_url
					 FROM room_members WHERE user_key = ?`,
					user.userKey,
				)
				.toArray()[0];

			const guestRows =
				user.authType === "waline" && cleanEmail !== ""
					? (() => {
							const deterministicGuestKey = this.env.CHAT_GUEST_SECRET
								? computeGuestUserKey(cleanEmail, this.env.CHAT_GUEST_SECRET)
								: "";
							return this.ctx.storage.sql
								.exec<{
									user_key: string;
									notify_email: number;
									bio: string;
									status: string;
									first_seen_at: number;
									last_seen_at: number;
									last_notified_at: number;
									last_read_at: number;
								}>(
									deterministicGuestKey &&
										deterministicGuestKey !== user.userKey
										? `SELECT user_key, notify_email, bio, status, first_seen_at, last_seen_at, last_notified_at, last_read_at
										   FROM room_members
										   WHERE auth_type = 'guest' AND allow_auto_merge = 1 AND user_key != ?
										     AND (LOWER(TRIM(email)) = ? OR user_key = ?)`
										: `SELECT user_key, notify_email, bio, status, first_seen_at, last_seen_at, last_notified_at, last_read_at
										   FROM room_members
										   WHERE auth_type = 'guest' AND allow_auto_merge = 1 AND user_key != ?
										     AND LOWER(TRIM(email)) = ?`,
									...(deterministicGuestKey &&
									deterministicGuestKey !== user.userKey
										? [user.userKey, cleanEmail, deterministicGuestKey]
										: [user.userKey, cleanEmail]),
								)
								.toArray();
						})()
					: [];

			const guestKeySet = new Set(guestRows.map((g) => g.user_key));
			if (
				user.authType === "waline" &&
				cleanEmail !== "" &&
				this.env.CHAT_GUEST_SECRET
			) {
				const deterministicGuestKey = computeGuestUserKey(
					cleanEmail,
					this.env.CHAT_GUEST_SECRET,
				);
				if (
					deterministicGuestKey !== user.userKey &&
					!guestKeySet.has(deterministicGuestKey) &&
					this.hasAnyRecordForUserKey(deterministicGuestKey)
				) {
					guestKeySet.add(deterministicGuestKey);
				}
			}

			const mergedMeta = resolveMergedMemberMetadata({
				existingTarget: existing
					? {
							notifyEmail: existing.notify_email,
							bio: existing.bio,
							status: existing.status,
							firstSeenAt: existing.first_seen_at,
							lastSeenAt: existing.last_seen_at,
							lastNotifiedAt: existing.last_notified_at,
							lastReadAt: existing.last_read_at,
						}
					: null,
				guestRows: guestRows.map((g) => ({
					notifyEmail: g.notify_email,
					bio: g.bio,
					status: g.status,
					firstSeenAt: g.first_seen_at,
					lastSeenAt: g.last_seen_at,
					lastNotifiedAt: g.last_notified_at,
					lastReadAt: g.last_read_at,
				})),
				notifyEmailOverride: effectiveNotifyOverride,
				defaultNotifyEmail: isIsolatedGuest ? 0 : 1,
				bioOverride,
				statusFromUser: user.status,
				bioFromUser: user.bio,
				now,
			});

			const nextCustomName = customProfile
				? customProfile.customName
				: (existing?.custom_name ?? "");
			const nextCustomAvatar = customProfile
				? customProfile.customAvatar
				: (existing?.custom_avatar ?? "");
			const nextCustomUrl = customProfile
				? customProfile.customUrl
				: (existing?.custom_url ?? "");
			const nextHasCustomUrl = customProfile
				? customProfile.hasCustomUrl
					? 1
					: 0
				: (existing?.has_custom_url ?? 0);

			const effectiveProfile = customProfile
				? {
						name: user.name,
						avatar: user.avatar,
						url: user.url,
					}
				: resolveEffectiveMemberProfile({
						baseName: user.name,
						baseAvatar: user.avatar,
						baseUrl: user.url,
						allowCustomName:
							user.isAdmin || !isReservedGuestName(nextCustomName),
						custom: {
							customName: nextCustomName,
							customAvatar: nextCustomAvatar,
							customUrl: nextCustomUrl,
							hasCustomUrl: nextHasCustomUrl === 1,
						},
					});

			this.ctx.storage.sql.exec(
				`INSERT INTO room_members (
					user_key, auth_type, name, email, avatar, url, badge, badge_type, is_admin, notify_email, allow_auto_merge, bio, status, first_seen_at, last_seen_at, last_notified_at, cooldown_until, last_read_at,
					custom_name, custom_avatar, custom_url, has_custom_url
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
				ON CONFLICT(user_key) DO UPDATE SET
					auth_type = excluded.auth_type,
					name = excluded.name,
					email = CASE WHEN excluded.email != '' THEN excluded.email ELSE room_members.email END,
					avatar = excluded.avatar,
					url = excluded.url,
					badge = excluded.badge,
					badge_type = excluded.badge_type,
					is_admin = excluded.is_admin,
					notify_email = ?,
					allow_auto_merge = CASE
						WHEN room_members.allow_auto_merge = 0 OR excluded.allow_auto_merge = 0 THEN 0
						ELSE 1
					END,
					bio = ?,
					status = ?,
					custom_name = ?,
					custom_avatar = ?,
					custom_url = ?,
					has_custom_url = ?,
					first_seen_at = CASE
						WHEN room_members.first_seen_at > 0 AND room_members.first_seen_at < excluded.first_seen_at THEN room_members.first_seen_at
						ELSE excluded.first_seen_at
					END,
					last_seen_at = excluded.last_seen_at,
					last_notified_at = CASE
						WHEN excluded.last_notified_at > room_members.last_notified_at THEN excluded.last_notified_at
						ELSE room_members.last_notified_at
					END,
					last_read_at = CASE
						WHEN excluded.last_read_at > room_members.last_read_at THEN excluded.last_read_at
						ELSE room_members.last_read_at
					END`,
				user.userKey,
				user.authType,
				effectiveProfile.name,
				cleanEmail,
				effectiveProfile.avatar,
				effectiveProfile.url,
				user.badge,
				user.badgeType,
				user.isAdmin ? 1 : 0,
				mergedMeta.notifyInt,
				allowAutoMergeInt,
				mergedMeta.bio,
				mergedMeta.status,
				mergedMeta.firstSeenAt,
				now,
				mergedMeta.lastNotifiedAt,
				mergedMeta.lastReadAt,
				nextCustomName,
				nextCustomAvatar,
				nextCustomUrl,
				nextHasCustomUrl,
				mergedMeta.notifyInt,
				mergedMeta.bio,
				mergedMeta.status,
				nextCustomName,
				nextCustomAvatar,
				nextCustomUrl,
				nextHasCustomUrl,
			);

			const finalUser: VerifiedUser = {
				...user,
				...(isIsolatedGuest ? { isolated: true } : {}),
				name: effectiveProfile.name,
				avatar: effectiveProfile.avatar,
				url: effectiveProfile.url,
				bio: mergedMeta.bio,
				status: mergedMeta.status,
				notifyEmail: isIsolatedGuest ? false : mergedMeta.notifyInt !== 0,
			};

			const mergedFromKeys = Array.from(guestKeySet);
			let musicChanged = false;
			if (mergedFromKeys.length > 0) {
				musicChanged = this.mergeGuestKeysIntoUser(guestKeySet, finalUser);
			}

			return {
				user: finalUser,
				mergedFromKeys,
				musicChanged,
			};
		});
	}

	private hasAnyRecordForUserKey(userKey: string): boolean {
		const checks = [
			"SELECT 1 FROM messages WHERE user_key = ? OR recalled_by = ? LIMIT 1",
			"SELECT 1 FROM music_request_logs WHERE requester_key = ? LIMIT 1",
			"SELECT 1 FROM music_history WHERE last_requester_key = ? LIMIT 1",
			"SELECT 1 FROM music_queue WHERE requester_key = ? LIMIT 1",
			"SELECT 1 FROM pending_mention_emails WHERE target_user_key = ? LIMIT 1",
			"SELECT 1 FROM user_playlists WHERE owner_key = ? LIMIT 1",
		];
		for (let i = 0; i < checks.length; i += 1) {
			const rows =
				i === 0
					? this.ctx.storage.sql
							.exec<{ 1: number }>(checks[i], userKey, userKey)
							.toArray()
					: this.ctx.storage.sql
							.exec<{ 1: number }>(checks[i], userKey)
							.toArray();
			if (rows.length > 0) return true;
		}
		const current = this.getCurrentPlayback();
		if (
			current &&
			((!current.isFallback && current.requesterKey === userKey) ||
				current.skipVotes.includes(userKey) ||
				current.errorReports.includes(userKey))
		) {
			return true;
		}
		return false;
	}

	private mergeGuestKeysIntoUser(
		guestKeySet: Set<string>,
		targetUser: VerifiedUser,
	): boolean {
		const guestKeys = Array.from(guestKeySet);
		if (guestKeys.length === 0) return false;

		let musicChanged = false;
		const isAdminInt = targetUser.isAdmin ? 1 : 0;

		for (const guestKey of guestKeys) {
			this.ctx.storage.sql.exec(
				`UPDATE messages
				 SET user_key = ?, name = ?, avatar = ?, url = ?, badge = ?, badge_type = ?, is_admin = ?
				 WHERE user_key = ?`,
				targetUser.userKey,
				targetUser.name,
				targetUser.avatar,
				targetUser.url,
				targetUser.badge,
				targetUser.badgeType,
				isAdminInt,
				guestKey,
			);

			this.ctx.storage.sql.exec(
				"UPDATE messages SET recalled_by = ?, recalled_by_name = ? WHERE recalled_by = ?",
				targetUser.userKey,
				targetUser.name,
				guestKey,
			);

			const mentionRows = this.ctx.storage.sql
				.exec<{ id: number; mention_keys_json: string }>(
					"SELECT id, mention_keys_json FROM messages WHERE mention_keys_json LIKE ?",
					`%${guestKey}%`,
				)
				.toArray();
			for (const row of mentionRows) {
				const parsed = safeParseArray<string>(row.mention_keys_json);
				const remapped = remapUserKeyList(
					parsed,
					guestKeySet,
					targetUser.userKey,
				);
				if (remapped.changed) {
					this.ctx.storage.sql.exec(
						"UPDATE messages SET mention_keys_json = ? WHERE id = ?",
						JSON.stringify(remapped.next),
						row.id,
					);
				}
			}

			const replyRows = this.ctx.storage.sql
				.exec<{ id: number; reply_to_json: string }>(
					"SELECT id, reply_to_json FROM messages WHERE reply_to_json LIKE ?",
					`%${guestKey}%`,
				)
				.toArray();
			for (const row of replyRows) {
				const remapped = remapReplyRefJson(
					row.reply_to_json,
					guestKeySet,
					targetUser.userKey,
					targetUser.name,
				);
				if (remapped.changed) {
					this.ctx.storage.sql.exec(
						"UPDATE messages SET reply_to_json = ? WHERE id = ?",
						remapped.nextJson,
						row.id,
					);
				}
			}

			const hasMusicLogs =
				this.ctx.storage.sql
					.exec<{ 1: number }>(
						"SELECT 1 FROM music_request_logs WHERE requester_key = ? LIMIT 1",
						guestKey,
					)
					.toArray().length > 0;
			if (hasMusicLogs) {
				musicChanged = true;
				this.ctx.storage.sql.exec(
					"UPDATE music_request_logs SET requester_key = ?, requester_name = ?, requester_avatar = ? WHERE requester_key = ?",
					targetUser.userKey,
					targetUser.name,
					targetUser.avatar,
					guestKey,
				);
			}

			const hasMusicHistory =
				this.ctx.storage.sql
					.exec<{ 1: number }>(
						"SELECT 1 FROM music_history WHERE last_requester_key = ? LIMIT 1",
						guestKey,
					)
					.toArray().length > 0;
			if (hasMusicHistory) {
				musicChanged = true;
				this.ctx.storage.sql.exec(
					"UPDATE music_history SET last_requester_key = ?, last_requester_name = ? WHERE last_requester_key = ?",
					targetUser.userKey,
					targetUser.name,
					guestKey,
				);
			}

			const hasMusicQueue =
				this.ctx.storage.sql
					.exec<{ 1: number }>(
						"SELECT 1 FROM music_queue WHERE requester_key = ? LIMIT 1",
						guestKey,
					)
					.toArray().length > 0;
			if (hasMusicQueue) {
				musicChanged = true;
				this.ctx.storage.sql.exec(
					"UPDATE music_queue SET requester_key = ?, requester_name = ? WHERE requester_key = ?",
					targetUser.userKey,
					targetUser.name,
					guestKey,
				);
			}

			this.ctx.storage.sql.exec(
				"UPDATE pending_mention_emails SET target_user_key = ? WHERE target_user_key = ?",
				targetUser.userKey,
				guestKey,
			);

			this.ctx.storage.sql.exec(
				"UPDATE user_playlists SET owner_key = ?, owner_name = ? WHERE owner_key = ?",
				targetUser.userKey,
				targetUser.name,
				guestKey,
			);

			this.ctx.storage.sql.exec(
				"DELETE FROM room_members WHERE user_key = ?",
				guestKey,
			);
		}

		const current = this.getCurrentPlayback();
		if (current) {
			const playbackRemap = remapPlaybackUserKeys(
				current,
				guestKeySet,
				targetUser.userKey,
				targetUser.name,
			);
			if (playbackRemap.changed) {
				this.setStateValue("current_playback", playbackRemap.next);
				musicChanged = true;
			}
		}

		return musicChanged;
	}

	private hasWalineMemberByEmail(email: string): boolean {
		const cleanEmail = email.trim().toLowerCase();
		if (!cleanEmail) return false;
		const row = this.ctx.storage.sql
			.exec<{ 1: number }>(
				`SELECT 1 FROM room_members
				 WHERE auth_type = 'waline' AND LOWER(TRIM(email)) = ?
				 LIMIT 1`,
				cleanEmail,
			)
			.toArray()[0];
		return Boolean(row);
	}

	private isGuestEmailBlockedByWaline(
		email: string,
		isolated = false,
	): boolean {
		return shouldBlockGuestByWaline({
			isAdminEmail: isAdminEmail(this.env, email),
			hasWalineMember: this.hasWalineMemberByEmail(email),
			isolated,
		});
	}

	private buildVerifiedUserFromMemberRow(row: RoomMemberRow): VerifiedUser {
		const authType: "waline" | "guest" =
			row.auth_type === "waline" ? "waline" : "guest";
		const isAdmin = row.is_admin === 1;
		const roleBadge = resolveRoleBadge(authType, isAdmin);
		const isIsolated =
			authType === "guest" &&
			(row.allow_auto_merge === 0 || isIsolatedGuestUserKey(row.user_key));
		return {
			userKey: row.user_key,
			authType,
			name: row.name,
			avatar: row.avatar,
			url: row.url,
			badge: roleBadge.badge,
			badgeType: roleBadge.badgeType,
			isAdmin,
			...(isIsolated ? { isolated: true } : {}),
			bio: row.bio || "",
			status: row.status || "在线",
			notifyEmail: isIsolated ? false : row.notify_email !== 0,
		};
	}

	private mergeMemberIntoTarget(
		sourceUserKey: string,
		targetUserKey: string,
		broadcastLive = true,
		skipIfAutoMergeDisabled = false,
	): {
		ok: boolean;
		merged: boolean;
		error?: string;
		targetUser?: VerifiedUser;
	} {
		const cleanSource = sourceUserKey.trim();
		const cleanTarget = targetUserKey.trim();
		if (!cleanSource || !cleanTarget || cleanSource === cleanTarget) {
			return { ok: false, merged: false, error: "源账号与目标账号标识无效" };
		}

		const txResult = this.ctx.storage.transactionSync(() => {
			const targetRow = this.ctx.storage.sql
				.exec<RoomMemberRow & { last_read_at: number }>(
					`SELECT user_key, auth_type, name, email, avatar, url, badge, badge_type, is_admin, notify_email, allow_auto_merge, bio, status, first_seen_at, last_seen_at, last_notified_at, cooldown_until, last_read_at
					 FROM room_members WHERE user_key = ?`,
					cleanTarget,
				)
				.toArray()[0];
			if (!targetRow) {
				return {
					ok: false as const,
					merged: false,
					error: "目标账号不存在",
				};
			}

			const sourceRow = this.ctx.storage.sql
				.exec<RoomMemberRow & { last_read_at: number }>(
					`SELECT user_key, auth_type, name, email, avatar, url, badge, badge_type, is_admin, notify_email, allow_auto_merge, bio, status, first_seen_at, last_seen_at, last_notified_at, cooldown_until, last_read_at
					 FROM room_members WHERE user_key = ?`,
					cleanSource,
				)
				.toArray()[0];

			if (
				skipIfAutoMergeDisabled &&
				(sourceRow?.allow_auto_merge === 0 ||
					isIsolatedGuestUserKey(cleanSource))
			) {
				return {
					ok: true as const,
					merged: false,
				};
			}

			if (!sourceRow && !this.hasAnyRecordForUserKey(cleanSource)) {
				return {
					ok: true as const,
					merged: false,
				};
			}

			const firstSeenAt = pickEarliestPositiveTimestamp([
				targetRow.first_seen_at,
				targetRow.last_seen_at,
				sourceRow?.first_seen_at,
				sourceRow?.last_seen_at,
			]);
			const lastReadAt = pickLatestPositiveTimestamp([
				targetRow.last_read_at,
				sourceRow?.last_read_at,
			]);
			const lastNotifiedAt = pickLatestPositiveTimestamp([
				targetRow.last_notified_at,
				sourceRow?.last_notified_at,
			]);

			if (firstSeenAt > 0 || lastReadAt > 0 || lastNotifiedAt > 0) {
				this.ctx.storage.sql.exec(
					`UPDATE room_members
					 SET first_seen_at = CASE WHEN ? > 0 THEN ? ELSE first_seen_at END,
					     last_read_at = CASE WHEN ? > last_read_at THEN ? ELSE last_read_at END,
					     last_notified_at = CASE WHEN ? > last_notified_at THEN ? ELSE last_notified_at END
					 WHERE user_key = ?`,
					firstSeenAt,
					firstSeenAt,
					lastReadAt,
					lastReadAt,
					lastNotifiedAt,
					lastNotifiedAt,
					cleanTarget,
				);
			}

			const targetUser = this.buildVerifiedUserFromMemberRow(targetRow);
			const musicChanged = this.mergeGuestKeysIntoUser(
				new Set([cleanSource]),
				targetUser,
			);
			return {
				ok: true as const,
				merged: true,
				targetUser,
				musicChanged,
			};
		});

		if (!txResult.ok) {
			return { ok: false, merged: false, error: txResult.error };
		}
		if (!txResult.merged || !txResult.targetUser) {
			return { ok: true, merged: false };
		}

		if (broadcastLive) {
			this.syncMergedSockets([cleanSource], txResult.targetUser);
			this.broadcast({
				type: "member:merged",
				roomId: this.getRoomId(),
				fromUserKeys: [cleanSource],
				user: txResult.targetUser,
			});
			this.broadcastPresence();
			if (txResult.musicChanged) {
				this.broadcastMusic();
			}
		}

		return {
			ok: true,
			merged: true,
			targetUser: txResult.targetUser,
		};
	}

	private deleteMemberByUserKey(
		targetUserKey: string,
		broadcastLive = true,
	): { ok: boolean; deleted: boolean } {
		const cleanKey = targetUserKey.trim();
		if (!cleanKey) return { ok: false, deleted: false };
		const existing = this.ctx.storage.sql
			.exec<{ user_key: string }>(
				"SELECT user_key FROM room_members WHERE user_key = ?",
				cleanKey,
			)
			.toArray()[0];
		if (!existing) {
			return { ok: true, deleted: false };
		}
		this.ctx.storage.sql.exec(
			"DELETE FROM pending_mention_emails WHERE target_user_key = ?",
			cleanKey,
		);
		this.ctx.storage.sql.exec(
			"DELETE FROM room_members WHERE user_key = ?",
			cleanKey,
		);
		if (broadcastLive) {
			for (const peer of this.ctx.getWebSockets()) {
				const peerAtt = peer.deserializeAttachment() as WsAttachment | null;
				if (peerAtt?.user?.userKey === cleanKey) {
					peerAtt.user = null;
					peerAtt.baseName = "";
					peerAtt.baseAvatar = "";
					peerAtt.baseUrl = "";
					peerAtt.isMuted = true;
					peer.serializeAttachment(peerAtt);
					this.send(peer, { type: "auth:result", user: null });
				}
			}
			this.broadcastPresence();
		}
		return { ok: true, deleted: true };
	}

	private reconcileLegacyGuestMerges(): void {
		const walineRows = this.ctx.storage.sql
			.exec<RoomMemberRow & { last_read_at: number }>(
				`SELECT user_key, auth_type, name, email, avatar, url, badge, badge_type, is_admin, notify_email, bio, status, first_seen_at, last_seen_at, last_notified_at, cooldown_until, last_read_at
				 FROM room_members
				 WHERE auth_type = 'waline' AND TRIM(email) != ''
				 ORDER BY last_seen_at DESC`,
			)
			.toArray();
		for (const wRow of walineRows) {
			const cleanEmail = wRow.email.trim().toLowerCase();
			if (!cleanEmail) continue;
			const guestMatches = this.ctx.storage.sql
				.exec<{ user_key: string }>(
					`SELECT user_key FROM room_members
					 WHERE auth_type = 'guest' AND allow_auto_merge = 1 AND user_key != ? AND LOWER(TRIM(email)) = ?`,
					wRow.user_key,
					cleanEmail,
				)
				.toArray();
			for (const g of guestMatches) {
				this.mergeMemberIntoTarget(g.user_key, wRow.user_key, false, true);
			}
			if (this.env.CHAT_GUEST_SECRET) {
				const deterministicGuestKey = computeGuestUserKey(
					cleanEmail,
					this.env.CHAT_GUEST_SECRET,
				);
				if (deterministicGuestKey !== wRow.user_key) {
					this.mergeMemberIntoTarget(
						deterministicGuestKey,
						wRow.user_key,
						false,
						true,
					);
				}
			}
		}
	}

	private syncMergedSockets(
		mergedFromKeys: string[],
		targetUser: VerifiedUser,
		excludeWs?: WebSocket,
		baseInfo?: { baseName: string; baseAvatar: string; baseUrl: string },
	): void {
		if (mergedFromKeys.length === 0) return;
		const keySet = new Set(mergedFromKeys);
		for (const peer of this.ctx.getWebSockets()) {
			if (excludeWs && peer === excludeWs) continue;
			const peerAtt = peer.deserializeAttachment() as WsAttachment | null;
			if (!peerAtt?.user || !keySet.has(peerAtt.user.userKey)) continue;
			peerAtt.user = targetUser;
			if (baseInfo) {
				peerAtt.baseName = baseInfo.baseName;
				peerAtt.baseAvatar = baseInfo.baseAvatar;
				peerAtt.baseUrl = baseInfo.baseUrl;
			}
			peer.serializeAttachment(peerAtt);
			this.send(peer, {
				type: "auth:result",
				user: targetUser,
				mergedGuestHistory: true,
			});
		}
	}

	private getMemberTracksPage(
		targetUserKey: string,
		limit = 50,
		beforeId = 0,
	): {
		items: Array<{
			logId: number;
			track: StandardTrack;
			requestedAt: number;
			requestCount: number;
		}>;
		hasMore: boolean;
		nextBeforeId: number;
	} {
		const userKey = targetUserKey.trim();
		const clampedLimit = Math.min(Math.max(limit || 50, 1), 100);
		if (!userKey) {
			return { items: [], hasMore: false, nextBeforeId: 0 };
		}

		const rows = (
			beforeId > 0
				? this.ctx.storage.sql.exec<{
						id: number;
						track_json: string;
						requested_at: number;
						request_count: number | null;
					}>(
						`SELECT l.id, l.track_json, l.requested_at, h.request_count
						 FROM music_request_logs l
						 LEFT JOIN music_history h ON h.track_id = l.track_id
						 WHERE l.requester_key = ? AND l.id < ?
						 ORDER BY l.id DESC
						 LIMIT ?`,
						userKey,
						beforeId,
						clampedLimit + 1,
					)
				: this.ctx.storage.sql.exec<{
						id: number;
						track_json: string;
						requested_at: number;
						request_count: number | null;
					}>(
						`SELECT l.id, l.track_json, l.requested_at, h.request_count
						 FROM music_request_logs l
						 LEFT JOIN music_history h ON h.track_id = l.track_id
						 WHERE l.requester_key = ?
						 ORDER BY l.id DESC
						 LIMIT ?`,
						userKey,
						clampedLimit + 1,
					)
		).toArray();

		const hasMore = rows.length > clampedLimit;
		const sliced = hasMore ? rows.slice(0, clampedLimit) : rows;
		const items: Array<{
			logId: number;
			track: StandardTrack;
			requestedAt: number;
			requestCount: number;
		}> = [];
		for (const row of sliced) {
			try {
				const parsed = JSON.parse(row.track_json) as StandardTrack;
				items.push({
					logId: row.id,
					track: parsed,
					requestedAt: row.requested_at,
					requestCount: Math.max(1, row.request_count ?? 1),
				});
			} catch {
				// Skip malformed track json
			}
		}
		const nextBeforeId =
			hasMore && sliced.length > 0 ? sliced[sliced.length - 1].id : 0;
		return { items, hasMore, nextBeforeId };
	}

	private getMemberProfileSnapshot(
		targetUserKey: string,
		tracksLimit = 50,
		viewerUser: VerifiedUser | null = null,
	) {
		const userKey = targetUserKey.trim();
		if (!userKey) return null;

		const onlineMatch = this.getPresenceSnapshot().members.find(
			(m) => m.userKey === userKey,
		);

		const memberRow = this.ctx.storage.sql
			.exec<RoomMemberRow>(
				`SELECT user_key, auth_type, name, email, avatar, url, badge, badge_type, is_admin, notify_email, bio, status, first_seen_at, last_seen_at, last_notified_at, cooldown_until
				 FROM room_members WHERE user_key = ?`,
				userKey,
			)
			.toArray()[0];

		const latestMsg = !memberRow
			? this.ctx.storage.sql
					.exec<{
						name: string;
						avatar: string;
						url: string;
						is_admin: number;
						created_at: number;
					}>(
						"SELECT name, avatar, url, is_admin, created_at FROM messages WHERE user_key = ? AND kind = 'user' ORDER BY id DESC LIMIT 1",
						userKey,
					)
					.toArray()[0]
			: undefined;

		if (!onlineMatch && !memberRow && !latestMsg) {
			return null;
		}

		const inferredAuthType: "waline" | "guest" =
			onlineMatch?.authType ??
			(memberRow?.auth_type === "waline" || userKey.startsWith("waline:")
				? "waline"
				: "guest");
		const isAdmin = Boolean(
			onlineMatch?.isAdmin ??
				(memberRow ? memberRow.is_admin === 1 : latestMsg?.is_admin === 1),
		);
		const roleBadge = resolveRoleBadge(inferredAuthType, isAdmin);

		const msgCountRow = this.ctx.storage.sql
			.exec<{ cnt: number }>(
				"SELECT COUNT(*) AS cnt FROM messages WHERE user_key = ? AND kind = 'user' AND is_recalled = 0",
				userKey,
			)
			.toArray()[0];

		const songCountRow = this.ctx.storage.sql
			.exec<{ cnt: number }>(
				"SELECT COUNT(*) AS cnt FROM music_request_logs WHERE requester_key = ?",
				userKey,
			)
			.toArray()[0];

		const trackPage = this.getMemberTracksPage(userKey, tracksLimit, 0);

		const canSeePrivatePlaylists = Boolean(
			viewerUser &&
				(viewerUser.isAdmin ||
					(viewerUser.authType === "waline" && viewerUser.userKey === userKey)),
		);
		const playlistRows = this.ctx.storage.sql
			.exec<{
				id: string;
				title: string;
				platform: string;
				cover_url: string;
				track_count: number;
			}>(
				`SELECT id, title, platform, cover_url, track_count
				 FROM user_playlists
				 WHERE owner_key = ?
				   ${canSeePrivatePlaylists ? "" : "AND (is_public = 1 OR is_featured = 1)"}
				 ORDER BY is_featured DESC, is_public DESC, updated_at DESC
				 LIMIT 8`,
				userKey,
			)
			.toArray();

		const recentMsgRows = this.ctx.storage.sql
			.exec<{
				msg_uid: string;
				content: string;
				attachments_json: string;
				created_at: number;
			}>(
				`SELECT msg_uid, content, attachments_json, created_at
				 FROM messages
				 WHERE user_key = ? AND kind = 'user' AND is_recalled = 0
				 ORDER BY id DESC
				 LIMIT 10`,
				userKey,
			)
			.toArray();

		const recentMessages = recentMsgRows.map((row) => {
			let hasImage = false;
			try {
				const atts = JSON.parse(row.attachments_json || "[]") as unknown[];
				hasImage = Array.isArray(atts) && atts.length > 0;
			} catch {
				hasImage = false;
			}
			return {
				msgUid: row.msg_uid,
				content: row.content,
				hasImage,
				createdAt: row.created_at,
			};
		});

		const topTrackRows = this.ctx.storage.sql
			.exec<{
				track_json: string;
				user_request_count: number;
				last_requested_at: number;
			}>(
				`SELECT track_json, COUNT(*) AS user_request_count, MAX(requested_at) AS last_requested_at
				 FROM music_request_logs
				 WHERE requester_key = ?
				 GROUP BY track_id
				 ORDER BY user_request_count DESC, last_requested_at DESC
				 LIMIT 50`,
				userKey,
			)
			.toArray();

		const topTracks: Array<{
			track: StandardTrack;
			requestCount: number;
			lastRequestedAt: number;
		}> = [];
		const artistCounts = new Map<string, number>();
		for (const row of topTrackRows) {
			try {
				const parsed = JSON.parse(row.track_json) as StandardTrack;
				topTracks.push({
					track: parsed,
					requestCount: row.user_request_count,
					lastRequestedAt: row.last_requested_at,
				});
				const artist = (parsed.artist || "").trim();
				if (artist && artist !== "未知歌手") {
					artistCounts.set(
						artist,
						(artistCounts.get(artist) ?? 0) + row.user_request_count,
					);
				}
			} catch {
				// Skip malformed track json
			}
		}

		const topArtists = Array.from(artistCounts.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([artist, count]) => ({ artist, count }));

		return {
			userKey,
			authType: inferredAuthType,
			name: onlineMatch?.name || memberRow?.name || latestMsg?.name || "房友",
			avatar:
				onlineMatch?.avatar || memberRow?.avatar || latestMsg?.avatar || "",
			url: onlineMatch?.url || memberRow?.url || latestMsg?.url || "",
			badge: roleBadge.badge,
			badgeType: roleBadge.badgeType,
			isAdmin,
			online: Boolean(onlineMatch),
			status: onlineMatch?.status || memberRow?.status || "在线",
			bio: onlineMatch?.bio ?? memberRow?.bio ?? "",
			firstSeenAt:
				memberRow?.first_seen_at ||
				memberRow?.last_seen_at ||
				latestMsg?.created_at ||
				0,
			lastSeenAt: onlineMatch
				? Date.now()
				: memberRow?.last_seen_at || latestMsg?.created_at || 0,
			stats: {
				messageCount: msgCountRow?.cnt ?? 0,
				songRequestCount: songCountRow?.cnt ?? 0,
			},
			recentTracks: trackPage.items,
			tracksHasMore: trackPage.hasMore,
			tracksNextBeforeId: trackPage.nextBeforeId,
			topTracks,
			topArtists,
			recentMessages,
			playlists: playlistRows.map((p) => ({
				id: p.id,
				title: p.title,
				platform: p.platform,
				coverUrl: p.cover_url,
				trackCount: p.track_count,
			})),
		};
	}

	private async markMemberOnline(userKey: string): Promise<void> {
		this.ctx.storage.sql.exec(
			"DELETE FROM pending_mention_emails WHERE target_user_key = ?",
			userKey,
		);
		this.ctx.storage.sql.exec(
			"UPDATE room_members SET cooldown_until = 0, last_seen_at = ? WHERE user_key = ?",
			Date.now(),
			userKey,
		);
		await this.syncNextAlarm();
	}

	private touchMemberLastSeen(userKey: string): void {
		this.ctx.storage.sql.exec(
			"UPDATE room_members SET last_seen_at = ? WHERE user_key = ?",
			Date.now(),
			userKey,
		);
	}

	private getOnlineUserKeys(excludeWs?: WebSocket): Set<string> {
		const keys = new Set<string>();
		for (const ws of this.ctx.getWebSockets()) {
			if (excludeWs && ws === excludeWs) continue;
			if (
				ws.readyState !== WebSocket.OPEN &&
				ws.readyState !== WebSocket.CONNECTING
			) {
				continue;
			}
			const att = ws.deserializeAttachment() as WsAttachment | null;
			if (att?.user?.userKey) {
				keys.add(att.user.userKey);
			}
		}
		return keys;
	}

	private getMentionDirectorySnapshot(
		excludeWs?: WebSocket,
	): MentionDirectoryMember[] {
		const { members: onlineMembers } = this.getPresenceSnapshot(excludeWs);
		const now = Date.now();
		const onlineSet = new Set<string>();
		const list: MentionDirectoryMember[] = [];

		for (const m of onlineMembers) {
			onlineSet.add(m.userKey);
			list.push({
				userKey: m.userKey,
				authType: m.authType,
				name: m.name,
				avatar: m.avatar,
				url: m.url,
				badge: m.badge,
				badgeType: m.badgeType,
				isAdmin: m.isAdmin,
				online: true,
				status: m.status,
				bio: m.bio,
				lastSeenAt: now,
			});
		}

		const offlineRows = this.ctx.storage.sql
			.exec<RoomMemberRow>(
				`SELECT user_key, auth_type, name, email, avatar, url, badge, badge_type, is_admin, notify_email, bio, status, last_seen_at, last_notified_at, cooldown_until
				 FROM room_members
				 WHERE name != ''
				 ORDER BY is_admin DESC, last_seen_at DESC
				 LIMIT ?`,
				MAX_MENTION_DIRECTORY,
			)
			.toArray();

		for (const row of offlineRows) {
			if (onlineSet.has(row.user_key)) continue;
			const isAdmin = row.is_admin === 1;
			const authType: "waline" | "guest" =
				row.auth_type === "waline" ? "waline" : "guest";
			const roleBadge = resolveRoleBadge(authType, isAdmin);
			list.push({
				userKey: row.user_key,
				authType,
				name: row.name,
				avatar: row.avatar,
				url: row.url || "",
				badge: roleBadge.badge,
				badgeType: roleBadge.badgeType,
				isAdmin,
				online: false,
				status: row.status || "在线",
				bio: row.bio || "",
				lastSeenAt: row.last_seen_at,
			});
		}

		return list.slice(0, MAX_MENTION_DIRECTORY);
	}

	private getMentionCandidates(
		excludeWs?: WebSocket,
	): MentionCandidateRecord[] {
		return this.getMentionDirectorySnapshot(excludeWs).map((m) => ({
			userKey: m.userKey,
			name: m.name,
			online: m.online,
			lastSeenAt: m.lastSeenAt,
		}));
	}

	private getRoomDisplayName(roomId: string): string {
		if (roomId === "chat") return "闲聊";
		if (roomId === INTERCONNECT_ROOM) return "互联茶室";
		return roomId;
	}

	private async sendMentionDigestEmail(params: {
		toEmail: string;
		toName: string;
		messages: Array<{
			msgUid: string;
			senderName: string;
			senderBadge: string;
			content: string;
			attachments: ImageAttachment[];
			replyTo?: {
				msgUid?: string;
				name: string;
				content: string;
				hasImage?: boolean;
				isReplyToRecipient?: boolean;
			} | null;
			createdAt: number;
		}>;
	}): Promise<boolean> {
		const secret = this.env.INTERNAL_NOTIFY_SECRET?.trim() || "";
		if (
			!secret ||
			!params.toEmail.includes("@") ||
			params.messages.length === 0
		) {
			return false;
		}
		const roomId = this.getRoomId();
		const payload = JSON.stringify({
			toEmail: params.toEmail,
			toName: params.toName,
			roomId,
			roomName: this.getRoomDisplayName(roomId),
			siteUrl: (this.env.SITE_URL || "https://lengxiqwq.com").replace(
				/\/+$/,
				"",
			),
			messages: params.messages,
		});

		const headers = {
			"Content-Type": "application/json",
			"X-Internal-Secret": secret,
		};

		try {
			let resp: Response | null = null;
			if (this.env.WALINE) {
				resp = await this.env.WALINE.fetch(
					"https://waline.internal/api/internal/chat-mention-notify",
					{
						method: "POST",
						headers,
						body: payload,
					},
				);
			} else if (this.env.WALINE_SERVER_URL) {
				const base = this.env.WALINE_SERVER_URL.replace(/\/+$/, "");
				resp = await fetch(`${base}/api/internal/chat-mention-notify`, {
					method: "POST",
					headers,
					body: payload,
					signal: AbortSignal.timeout(8000),
				});
			}
			return Boolean(resp?.ok);
		} catch (err) {
			console.error("[Chat Mention Mail Error]", err);
			return false;
		}
	}

	private async dispatchChatMentions(
		saved: ChatMessageRecord,
		targetUserKeys: string[],
	): Promise<void> {
		if (targetUserKeys.length === 0) return;

		const onlineKeys = this.getOnlineUserKeys();
		const now = Date.now();
		let queuedAny = false;
		const replyToJson = saved.replyTo ? JSON.stringify(saved.replyTo) : "";

		for (const targetKey of targetUserKeys) {
			if (!targetKey || targetKey === saved.userKey) continue;
			// Online members already receive real-time WebSocket in-page mention/reply alerts
			if (onlineKeys.has(targetKey)) continue;

			const row = this.ctx.storage.sql
				.exec<RoomMemberRow>(
					`SELECT user_key, auth_type, name, email, avatar, url, badge, badge_type, is_admin, notify_email, last_seen_at, last_notified_at, cooldown_until
					 FROM room_members WHERE user_key = ?`,
					targetKey,
				)
				.toArray()[0];

			if (!row?.email?.includes("@") || row.notify_email === 0) {
				continue;
			}

			const isAdminRecipient = row.is_admin === 1;
			if (isAdminRecipient) {
				const pendingRows = this.ctx.storage.sql
					.exec<PendingMentionEmailRow>(
						`SELECT id, target_user_key, msg_uid, sender_name, sender_badge, content, attachments_json, reply_to_json, created_at
						 FROM pending_mention_emails
						 WHERE target_user_key = ?
						 ORDER BY created_at ASC, id ASC`,
						targetKey,
					)
					.toArray();

				const batch = [
					...pendingRows.map((p) => ({
						msgUid: p.msg_uid,
						senderName: p.sender_name,
						senderBadge: p.sender_badge,
						content: p.content,
						attachments: safeParseArray<ImageAttachment>(p.attachments_json),
						replyTo: formatEmailReplyRef(
							parseReplyRef(p.reply_to_json),
							targetKey,
						),
						createdAt: p.created_at,
					})),
					{
						msgUid: saved.msgUid,
						senderName: saved.name,
						senderBadge: saved.badge,
						content: saved.content,
						attachments: saved.attachments,
						replyTo: formatEmailReplyRef(saved.replyTo, targetKey),
						createdAt: saved.createdAt,
					},
				];

				this.ctx.storage.sql.exec(
					"DELETE FROM pending_mention_emails WHERE target_user_key = ?",
					targetKey,
				);
				this.ctx.storage.sql.exec(
					"UPDATE room_members SET last_notified_at = ?, cooldown_until = 0 WHERE user_key = ?",
					now,
					targetKey,
				);

				await this.sendMentionDigestEmail({
					toEmail: row.email,
					toName: row.name,
					messages: batch,
				});
			} else {
				const windowMs = getMentionCooldownMs(false);
				const hasPending =
					this.ctx.storage.sql
						.exec<{ id: number }>(
							"SELECT id FROM pending_mention_emails WHERE target_user_key = ? LIMIT 1",
							targetKey,
						)
						.toArray().length > 0;

				this.ctx.storage.sql.exec(
					`INSERT INTO pending_mention_emails (
						target_user_key, msg_uid, sender_name, sender_badge, content, attachments_json, reply_to_json, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					targetKey,
					saved.msgUid,
					saved.name,
					saved.badge,
					saved.content,
					JSON.stringify(saved.attachments),
					replyToJson,
					saved.createdAt,
				);

				if (!hasPending || row.cooldown_until <= now) {
					this.ctx.storage.sql.exec(
						"UPDATE room_members SET cooldown_until = ? WHERE user_key = ?",
						now + windowMs,
						targetKey,
					);
				}
				queuedAny = true;
			}
		}

		if (queuedAny) {
			await this.syncNextAlarm();
		}
	}

	private async flushDueMentionEmails(): Promise<void> {
		const targetRows = this.ctx.storage.sql
			.exec<{ target_user_key: string }>(
				"SELECT DISTINCT target_user_key FROM pending_mention_emails",
			)
			.toArray();
		if (targetRows.length === 0) return;

		const onlineKeys = this.getOnlineUserKeys();
		const now = Date.now();

		for (const { target_user_key: targetKey } of targetRows) {
			if (onlineKeys.has(targetKey)) {
				this.ctx.storage.sql.exec(
					"DELETE FROM pending_mention_emails WHERE target_user_key = ?",
					targetKey,
				);
				continue;
			}

			const member = this.ctx.storage.sql
				.exec<RoomMemberRow>(
					`SELECT user_key, auth_type, name, email, avatar, url, badge, badge_type, is_admin, notify_email, last_seen_at, last_notified_at, cooldown_until
					 FROM room_members WHERE user_key = ?`,
					targetKey,
				)
				.toArray()[0];

			if (!member?.email?.includes("@") || member.notify_email === 0) {
				this.ctx.storage.sql.exec(
					"DELETE FROM pending_mention_emails WHERE target_user_key = ?",
					targetKey,
				);
				continue;
			}

			if (member.is_admin !== 1 && now < member.cooldown_until) {
				continue;
			}

			const pendingRows = this.ctx.storage.sql
				.exec<PendingMentionEmailRow>(
					`SELECT id, target_user_key, msg_uid, sender_name, sender_badge, content, attachments_json, reply_to_json, created_at
					 FROM pending_mention_emails
					 WHERE target_user_key = ?
					 ORDER BY created_at ASC, id ASC`,
					targetKey,
				)
				.toArray();

			if (pendingRows.length === 0) continue;

			this.ctx.storage.sql.exec(
				"DELETE FROM pending_mention_emails WHERE target_user_key = ?",
				targetKey,
			);
			this.ctx.storage.sql.exec(
				"UPDATE room_members SET last_notified_at = ?, cooldown_until = 0 WHERE user_key = ?",
				now,
				targetKey,
			);

			await this.sendMentionDigestEmail({
				toEmail: member.email,
				toName: member.name,
				messages: pendingRows.map((p) => ({
					msgUid: p.msg_uid,
					senderName: p.sender_name,
					senderBadge: p.sender_badge,
					content: p.content,
					attachments: safeParseArray<ImageAttachment>(p.attachments_json),
					replyTo: formatEmailReplyRef(
						parseReplyRef(p.reply_to_json),
						targetKey,
					),
					createdAt: p.created_at,
				})),
			});
		}
	}

	private getPlaybackAlarmDue(): number | null {
		const playback = this.getCurrentPlayback();
		if (!playback) return null;
		const delayMs =
			playback.durationSec > 0
				? playback.durationSec * 1000
				: UNKNOWN_DURATION_FALLBACK_MS;
		return playback.startedAt + delayMs;
	}

	private async syncNextAlarm(): Promise<void> {
		const playbackDue = this.hasConnectedSockets()
			? this.getPlaybackAlarmDue()
			: null;
		const pendingDueRow = this.ctx.storage.sql
			.exec<{ next_due: number | null }>(
				`SELECT MIN(m.cooldown_until) AS next_due
				 FROM pending_mention_emails p
				 JOIN room_members m ON m.user_key = p.target_user_key`,
			)
			.toArray()[0];

		const mentionDueRaw = pendingDueRow?.next_due ?? null;
		const mentionDue =
			typeof mentionDueRaw === "number" && Number.isFinite(mentionDueRaw)
				? Math.max(Date.now() + 100, mentionDueRaw)
				: null;

		const nextTs = computeNextAlarmTimestamp([playbackDue, mentionDue, this.getMatrix()?.due() ?? null]);
		if (nextTs !== null) {
			await this.ctx.storage.setAlarm(nextTs);
		} else {
			await this.ctx.storage.deleteAlarm();
		}
	}

	private broadcastPresence(excludeWs?: WebSocket): void {
		const presence = this.getPresenceSnapshot(excludeWs);
		const mentionMembers = this.getMentionDirectorySnapshot(excludeWs);
		const unmutedCount = presence.members.filter(
			(m) => m.isMuted === false,
		).length;
		const changed = this.reconcilePresenceTransition(
			presence.members.length,
			unmutedCount,
		);
		this.broadcast(
			{
				type: "presence:update",
				roomId: this.getRoomId(),
				...presence,
				mentionMembers,
			},
			excludeWs,
		);
		if (changed) {
			this.broadcastMusic(excludeWs);
		}
	}

	private broadcastMusic(excludeWs?: WebSocket): void {
		this.broadcast(
			{
				type: "music:state",
				roomId: this.getRoomId(),
				...this.getMusicSnapshot(excludeWs),
			},
			excludeWs,
		);
	}

	private async scheduleAlarmForPlayback(
		_playback: CurrentPlayback,
	): Promise<void> {
		await this.syncNextAlarm();
	}

	private async ensureActivePlayback(): Promise<void> {
		await this.withPlaybackLock(async () => {
			const current = this.getCurrentPlayback();
			if (!current) {
				if (this.getQueue().length > 0 || this.hasAnyFallbackSource()) {
					await this.advanceTrack("init");
				}
				return;
			}
			if (current.isFallback && !this.hasAnyFallbackSource()) {
				this.setStateValue("current_playback", null);
				await this.syncNextAlarm();
				if (this.getQueue().length > 0) {
					await this.advanceTrack("init");
				}
				return;
			}
			if (
				current.durationSec > 0 &&
				Date.now() >= current.startedAt + current.durationSec * 1000
			) {
				await this.advanceTrack("alarm");
			}
		});
	}

	private async startPlayEntry(params: {
		track: StandardTrack;
		requesterKey: string;
		requesterName: string;
		isFallback: boolean;
		reason:
			| "init"
			| "alarm"
			| "skip"
			| "vote"
			| "ended"
			| "error"
			| "host_pick";
		actorName?: string;
	}): Promise<void> {
		const registry = createMusicRegistry(this.env);
		const signSecret = this.env.STREAM_SIGN_SECRET || "dev-stream-secret";
		const origin = this.getWorkerOrigin();

		let playable = await registry.resolvePlayable(
			params.track,
			origin,
			signSecret,
		);

		// If primary requested online track failed to resolve, try next queue item or fallback
		if (!playable) {
			const systemMsg = this.appendMessage({
				kind: "system",
				userKey: "",
				name: "",
				avatar: "",
				url: "",
				badge: "",
				badgeType: "tag",
				isAdmin: false,
				content: `《${params.track.title}》音源解析失败，已自动顺延下一曲`,
				attachments: [],
				mentions: [],
			});
			this.broadcast({
				type: "chat:message",
				roomId: this.getRoomId(),
				message: systemMsg,
			});

			const queue = this.getQueue();
			if (queue.length > 0) {
				const [next, ..._rest] = queue;
				this.ctx.storage.sql.exec(
					"DELETE FROM music_queue WHERE uid = ?",
					next.uid,
				);
				await this.startPlayEntry({
					track: next.track,
					requesterKey: next.requesterKey,
					requesterName: next.requesterName,
					isFallback: false,
					reason: "error",
				});
				return;
			}

			const playlistFallback = await this.pickNextFallbackPlaylistTrack();
			if (playlistFallback) {
				const resolvedPlaylistPlayable = await registry.resolvePlayable(
					playlistFallback,
					origin,
					signSecret,
				);
				if (resolvedPlaylistPlayable) {
					playable = resolvedPlaylistPlayable;
					params = {
						track: playlistFallback,
						requesterKey: "system:fallback",
						requesterName: "电台顺序",
						isFallback: true,
						reason: "error",
					};
				}
			}

			if (!playable) {
				const fallbacks = this.getFallbackTracks();
				if (fallbacks.length === 0) {
					this.setStateValue("current_playback", null);
					await this.syncNextAlarm();
					this.broadcastMusic();
					return;
				}
				const fallbackTrack = fallbacks[0];
				playable = await registry.resolvePlayable(
					fallbackTrack,
					origin,
					signSecret,
				);
				if (!playable) {
					this.setStateValue("current_playback", null);
					await this.syncNextAlarm();
					this.broadcastMusic();
					return;
				}
				params = {
					track: fallbackTrack,
					requesterKey: "system:fallback",
					requesterName: "电台顺序",
					isFallback: true,
					reason: "error",
				};
			}
		}

		const playback: CurrentPlayback = {
			uid: crypto.randomUUID(),
			track: playable,
			requesterKey: params.requesterKey,
			requesterName: params.requesterName,
			isFallback: params.isFallback,
			startedAt: Date.now(),
			durationSec: playable.durationSec,
			skipVotes: [],
			errorReports: [],
		};

		this.setStateValue("current_playback", playback);
		await this.scheduleAlarmForPlayback(playback);

		if (params.reason === "skip" && params.actorName) {
			const msg = this.appendMessage({
				kind: "system",
				userKey: "",
				name: "",
				avatar: "",
				url: "",
				badge: "",
				badgeType: "tag",
				isAdmin: false,
				content: `${params.actorName} 切到了下一首《${playable.title}》`,
				attachments: [],
				mentions: [],
			});
			this.broadcast({
				type: "chat:message",
				roomId: this.getRoomId(),
				message: msg,
			});
		} else if (params.reason === "vote") {
			const msg = this.appendMessage({
				kind: "system",
				userKey: "",
				name: "",
				avatar: "",
				url: "",
				badge: "",
				badgeType: "tag",
				isAdmin: false,
				content: `投票切歌通过，已切至《${playable.title}》`,
				attachments: [],
				mentions: [],
			});
			this.broadcast({
				type: "chat:message",
				roomId: this.getRoomId(),
				message: msg,
			});
		} else if (params.reason === "host_pick" && params.actorName) {
			const msg = this.appendMessage({
				kind: "system",
				userKey: "",
				name: "",
				avatar: "",
				url: "",
				badge: "",
				badgeType: "tag",
				isAdmin: false,
				content: `${params.actorName} 切播了《${playable.title}》`,
				attachments: [],
				mentions: [],
			});
			this.broadcast({
				type: "chat:message",
				roomId: this.getRoomId(),
				message: msg,
			});
		}

		this.broadcastMusic();
	}

	private async advanceTrack(
		reason: "init" | "alarm" | "skip" | "vote" | "ended" | "error",
		actorName?: string,
	): Promise<void> {
		const queue = this.getQueue();
		if (queue.length > 0) {
			const next = queue[0];
			this.ctx.storage.sql.exec(
				"DELETE FROM music_queue WHERE uid = ?",
				next.uid,
			);
			await this.startPlayEntry({
				track: next.track,
				requesterKey: next.requesterKey,
				requesterName: next.requesterName,
				isFallback: false,
				reason,
				actorName,
			});
			return;
		}

		const playlistFallback = await this.pickNextFallbackPlaylistTrack();
		if (playlistFallback) {
			await this.startPlayEntry({
				track: playlistFallback,
				requesterKey: "system:fallback",
				requesterName: "电台顺序",
				isFallback: true,
				reason,
				actorName,
			});
			return;
		}

		const fallbacks = this.getFallbackTracks();
		if (fallbacks.length === 0) {
			this.setStateValue("current_playback", null);
			await this.syncNextAlarm();
			this.broadcastMusic();
			return;
		}
		const current = this.getCurrentPlayback();
		let nextIndex = 0;
		if (current) {
			const idx = fallbacks.findIndex((t) => t.id === current.track.id);
			if (idx >= 0) {
				nextIndex = (idx + 1) % fallbacks.length;
			}
		}
		const fallbackTrack = fallbacks[nextIndex];
		if (!fallbackTrack) {
			this.setStateValue("current_playback", null);
			await this.syncNextAlarm();
			this.broadcastMusic();
			return;
		}
		await this.startPlayEntry({
			track: fallbackTrack,
			requesterKey: "system:fallback",
			requesterName: "电台顺序",
			isFallback: true,
			reason,
			actorName,
		});
	}

	override async alarm(): Promise<void> {
		const matrix = this.getMatrix();
		try {
			const outcomes = await Promise.allSettled([
				this.runLocalAlarm(),
				matrix?.poll(),
				matrix?.drain(),
			]);
			for (const result of outcomes) {
				if (result.status === "rejected") throw result.reason;
			}
		} finally {
			await this.syncNextAlarm();
		}
	}

	private async runLocalAlarm(): Promise<void> {
		await this.flushDueMentionEmails();

		await this.withPlaybackLock(async () => {
			if (!this.hasConnectedSockets()) {
				const current = this.getCurrentPlayback();
				const playbackDue = this.getPlaybackAlarmDue();
				if (current && playbackDue !== null && Date.now() >= playbackDue) {
					this.setStateValue("current_playback", null);
				}
				await this.syncNextAlarm();
				return;
			}

			const current = this.getCurrentPlayback();
			const playbackDue = this.getPlaybackAlarmDue();
			if (!current) {
				if (this.getQueue().length > 0 || this.hasAnyFallbackSource()) {
					await this.advanceTrack("init");
				}
			} else if (playbackDue !== null && Date.now() >= playbackDue) {
				await this.advanceTrack("alarm");
			}

			await this.syncNextAlarm();
		});
	}

	private parseForwardedUser(request: Request): VerifiedUser | null {
		const raw = request.headers.get("X-Chat-User");
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as VerifiedUser;
			if (!parsed || typeof parsed.userKey !== "string") return null;
			return parsed;
		} catch {
			return null;
		}
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const roomId = (url.searchParams.get("room") || "chat").trim().toLowerCase();
		if (
			request.method === "GET" &&
			url.hostname === "room.internal" &&
			url.pathname.startsWith("/interconnect/media/")
		) {
			return (
				this.getMatrix()?.media(url.pathname.split("/").pop() ?? "") ??
				new Response(null, { status: 404 })
			);
		}
		if (
			url.hostname !== "room.internal" &&
			url.origin !== this.cachedWorkerOrigin
		) {
			this.cachedWorkerOrigin = url.origin;
			this.setStateValue("worker_origin", url.origin);
		}
		if (roomId !== this.cachedRoomId) {
			this.cachedRoomId = roomId;
			this.setStateValue("room_id", roomId);
		}

		this.runStartupMergesIfNeeded();

		// Internal migration endpoints are reachable only through a Durable Object binding.
		if (url.hostname === "room.internal" && url.pathname === "/playlist-export") {
			return Response.json({
				playlists: this.ctx.storage.sql.exec("SELECT * FROM user_playlists").toArray(),
				tracks: this.ctx.storage.sql.exec("SELECT * FROM user_playlist_tracks").toArray(),
			});
		}
		if (url.hostname === "room.internal" && url.pathname === "/fallback-selection" && request.method === "GET") {
			const selected = this.ctx.storage.sql.exec<{ id: string; owner_key: string; source_url: string; updated_at: number }>(
				"SELECT id, owner_key, source_url, updated_at FROM user_playlists WHERE is_fallback = 1 ORDER BY updated_at DESC LIMIT 1",
			).toArray()[0] ?? null;
			return Response.json({ selected });
		}
		if (url.hostname === "room.internal" && url.pathname === "/fallback-selection" && request.method === "POST") {
			const data = await request.json() as { playlist: Record<string, any> | null; tracks: Record<string, any>[] };
			this.ctx.storage.transactionSync(() => {
				this.ctx.storage.sql.exec("UPDATE user_playlists SET is_fallback = 0 WHERE is_fallback = 1");
				const p = data.playlist;
				if (!p) return;
				this.ctx.storage.sql.exec(`INSERT INTO user_playlists (id, owner_key, owner_name, title, platform, source_url, cover_url, creator, track_count, retrieval_mode, is_public, is_featured, is_fallback, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_name=excluded.owner_name, title=excluded.title, platform=excluded.platform, source_url=excluded.source_url, cover_url=excluded.cover_url, creator=excluded.creator, track_count=excluded.track_count, retrieval_mode=excluded.retrieval_mode, is_public=excluded.is_public, is_featured=excluded.is_featured, is_fallback=1, updated_at=excluded.updated_at`, p.id, p.owner_key, p.owner_name, p.title, p.platform, p.source_url, p.cover_url, p.creator, p.track_count, p.retrieval_mode, p.is_public, p.is_featured, p.created_at, p.updated_at);
				this.ctx.storage.sql.exec("DELETE FROM user_playlist_tracks WHERE playlist_id = ?", p.id);
				for (const t of data.tracks) {
					this.ctx.storage.sql.exec(`INSERT INTO user_playlist_tracks (playlist_id, position, source_platform, source_track_id, title, artist, album, cover, duration_sec, source_url, matched_track_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, p.id, t.position, t.source_platform, t.source_track_id, t.title, t.artist, t.album, t.cover, t.duration_sec, t.source_url, t.matched_track_json);
				}
			});
			await this.ensureActivePlayback();
			return Response.json({ ok: true });
		}
		if (url.hostname === "room.internal" && url.pathname === "/playlist-migrate") {
			if (!this.getStateValue<boolean>("shared_playlists_migrated_v1")) {
				const other = this.env.CHAT_ROOMS.get(this.env.CHAT_ROOMS.idFromName("interconnect"));
				const response = await other.fetch("https://room.internal/playlist-export?room=interconnect");
				if (!response.ok) return new Response("Playlist migration failed", { status: 503 });
				const data = await response.json() as { playlists: Record<string, any>[]; tracks: Record<string, any>[] };
				this.ctx.storage.transactionSync(() => {
					if (this.getStateValue<boolean>("shared_playlists_migrated_v1")) return;
					for (const p of data.playlists) {
						const existing = this.ctx.storage.sql.exec<{ id: string; updated_at: number; is_fallback: number }>(
							"SELECT id, updated_at, is_fallback FROM user_playlists WHERE owner_key = ? AND source_url = ? LIMIT 1", p.owner_key, p.source_url,
						).toArray()[0];
						if (existing && existing.updated_at >= p.updated_at) continue;
						if (existing) {
							this.ctx.storage.sql.exec("DELETE FROM user_playlist_tracks WHERE playlist_id = ?", existing.id);
							this.ctx.storage.sql.exec("DELETE FROM user_playlists WHERE id = ?", existing.id);
						}
						this.ctx.storage.sql.exec(`INSERT INTO user_playlists (id, owner_key, owner_name, title, platform, source_url, cover_url, creator, track_count, retrieval_mode, is_public, is_featured, is_fallback, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, p.id, p.owner_key, p.owner_name, p.title, p.platform, p.source_url, p.cover_url, p.creator, p.track_count, p.retrieval_mode, p.is_public, p.is_featured, existing?.is_fallback ?? 0, p.created_at, p.updated_at);
						for (const t of data.tracks.filter((track) => track.playlist_id === p.id)) {
							this.ctx.storage.sql.exec(`INSERT INTO user_playlist_tracks (playlist_id, position, source_platform, source_track_id, title, artist, album, cover, duration_sec, source_url, matched_track_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, t.playlist_id, t.position, t.source_platform, t.source_track_id, t.title, t.artist, t.album, t.cover, t.duration_sec, t.source_url, t.matched_track_json);
						}
					}
					this.setStateValue("shared_playlists_migrated_v1", true);
				});
			}
			return Response.json({ ok: true });
		}

		const skipPlaybackBoot =
			request.method === "GET" &&
			(url.pathname === "/check-waline-email" ||
				url.pathname === "/summary" ||
				url.pathname === "/presence-snapshot" ||
				url.pathname === "/member-playlists" ||
				url.pathname === "/member-profile" ||
				url.pathname === "/member-tracks" ||
				url.pathname === "/playlists" ||
				url.pathname === "/playlists/detail" ||
				url.pathname === "/admin/messages");
		if (!skipPlaybackBoot) {
			await this.ensureActivePlayback();
		}

		if (url.pathname === "/playlists" && request.method === "GET") {
			const user = this.parseForwardedUser(request);
			const includeTracks = url.searchParams.get("includeTracks") === "1";
			const data = this.listPlaylistsForUser(user, includeTracks);
			return Response.json({ ok: true, ...data });
		}

		if (url.pathname === "/playlists/detail" && request.method === "GET") {
			const playlistId = (url.searchParams.get("id") || "").trim();
			if (!playlistId) {
				return Response.json(
					{ ok: false, error: "缺少歌单 ID" },
					{ status: 400 },
				);
			}
			const user = this.parseForwardedUser(request);
			const result = this.getPlaylistDetailForUser(playlistId, user);
			if (!result.ok) {
				return Response.json(
					{ ok: false, error: result.error },
					{ status: result.status },
				);
			}
			return Response.json({ ok: true, playlist: result.playlist });
		}

		if (url.pathname === "/playlists/import" && request.method === "POST") {
			const user = this.parseForwardedUser(request);
			if (user?.authType !== "waline") {
				return Response.json(
					{ ok: false, error: "请先登录账号后再导入歌单" },
					{ status: 401 },
				);
			}
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return Response.json(
					{ ok: false, error: "请求体格式错误" },
					{ status: 400 },
				);
			}
			const sanitized = sanitizePlaylistPayload(body);
			if (!sanitized.ok) {
				return Response.json(
					{ ok: false, error: sanitized.error },
					{ status: 400 },
				);
			}
			const result = this.importPlaylistForUser(user, sanitized.data);
			if (!result.ok) {
				return Response.json(
					{ ok: false, error: result.error },
					{ status: result.status },
				);
			}
			return Response.json({
				ok: true,
				playlist: result.playlist,
				updatedExisting: result.updatedExisting,
			});
		}

		if (url.pathname === "/playlists/refresh" && request.method === "POST") {
			const user = this.parseForwardedUser(request);
			if (user?.authType !== "waline") {
				return Response.json(
					{ ok: false, error: "请先登录账号后再刷新歌单" },
					{ status: 401 },
				);
			}
			let body: { playlistId?: unknown; playlist?: unknown };
			try {
				body = (await request.json()) as {
					playlistId?: unknown;
					playlist?: unknown;
				};
			} catch {
				return Response.json(
					{ ok: false, error: "请求体格式错误" },
					{ status: 400 },
				);
			}
			const playlistId =
				typeof body.playlistId === "string" ? body.playlistId.trim() : "";
			if (!playlistId) {
				return Response.json(
					{ ok: false, error: "缺少歌单 ID" },
					{ status: 400 },
				);
			}
			const sanitized = sanitizePlaylistPayload(body.playlist);
			if (!sanitized.ok) {
				return Response.json(
					{ ok: false, error: sanitized.error },
					{ status: 400 },
				);
			}
			const result = this.refreshPlaylistForUser(
				user,
				playlistId,
				sanitized.data,
			);
			if (!result.ok) {
				return Response.json(
					{ ok: false, error: result.error },
					{ status: result.status },
				);
			}
			return Response.json({ ok: true, playlist: result.playlist });
		}

		if (url.pathname === "/playlists/flags" && request.method === "POST") {
			const user = this.parseForwardedUser(request);
			if (user?.authType !== "waline") {
				return Response.json(
					{ ok: false, error: "请先登录账号" },
					{ status: 401 },
				);
			}
			let body: {
				playlistId?: unknown;
				isPublic?: unknown;
				isFeatured?: unknown;
				isFallback?: unknown;
			};
			try {
				body = (await request.json()) as {
					playlistId?: unknown;
					isPublic?: unknown;
					isFeatured?: unknown;
					isFallback?: unknown;
				};
			} catch {
				return Response.json(
					{ ok: false, error: "请求体格式错误" },
					{ status: 400 },
				);
			}
			const playlistId =
				typeof body.playlistId === "string" ? body.playlistId.trim() : "";
			if (!playlistId) {
				return Response.json(
					{ ok: false, error: "缺少歌单 ID" },
					{ status: 400 },
				);
			}
			const result = this.updatePlaylistFlagsForUser(user, playlistId, {
				isPublic:
					typeof body.isPublic === "boolean" ? body.isPublic : undefined,
				isFeatured:
					typeof body.isFeatured === "boolean" ? body.isFeatured : undefined,
				isFallback:
					typeof body.isFallback === "boolean" ? body.isFallback : undefined,
			});
			if (!result.ok) {
				return Response.json(
					{ ok: false, error: result.error },
					{ status: result.status },
				);
			}
			if (
				typeof body.isFallback === "boolean" &&
				body.isFallback &&
				!this.getCurrentPlayback()
			) {
				await this.ensureActivePlayback();
			}
			return Response.json({ ok: true, playlist: result.playlist });
		}

		if (url.pathname === "/playlists/delete" && request.method === "POST") {
			const user = this.parseForwardedUser(request);
			if (user?.authType !== "waline") {
				return Response.json(
					{ ok: false, error: "请先登录账号" },
					{ status: 401 },
				);
			}
			let body: { playlistId?: unknown };
			try {
				body = (await request.json()) as { playlistId?: unknown };
			} catch {
				return Response.json(
					{ ok: false, error: "请求体格式错误" },
					{ status: 400 },
				);
			}
			const playlistId =
				typeof body.playlistId === "string" ? body.playlistId.trim() : "";
			if (!playlistId) {
				return Response.json(
					{ ok: false, error: "缺少歌单 ID" },
					{ status: 400 },
				);
			}
			const result = this.deletePlaylistForUser(user, playlistId);
			if (!result.ok) {
				return Response.json(
					{ ok: false, error: result.error },
					{ status: result.status },
				);
			}
			return Response.json({ ok: true });
		}

		if (url.pathname === "/summary") {
			const presence = this.getPresenceSnapshot();
			return Response.json({
				roomId,
				onlineCount: presence.totalCount,
				memberCount: presence.members.length,
			});
		}
		if (url.pathname === "/presence-snapshot" && url.hostname === "room.internal") {
			return Response.json(this.getPresenceSnapshot());
		}
		if (url.pathname === "/member-playlists" && url.hostname === "room.internal") {
			const userKey = url.searchParams.get("userKey") || "";
			const viewer = this.parseForwardedUser(request);
			const privateAccess = Boolean(viewer && (viewer.isAdmin || (viewer.authType === "waline" && viewer.userKey === userKey)));
			const rows = this.ctx.storage.sql.exec<{ id: string; title: string; platform: string; cover_url: string; track_count: number }>(
				`SELECT id, title, platform, cover_url, track_count FROM user_playlists WHERE owner_key = ? ${privateAccess ? "" : "AND (is_public = 1 OR is_featured = 1)"} ORDER BY is_featured DESC, is_public DESC, updated_at DESC LIMIT 8`, userKey,
			).toArray();
			return Response.json({ playlists: rows.map((p) => ({ id: p.id, title: p.title, platform: p.platform, coverUrl: p.cover_url, trackCount: p.track_count })) });
		}

		if (url.pathname === "/member-profile") {
			const userKey = (url.searchParams.get("userKey") || "").trim();
			if (!userKey) {
				return Response.json(
					{ ok: false, error: "缺少用户标识" },
					{ status: 400 },
				);
			}
			const tracksLimit =
				Number.parseInt(url.searchParams.get("tracksLimit") || "50", 10) || 50;
			const viewerUser = this.parseForwardedUser(request);
			const profile = this.getMemberProfileSnapshot(
				userKey,
				tracksLimit,
				viewerUser,
			);
			if (!profile) {
				return Response.json(
					{ ok: false, error: "未找到该成员信息" },
					{ status: 404 },
				);
			}
			return Response.json({ ok: true, profile });
		}

		if (url.pathname === "/member-tracks") {
			const userKey = (url.searchParams.get("userKey") || "").trim();
			if (!userKey) {
				return Response.json(
					{ ok: false, error: "缺少用户标识" },
					{ status: 400 },
				);
			}
			const limit =
				Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50;
			const beforeId =
				Number.parseInt(url.searchParams.get("beforeId") || "0", 10) || 0;
			const page = this.getMemberTracksPage(userKey, limit, beforeId);
			return Response.json({ ok: true, ...page });
		}

		if (url.pathname === "/admin/messages") {
			const filterParam = (url.searchParams.get("filter") || "all").trim();
			const filter =
				filterParam === "recalled" || filterParam === "normal"
					? filterParam
					: "all";
			const limit =
				Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100;
			const beforeId =
				Number.parseInt(url.searchParams.get("beforeId") || "0", 10) || 0;
			const items = this.getAdminMessages({ filter, limit, beforeId });
			return Response.json({
				ok: true,
				roomId,
				filter,
				messages: items,
			});
		}

		if (url.pathname === "/admin/members" && request.method === "GET") {
			const rows = this.ctx.storage.sql
				.exec<{
					user_key: string;
					auth_type: string;
					name: string;
					email: string;
					avatar: string;
					is_admin: number;
					first_seen_at: number;
					last_seen_at: number;
				}>(
					`SELECT user_key, auth_type, name, email, avatar, is_admin, first_seen_at, last_seen_at
					 FROM room_members
					 ORDER BY last_seen_at DESC
					 LIMIT 500`,
				)
				.toArray();
			return Response.json({
				ok: true,
				roomId,
				members: rows.map((r) => ({
					userKey: r.user_key,
					authType: r.auth_type,
					name: r.name,
					email: r.email,
					avatar: r.avatar,
					isAdmin: r.is_admin === 1,
					firstSeenAt: r.first_seen_at,
					lastSeenAt: r.last_seen_at,
				})),
			});
		}

		if (url.pathname === "/admin/members/merge" && request.method === "POST") {
			let body: { sourceUserKey?: unknown; targetUserKey?: unknown };
			try {
				body = (await request.json()) as {
					sourceUserKey?: unknown;
					targetUserKey?: unknown;
				};
			} catch {
				return Response.json(
					{ ok: false, error: "请求体格式错误" },
					{ status: 400 },
				);
			}
			const sourceUserKey =
				typeof body.sourceUserKey === "string" ? body.sourceUserKey.trim() : "";
			const targetUserKey =
				typeof body.targetUserKey === "string" ? body.targetUserKey.trim() : "";
			if (!sourceUserKey || !targetUserKey || sourceUserKey === targetUserKey) {
				return Response.json(
					{ ok: false, error: "请提供不同的源账号与目标账号 userKey" },
					{ status: 400 },
				);
			}
			const res = this.mergeMemberIntoTarget(
				sourceUserKey,
				targetUserKey,
				true,
			);
			if (!res.ok) {
				return Response.json(
					{ ok: false, error: res.error || "合并失败" },
					{ status: 404 },
				);
			}
			return Response.json({
				ok: true,
				merged: res.merged,
				targetUser: res.targetUser ?? null,
			});
		}

		if (url.pathname === "/admin/members/delete" && request.method === "POST") {
			let body: { userKey?: unknown };
			try {
				body = (await request.json()) as { userKey?: unknown };
			} catch {
				return Response.json(
					{ ok: false, error: "请求体格式错误" },
					{ status: 400 },
				);
			}
			const targetKey =
				typeof body.userKey === "string" ? body.userKey.trim() : "";
			if (!targetKey) {
				return Response.json(
					{ ok: false, error: "缺少 userKey" },
					{ status: 400 },
				);
			}
			const res = this.deleteMemberByUserKey(targetKey, true);
			return Response.json({ ok: res.ok, deleted: res.deleted });
		}

		if (url.pathname === "/check-waline-email" && request.method === "GET") {
			const email = (url.searchParams.get("email") || "").trim().toLowerCase();
			return Response.json({
				ok: true,
				exists: this.hasWalineMemberByEmail(email),
			});
		}

		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket Upgrade", { status: 426 });
		}

		const authKind = url.searchParams.get("authKind") || "";
		const token = url.searchParams.get("token") || "";

		let user: VerifiedUser | null = null;
		let rawBaseName = "";
		let rawBaseAvatar = "";
		let rawBaseUrl = "";
		let mergedFromKeys: string[] = [];
		let mergedMusicChanged = false;
		let guestRejectedByWaline = false;
		let tokenInvalidKind: "waline" | "guest" | null = null;
		if (authKind === "waline" && token) {
			const session = await verifyWalineTokenWithEmail(this.env, token);
			if (session) {
				rawBaseName = session.user.name;
				rawBaseAvatar = session.user.avatar;
				rawBaseUrl = session.user.url;
				const res = this.upsertRoomMemberWithMerge(session.user, session.email);
				user = res.user;
				mergedFromKeys = res.mergedFromKeys;
				mergedMusicChanged = res.musicChanged;
			} else {
				tokenInvalidKind = "waline";
			}
		} else if (authKind === "guest" && token) {
			const session = await verifyGuestTokenWithEmail(this.env, token);
			if (session) {
				if (
					this.isGuestEmailBlockedByWaline(
						session.email,
						Boolean(session.isolated),
					)
				) {
					guestRejectedByWaline = true;
				} else {
					rawBaseName = session.user.name;
					rawBaseAvatar = session.user.avatar;
					rawBaseUrl = session.user.url;
					user = this.upsertRoomMember(session.user, session.email);
				}
			} else {
				tokenInvalidKind = "guest";
			}
		}

		if (user) {
			if (mergedFromKeys.length > 0) {
				this.syncMergedSockets(mergedFromKeys, user, undefined, {
					baseName: rawBaseName,
					baseAvatar: rawBaseAvatar,
					baseUrl: rawBaseUrl,
				});
			}
			await this.markMemberOnline(user.userKey);
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		const attachment: WsAttachment = {
			connId: crypto.randomUUID(),
			roomId,
			user,
			baseName: rawBaseName,
			baseAvatar: rawBaseAvatar,
			baseUrl: rawBaseUrl,
			connectedAt: Date.now(),
			isMuted: true,
		};

		const firstSocket = !this.hasConnectedSockets();
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(attachment);

		const presence = this.getPresenceSnapshot();
		const mentionMembers = this.getMentionDirectorySnapshot();
		const unmutedCount = presence.members.filter(
			(m) => m.isMuted === false,
		).length;
		const changed = this.reconcilePresenceTransition(
			presence.members.length,
			unmutedCount,
		);
		const messages = this.getRecentMessages();
		const oldestLoadedId = messages[0]?.id ?? 0;
		const hasMoreHistory =
			oldestLoadedId > 0 ? this.hasMessagesBefore(oldestLoadedId) : false;

		const queryLastReadAt = Number(url.searchParams.get("lastReadAt")) || 0;
		const serverLastReadAt = user ? this.getMemberLastReadAt(user.userKey) : 0;
		const effectiveLastReadAt = Math.max(
			Number.isFinite(queryLastReadAt) && queryLastReadAt > 0
				? queryLastReadAt
				: 0,
			serverLastReadAt,
		);
		const unreadCount =
			effectiveLastReadAt > 0
				? this.countMessagesSince(effectiveLastReadAt, true)
				: 0;
		const unreadUserCount =
			effectiveLastReadAt > 0
				? this.countMessagesSince(effectiveLastReadAt, false)
				: 0;
		const music = this.getMusicSnapshot();

		this.send(server, {
			type: "room:init",
			roomId,
			self: user,
			mergedGuestHistory: mergedFromKeys.length > 0,
			interconnected: this.getMatrix()?.enabled || undefined,
			messages,
			hasMoreHistory,
			lastReadAt: effectiveLastReadAt,
			unreadCount,
			unreadUserCount,
			...presence,
			mentionMembers,
			music,
		});

		if (guestRejectedByWaline) {
			this.send(server, {
				type: "error",
				code: "WALINE_LOGIN_REQUIRED",
				message:
					"检测到该邮箱已绑定正式账号，旧访客凭证已失效，请使用 Waline 重新登录",
			});
		} else if (tokenInvalidKind) {
			this.send(server, {
				type: "error",
				code: "TOKEN_INVALID",
				authKind: tokenInvalidKind,
				message:
					tokenInvalidKind === "waline"
						? "Waline 登录凭证已过期或失效，请重新登录"
						: "临时访客凭证已过期或失效，请重新认证",
			});
		}

		// Notify other connections that presence changed
		this.broadcast(
			{
				type: "presence:update",
				roomId,
				...presence,
				mentionMembers,
			},
			server,
		);
		if (mergedFromKeys.length > 0 && user) {
			this.broadcast(
				{
					type: "member:merged",
					roomId,
					fromUserKeys: mergedFromKeys,
					user,
				},
				server,
			);
		}
		if (changed || mergedMusicChanged) {
			this.broadcast(
				{
					type: "music:state",
					roomId,
					...music,
				},
				server,
			);
		}

		const matrix = this.getMatrix();
		if (matrix?.enabled && firstSocket) {
			matrix.wake();
			await this.syncNextAlarm();
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		if (typeof message !== "string") return;

		let packet: { type?: string; [key: string]: unknown };
		try {
			packet = JSON.parse(message) as { type?: string; [key: string]: unknown };
		} catch {
			return;
		}

		const attachment = ws.deserializeAttachment() as WsAttachment | null;
		if (!attachment) return;

		switch (packet.type) {
			case "ping": {
				this.send(ws, { type: "pong", serverTime: Date.now() });
				return;
			}

			case "auth:sync": {
				const authKind = String(packet.authKind || "");
				const token = String(packet.token || "");
				let verified: VerifiedUser | null = null;
				let rawBaseName = "";
				let rawBaseAvatar = "";
				let rawBaseUrl = "";
				let mergedFromKeys: string[] = [];
				let mergedMusicChanged = false;
				let guestRejectedByWaline = false;
				let tokenInvalidKind: "waline" | "guest" | null = null;
				if (authKind === "waline" && token) {
					const session = await verifyWalineTokenWithEmail(this.env, token);
					if (session) {
						rawBaseName = session.user.name;
						rawBaseAvatar = session.user.avatar;
						rawBaseUrl = session.user.url;
						const res = this.upsertRoomMemberWithMerge(
							session.user,
							session.email,
						);
						verified = res.user;
						mergedFromKeys = res.mergedFromKeys;
						mergedMusicChanged = res.musicChanged;
					} else {
						tokenInvalidKind = "waline";
					}
				} else if (authKind === "guest" && token) {
					const session = await verifyGuestTokenWithEmail(this.env, token);
					if (session) {
						if (
							this.isGuestEmailBlockedByWaline(
								session.email,
								Boolean(session.isolated),
							)
						) {
							guestRejectedByWaline = true;
						} else {
							rawBaseName = session.user.name;
							rawBaseAvatar = session.user.avatar;
							rawBaseUrl = session.user.url;
							verified = this.upsertRoomMember(session.user, session.email);
						}
					} else {
						tokenInvalidKind = "guest";
					}
				}
				attachment.user = verified;
				attachment.baseName = rawBaseName;
				attachment.baseAvatar = rawBaseAvatar;
				attachment.baseUrl = rawBaseUrl;
				ws.serializeAttachment(attachment);
				if (verified) {
					if (mergedFromKeys.length > 0) {
						this.syncMergedSockets(mergedFromKeys, verified, ws, {
							baseName: rawBaseName,
							baseAvatar: rawBaseAvatar,
							baseUrl: rawBaseUrl,
						});
					}
					await this.markMemberOnline(verified.userKey);
				}
				this.send(ws, {
					type: "auth:result",
					user: verified,
					mergedGuestHistory: mergedFromKeys.length > 0,
				});
				if (guestRejectedByWaline) {
					this.send(ws, {
						type: "error",
						code: "WALINE_LOGIN_REQUIRED",
						message:
							"该邮箱已绑定正式账号，为防止身份分裂及他人冒用，请直接通过 Waline 账号登录",
					});
				} else if (tokenInvalidKind) {
					this.send(ws, {
						type: "error",
						code: "TOKEN_INVALID",
						authKind: tokenInvalidKind,
						message:
							tokenInvalidKind === "waline"
								? "Waline 登录凭证已过期或失效，请重新登录"
								: "临时访客凭证已过期或失效，请重新认证",
					});
				}
				if (mergedFromKeys.length > 0 && verified) {
					this.broadcast({
						type: "member:merged",
						roomId: this.getRoomId(),
						fromUserKeys: mergedFromKeys,
						user: verified,
					});
					if (mergedMusicChanged) {
						this.broadcastMusic();
					}
				}
				this.broadcastPresence();
				return;
			}

			case "auth:logout": {
				if (attachment.user) {
					this.touchMemberLastSeen(attachment.user.userKey);
				}
				attachment.user = null;
				attachment.baseName = "";
				attachment.baseAvatar = "";
				attachment.baseUrl = "";
				attachment.isMuted = true;
				ws.serializeAttachment(attachment);
				this.send(ws, { type: "auth:result", user: null });
				this.broadcastPresence();
				return;
			}

			case "presence:audio": {
				const nextMuted = packet.isMuted !== false;
				if ((attachment.isMuted !== false) !== nextMuted) {
					attachment.isMuted = nextMuted;
					ws.serializeAttachment(attachment);
					if (attachment.user) {
						this.broadcastPresence();
					}
				}
				return;
			}

			case "auth:update_profile": {
				const currentUser = attachment.user;
				if (!currentUser) {
					this.send(ws, {
						type: "error",
						message: "请先完成身份认证再修改资料",
					});
					return;
				}
				const nextNameRaw =
					typeof packet.nickname === "string" ? packet.nickname : "";
				const cleanedName = sanitizeDisplayName(nextNameRaw);

				let finalName = currentUser.name;
				if (cleanedName) {
					if (!currentUser.isAdmin && isReservedGuestName(cleanedName)) {
						this.send(ws, {
							type: "error",
							message: "该昵称为站长/系统保留名称",
						});
						return;
					}
					finalName = cleanedName;
				}

				const badgeInfo = resolveRoleBadge(
					currentUser.authType,
					currentUser.isAdmin,
				);
				const nextStatus =
					typeof packet.status === "string"
						? sanitizeStatus(packet.status)
						: currentUser.status || "在线";
				const nextUrl =
					typeof packet.url === "string"
						? sanitizeWebsiteUrl(packet.url)
						: currentUser.url;

				let nextAvatar = currentUser.avatar;
				let customAvatarValue: string | undefined;
				if (typeof packet.avatar === "string") {
					const trimmedAvatar = packet.avatar.trim();
					if (!trimmedAvatar) {
						nextAvatar = attachment.baseAvatar ?? "";
						customAvatarValue = "";
					} else {
						const safeAvatar = sanitizeAvatarUrl(trimmedAvatar);
						if (!safeAvatar) {
							this.send(ws, {
								type: "error",
								message: "头像链接仅支持 http/https 图片地址",
							});
							return;
						}
						nextAvatar = safeAvatar;
						customAvatarValue =
							attachment.baseAvatar !== undefined &&
							safeAvatar === attachment.baseAvatar
								? ""
								: safeAvatar;
					}
				} else {
					customAvatarValue =
						attachment.baseAvatar !== undefined &&
						currentUser.avatar === attachment.baseAvatar
							? ""
							: currentUser.avatar;
				}

				const customNameValue =
					attachment.baseName !== undefined && finalName === attachment.baseName
						? ""
						: finalName;
				const hasCustomUrlValue =
					typeof packet.url === "string"
						? attachment.baseUrl === undefined || nextUrl !== attachment.baseUrl
						: attachment.baseUrl === undefined ||
							currentUser.url !== attachment.baseUrl;

				const isIsolatedGuest =
					currentUser.authType === "guest" &&
					(Boolean(currentUser.isolated) ||
						isIsolatedGuestUserKey(currentUser.userKey));
				const notifyEmailOverride = isIsolatedGuest
					? false
					: typeof packet.notifyEmail === "boolean"
						? packet.notifyEmail
						: undefined;
				const bioOverride =
					typeof packet.bio === "string" ? sanitizeBio(packet.bio) : undefined;

				const updatedUser = this.upsertRoomMember(
					{
						...currentUser,
						name: finalName,
						avatar: nextAvatar,
						url: nextUrl,
						badge: badgeInfo.badge,
						badgeType: badgeInfo.badgeType,
						status: nextStatus,
					},
					"",
					notifyEmailOverride,
					bioOverride,
					{
						customName: customNameValue,
						customAvatar: customAvatarValue,
						customUrl: nextUrl,
						hasCustomUrl: hasCustomUrlValue,
					},
				);
				attachment.user = updatedUser;
				ws.serializeAttachment(attachment);

				// Propagate updated profile across all sockets of the same userKey
				for (const peer of this.ctx.getWebSockets()) {
					if (peer === ws) continue;
					const peerAtt = peer.deserializeAttachment() as WsAttachment | null;
					if (peerAtt?.user?.userKey === updatedUser.userKey) {
						peerAtt.user = updatedUser;
						peer.serializeAttachment(peerAtt);
						this.send(peer, { type: "auth:result", user: updatedUser });
					}
				}

				this.send(ws, { type: "auth:result", user: updatedUser });
				this.broadcastPresence();
				return;
			}

			case "room:register_fallback": {
				if (!Array.isArray(packet.tracks)) return;
				const validLocal: StandardTrack[] = [];
				for (const raw of packet.tracks.slice(0, 30)) {
					if (!raw || typeof raw !== "object") continue;
					const t = raw as Partial<StandardTrack>;
					if (
						typeof t.id === "string" &&
						typeof t.title === "string" &&
						typeof t.artist === "string" &&
						typeof t.url === "string" &&
						t.url.startsWith("/assets/music/")
					) {
						validLocal.push({
							id: t.id,
							provider: "local",
							sourceId: t.id,
							title: t.title.slice(0, 120),
							artist: t.artist.slice(0, 120),
							cover:
								typeof t.cover === "string" && t.cover.startsWith("/")
									? t.cover
									: "/assets/music/cover/oh-my-girl.webp",
							url: t.url,
							lrc:
								typeof t.lrc === "string" && t.lrc.startsWith("/")
									? t.lrc
									: undefined,
							durationSec: 0,
						});
					}
				}
				await this.withPlaybackLock(async () => {
					this.setStateValue("fallback_tracks", validLocal);
					if (!this.hasAnyFallbackSource()) {
						const current = this.getCurrentPlayback();
						if (current?.isFallback) {
							this.setStateValue("current_playback", null);
							await this.syncNextAlarm();
							this.broadcastMusic();
						}
					}
				});
				return;
			}

			case "chat:send": {
				const user = attachment.user;
				if (!user) {
					this.send(ws, {
						type: "error",
						code: "AUTH_REQUIRED",
						message: "请先登录或填写访客信息后再发言",
					});
					return;
				}

				if (!user.isAdmin && !this.allowChatRate(attachment.connId)) {
					this.send(ws, {
						type: "error",
						message: "发言太快啦，请稍微歇两秒再发",
					});
					return;
				}

				const rawContent =
					typeof packet.content === "string" ? packet.content : "";
				const content = rawContent.replace(/\r\n/g, "\n").trim().slice(0, 1000);
				const attachments = this.validateAttachments(packet.attachments);

				if (!content && attachments.length === 0) {
					return;
				}

				const explicitKeys = Array.isArray(packet.mentionKeys)
					? packet.mentionKeys
							.filter((k): k is string => typeof k === "string" && k.length > 0)
							.slice(0, 20)
					: [];

				const rawTokens = extractMentions(content);
				const resolved = resolveMentionTargets({
					senderUserKey: user.userKey,
					content,
					rawTokens,
					explicitKeys,
					candidates: this.getMentionCandidates(),
				});

				const replyToUid =
					typeof packet.replyToUid === "string" ? packet.replyToUid.trim() : "";
				const replyTo = replyToUid ? this.resolveReplyTarget(replyToUid) : null;

				const matrix = this.getMatrix();
				const pendingStickers = matrix?.enabled
					? matrix.resolveStickers(content)
					: undefined;
				const resolvedStickers = pendingStickers
					? await pendingStickers
					: undefined;
				if (pendingStickers) {
					const current = ws.deserializeAttachment() as WsAttachment | null;
					if (ws.readyState !== WebSocket.OPEN || current?.user?.userKey !== user.userKey) {
						return;
					}
				}
				const saved = this.ctx.storage.transactionSync(() => {
					const record = this.appendMessage({
						kind: "user",
						userKey: user.userKey,
						name: user.name,
						avatar: user.avatar,
						url: user.url,
						badge: user.badge,
						badgeType: user.badgeType,
						isAdmin: user.isAdmin,
						content,
						attachments,
						mentions: resolved.matchedNames,
						mentionKeys: resolved.targetUserKeys,
						replyTo,
					});
					matrix?.enqueue(record, resolvedStickers);
					return record;
				});

				this.broadcast({
					type: "chat:message",
					roomId: this.getRoomId(),
					message: saved,
				});
				this.updateMemberLastReadAt(user.userKey, saved.createdAt);
				if (matrix?.enabled) await this.syncNextAlarm();

				const notifyUserKeys = mergeNotificationTargets({
					mentionUserKeys: resolved.targetUserKeys,
					replyToUserKey: replyTo?.userKey,
					senderUserKey: user.userKey,
				});
				if (notifyUserKeys.length > 0) {
					this.ctx.waitUntil(this.dispatchChatMentions(saved, notifyUserKeys));
				}
				return;
			}

			case "chat:load_history": {
				const beforeId = Number(packet.beforeId) || 0;
				const sinceCreatedAt = Number(packet.sinceCreatedAt) || 0;
				const jumpTarget = Boolean(packet.jumpTarget);
				if (beforeId <= 0) {
					this.send(ws, {
						type: "chat:history_batch",
						roomId: this.getRoomId(),
						messages: [],
						hasMoreHistory: false,
						jumpTarget,
					});
					return;
				}
				const batch = this.getMessagesBefore({
					beforeId,
					sinceCreatedAt: sinceCreatedAt > 0 ? sinceCreatedAt : undefined,
				});
				this.send(ws, {
					type: "chat:history_batch",
					roomId: this.getRoomId(),
					messages: batch.messages,
					hasMoreHistory: batch.hasMoreHistory,
					jumpTarget,
				});
				return;
			}

			case "chat:mark_read": {
				const user = attachment.user;
				const timestamp = Number(packet.timestamp) || 0;
				if (user && Number.isFinite(timestamp) && timestamp > 0) {
					this.updateMemberLastReadAt(user.userKey, timestamp);
				}
				return;
			}

			case "chat:recall": {
				const user = attachment.user;
				const msgUid = typeof packet.msgUid === "string" ? packet.msgUid : "";
				if (!user || !msgUid) return;

				const row = this.ctx.storage.sql
					.exec<{
						kind: string;
						user_key: string;
						name: string;
						created_at: number;
						is_recalled: number;
					}>(
						"SELECT kind, user_key, name, created_at, is_recalled FROM messages WHERE msg_uid = ?",
						msgUid,
					)
					.toArray()[0];
				if (!row || row.is_recalled === 1 || row.kind !== "user") return;

				const recallCheck = canRecallMessage({
					msgUserKey: row.user_key,
					msgCreatedAt: row.created_at,
					actorUserKey: user.userKey,
					actorIsAdmin: user.isAdmin,
				});
				if (!recallCheck.allowed) {
					this.send(ws, {
						type: "error",
						message: recallCheck.reason || "无权撤回该消息",
					});
					return;
				}

				const recalledAt = Date.now();
				const matrix = this.getMatrix();
				this.ctx.storage.transactionSync(() => {
					this.ctx.storage.sql.exec(
						`UPDATE messages
						 SET is_recalled = 1,
						     status = 'recalled',
						     recalled_at = ?,
						     recalled_by = ?,
						     recalled_by_name = ?
						 WHERE msg_uid = ?`,
						recalledAt,
						user.userKey,
						user.name,
						msgUid,
					);
					this.ctx.storage.sql.exec(
						"DELETE FROM pending_mention_emails WHERE msg_uid = ?",
						msgUid,
					);
					matrix?.enqueueDeletion(msgUid);
				});
				if (matrix?.enabled) await this.syncNextAlarm();
				this.broadcast({
					type: "chat:deleted",
					roomId: this.getRoomId(),
					msgUid,
					recalled: true,
				});

				const notice = this.appendMessage({
					kind: "system",
					userKey: user.userKey,
					name: user.name,
					avatar: user.avatar,
					url: user.url,
					badge: user.badge,
					badgeType: user.badgeType,
					isAdmin: user.isAdmin,
					content: buildRecallNoticeContent({
						actorUserKey: user.userKey,
						actorName: user.name,
						msgUserKey: row.user_key,
						msgAuthorName: row.name,
					}),
					attachments: [],
					mentions: user.userKey !== row.user_key ? [row.name] : [],
					mentionKeys: user.userKey !== row.user_key ? [row.user_key] : [],
				});
				this.broadcast({
					type: "chat:message",
					roomId: this.getRoomId(),
					message: notice,
				});
				return;
			}

			case "chat:delete": {
				const user = attachment.user;
				const msgUid = typeof packet.msgUid === "string" ? packet.msgUid : "";
				if (!user || !msgUid) return;

				const deleteCheck = canSilentDeleteMessage({
					actorUserKey: user.userKey,
					actorIsAdmin: user.isAdmin,
				});
				if (!deleteCheck.allowed) {
					this.send(ws, {
						type: "error",
						message: deleteCheck.reason || "无权删除该消息",
					});
					return;
				}

				const row = this.ctx.storage.sql
					.exec<{
						kind: string;
						is_recalled: number;
					}>("SELECT kind, is_recalled FROM messages WHERE msg_uid = ?", msgUid)
					.toArray()[0];
				if (!row || row.is_recalled === 1 || row.kind !== "user") return;

				const recalledAt = Date.now();
				const matrix = this.getMatrix();
				this.ctx.storage.transactionSync(() => {
					this.ctx.storage.sql.exec(
						`UPDATE messages
						 SET is_recalled = 1,
						     status = 'deleted',
						     recalled_at = ?,
						     recalled_by = ?,
						     recalled_by_name = ?
						 WHERE msg_uid = ?`,
						recalledAt,
						user.userKey,
						user.name,
						msgUid,
					);
					this.ctx.storage.sql.exec(
						"DELETE FROM pending_mention_emails WHERE msg_uid = ?",
						msgUid,
					);
					matrix?.enqueueDeletion(msgUid);
				});
				if (matrix?.enabled) await this.syncNextAlarm();
				this.broadcast({
					type: "chat:deleted",
					roomId: this.getRoomId(),
					msgUid,
					recalled: false,
				});
				return;
			}

			case "music:enqueue": {
				const user = attachment.user;
				if (!user) {
					this.send(ws, {
						type: "error",
						code: "AUTH_REQUIRED",
						message: "请先登录或填写访客信息后再点歌",
					});
					return;
				}

				const rawTrack = packet.track as
					| (Partial<StandardTrack> & {
							sourcePlatform?: unknown;
							playlistId?: unknown;
							position?: unknown;
					  })
					| undefined;
				const allowedProviders = new Set(
					createMusicRegistry(this.env)
						.listProviders()
						.map((p) => p.id),
				);
				let track = sanitizeIncomingTrack(rawTrack, allowedProviders);
				if (
					!track &&
					rawTrack &&
					rawTrack.provider === "external" &&
					typeof rawTrack.title === "string" &&
					rawTrack.title.trim()
				) {
					const playlistId =
						typeof rawTrack.playlistId === "string"
							? rawTrack.playlistId.trim()
							: "";
					const position =
						typeof rawTrack.position === "number" &&
						Number.isInteger(rawTrack.position) &&
						rawTrack.position >= 0
							? rawTrack.position
							: -1;
					const cacheRef =
						playlistId && position >= 0 ? { playlistId, position } : undefined;
					const resolved = await this.resolveExternalTrackToStandardTrack(
						{
							sourcePlatform:
								typeof rawTrack.sourcePlatform === "string"
									? rawTrack.sourcePlatform.trim().toLowerCase()
									: "external",
							sourceTrackId:
								typeof rawTrack.sourceId === "string"
									? rawTrack.sourceId.trim()
									: "",
							title: rawTrack.title.trim().slice(0, 120),
							artist:
								typeof rawTrack.artist === "string" && rawTrack.artist.trim()
									? rawTrack.artist.trim().slice(0, 120)
									: "未知歌手",
							album:
								typeof rawTrack.album === "string"
									? rawTrack.album.trim().slice(0, 120)
									: undefined,
							cover:
								typeof rawTrack.cover === "string" &&
								rawTrack.cover.startsWith("https://")
									? rawTrack.cover.slice(0, 400)
									: "",
							durationSec:
								typeof rawTrack.durationSec === "number" &&
								Number.isFinite(rawTrack.durationSec) &&
								rawTrack.durationSec > 0
									? Math.round(rawTrack.durationSec)
									: 0,
						},
						cacheRef,
					);
					if (!resolved) {
						this.send(ws, {
							type: "error",
							message: `未在曲库中找到《${rawTrack.title.trim().slice(0, 40)}》的可播音源，可在「搜索」中手动搜歌名试试`,
						});
						return;
					}
					track = resolved;
				}
				if (!track) {
					this.send(ws, { type: "error", message: "无效的曲目信息" });
					return;
				}

				if (!user.isAdmin && track.durationSec > MAX_TRACK_DURATION_GUEST) {
					this.send(ws, {
						type: "error",
						message: "单曲时长超过 15 分钟，暂不支持普通访客点播",
					});
					return;
				}

				const resolvedTrack = track;
				await this.withPlaybackLock(async () => {
					const current = this.getCurrentPlayback();
					if (current && current.track.id === resolvedTrack.id) {
						this.send(ws, { type: "error", message: "这首歌正在播放中哦" });
						return;
					}

					const queue = this.getQueue();
					if (queue.some((q) => q.track.id === resolvedTrack.id)) {
						this.send(ws, { type: "error", message: "这首歌已经在待播队列中" });
						return;
					}

					if (!user.isAdmin) {
						if (queue.length >= MAX_QUEUE_LENGTH) {
							this.send(ws, {
								type: "error",
								message: "当前排队歌单已满，请稍后再点",
							});
							return;
						}
						const userCount = queue.filter(
							(q) => q.requesterKey === user.userKey,
						).length;
						if (userCount >= MAX_QUEUE_PER_USER) {
							this.send(ws, {
								type: "error",
								message: `每人最多同时排队 ${MAX_QUEUE_PER_USER} 首歌`,
							});
							return;
						}
					}

					const uid = crypto.randomUUID();
					const now = Date.now();
					this.ctx.storage.sql.exec(
						"INSERT INTO music_queue (uid, track_json, requester_key, requester_name, created_at) VALUES (?, ?, ?, ?, ?)",
						uid,
						JSON.stringify(resolvedTrack),
						user.userKey,
						user.name,
						now,
					);
					this.recordMusicHistory(
						resolvedTrack,
						user.userKey,
						user.name,
						user.avatar,
						now,
					);

					const notice = this.appendMessage({
						kind: "system",
						userKey: "",
						name: "",
						avatar: "",
						url: "",
						badge: "",
						badgeType: "tag",
						isAdmin: false,
						content: `${user.name} 点播了《${resolvedTrack.title}》`,
						attachments: [],
						mentions: [],
					});
					this.broadcast({
						type: "chat:message",
						roomId: this.getRoomId(),
						message: notice,
					});

					if (
						shouldPlayEnqueuedImmediately({
							hasCurrentPlayback: Boolean(current),
							currentIsFallback: Boolean(current?.isFallback),
							existingQueueLength: queue.length,
						})
					) {
						this.ctx.storage.sql.exec(
							"DELETE FROM music_queue WHERE uid = ?",
							uid,
						);
						await this.startPlayEntry({
							track: resolvedTrack,
							requesterKey: user.userKey,
							requesterName: user.name,
							isFallback: false,
							reason: "init",
						});
						return;
					}

					this.broadcastMusic();
				});
				return;
			}

			case "music:remove": {
				const user = attachment.user;
				const uid = typeof packet.uid === "string" ? packet.uid : "";
				if (!user || !uid) return;

				const entry = this.getQueue().find((q) => q.uid === uid);
				if (!entry) return;

				if (!user.isAdmin && entry.requesterKey !== user.userKey) {
					this.send(ws, {
						type: "error",
						message: "只能移除自己点播的歌曲",
					});
					return;
				}

				this.ctx.storage.sql.exec("DELETE FROM music_queue WHERE uid = ?", uid);
				this.broadcastMusic();
				return;
			}

			case "music:play_queued": {
				const user = attachment.user;
				const uid = typeof packet.uid === "string" ? packet.uid : "";
				if (!user?.isAdmin || !uid) {
					this.send(ws, { type: "error", message: "仅站长可直接插播切歌" });
					return;
				}

				await this.withPlaybackLock(async () => {
					const entry = this.getQueue().find((q) => q.uid === uid);
					if (!entry) return;

					this.ctx.storage.sql.exec(
						"DELETE FROM music_queue WHERE uid = ?",
						uid,
					);
					await this.startPlayEntry({
						track: entry.track,
						requesterKey: entry.requesterKey,
						requesterName: entry.requesterName,
						isFallback: false,
						reason: "host_pick",
						actorName: user.name,
					});
				});
				return;
			}

			case "music:skip": {
				const user = attachment.user;
				if (!user) {
					this.send(ws, {
						type: "error",
						code: "AUTH_REQUIRED",
						message: "请先完成身份认证",
					});
					return;
				}

				await this.withPlaybackLock(async () => {
					const current = this.getCurrentPlayback();
					if (!current) return;

					const { members } = this.getPresenceSnapshot();
					const soloCooldownUntil = this.getSoloCooldownUntil();
					const isTrackRequester =
						!current.isFallback && current.requesterKey === user.userKey;
					const otherUnmutedCount = members.filter(
						(m) => m.userKey !== user.userKey && m.isMuted === false,
					).length;
					const skipDecision = canDirectSkipTrack({
						isFallback: current.isFallback,
						isAdmin: user.isAdmin,
						isTrackRequester,
						onlineMemberCount: members.length,
						otherUnmutedCount,
						soloCooldownUntil,
					});

					if (!skipDecision.allowed) {
						this.send(ws, {
							type: "error",
							message: skipDecision.reason || "暂无权直接切歌",
						});
						return;
					}

					await this.advanceTrack("skip", user.name);
				});
				return;
			}

			case "music:vote_skip": {
				const user = attachment.user;
				if (!user) {
					this.send(ws, {
						type: "error",
						code: "AUTH_REQUIRED",
						message: "请先完成身份认证再投票切歌",
					});
					return;
				}

				await this.withPlaybackLock(async () => {
					const current = this.getCurrentPlayback();
					if (!current) return;

					const existingIdx = current.skipVotes.indexOf(user.userKey);
					if (existingIdx >= 0) {
						current.skipVotes.splice(existingIdx, 1);
						this.setStateValue("current_playback", current);
						this.broadcastMusic();
						return;
					}

					current.skipVotes.push(user.userKey);
					this.setStateValue("current_playback", current);

					const { members } = this.getPresenceSnapshot();
					const onlineKeys = new Set(members.map((m) => m.userKey));
					const unmutedMembers = members.filter((m) => m.isMuted === false);
					const unmutedKeys = new Set(unmutedMembers.map((m) => m.userKey));
					const requesterOnline = onlineKeys.has(current.requesterKey);
					const requesterActive = unmutedKeys.has(current.requesterKey);
					const effectiveVoteCount =
						unmutedMembers.length >= 2 ? unmutedMembers.length : members.length;
					const threshold = computeVoteThreshold(
						effectiveVoteCount,
						current.isFallback,
						unmutedMembers.length >= 2 ? requesterActive : requesterOnline,
					);

					if (current.skipVotes.length >= threshold) {
						await this.advanceTrack("vote");
					} else {
						this.broadcastMusic();
					}
				});
				return;
			}

			case "music:report_duration": {
				const playUid =
					typeof packet.playUid === "string" ? packet.playUid : "";
				const reported = Number(packet.durationSec);
				await this.withPlaybackLock(async () => {
					const current = this.getCurrentPlayback();
					if (
						!current ||
						current.uid !== playUid ||
						current.durationSec > 0 ||
						!Number.isFinite(reported) ||
						reported < 10 ||
						reported > 1800
					) {
						return;
					}
					current.durationSec = Math.round(reported);
					current.track.durationSec = current.durationSec;
					this.setStateValue("current_playback", current);
					this.updateHistoryTrackDuration(
						current.track.id,
						current.durationSec,
					);
					await this.scheduleAlarmForPlayback(current);
					this.broadcastMusic();
				});
				return;
			}

			case "music:ended": {
				const playUid =
					typeof packet.playUid === "string" ? packet.playUid : "";
				await this.withPlaybackLock(async () => {
					const current = this.getCurrentPlayback();
					if (!current || current.uid !== playUid) return;

					const elapsedSec = (Date.now() - current.startedAt) / 1000;
					const minAllowedSec =
						current.durationSec > 0 ? Math.max(8, current.durationSec - 4) : 25;
					if (elapsedSec >= minAllowedSec) {
						await this.advanceTrack("ended");
					}
				});
				return;
			}

			case "music:report_error": {
				const playUid =
					typeof packet.playUid === "string" ? packet.playUid : "";
				await this.withPlaybackLock(async () => {
					const current = this.getCurrentPlayback();
					if (!current || current.uid !== playUid) return;

					const reporter = attachment.user?.userKey || attachment.connId;
					if (!current.errorReports.includes(reporter)) {
						current.errorReports.push(reporter);
						this.setStateValue("current_playback", current);
					}

					const totalSockets = Math.max(1, this.ctx.getWebSockets().length);
					const errorThreshold = Math.min(
						3,
						Math.max(1, Math.ceil(totalSockets / 2)),
					);
					if (current.errorReports.length >= errorThreshold) {
						const sys = this.appendMessage({
							kind: "system",
							userKey: "",
							name: "",
							avatar: "",
							url: "",
							badge: "",
							badgeType: "tag",
							isAdmin: false,
							content: `《${current.track.title}》播放失败，已自动切下一首`,
							attachments: [],
							mentions: [],
						});
						this.broadcast({
							type: "chat:message",
							roomId: this.getRoomId(),
							message: sys,
						});
						await this.advanceTrack("error");
					}
				});
				return;
			}
		}
	}

	override async webSocketClose(ws: WebSocket): Promise<void> {
		const closingUserKey = (ws.deserializeAttachment() as WsAttachment | null)
			?.user?.userKey;
		try {
			ws.serializeAttachment(null);
			ws.close();
		} catch {
			// Already closed
		}
		if (closingUserKey && !this.getOnlineUserKeys(ws).has(closingUserKey)) {
			this.touchMemberLastSeen(closingUserKey);
		}
		this.broadcastPresence(ws);
		if (!this.hasConnectedSockets(ws)) {
			await this.syncNextAlarm();
		}
	}

	override async webSocketError(ws: WebSocket): Promise<void> {
		const closingUserKey = (ws.deserializeAttachment() as WsAttachment | null)
			?.user?.userKey;
		try {
			ws.serializeAttachment(null);
			ws.close();
		} catch {
			// Already closed
		}
		if (closingUserKey && !this.getOnlineUserKeys(ws).has(closingUserKey)) {
			this.touchMemberLastSeen(closingUserKey);
		}
		this.broadcastPresence(ws);
		if (!this.hasConnectedSockets(ws)) {
			await this.syncNextAlarm();
		}
	}

	private allowChatRate(connId: string): boolean {
		const now = Date.now();
		const windowMs = 10_000;
		const maxMsgs = 6;
		const prev = (this.msgTimestamps.get(connId) ?? []).filter(
			(ts) => now - ts < windowMs,
		);
		if (prev.length >= maxMsgs) {
			this.msgTimestamps.set(connId, prev);
			return false;
		}
		prev.push(now);
		this.msgTimestamps.set(connId, prev);
		return true;
	}

	private validateAttachments(raw: unknown): ImageAttachment[] {
		if (!Array.isArray(raw)) return [];
		const trustedPrefixes = (
			this.env.TRUSTED_IMAGE_ORIGINS || "https://img.lengxiqwq.com"
		)
			.split(",")
			.map((s) => s.trim().replace(/\/+$/, ""))
			.filter(Boolean);

		const out: ImageAttachment[] = [];
		for (const item of raw.slice(0, 3)) {
			if (!item || typeof item !== "object") continue;
			const att = item as { type?: unknown; url?: unknown };
			if (att.type !== "image" || typeof att.url !== "string") continue;
			try {
				const rawUrl = att.url.trim();
				const parsed = new URL(rawUrl);
				if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
					continue;
				}
				const isTrusted = trustedPrefixes.some(
					(prefix) =>
						parsed.origin === prefix || rawUrl.startsWith(`${prefix}/`),
				);
				if (isTrusted) {
					out.push({ type: "image", url: parsed.toString() });
				}
			} catch {
				// Ignore invalid URL
			}
		}
		return out;
	}
}

function safeParseArray<T>(json: string): T[] {
	try {
		const val = JSON.parse(json);
		return Array.isArray(val) ? (val as T[]) : [];
	} catch {
		return [];
	}
}

function formatEmailReplyRef(
	replyTo: ChatReplyRef | null | undefined,
	targetKey: string,
) {
	if (!replyTo) return null;
	return {
		msgUid: replyTo.msgUid,
		name: replyTo.name,
		content: replyTo.content,
		hasImage: Boolean(replyTo.hasImage),
		isReplyToRecipient: Boolean(
			replyTo.userKey && replyTo.userKey === targetKey,
		),
	};
}

function parseReplyRef(json: string): ChatReplyRef | null {
	if (!json) return null;
	try {
		const val = JSON.parse(json) as Partial<ChatReplyRef>;
		if (
			val &&
			typeof val === "object" &&
			typeof val.msgUid === "string" &&
			val.msgUid.trim() !== ""
		) {
			return {
				msgUid: val.msgUid,
				userKey: typeof val.userKey === "string" ? val.userKey : "",
				name: typeof val.name === "string" ? val.name : "",
				content: typeof val.content === "string" ? val.content : "",
				hasImage: Boolean(val.hasImage),
				isRecalled: Boolean(val.isRecalled),
			};
		}
		return null;
	} catch {
		return null;
	}
}

function extractMentions(content: string): string[] {
	const matches = content.matchAll(/@([^\s@]{1,16})/g);
	const out = new Set<string>();
	for (const m of matches) {
		if (m[1]) out.add(m[1]);
	}
	return Array.from(out);
}

function sanitizeIncomingTrack(
	raw: Partial<StandardTrack> | undefined,
	allowedProviders: Set<string>,
): StandardTrack | null {
	if (!raw || typeof raw !== "object") return null;
	if (
		typeof raw.id !== "string" ||
		typeof raw.provider !== "string" ||
		typeof raw.sourceId !== "string" ||
		typeof raw.title !== "string" ||
		typeof raw.artist !== "string"
	) {
		return null;
	}

	const provider = raw.provider.trim();
	if (provider === "local") {
		if (typeof raw.url !== "string" || !raw.url.startsWith("/assets/music/")) {
			return null;
		}
		return {
			id: raw.id.slice(0, 120),
			provider: "local",
			sourceId: raw.sourceId.slice(0, 120),
			title: raw.title.trim().slice(0, 120),
			artist: raw.artist.trim().slice(0, 120),
			cover:
				typeof raw.cover === "string" && raw.cover.startsWith("/")
					? raw.cover
					: "/assets/music/cover/oh-my-girl.webp",
			url: raw.url,
			lrc:
				typeof raw.lrc === "string" && raw.lrc.startsWith("/")
					? raw.lrc
					: undefined,
			durationSec: 0,
		};
	}

	if (!allowedProviders.has(provider)) {
		return null;
	}

	const cleanSourceId = raw.sourceId.trim().slice(0, 64);
	if (!cleanSourceId) return null;

	const safeCover =
		typeof raw.cover === "string" && raw.cover.startsWith("https://")
			? raw.cover.slice(0, 400)
			: "";
	const durationSec =
		typeof raw.durationSec === "number" &&
		Number.isFinite(raw.durationSec) &&
		raw.durationSec > 0
			? Math.round(raw.durationSec)
			: 0;

	return {
		id: `${provider}:${cleanSourceId}`,
		provider,
		sourceId: cleanSourceId,
		title: raw.title.trim().slice(0, 120),
		artist: raw.artist.trim().slice(0, 120),
		album:
			typeof raw.album === "string"
				? raw.album.trim().slice(0, 120)
				: undefined,
		cover: safeCover,
		durationSec,
	};
}

export { sanitizeWebsiteUrl };
