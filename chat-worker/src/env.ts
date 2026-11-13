export interface Env {
	CHAT_ROOMS: DurableObjectNamespace;
	WALINE?: Fetcher;

	// Public environment variables
	WALINE_SERVER_URL?: string;
	SITE_URL?: string;
	ALLOWED_ORIGINS?: string;
	TRUSTED_IMAGE_ORIGINS?: string;
	GRAVATAR_STR?: string;
	AVATAR_PROXY?: string;
	DEFAULT_ROOMS?: string;
	MATRIX_ENABLED?: string;
	MATRIX_HOMESERVER?: string;
	MATRIX_ROOM_ID?: string;
	MATRIX_BOT_USER_ID?: string;
	MATRIX_ACCESS_TOKEN?: string;

	// Secrets
	CYAPI_KEY?: string;
	CHAT_GUEST_SECRET?: string;
	STREAM_SIGN_SECRET?: string;
	ADMIN_EMAILS?: string;
	INTERNAL_NOTIFY_SECRET?: string;
}
