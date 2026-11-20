import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg)
	throw new Error(
		"Usage: node prepare-candidate.mjs <local-runtime-snapshot> <new-output-directory>",
	);
const source = path.resolve(sourceArg);
const output = path.resolve(outputArg);
if (
	source === output ||
	output.startsWith(source + path.sep) ||
	source.startsWith(output + path.sep)
)
	throw new Error("Source and output must be separate directories");

const root = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
	await readFile(path.join(root, "handoff-sha256.json"), "utf8"),
);
const files = ["server.mjs", "src/music/music-manager.mjs"];
const staging = await mkdtemp(path.join(tmpdir(), "chat-handoff-"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
	await mkdir(path.join(staging, "src/music"), { recursive: true });
	for (const file of files) {
		const bytes = await readFile(path.join(source, file));
		if (digest(bytes) !== manifest[file].before)
			throw new Error(
				"Production baseline changed. Review and merge again: " + file,
			);
		await writeFile(path.join(staging, file), bytes, { mode: 0o600 });
	}
	execFileSync(
		"git",
		[
			"-c",
			"core.autocrlf=false",
			"apply",
			"--no-index",
			path.join(root, "playback-handoff.patch"),
		],
		{ cwd: staging },
	);
	const verified = new Map();
	for (const file of files) {
		const bytes = await readFile(path.join(staging, file));
		if (digest(bytes) !== manifest[file].after)
			throw new Error("Unexpected patched output: " + file);
		execFileSync(process.execPath, ["--check", path.join(staging, file)]);
		verified.set(file, bytes);
	}
	await mkdir(output);
	try {
		await mkdir(path.join(output, "src/music"), { recursive: true });
		for (const [file, bytes] of verified)
			await writeFile(path.join(output, file), bytes, {
				flag: "wx",
				mode: 0o600,
			});
	} catch (error) {
		// This invocation exclusively created the output directory above.
		await rm(output, { recursive: true, force: true });
		throw error;
	}
	console.log(
		"Verified both files. Keep the generated gateway private. No deployment performed.",
	);
} finally {
	await rm(staging, { recursive: true, force: true });
}
