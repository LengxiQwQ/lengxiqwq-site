/* Create a timestamped dynamic markdown file from command-line text. */

import fs from "node:fs";
import path from "node:path";
import { siteConfig } from "../src/config/siteConfig.ts";

const content = process.argv.slice(2).join(" ").trim();

if (!content) {
	console.error(
		"Error: No dynamic content provided\nUsage: pnpm new-dynamic <content>",
	);
	process.exit(1);
}

const now = new Date();
const timezone = siteConfig.timezone || "Asia/Shanghai";
const dateParts = new Intl.DateTimeFormat("en-CA", {
	timeZone: timezone,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hourCycle: "h23",
})
	.formatToParts(now)
	.reduce((parts, part) => {
		if (part.type !== "literal") parts[part.type] = part.value;
		return parts;
	}, {});
const year = dateParts.year;
const month = dateParts.month;
const day = dateParts.day;
const hours = dateParts.hour;
const minutes = dateParts.minute;
const seconds = dateParts.second;
const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
const fileName = `${year}-${month}-${day}-${hours}${minutes}${seconds}.md`;
let contentDir = process.env.CONTENT_DIR;
if (!contentDir) {
	const localSiblingContent = path.resolve("../lengxiqwq-site-content");
	if (fs.existsSync(localSiblingContent)) {
		contentDir = localSiblingContent;
	} else {
		console.error(
			"Error: Private content repository not found.\nPlease set CONTENT_DIR or ensure ../lengxiqwq-site-content exists.\n(Dynamic is private owned content and cannot be created in the public code repo)",
		);
		process.exit(1);
	}
}

const resolvedContentDir = path.resolve(contentDir);
if (!fs.existsSync(resolvedContentDir)) {
	console.error(`Error: CONTENT_DIR does not exist: ${resolvedContentDir}`);
	process.exit(1);
}

const targetDir = path.join(resolvedContentDir, "content/dynamic");
const fullPath = path.join(targetDir, fileName);

fs.mkdirSync(targetDir, { recursive: true });

if (fs.existsSync(fullPath)) {
	console.error(`Error: File ${fullPath} already exists`);
	process.exit(1);
}

fs.writeFileSync(fullPath, `---\npublished: ${timestamp}\n---\n\n${content}\n`);

console.log(`Dynamic ${fullPath} created`);
