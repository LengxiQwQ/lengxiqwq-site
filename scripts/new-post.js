/* This is a script to create a new post markdown file with front-matter */

import fs from "node:fs";
import path from "node:path";
import { pinyin } from "pinyin-pro";
import { siteConfig } from "../src/config/siteConfig.ts";

function getDate() {
	const now = new Date();
	const timezone = siteConfig.timezone || "Asia/Shanghai";
	const dateParts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	})
		.formatToParts(now)
		.reduce((parts, part) => {
			if (part.type !== "literal") parts[part.type] = part.value;
			return parts;
		}, {});

	return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
}

const args = process.argv.slice(2);

if (args.length === 0) {
	console.error(`Error: No filename argument provided
Usage: pnpm new-post <filename>`);
	process.exit(1);
}

let fileName = args[0];

// Add .md extension if not present
const fileExtensionRegex = /\.(md|mdx)$/i;
if (!fileExtensionRegex.test(fileName)) {
	fileName += ".md";
}

let contentDir = process.env.CONTENT_DIR;
if (!contentDir) {
	const localSiblingContent = path.resolve("../lengxiqwq-site-content");
	if (fs.existsSync(localSiblingContent)) {
		contentDir = localSiblingContent;
	} else {
		console.error(
			"Error: Private content repository not found.\nPlease set CONTENT_DIR or ensure ../lengxiqwq-site-content exists.\n(Posts are private owned content and cannot be created in the public code repo)",
		);
		process.exit(1);
	}
}

const resolvedContentDir = path.resolve(contentDir);
if (!fs.existsSync(resolvedContentDir)) {
	console.error(`Error: CONTENT_DIR does not exist: ${resolvedContentDir}`);
	process.exit(1);
}

const targetDir = path.join(resolvedContentDir, "content/posts");
const fullPath = path.join(targetDir, fileName);

// Generate slug from filename: strip extension, strip trailing /index
let slug = fileName.replace(fileExtensionRegex, "");
if (slug.endsWith("/index")) {
	slug = slug.slice(0, -"/index".length);
}

// Convert Chinese characters to pinyin, keep other chars as-is
slug = slug
	.split("/")
	.map((segment) => {
		if (!/[一-鿿]/.test(segment)) return segment;
		// Process character by character: Chinese → pinyin, others → keep
		const chars = [...segment];
		const parts = [];
		let buf = "";
		for (const ch of chars) {
			if (/[一-鿿]/.test(ch)) {
				if (buf) {
					parts.push(buf);
					buf = "";
				}
				parts.push(pinyin(ch, { toneType: "none", type: "array" })[0]);
			} else {
				buf += ch;
			}
		}
		if (buf) parts.push(buf);
		return parts
			.join("-")
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
	})
	.join("/");

if (fs.existsSync(fullPath)) {
	console.error(`Error: File ${fullPath} already exists`);
	process.exit(1);
}

// recursive mode creates multi-level directories
const dirPath = path.dirname(fullPath);
if (!fs.existsSync(dirPath)) {
	fs.mkdirSync(dirPath, { recursive: true });
}

const content = `---
title: ${args[0]}
published: ${getDate()}
description: ''
image: ''
tags: []
category: ''
draft: false
lang: ''
slug: ${slug}
---
`;

fs.writeFileSync(fullPath, content);

console.log(`Post ${fullPath} created`);
