#!/usr/bin/env node
import { execFile } from "node:child_process";
/**
 * 把聊天室 Lottie 表情离线渲染成动图（默认 GIF，192px / 15fps）。
 *
 * Matrix 的 m.sticker 只能携带一张图片，站点里的 Lottie 是 JSON 动画，
 * 所以需要提前把每枚表情渲染成动图，交给聊天网关当作普通贴纸发给 Matrix。
 * 选 GIF 是为了对齐互联大厅里其他站点的做法：所有客户端都能直接播放，
 * 平坦的卡通色块不会像有损 WebP 那样糊边。15fps 写进 GIF 时会被量化成
 * 7cs/帧（约 14.29fps），与听雨茶室等站点一致。
 *
 * 产物默认写入内容仓 public/assets/stickers/lottie/<name>.gif，
 * 由静态站 CDN 分发，网关只在发送时把它上传成 mxc。
 *
 * 只在表情包发生变化时手动运行，构建流程不会调用本脚本。
 *
 * 用法：
 *   node scripts/render-lottie-stickers.mjs            # 只补缺失的
 *   node scripts/render-lottie-stickers.mjs --force    # 全部重渲染
 *   node scripts/render-lottie-stickers.mjs --only=aini,caigou
 *   node scripts/render-lottie-stickers.mjs --size=160 --fps=12 --quality=60
 *   node scripts/render-lottie-stickers.mjs --format=webp --quality=85
 *
 * 依赖：本机已安装 Chrome 或 Edge（或设置 CHROME_PATH），以及 ffmpeg（或设置 FFMPEG_PATH）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const DEFAULT_OUT = path.resolve(
	REPO_ROOT,
	"../lengxiqwq-site-content/public/assets/stickers/lottie",
);
const LOTTIE_LIB = path.join(
	REPO_ROOT,
	"public/assets/vendor/lottie-5.12.2.min.js",
);
const STICKER_KEYS_FILE = path.join(
	REPO_ROOT,
	"src/components/pages/chat/stickerLoader.ts",
);

const JSON_HOSTS = ["https://rainzt.cn/lottie", "https://somoe.xyz/lottie"];

function parseArgs(argv) {
	const args = {
		force: false,
		keepFrames: false,
		size: 192,
		fps: 15,
		quality: 65,
		format: "gif",
		colors: 256,
	};
	for (const raw of argv) {
		const [key, value] = raw.split("=");
		switch (key) {
			case "--force":
				args.force = true;
				break;
			case "--keep-frames":
				args.keepFrames = true;
				break;
			case "--only":
				args.only = (value ?? "")
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
				break;
			case "--out":
				args.out = path.resolve(value);
				break;
			case "--size":
				args.size = Number(value);
				break;
			case "--fps":
				args.fps = Number(value);
				break;
			case "--quality":
				args.quality = Number(value);
				break;
			case "--format":
				args.format = value === "webp" ? "webp" : "gif";
				break;
			case "--colors":
				args.colors = Number(value);
				break;
			default:
				console.warn(`[lottie] 忽略未知参数：${raw}`);
		}
	}
	return args;
}

function findChrome() {
	const candidates = [
		process.env.CHROME_PATH,
		"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
		"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
		"C:/Program Files/Google/Chrome/Application/chrome.exe",
		"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
	].filter(Boolean);
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	throw new Error(
		"未找到 Chrome / Edge。请设置环境变量 CHROME_PATH 指向浏览器可执行文件。",
	);
}

function readStickerNames() {
	const source = fs.readFileSync(STICKER_KEYS_FILE, "utf8");
	const match =
		/export\s+const\s+LOTTIE_SPRITE_KEYS[^=]*=\s*\[([\s\S]*?)\]/.exec(source);
	if (!match)
		throw new Error(`未在 ${STICKER_KEYS_FILE} 中找到 LOTTIE_SPRITE_KEYS`);
	return [...match[1].matchAll(/["']([a-z0-9-]+)["']/g)].map((m) => m[1]);
}

async function fetchAnimation(name) {
	let lastError;
	for (const host of JSON_HOSTS) {
		try {
			const res = await fetch(`${host}/${name}.json`, {
				signal: AbortSignal.timeout(20000),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			if (!json?.v || !Array.isArray(json.layers))
				throw new Error("不是合法的 Lottie JSON");
			return json;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError ?? new Error("下载失败");
}

/** 在页面里逐帧渲染，返回 PNG data URL 列表。 */
async function captureFrames(page, animationData, size, fps) {
	return page.evaluate(
		async (data, canvasSize, targetFps) => {
			const canvas = document.createElement("canvas");
			canvas.width = canvasSize;
			canvas.height = canvasSize;
			const context = canvas.getContext("2d");
			const animation = window.lottie.loadAnimation({
				renderer: "canvas",
				loop: false,
				autoplay: false,
				animationData: data,
				rendererSettings: {
					context,
					clearCanvas: true,
					preserveAspectRatio: "xMidYMid meet",
					dpr: 1,
				},
			});
			await new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("动画加载超时")),
					15000,
				);
				animation.addEventListener("DOMLoaded", () => {
					clearTimeout(timer);
					resolve();
				});
				animation.addEventListener("data_failed", () => {
					clearTimeout(timer);
					reject(new Error("动画数据解析失败"));
				});
			});
			const frameRate = animation.frameRate || 60;
			const step = Math.max(1, Math.round(frameRate / targetFps));
			const shots = [];
			for (let frame = 0; frame < animation.totalFrames; frame += step) {
				animation.goToAndStop(frame, true);
				shots.push(canvas.toDataURL("image/png"));
			}
			animation.destroy();
			return shots;
		},
		animationData,
		size,
		fps,
	);
}

