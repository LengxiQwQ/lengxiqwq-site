import type { APIRoute } from "astro";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// A production static build has no entries for this local acceptance room.
export function getStaticPaths(): { params: { room: string } }[] {
	return import.meta.env.DEV
		? ["joint", "clock", "client", "bundle", "snapshot", "skip", "events"].map(
				(room) => ({ params: { room } }),
			)
		: [];
}

const preview: APIRoute = async ({ request, url, params }): Promise<Response> => {
	if (!import.meta.env.DEV) {
		return new Response(null, { status: 404 });
	}
	const runtime = pathToFileURL(
		resolve("scripts/chat-music-sync/preview-room.mjs"),
	).href;
	const { handle } = await import(/* @vite-ignore */ runtime);
	const target = new URL(url);
	if (params.room !== "joint") target.searchParams.set("part", params.room!);
	return handle(request, target);
};

export const GET: APIRoute = preview;
export const PUT: APIRoute = preview;
