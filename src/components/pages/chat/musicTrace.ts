type Detail = Record<string, string | number | boolean>;
const events: ({ at: number; event: string; uid: string } & Detail)[] = [];
export function recordMusicEvent(
	event: string,
	uid = "",
	detail: Detail = {},
): void {
	if (events.length >= 512) events.shift();
	events.push({
		at: Math.round(performance.timeOrigin + performance.now()),
		event,
		uid,
		...detail,
	});
}
export function downloadMusicTrace(): void {
	const data = JSON.stringify(
		{ version: 1, browser: navigator.userAgent, events },
		null,
		2,
	);
	const url = URL.createObjectURL(
		new Blob([data], { type: "application/json" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = "chat-music-" + Date.now() + ".json";
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 60000);
}
