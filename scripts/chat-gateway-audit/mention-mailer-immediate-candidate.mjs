import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const MENTION_EMAIL_DELAY_MS = 5 * 60 * 1000;
const MAX_LIVE_EVENT_AGE_MS = 10 * 60 * 1000;
const RETRY_DELAY_MS = 60 * 1000;
const MAX_RETRIES = 2;
const MAX_BATCH_MESSAGES = 30;

export function loadEnvFile(envPath) {
	if (!existsSync(envPath)) return;
	try {
		const raw = readFileSync(envPath, "utf8");
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eqIdx = trimmed.indexOf("=");
			if (eqIdx <= 0) continue;
			const key = trimmed.slice(0, eqIdx).trim();
			let val = trimmed.slice(eqIdx + 1).trim();
			if (
				(val.startsWith('"') && val.endsWith('"')) ||
				(val.startsWith("'") && val.endsWith("'"))
			) {
				val = val.slice(1, -1);
			}
			if (key && process.env[key] === undefined) {
				process.env[key] = val;
			}
		}
	} catch (err) {
		console.warn("[MentionMailer] Failed to load .env:", err.message);
	}
}

function writeJsonAtomic(filePath, data) {
	const tmpPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
	writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
	renameSync(tmpPath, filePath);
}

function loadJsonObject(filePath) {
	if (!existsSync(filePath)) return {};
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: {};
	} catch (err) {
		console.warn(`[MentionMailer] Failed to parse ${filePath}:`, err.message);
		return {};
	}
}

function isRoomWideKey(key) {
	const lower = String(key || "")
		.trim()
		.toLowerCase();
	return (
		lower === "room" ||
		lower === "@room" ||
		lower === "all" ||
		lower === "@all" ||
		lower === "所有人" ||
		lower === "@所有人"
	);
}

function isValidEmail(email) {
	return (
		typeof email === "string" &&
		/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())
	);
}

