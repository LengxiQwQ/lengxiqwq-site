import fs from "node:fs/promises";
import path from "node:path";
import type {
	SteamData,
	SteamGameItem,
	SteamPlayerSummary,
} from "../src/types/steamConfig";

const OUTPUT_FILE = path.resolve("src/constants/steam-data.json");
const HIDDEN_APPS_FILE = path.resolve("src/constants/steam-hidden-apps.json");

interface LoadedConfig {
	steamId: string;
	apiKey: string;
	excludeAppIds: number[];
	excludeGames: string[];
}

// 尝试从本地 Steam 客户端读取「隐藏的游戏」配置（Steam 客户端中右键 -> 管理 -> 隐藏此游戏）
async function getSteamClientHiddenAppIds(steamId: string): Promise<number[]> {
	let cachedAppIds: number[] = [];
	try {
		const cached = await fs.readFile(HIDDEN_APPS_FILE, "utf-8");
		cachedAppIds = JSON.parse(cached);
		if (!Array.isArray(cachedAppIds)) cachedAppIds = [];
	} catch {}

	if (!steamId) return cachedAppIds;

	try {
		// 计算 32 位 Account ID (SteamID64 = 76561197960265728 + AccountId)
		const accountId = (BigInt(steamId) - 76561197960265728n).toString();
		const possibleRoots = [
			process.env["ProgramFiles(x86)"]
				? path.join(process.env["ProgramFiles(x86)"]!, "Steam")
				: null,
			process.env.ProgramFiles
				? path.join(process.env.ProgramFiles, "Steam")
				: null,
			"C:\\Program Files (x86)\\Steam",
			"C:\\Program Files\\Steam",
			"D:\\Steam",
			"E:\\Steam",
		].filter(Boolean) as string[];

		for (const root of possibleRoots) {
			const cloudStorageFile = path.join(
				root,
				"userdata",
				accountId,
				"config",
				"cloudstorage",
				"cloud-storage-namespace-1.json",
			);
			try {
				const content = await fs.readFile(cloudStorageFile, "utf-8");
				const json = JSON.parse(content);
				for (const key of Object.keys(json)) {
					const item = json[key];
					if (
						Array.isArray(item) &&
						item[0] === "user-collections.hidden" &&
						item[1]?.value
					) {
						const val = JSON.parse(item[1].value);
						if (val.id === "hidden" && Array.isArray(val.added)) {
							const foundIds: number[] = val.added
								.map(Number)
								.filter((n: number) => !isNaN(n));
							console.log(
								`🙈 成功自动识别本地 Steam 客户端「隐藏的游戏」列表，共发现 ${foundIds.length} 款隐藏游戏`,
							);
							// 缓存至工程常量，以便 CI/CD 或远程构建时自动复用
							await fs.writeFile(
								HIDDEN_APPS_FILE,
								JSON.stringify(foundIds, null, 2),
								"utf-8",
							);
							return foundIds;
						}
					}
				}
			} catch {}
		}
	} catch {}

	if (cachedAppIds.length > 0) {
		console.log(
			`🙈 未在本地找到 Steam 客户端路径，已复用之前缓存的「隐藏的游戏」列表，共 ${cachedAppIds.length} 款`,
		);
		return cachedAppIds;
	}

	return [];
}

