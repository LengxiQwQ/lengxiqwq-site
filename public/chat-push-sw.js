self.addEventListener("install", (event) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("push", (event) => {
	let payload;
	try {
		payload = event.data?.json();
	} catch {
		return;
	}
	if (!payload || typeof payload.body !== "string") return;

	const url = new URL("/chat/", self.location.origin);
	let tag = "chat-push-test";
	if (!payload.test) {
		if (!["chat", "interconnect"].includes(payload.roomId) || typeof payload.msgUid !== "string") return;
		url.searchParams.set("room", payload.roomId);
		url.searchParams.set("msg", payload.msgUid);
		tag = `chat-msg-${payload.roomId}-${payload.msgUid}`;
	}
	event.waitUntil(self.registration.showNotification(
		payload.test ? "聊天室推送测试" : "LengxiQwQ 聊天室",
		{ body: payload.body, icon: "/favicon/favicon-light-192.png", tag, data: { url: url.href } },
	));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = new URL(event.notification.data?.url || "/chat/", self.location.origin);
	if (target.origin !== self.location.origin || target.pathname !== "/chat/") return;
	event.waitUntil((async () => {
		const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		const tab = tabs.find((client) => client.url === target.href);
		if (tab) await tab.focus();
		else await self.clients.openWindow(target.href);
	})());
});
