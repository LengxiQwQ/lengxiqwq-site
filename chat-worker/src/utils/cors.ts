function isPrivateLanOrigin(parsedOrigin: URL): boolean {
	if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") {
		return false;
	}
	const host = parsedOrigin.hostname.toLowerCase();
	return (
		host === "localhost" ||
		host === "127.0.0.1" ||
		/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
		/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)
	);
}

export function isOriginAllowed(
	origin: string | undefined,
	allowedListRaw?: string,
): boolean {
	if (!origin) return false;
	const raw = (allowedListRaw || "").trim();
	if (!raw) return true;

	let parsedOrigin: URL;
	try {
		parsedOrigin = new URL(origin);
	} catch {
		return false;
	}

	if (isPrivateLanOrigin(parsedOrigin)) {
		return true;
	}

	const patterns = raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	for (const pattern of patterns) {
		if (pattern === "*") return true;
		if (pattern === origin) return true;

		try {
			if (pattern.includes("*.") && pattern.includes("://")) {
				const [scheme, rest] = pattern.split("://");
				const hostPattern = rest.replace(/\/.*$/, "");
				if (
					parsedOrigin.protocol === `${scheme}:` &&
					hostPattern.startsWith("*.")
				) {
					const suffix = hostPattern.slice(1);
					if (parsedOrigin.hostname.endsWith(suffix)) {
						return true;
					}
				}
			}
		} catch {
			// Ignore invalid pattern
		}
	}

	return false;
}