export function createMentionMailer(deps) {
	const {
		dataDir,
		serverOrigin = "https://chat-server.lengxiqwq.com",
		siteUrl = "https://lengxiqwq.com",
		walineNotifyUrl = "https://comment.lengxiqwq.com/api/internal/chat-mention-notify",
		internalSecret = "",
		isUserOnline,
		getMemberName,
		normalizeUserKey,
		defaultAdminEmail = "me@lengxiqwq.com",
	} = deps;

	mkdirSync(dataDir, { recursive: true });
	const prefsPath = join(dataDir, "member_notify_prefs.json");
	const pendingPath = join(dataDir, "pending_mention_emails.json");

	const prefs = loadJsonObject(prefsPath);
	const pending = loadJsonObject(pendingPath);
	const timers = new Map();

	// Ensure owner waline:1 has fallback email on boot so mentions work before next reconnect
	if (!prefs["waline:1"] && isValidEmail(defaultAdminEmail)) {
		prefs["waline:1"] = {
			email: defaultAdminEmail.trim().toLowerCase(),
			notifyEmail: true,
			updatedAt: Date.now(),
		};
		try {
			writeJsonAtomic(prefsPath, prefs);
		} catch (err) {
			console.warn("[MentionMailer] Failed to seed admin pref:", err.message);
		}
	}

	function savePrefs() {
		try {
			writeJsonAtomic(prefsPath, prefs);
		} catch (err) {
			console.error("[MentionMailer] Save prefs error:", err.message);
		}
	}

	function savePending() {
		try {
			writeJsonAtomic(pendingPath, pending);
		} catch (err) {
			console.error("[MentionMailer] Save pending error:", err.message);
		}
	}

	function cancelTimer(bucketKey) {
		const t = timers.get(bucketKey);
		if (t) {
			clearTimeout(t);
			timers.delete(bucketKey);
		}
	}

	function armTimer(bucketKey, delayMs) {
		cancelTimer(bucketKey);
		const safeDelay = Math.max(500, Math.min(delayMs, 24 * 60 * 60 * 1000));
		const timer = setTimeout(() => {
			timers.delete(bucketKey);
			void flushBucket(bucketKey);
		}, safeDelay);
		if (typeof timer.unref === "function") timer.unref();
		timers.set(bucketKey, timer);
	}

	function toAbsoluteUrl(rawUrl) {
		if (typeof rawUrl !== "string") return "";
		const trimmed = rawUrl.trim();
		if (!trimmed) return "";
		if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
			return `${serverOrigin.replace(/\/+$/, "")}${trimmed}`;
		}
		if (/^https?:\/\//i.test(trimmed)) return trimmed;
		return "";
	}

	function formatEmailContent(message) {
		const raw =
			typeof message.content === "string" ? message.content.trim() : "";
		if (raw) return raw;
		const atts = Array.isArray(message.attachments) ? message.attachments : [];
		const nonImages = atts.filter((a) => a && a.type && a.type !== "image");
		if (nonImages.length > 0) {
			const first = nonImages[0];
			if (first.type === "audio") return "[语音留言]";
			if (first.type === "video") return "[视频消息]";
			if (first.type === "file") return `[文件: ${first.name || "附件"}]`;
		}
		return "";
	}

	function formatImageAttachments(attachments) {
		if (!Array.isArray(attachments)) return [];
		const out = [];
		for (const att of attachments) {
			if (!att || att.type !== "image") continue;
			const absUrl = toAbsoluteUrl(att.url);
			if (absUrl) {
				out.push({ type: "image", url: absUrl });
			}
			if (out.length >= 3) break;
		}
		return out;
	}

	function formatReplyRef(replyTo, targetUserKey) {
		if (!replyTo || typeof replyTo !== "object") return null;
		const replyOwnerKey = normalizeUserKey(replyTo.userKey || "");
		return {
			msgUid: typeof replyTo.msgUid === "string" ? replyTo.msgUid : undefined,
			name:
				typeof replyTo.name === "string" && replyTo.name.trim()
					? replyTo.name.trim()
					: "小伙伴",
			content: typeof replyTo.content === "string" ? replyTo.content : "",
			hasImage: Boolean(replyTo.hasImage),
			isReplyToRecipient: Boolean(
				replyOwnerKey && replyOwnerKey === targetUserKey,
			),
		};
	}

	async function flushBucket(bucketKey) {
		const bucket = pending[bucketKey];
		if (
			!bucket ||
			!Array.isArray(bucket.messages) ||
			bucket.messages.length === 0
		) {
			delete pending[bucketKey];
			cancelTimer(bucketKey);
			savePending();
			return;
		}

		const { targetUserKey, roomId } = bucket;

		// Online user check: any active WS connection (even if tab is away/blurred) cancels offline mail
		if (isUserOnline(targetUserKey)) {
			delete pending[bucketKey];
			cancelTimer(bucketKey);
			savePending();
			return;
		}

		const pref = prefs[targetUserKey];
		if (!pref || !isValidEmail(pref.email) || pref.notifyEmail === false) {
			delete pending[bucketKey];
			cancelTimer(bucketKey);
			savePending();
			return;
		}

		if (!internalSecret || !walineNotifyUrl) {
			console.warn(
				"[MentionMailer] Missing INTERNAL_NOTIFY_SECRET or WALINE_NOTIFY_URL; dropping pending batch.",
			);
			delete pending[bucketKey];
			cancelTimer(bucketKey);
			savePending();
			return;
		}

		const roomName = roomId === "interconnect" ? "互联茶室" : "闲聊";
		const toName = (getMemberName(targetUserKey) || "小伙伴").trim();
		const payload = {
			toEmail: pref.email,
			toName,
			roomId,
			roomName,
			siteUrl: siteUrl.replace(/\/+$/, ""),
			messages: bucket.messages.slice(-MAX_BATCH_MESSAGES),
		};

		try {
			const resp = await fetch(walineNotifyUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Internal-Secret": internalSecret,
				},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(10000),
			});

			if (resp.ok) {
				delete pending[bucketKey];
				cancelTimer(bucketKey);
				savePending();
				console.log(
					`[MentionMailer] Sent ${payload.messages.length} offline notification(s) to ${targetUserKey} in #${roomId}`,
				);
				return;
			}

			const errText = await resp.text().catch(() => "");
			console.error(
				`[MentionMailer] Worker returned HTTP ${resp.status} for ${targetUserKey}: ${errText.slice(0, 200)}`,
			);

			if (resp.status >= 500 && (bucket.retryCount || 0) < MAX_RETRIES) {
				bucket.retryCount = (bucket.retryCount || 0) + 1;
				bucket.dueAt = Date.now() + RETRY_DELAY_MS;
				savePending();
				armTimer(bucketKey, RETRY_DELAY_MS);
			} else {
				delete pending[bucketKey];
				cancelTimer(bucketKey);
				savePending();
			}
		} catch (err) {
			console.error(
				`[MentionMailer] Network error sending to ${targetUserKey}:`,
				err.message,
			);
			if ((bucket.retryCount || 0) < MAX_RETRIES) {
				bucket.retryCount = (bucket.retryCount || 0) + 1;
				bucket.dueAt = Date.now() + RETRY_DELAY_MS;
				savePending();
				armTimer(bucketKey, RETRY_DELAY_MS);
			} else {
				delete pending[bucketKey];
				cancelTimer(bucketKey);
				savePending();
			}
		}
	}

	function recordMemberEmail(userKey, email) {
		if (!userKey || !isValidEmail(email)) return;
		const cleanEmail = email.trim().toLowerCase();
		const existing = prefs[userKey];
		if (existing) {
			if (existing.email === cleanEmail) return;
			existing.email = cleanEmail;
			existing.updatedAt = Date.now();
		} else {
			prefs[userKey] = {
				email: cleanEmail,
				notifyEmail: true,
				updatedAt: Date.now(),
			};
		}
		savePrefs();
	}

	function getEmail(userKey) {
		return prefs[userKey]?.email || "";
	}

	function getNotifyEnabled(userKey) {
		if (!userKey) return true;
		const pref = prefs[userKey];
		return pref ? pref.notifyEmail !== false : true;
	}

	function setNotifyEnabled(userKey, enabled) {
		if (!userKey) return;
		const boolVal = Boolean(enabled);
		const existing = prefs[userKey];
		if (existing) {
			existing.notifyEmail = boolVal;
			existing.updatedAt = Date.now();
		} else {
			prefs[userKey] = {
				email: "",
				notifyEmail: boolVal,
				updatedAt: Date.now(),
			};
		}
		savePrefs();
		if (!boolVal) {
			clearPendingForUser(userKey);
		}
	}

	function clearPendingForUser(userKey) {
		if (!userKey) return false;
		let changed = false;
		const prefix = `${userKey}::`;
		for (const bucketKey of Object.keys(pending)) {
			if (
				bucketKey.startsWith(prefix) ||
				pending[bucketKey]?.targetUserKey === userKey
			) {
				delete pending[bucketKey];
				cancelTimer(bucketKey);
				changed = true;
			}
		}
		if (changed) savePending();
		return changed;
	}

	function mergeGuestPrefs(guestUserKey, walineUserKey, walineEmail = "") {
		if (!guestUserKey || !walineUserKey || guestUserKey === walineUserKey)
			return;
		const guestPref = prefs[guestUserKey];
		const walinePref = prefs[walineUserKey];

		const finalEmail = isValidEmail(walineEmail)
			? walineEmail.trim().toLowerCase()
			: walinePref?.email || guestPref?.email || "";

		let finalNotify = true;
		if (walinePref && typeof walinePref.notifyEmail === "boolean") {
			finalNotify = walinePref.notifyEmail;
		} else if (guestPref && typeof guestPref.notifyEmail === "boolean") {
			finalNotify = guestPref.notifyEmail;
		}

		if (finalEmail || guestPref || walinePref) {
			prefs[walineUserKey] = {
				email: finalEmail,
				notifyEmail: finalNotify,
				updatedAt: Date.now(),
			};
		}
		if (guestPref) {
			delete prefs[guestUserKey];
		}
		savePrefs();

		let pendingChanged = false;
		for (const oldKey of Object.keys(pending)) {
			const oldBucket = pending[oldKey];
			if (!oldBucket || oldBucket.targetUserKey !== guestUserKey) continue;
			const newKey = `${walineUserKey}::${oldBucket.roomId}`;
			if (!finalNotify || isUserOnline(walineUserKey)) {
				delete pending[oldKey];
				cancelTimer(oldKey);
				pendingChanged = true;
				continue;
			}
			if (pending[newKey]) {
				const merged = [
					...pending[newKey].messages,
					...oldBucket.messages,
				].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
				const seen = new Set();
				pending[newKey].messages = merged
					.filter((m) => {
						if (!m?.msgUid || seen.has(m.msgUid)) return false;
						seen.add(m.msgUid);
						return true;
					})
					.slice(-MAX_BATCH_MESSAGES);
				pending[newKey].dueAt = Math.min(
					pending[newKey].dueAt,
					oldBucket.dueAt,
				);
				delete pending[oldKey];
				cancelTimer(oldKey);
				armTimer(newKey, pending[newKey].dueAt - Date.now());
			} else {
				oldBucket.targetUserKey = walineUserKey;
				pending[newKey] = oldBucket;
				delete pending[oldKey];
				cancelTimer(oldKey);
				armTimer(newKey, oldBucket.dueAt - Date.now());
			}
			pendingChanged = true;
		}
		if (pendingChanged) savePending();
	}

	function removeMessageFromPending(msgUid) {
		if (!msgUid) return;
		let changed = false;
		for (const bucketKey of Object.keys(pending)) {
			const bucket = pending[bucketKey];
			if (!bucket || !Array.isArray(bucket.messages)) continue;
			const next = bucket.messages.filter((m) => m.msgUid !== msgUid);
			if (next.length !== bucket.messages.length) {
				if (next.length === 0) {
					delete pending[bucketKey];
					cancelTimer(bucketKey);
				} else {
					bucket.messages = next;
				}
				changed = true;
			}
		}
		if (changed) savePending();
	}

	function updateMessageContentInPending(msgUid, newContent) {
		if (!msgUid || typeof newContent !== "string") return;
		let changed = false;
		for (const bucket of Object.values(pending)) {
			if (!bucket || !Array.isArray(bucket.messages)) continue;
			for (const item of bucket.messages) {
				if (item.msgUid === msgUid) {
					item.content = newContent;
					changed = true;
				}
			}
		}
		if (changed) savePending();
	}

	async function sendImmediateMention(targetUserKey, roomId, item, pref) {
		if (!internalSecret || !walineNotifyUrl) {
			console.warn(
				"[MentionMailer] Missing INTERNAL_NOTIFY_SECRET or WALINE_NOTIFY_URL; dropping immediate mention.",
			);
			return;
		}
		const payload = {
			toEmail: pref.email,
			toName: (getMemberName(targetUserKey) || "小伙伴").trim(),
			roomId,
			roomName: roomId === "interconnect" ? "互联茶室" : "闲聊",
			siteUrl: siteUrl.replace(/\/+$/, ""),
			messages: [item],
		};
		try {
			const resp = await fetch(walineNotifyUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Internal-Secret": internalSecret,
				},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(10000),
			});
			if (resp.ok) {
				console.log(
					`[MentionMailer] Sent immediate mention to ${targetUserKey} in #${roomId}`,
				);
			} else {
				console.error(
					`[MentionMailer] Immediate mention returned HTTP ${resp.status} for ${targetUserKey}`,
				);
			}
		} catch (err) {
			console.error(
				`[MentionMailer] Network error sending immediate mention to ${targetUserKey}:`,
				err.message,
			);
		}
	}

	function enqueueForMessage({ roomId, message, isLive = true }) {
		if (
			!isLive ||
			!message ||
			message.kind !== "user" ||
			message.isEncryptedPlaceholder
		)
			return;
		if (roomId !== "chat" && roomId !== "interconnect") return;

		const msgTs = Number(message.createdAt) || Date.now();
		if (Date.now() - msgTs > MAX_LIVE_EVENT_AGE_MS) {
			return;
		}

		const senderKey = normalizeUserKey(message.userKey || "");
		const ownerMentioned =
			Array.isArray(message.mentionKeys) &&
			message.mentionKeys.some(
				(key) => !isRoomWideKey(key) && normalizeUserKey(key) === "waline:1",
			);
		const rawTargets = [];
		if (Array.isArray(message.mentionKeys)) {
			for (const k of message.mentionKeys) rawTargets.push(k);
		}
		if (message.replyTo?.userKey) {
			rawTargets.push(message.replyTo.userKey);
		}

		const uniqueTargets = new Set();
		for (const rawKey of rawTargets) {
			if (!rawKey || isRoomWideKey(rawKey)) continue;
			const normalized = normalizeUserKey(rawKey);
			if (!normalized || isRoomWideKey(normalized)) continue;
			if (normalized === senderKey) continue;
			// Only local users can have registered emails
			if (normalized.startsWith("matrix:") || normalized.startsWith("@"))
				continue;
			uniqueTargets.add(normalized);
		}

		if (uniqueTargets.size === 0) return;

		const senderBadge = message.site
			? `${message.site}`
			: typeof message.badge === "string"
				? message.badge
				: "";
		const contentText = formatEmailContent(message);
		const imgAtts = formatImageAttachments(message.attachments);

		let changed = false;
		const now = Date.now();

		for (const targetUserKey of uniqueTargets) {
			const pref = prefs[targetUserKey];
			if (!pref || !isValidEmail(pref.email) || pref.notifyEmail === false) {
				continue;
			}

			const immediate = targetUserKey === "waline:1" && ownerMentioned;
			if (isUserOnline(targetUserKey)) continue;

			const item = {
				msgUid: String(message.msgUid || ""),
				senderName:
					typeof message.name === "string" && message.name.trim()
						? message.name.trim()
						: "小伙伴",
				senderBadge,
				content: contentText,
				attachments: imgAtts,
				replyTo: formatReplyRef(message.replyTo, targetUserKey),
				createdAt: msgTs,
			};

			if (immediate) {
				void sendImmediateMention(targetUserKey, roomId, item, pref);
				continue;
			}

			const bucketKey = `${targetUserKey}::${roomId}`;
			const existing = pending[bucketKey];
			if (existing && Array.isArray(existing.messages)) {
				if (
					!existing.messages.some((m) => m.msgUid && m.msgUid === item.msgUid)
				) {
					existing.messages.push(item);
					if (existing.messages.length > MAX_BATCH_MESSAGES) {
						existing.messages = existing.messages.slice(-MAX_BATCH_MESSAGES);
					}
					changed = true;
				}
			} else {
				const dueAt = now + MENTION_EMAIL_DELAY_MS;
				pending[bucketKey] = {
					targetUserKey,
					roomId,
					dueAt,
					retryCount: 0,
					messages: [item],
				};
				armTimer(bucketKey, MENTION_EMAIL_DELAY_MS);
				changed = true;
			}
		}

		if (changed) savePending();
	}

	function restoreTimers() {
		const now = Date.now();
		for (const [bucketKey, bucket] of Object.entries(pending)) {
			if (
				!bucket ||
				!Array.isArray(bucket.messages) ||
				bucket.messages.length === 0
			) {
				delete pending[bucketKey];
				continue;
			}
			const delayMs = Math.max(500, (Number(bucket.dueAt) || now) - now);
			armTimer(bucketKey, delayMs);
		}
	}

	return {
		recordMemberEmail,
		getEmail,
		getNotifyEnabled,
		setNotifyEnabled,
		clearPendingForUser,
		mergeGuestPrefs,
		removeMessageFromPending,
		updateMessageContentInPending,
		enqueueForMessage,
		restoreTimers,
	};
}
