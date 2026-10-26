import fs from "node:fs/promises";
import path from "node:path";
import type {
	SteamData,
	SteamGameItem,
	SteamPlayerSummary,
} from "../src/types/steamConfig";

const OUTPUT_FILE = path.resolve("src/constants/steam-data.json");

// 尝试安全读取 steamConfig 配置
async function loadConfig(): Promise<{ steamId: string; apiKey: string }> {
	let steamId = process.env.STEAM_ID || "";
	let apiKey = process.env.STEAM_API_KEY || "";

	// 如果未通过环境变量指定，尝试从私有内容仓配置或本地配置读取
	if (!apiKey || !steamId) {
		const configPaths = [
			path.resolve("../lengxiqwq-site-content/config/steamConfig.ts"),
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
			} catch {
				// 文件不存在或不可读时忽略
			}
		}
	}

	return { steamId, apiKey };
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
	const { steamId, apiKey } = await loadConfig();

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

		// 4. 处理并计算游戏列表
		const processedGames: SteamGameItem[] = rawGames.map((g) => {
			const playtimeForever = g.playtime_forever || 0;
			const playtime2weeks = g.playtime_2weeks || 0;
			return {
				appid: g.appid,
				name: g.name || `AppID ${g.appid}`,
				playtime_forever: playtimeForever,
				playtime_2weeks: playtime2weeks,
				img_icon_url: g.img_icon_url,
				rtime_last_played: g.rtime_last_played,
				playtime_hours: Number((playtimeForever / 60).toFixed(1)),
				playtime_2weeks_hours: Number((playtime2weeks / 60).toFixed(1)),
				cover_url: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${g.appid}/library_600x900_2x.jpg`,
				header_url: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${g.appid}/header.jpg`,
				store_url: `https://store.steampowered.com/app/${g.appid}/`,
			};
		});

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