// 尝试安全读取 steamConfig 配置
async function loadConfig(): Promise<LoadedConfig> {
	let steamId = process.env.STEAM_ID || "";
	let apiKey = process.env.STEAM_API_KEY || "";
	let excludeAppIds: number[] = [];
	let excludeGames: string[] = [];

	// 优先从私有内容仓或本地配置安全解析（兼顾 dual-repo 隔离机制）
	const contentDir = process.env.CONTENT_DIR || "../lengxiqwq-site-content";
	const configPaths = [
		path.resolve(contentDir, "config/steamConfig.ts"),
		path.resolve("src/config/steamConfig.ts"),
	];

	for (const p of configPaths) {
		try {
			const content = await fs.readFile(p, "utf-8");
			if (!steamId) {
				const idMatch = content.match(/steamId:\s*["']([^"']+)["']/);
				if (idMatch?.[1]) steamId = idMatch[1].trim();
			}
			if (!apiKey) {
				const keyMatch = content.match(/apiKey:\s*["']([^"']+)["']/);
				if (keyMatch?.[1]) apiKey = keyMatch[1].trim();
			}
			if (excludeAppIds.length === 0) {
				const appIdsMatch = content.match(/excludeAppIds:\s*\[([\s\S]*?)\]/);
				if (appIdsMatch?.[1]) {
					const ids = appIdsMatch[1]
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
						.map(Number)
						.filter((n) => !isNaN(n));
					if (ids.length > 0) excludeAppIds = ids;
				}
			}
			if (excludeGames.length === 0) {
				const gamesMatch = content.match(/excludeGames:\s*\[([\s\S]*?)\]/);
				if (gamesMatch?.[1]) {
					const games = Array.from(
						gamesMatch[1].matchAll(/["']([^"']+)["']/g),
						(m) => m[1].trim(),
					);
					if (games.length > 0) excludeGames = games;
				}
			}
		} catch {
			// 文件不存在或不可读时忽略
		}
	}

	return {
		steamId,
		apiKey,
		excludeAppIds,
		excludeGames,
	};
}

async function fetchWithTimeout(url: string, timeoutMs = 8000) {
	const controller = new AbortController();
	const id = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) {
			throw new Error(`HTTP error! status: ${res.status}`);
		}
		return await res.json();
	} finally {
		clearTimeout(id);
	}
}

