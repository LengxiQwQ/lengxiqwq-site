const MATRIX_STATUS_PROFILE_KEY = "org.matrix.msc4426.status";
const STATUS_EMOJI = "💬";
const MAX_STATUS_LENGTH = 20;
const MAX_MATRIX_STATUS_BYTES = 256;
const statusSegmenter = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});
const statusEncoder = new TextEncoder();

export function normalizeChatStatus(value) {
	let status = "";
	let count = 0;
	let bytes = 0;
	for (const { segment } of statusSegmenter.segment(
		String(value ?? "").trim(),
	)) {
		const segmentBytes = statusEncoder.encode(segment).length;
		if (
			count === MAX_STATUS_LENGTH ||
			bytes + segmentBytes > MAX_MATRIX_STATUS_BYTES
		)
			break;
		status += segment;
		count += 1;
		bytes += segmentBytes;
	}
	return status;
}

function backoff(attempt) {
	return Math.min(500 * 2 ** attempt, 8000);
}

async function readMatrixError(response) {
	const body = await response.json().catch(() => ({}));
	const retryHeader = response.headers.get("retry-after");
	const retrySeconds = retryHeader === null ? Number.NaN : Number(retryHeader);
	const retryDate = retryHeader === null ? Number.NaN : Date.parse(retryHeader);
	const retryAfter =
		typeof body?.retry_after_ms === "number"
			? body.retry_after_ms
			: Number.isFinite(retrySeconds)
				? retrySeconds * 1000
				: retryDate - Date.now();
	return {
		errcode: /^M_[A-Z0-9_]+$/.test(body?.errcode ?? "")
			? body.errcode
			: undefined,
		retryAfter: Number.isFinite(retryAfter)
			? Math.max(0, retryAfter)
			: undefined,
	};
}

export function createMatrixCustomStatusSync({
	baseUrl,
	getCredentials,
	fetchImpl = globalThis.fetch,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	logger = console,
	maxRetries = 5,
	timeoutMs = 5000,
}) {
	const queues = new Map();
	const lastSynced = new Map();

	async function writeStatus(task, queue) {
		const { user, status, force } = task;
		const creds = await getCredentials(user);
		if (!creds?.token || !creds?.userId || creds.isProxy) {
			return { outcome: "failed", errcode: "credentials_unavailable" };
		}

		const userId = creds.userId;
		const method = status ? "PUT" : "DELETE";
		const body = status
			? JSON.stringify({
					[MATRIX_STATUS_PROFILE_KEY]: { text: status, emoji: STATUS_EMOJI },
				})
			: undefined;
		const signature = JSON.stringify([userId, method, body]);
		const superseded = () => queue.next && queue.next.status !== status;
		if (superseded()) return { outcome: "superseded", userId };
		if (!force && lastSynced.get(user.userKey) === signature) {
			return { outcome: "synced", userId, cached: true };
		}

		const url = `${baseUrl.replace(/\/$/, "")}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/${MATRIX_STATUS_PROFILE_KEY}`;
		lastSynced.delete(user.userKey);
		for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
			if (superseded()) return { outcome: "superseded", userId };
			const response = await fetchImpl(url, {
				method,
				headers: {
					Authorization: `Bearer ${creds.token}`,
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				...(body ? { body } : {}),
				signal: AbortSignal.timeout(timeoutMs),
			}).catch(() => null);
			const httpStatus = response?.status;
			const details =
				response && !response.ok ? await readMatrixError(response) : {};
			if (
				response?.ok ||
				(method === "DELETE" &&
					httpStatus === 404 &&
					details.errcode === "M_NOT_FOUND")
			) {
				lastSynced.set(user.userKey, signature);
				return { outcome: "synced", userId, httpStatus };
			}
			if (superseded()) return { outcome: "superseded", userId };
			const retryable = !response || httpStatus === 429 || httpStatus >= 500;
			const delay =
				httpStatus === 429
					? (details.retryAfter ?? backoff(attempt))
					: backoff(attempt);
			if (!retryable || attempt === maxRetries || delay > 60_000) {
				return {
					outcome: "failed",
					userId,
					httpStatus,
					errcode: details.errcode ?? (response ? undefined : "network_error"),
				};
			}
			await sleep(delay);
		}
	}

	async function drain(userKey, queue) {
		while (queue.next) {
			const task = queue.next;
			queue.next = null;
			queue.active = task;
			let result;
			try {
				result = await writeStatus(task, queue);
			} catch {
				result = { outcome: "failed", errcode: "sync_error" };
			}
			if (result.outcome === "failed") {
				logger.warn?.("[MatrixStatus] Profile status sync failed", result);
			}
			task.resolve(result);
		}
		queues.delete(userKey);
	}

	return function syncMatrixCustomStatus(
		user,
		rawStatus,
		{ force = false } = {},
	) {
		if (!user?.userKey)
			return Promise.resolve({
				outcome: "failed",
				errcode: "credentials_unavailable",
			});
		const key = user.userKey;
		const status = normalizeChatStatus(rawStatus);
		const queue = queues.get(key) ?? { next: null, active: null };
		const latest = queue.next ?? queue.active;
		if (latest?.status === status && (!force || latest.force))
			return latest.promise;

		queue.next?.resolve({ outcome: "superseded" });
		let resolve;
		const promise = new Promise((done) => {
			resolve = done;
		});
		queue.next = { user: { ...user }, status, force, promise, resolve };
		if (!queues.has(key)) {
			queues.set(key, queue);
			void drain(key, queue);
		}
		return promise;
	};
}

export { MATRIX_STATUS_PROFILE_KEY };
