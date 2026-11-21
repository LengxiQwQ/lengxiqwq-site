import type { ChatDesktopNotificationMode } from "./chatTypes";

const STORAGE_KEY = "fireflyChatWebPush";
const WORKER_URL = "/chat-push-sw.js";

type Auth = { kind: "waline" | "guest"; token: string };
type ActiveMode = Exclude<ChatDesktopNotificationMode, "off">;
type Settings = { userKey: string; revocationKey: string; mode: ChatDesktopNotificationMode };
type PreparedPush = {
	registration: ServiceWorkerRegistration;
	subscription: PushSubscription | null;
	publicKey: Uint8Array<ArrayBuffer>;
};

export function supportsChatPush(): boolean {
	return typeof window !== "undefined" && window.isSecureContext &&
		"Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

export function readChatPushSettings(): Settings | null {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Settings | null;
	} catch {
		return null;
	}
}

function writeSettings(settings: Settings | null) {
	if (settings) localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	else localStorage.removeItem(STORAGE_KEY);
}

async function pushRequest(
	server: string,
	action: string,
	body?: Record<string, unknown>,
	auth?: Auth,
): Promise<{ mode?: ChatDesktopNotificationMode; publicKey?: string }> {
	const headers: Record<string, string> = {};
	if (body) headers["Content-Type"] = "application/json";
	if (auth) {
		headers.Authorization = `Bearer ${auth.token}`;
		headers["X-Auth-Kind"] = auth.kind;
	}
	const response = await fetch(`${server}/api/chat/push/${action}`, {
		method: body ? "POST" : "GET",
		headers,
		body: body ? JSON.stringify(body) : undefined,
		signal: AbortSignal.timeout(10000),
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || "unavailable");
	return data;
}

export async function prepareChatPush(server: string): Promise<PreparedPush> {
	const [{ publicKey }] = await Promise.all([
		pushRequest(server, "config"),
		navigator.serviceWorker.register(WORKER_URL, { updateViaCache: "none" }),
	]);
	if (!publicKey) throw new Error("unavailable");
	const registration = await navigator.serviceWorker.ready;
	if (!registration.active?.scriptURL.endsWith(WORKER_URL)) throw new Error("worker");
	return {
		registration,
		subscription: await registration.pushManager.getSubscription(),
		publicKey: Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0)),
	};
}

export async function enableChatPush(
	server: string,
	auth: Auth,
	userKey: string,
	deviceId: string,
	mode: ActiveMode,
	prepared: PreparedPush,
): Promise<void> {
	const existing = readChatPushSettings();
	if (existing && existing.userKey !== userKey) throw new Error("ownership");
	const subscription = prepared.subscription || await prepared.registration.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: prepared.publicKey,
	});
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const revocationKey = existing?.revocationKey ||
		btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	const settings = { userKey, revocationKey, mode: existing?.mode || "off" } satisfies Settings;
	writeSettings(settings);
	await pushRequest(server, "subscribe", {
		revocationKey, deviceId, mode, subscription: subscription.toJSON(),
	}, auth);
	prepared.subscription = subscription;
	writeSettings({ ...settings, mode });
}

export async function disableChatPush(server: string, settings: Settings | null = readChatPushSettings()): Promise<void> {
	if (!settings) return;
	const revoke = pushRequest(server, "disable", { revocationKey: settings.revocationKey });
	const unsubscribe = (async () => {
		const registration = await navigator.serviceWorker?.getRegistration();
		const subscription = await registration?.pushManager.getSubscription();
		if (subscription && !(await subscription.unsubscribe())) throw new Error("unsubscribe");
	})();
	const [removed, unsubscribed] = await Promise.allSettled([revoke, unsubscribe]);
	if (removed.status === "rejected" && unsubscribed.status === "rejected") throw removed.reason;
	if (readChatPushSettings()?.revocationKey === settings.revocationKey) writeSettings(null);
}

export async function getChatPushMode(server: string, auth: Auth, userKey: string): Promise<ChatDesktopNotificationMode> {
	const settings = readChatPushSettings();
	if (settings?.userKey !== userKey) return "off";
	const registration = await navigator.serviceWorker.getRegistration();
	const subscription = await registration?.pushManager.getSubscription();
	if (Notification.permission !== "granted" || !subscription) {
		await disableChatPush(server, settings);
		return "off";
	}
	const { mode = "off" } = await pushRequest(server, "status", { revocationKey: settings.revocationKey }, auth);
	if (readChatPushSettings()?.revocationKey === settings.revocationKey) {
		if (mode === "off" && settings.mode !== "off") await disableChatPush(server, settings);
		else if (mode !== settings.mode) writeSettings({ ...settings, mode });
	}
	return mode;
}

export async function testChatPush(server: string, auth: Auth, userKey: string): Promise<void> {
	const settings = readChatPushSettings();
	if (settings?.userKey !== userKey) throw new Error("missing");
	await pushRequest(server, "test", { revocationKey: settings.revocationKey }, auth);
}