async function main() {
	console.log("🎮 正在准备更新 Steam 游戏数据快照...");
	const { steamId, apiKey, excludeAppIds, excludeGames } = await loadConfig();

	if (!steamId || !apiKey) {
		console.warn(
			"⚠️ 未检测到有效的 steamId 或 apiKey，将跳过在线拉取并保留现有 steam-data.json 快照。",
		);
		console.warn(
			"💡 提示：可在 ../lengxiqwq-site-content/config/steamConfig.ts 中填入 steamId 与 apiKey 后重试。",
		);
		return;
	}

	try {
		console.log(`🌐 正在请求 Steam Web API (SteamID: ${steamId})...`);

		// 1. 获取玩家个人资料 (GetPlayerSummaries)
		const summaryUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${apiKey}&steamids=${steamId}`;
		const summaryRes = await fetchWithTimeout(summaryUrl);
		const rawProfile = summaryRes?.response?.players?.[0];

		if (!rawProfile) {
			console.warn(
				"⚠️ 未能获取到玩家资料，请检查 SteamID 是否正确或个人资料是否公开。",
			);
			return;
		}

		const profile: SteamPlayerSummary = {
			steamid: rawProfile.steamid,
			personaname: rawProfile.personaname || "Steam Player",
			profileurl:
				rawProfile.profileurl ||
				`https://steamcommunity.com/profiles/${steamId}/`,
			avatar: rawProfile.avatar || "",
			avatarmedium: rawProfile.avatarmedium || "",
			avatarfull: rawProfile.avatarfull || "",
			personastate: rawProfile.personastate ?? 0,
			gameextrainfo: rawProfile.gameextrainfo,
			gameid: rawProfile.gameid,
			communityvisibilitystate: rawProfile.communityvisibilitystate,
			lastlogoff: rawProfile.lastlogoff,
		};

		// 2. 获取拥有的所有游戏 (GetOwnedGames)
		const ownedGamesUrl = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${apiKey}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1`;
		const ownedRes = await fetchWithTimeout(ownedGamesUrl);
		const rawGames: Array<{
			appid: number;
			name: string;
			playtime_forever: number;
			playtime_2weeks?: number;
			img_icon_url?: string;
			rtime_last_played?: number;
		}> = ownedRes?.response?.games || [];

		// 自动探测本地 Steam 客户端「隐藏的游戏」(Hidden Games) 收藏夹
		const clientHiddenAppIds = await getSteamClientHiddenAppIds(steamId);
		const excludeAppIdSet = new Set([
			...excludeAppIds.map(Number),
			...clientHiddenAppIds.map(Number),
		]);

		let hiddenFilteredCount = 0;
		const rawFilteredGames = rawGames.filter((g) => {
			if (excludeAppIdSet.has(g.appid)) {
				hiddenFilteredCount++;
				return false;
			}
			if (
				excludeGames.some((kw) =>
					g.name.toLowerCase().includes(kw.toLowerCase().trim()),
				)
			) {
				console.log(`🚫 已排除关键词匹配游戏: ${g.name} (${g.appid})`);
				return false;
			}
			return true;
		});

		console.log(
			`🎮 原始拥有游戏 ${rawGames.length} 款（已排除 ${hiddenFilteredCount} 款客户端隐藏/黑名单游戏），保留全部 ${rawFilteredGames.length} 款进行展示`,
		);

		// 3. 获取等级与徽章信息 (GetBadges)
		let levelInfo: SteamData["levelInfo"];
		try {
			const badgesUrl = `https://api.steampowered.com/IPlayerService/GetBadges/v1/?key=${apiKey}&steamid=${steamId}`;
			const badgesRes = await fetchWithTimeout(badgesUrl);
			const rawBadgesData = badgesRes?.response;
			if (rawBadgesData) {
				const playerLevel = rawBadgesData.player_level || 0;
				const playerXp = rawBadgesData.player_xp || 0;
				const xpNeededNext = rawBadgesData.player_xp_needed_to_level_up || 0;
				const xpCurrentLevel =
					rawBadgesData.player_xp_needed_current_level || 0;
				const badgesList = rawBadgesData.badges || [];

				const xpInLevel = Math.max(0, playerXp - xpCurrentLevel);
				const levelSpan = xpInLevel + xpNeededNext;
				const progressPercent =
					levelSpan > 0
						? Math.min(100, Math.round((xpInLevel / levelSpan) * 100))
						: 100;

				levelInfo = {
					player_level: playerLevel,
					player_xp: playerXp,
					player_xp_needed_to_level_up: xpNeededNext,
					player_xp_needed_current_level: xpCurrentLevel,
					badges_count: badgesList.length,
					progress_percent: progressPercent,
					badges: badgesList.slice(0, 30),
				};
			}
		} catch (err) {
			console.warn(
				`⚠️ 获取 Steam 徽章及等级信息异常: ${(err as Error).message}`,
			);
		}

		// 读取已有快照以便保留已成功获取的真实 CDN 封面地址
		const existingGamesMap = new Map<number, SteamGameItem>();
		try {
			const existingRaw = await fs.readFile(OUTPUT_FILE, "utf-8");
			const existingData: SteamData = JSON.parse(existingRaw);
			if (Array.isArray(existingData?.games)) {
				for (const eg of existingData.games) {
					existingGamesMap.set(eg.appid, eg);
				}
			}
		} catch {}

		// 4. 智能并发解析封面地址（通用治本机制：自动探测 Steam 2024+ 哈希路径，新购游戏自动适配）
		console.log(
			`🖼️ 正在智能校验与解析 ${rawFilteredGames.length} 款游戏的真实官方封面...`,
		);

		async function resolveHeaderUrl(
			appid: number,
			iconHash?: string,
			existingUrl?: string,
		): Promise<string> {
			// 若已有缓存且为已解析出的非默认扁平 URL，直接复用
			if (existingUrl && !existingUrl.endsWith(`/apps/${appid}/header.jpg`)) {
				return existingUrl;
			}

			const flatUrl = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`;
			try {
				const headRes = await fetch(flatUrl, {
					method: "HEAD",
					signal: AbortSignal.timeout(2000),
				});
				if (headRes.ok) {
					return flatUrl;
				}
			} catch {}

			// 扁平路径失效（新规则应用）：动态请求 Steam Store 官方 API 获取带 hash 的真实 header_image
			try {
				const storeRes = await fetch(
					`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic`,
					{ signal: AbortSignal.timeout(4000) },
				);
				if (storeRes.ok) {
					const storeJson = await storeRes.json();
					const appInfo = storeJson?.[appid];
					if (appInfo?.success && appInfo?.data?.header_image) {
						return appInfo.data.header_image;
					}
				}
			} catch {}

			// 保底：Steam Community 应用图标（只要入库即永久可访问）
			if (iconHash) {
				return `https://media.steampowered.com/steamcommunity/public/images/apps/${appid}/${iconHash}.jpg`;
			}

			return flatUrl;
		}

		const CONCURRENCY = 15;
		const processedGames: SteamGameItem[] = new Array(rawFilteredGames.length);
		let currentIndex = 0;

		const workers = Array.from({ length: CONCURRENCY }, async () => {
			while (currentIndex < rawFilteredGames.length) {
				const idx = currentIndex++;
				const g = rawFilteredGames[idx];
				const existing = existingGamesMap.get(g.appid);
				const playtimeForever = g.playtime_forever || 0;
				const playtime2weeks = g.playtime_2weeks || 0;

				const headerUrl = await resolveHeaderUrl(
					g.appid,
					g.img_icon_url,
					existing?.header_url,
				);

				processedGames[idx] = {
					appid: g.appid,
					name: g.name || `AppID ${g.appid}`,
					playtime_forever: playtimeForever,
					playtime_2weeks: playtime2weeks,
					img_icon_url: g.img_icon_url,
					rtime_last_played: g.rtime_last_played,
					playtime_hours: Number((playtimeForever / 60).toFixed(1)),
					playtime_2weeks_hours: Number((playtime2weeks / 60).toFixed(1)),
					cover_url: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${g.appid}/library_600x900_2x.jpg`,
					header_url: headerUrl,
					store_url: `https://store.steampowered.com/app/${g.appid}/`,
				};
			}
		});

		await Promise.all(workers);

		// 按总时长降序排序
		processedGames.sort((a, b) => b.playtime_forever - a.playtime_forever);

		// 最近两周玩过的游戏列表
		const recentGames = processedGames
			.filter((g) => (g.playtime_2weeks || 0) > 0)
			.sort((a, b) => (b.playtime_2weeks || 0) - (a.playtime_2weeks || 0));

		const totalPlaytimeMinutes = processedGames.reduce(
			(acc, g) => acc + g.playtime_forever,
			0,
		);
		const recentPlaytimeMinutes = recentGames.reduce(
			(acc, g) => acc + (g.playtime_2weeks || 0),
			0,
		);

		const finalData: SteamData = {
			profile,
			stats: {
				totalGames: processedGames.length,
				totalPlaytimeHours: Number((totalPlaytimeMinutes / 60).toFixed(1)),
				recentPlaytimeHours: Number((recentPlaytimeMinutes / 60).toFixed(1)),
				lastUpdated: new Date().toISOString(),
			},
			levelInfo,
			recentGames,
			games: processedGames,
		};

		await fs.writeFile(
			OUTPUT_FILE,
			JSON.stringify(finalData, null, 2),
			"utf-8",
		);
		console.log(
			`✅ Steam 游戏快照已更新成功！共包含 ${processedGames.length} 款游戏，已写入 ${OUTPUT_FILE}`,
		);
	} catch (err) {
		console.warn(
			`⚠️ 拉取 Steam API 失败（可能受国内网络波动或接口限制影响）: ${(err as Error).message}`,
		);
		console.warn("🛡️ 已自动保留现有的本地数据快照，不会中断构建流程。");
	}
}

main();