async function encodeGif(framesDir, outputFile, fps, colors) {
	await execFileAsync(
		process.env.FFMPEG_PATH || "ffmpeg",
		[
			"-y",
			"-v",
			"error",
			"-framerate",
			String(fps),
			"-i",
			path.join(framesDir, "%03d.png"),
			"-filter_complex",
			`[0:v]split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=full:reserve_transparent=1[p];[b][p]paletteuse=dither=sierra2_4a:alpha_threshold=128`,
			"-loop",
			"0",
			"-an",
			outputFile,
		],
		{ timeout: 180000 },
	);
}

async function encodeWebp(framesDir, outputFile, fps, quality) {
	await execFileAsync(
		process.env.FFMPEG_PATH || "ffmpeg",
		[
			"-y",
			"-v",
			"error",
			"-framerate",
			String(fps),
			"-i",
			path.join(framesDir, "%03d.png"),
			"-c:v",
			"libwebp_anim",
			"-lossless",
			"0",
			"-q:v",
			String(quality),
			"-pix_fmt",
			"yuva420p",
			"-loop",
			"0",
			"-an",
			outputFile,
		],
		{ timeout: 120000 },
	);
}

function encodeFrames(args, framesDir, outputFile) {
	return args.format === "gif"
		? encodeGif(framesDir, outputFile, args.fps, args.colors)
		: encodeWebp(framesDir, outputFile, args.fps, args.quality);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const outDir = args.out ?? DEFAULT_OUT;
	const extension = args.format === "gif" ? "gif" : "webp";
	const chrome = findChrome();
	const allNames = readStickerNames();
	const names = args.only?.length ? args.only : allNames;

	const pending = names.filter((name) => {
		if (args.force) return true;
		const file = path.join(outDir, `${name}.${extension}`);
		return !fs.existsSync(file) || fs.statSync(file).size === 0;
	});
	const unknown = names.filter((name) => !allNames.includes(name));
	if (unknown.length)
		console.warn(`[lottie] 不在 LOTTIE_SPRITE_KEYS 中：${unknown.join(", ")}`);
	console.log(
		`[lottie] 共 ${names.length} 枚，待渲染 ${pending.length} 枚 → ${path.relative(process.cwd(), outDir)}`,
	);
	if (pending.length === 0) return;

	fs.mkdirSync(outDir, { recursive: true });
	const framesRoot = path.join(os.tmpdir(), "lottie-sticker-frames");
	fs.mkdirSync(framesRoot, { recursive: true });

	const library = fs.readFileSync(LOTTIE_LIB, "utf8");
	const browser = await puppeteer.launch({
		executablePath: chrome,
		headless: true,
		args: ["--no-sandbox", "--disable-gpu"],
	});
	const page = await browser.newPage();
	await page.setContent("<!doctype html><html><body></body></html>");
	await page.addScriptTag({ content: library });
	const ready = await page.evaluate(
		() => typeof window.lottie?.loadAnimation === "function",
	);
	if (!ready) throw new Error("lottie 库注入失败");

	const failures = [];
	for (let index = 0; index < pending.length; index++) {
		const name = pending[index];
		const label = `[${index + 1}/${pending.length}] ${name}`;
		const startedAt = Date.now();
		try {
			const animation = await fetchAnimation(name);
			const shots = await captureFrames(page, animation, args.size, args.fps);
			const framesDir = path.join(framesRoot, name);
			fs.rmSync(framesDir, { recursive: true, force: true });
			fs.mkdirSync(framesDir, { recursive: true });
			for (let frame = 0; frame < shots.length; frame++) {
				const base64 = shots[frame].slice(shots[frame].indexOf(",") + 1);
				fs.writeFileSync(
					path.join(framesDir, `${String(frame).padStart(3, "0")}.png`),
					Buffer.from(base64, "base64"),
				);
			}
			const outputFile = path.join(outDir, `${name}.${extension}`);
			await encodeFrames(args, framesDir, outputFile);
			if (!args.keepFrames)
				fs.rmSync(framesDir, { recursive: true, force: true });
			const sizeKb = (fs.statSync(outputFile).size / 1024).toFixed(0);
			console.log(
				`${label} ${shots.length} 帧 ${sizeKb}KB ${Date.now() - startedAt}ms`,
			);
		} catch (error) {
			failures.push({ name, message: error.message });
			console.error(`${label} 失败：${error.message}`);
		}
	}

	await browser.close();
	if (failures.length) {
		console.error(
			`[lottie] 失败 ${failures.length} 枚：${failures.map((f) => f.name).join(", ")}`,
		);
		process.exitCode = 1;
	} else {
		console.log("[lottie] 全部完成");
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
