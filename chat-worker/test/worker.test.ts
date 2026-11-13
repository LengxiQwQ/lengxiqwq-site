import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildAvatarFromEmail,
	computeGuestUserKey,
	isAdminEmail,
	isIsolatedGuestUserKey,
	issueGuestSession,
	resolveRoleBadge,
	sanitizePublicBadge,
	shouldBlockGuestByWaline,
	verifyGuestToken,
	verifyGuestTokenWithEmail,
	verifyWalineTokenWithEmail,
} from "../src/auth/verify.js";
import {
	remapPlaybackUserKeys,
	remapReplyRefJson,
	remapUserKeyList,
	resolveEffectiveMemberProfile,
	resolveMergedMemberMetadata,
} from "../src/do/member-merge.js";
import {
	buildRecallNoticeContent,
	canDirectSkipTrack,
	canRecallMessage,
	canSilentDeleteMessage,
	computeNextAlarmTimestamp,
	computeVoteThreshold,
	formatReplyPreview,
	getMentionCooldownMs,
	MESSAGE_RECALL_WINDOW_MS,
	mergeNotificationTargets,
	resolveMentionTargets,
	shouldPlayEnqueuedImmediately,
} from "../src/do/rules.js";
import type { Env } from "../src/env.js";
import {
	isLikelyQQSongMid,
	MAX_TRACKS_PER_PLAYLIST,
	pickBestMatchedTrack,
	sanitizePlaylistPayload,
} from "../src/music/playlist-store.js";
import { QQMusicProvider } from "../src/music/providers/qq-music.js";
import {
	isAllowedStreamTarget,
	signStreamProxyUrl,
	verifyStreamProxyToken,
} from "../src/music/stream-signer.js";
import { isOriginAllowed } from "../src/utils/cors.js";

const MOCK_ENV: Env = {
	CHAT_ROOMS: {} as DurableObjectNamespace,
	CHAT_GUEST_SECRET: "test-guest-secret-32-chars-minimum",
	STREAM_SIGN_SECRET: "test-stream-secret-32-chars-minimum",
	ADMIN_EMAILS: "admin@example.com",
	GRAVATAR_STR: "https://cravatar.cn/avatar/",
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Auth & anti-impersonation", () => {
	it("generates QQ avatar for @qq.com emails and Cravatar MD5 for others", () => {
		expect(buildAvatarFromEmail("123456789@qq.com")).toBe(
			"https://q1.qlogo.cn/g?b=qq&nk=123456789&s=100",
		);
		const gravatar = buildAvatarFromEmail(
			"user@example.com",
			"https://cravatar.cn/avatar/",
		);
		expect(gravatar).toMatch(
			/^https:\/\/cravatar\.cn\/avatar\/[a-f0-9]{32}\?d=404$/,
		);
	});

	it("issues and verifies guest session while blocking reserved names/emails/badges", async () => {
		const blockedName = await issueGuestSession(MOCK_ENV, {
			nickname: "冷汐OωO",
			email: "visitor@example.com",
		});
		expect(blockedName.ok).toBe(false);

		const blockedEmail = await issueGuestSession(MOCK_ENV, {
			nickname: "路人甲",
			email: "admin@example.com",
		});
		expect(blockedEmail.ok).toBe(false);
		if (!blockedEmail.ok) {
			expect(blockedEmail.code).toBe("WALINE_LOGIN_REQUIRED");
		}
		expect(isAdminEmail(MOCK_ENV, " ADMIN@EXAMPLE.COM ")).toBe(true);
		expect(isAdminEmail(MOCK_ENV, "visitor@example.com")).toBe(false);

		const okRes = await issueGuestSession(MOCK_ENV, {
			nickname: "小明同学",
			email: "12345678@qq.com",
			url: "example.com",
			badge: "博主",
		});
		expect(okRes.ok).toBe(true);
		if (!okRes.ok) return;

		expect(okRes.user.isAdmin).toBe(false);
		expect(okRes.user.badge).toBe("访客");
		expect(okRes.user.badgeType).toBe("tag");
		expect(okRes.user.url).toBe("https://example.com/");
		expect(okRes.user.avatar).toBe(
			"https://q1.qlogo.cn/g?b=qq&nk=12345678&s=100",
		);

		const verified = await verifyGuestToken(MOCK_ENV, okRes.token);
		expect(verified?.userKey).toBe(okRes.user.userKey);
		expect(verified?.name).toBe("小明同学");
		expect("email" in (verified ?? {})).toBe(false);

		const verifiedWithEmail = await verifyGuestTokenWithEmail(
			MOCK_ENV,
			okRes.token,
		);
		expect(verifiedWithEmail?.email).toBe("12345678@qq.com");
		expect(verifiedWithEmail?.user.userKey).toBe(okRes.user.userKey);
	});

	it("locks reserved badges for non-admins and maps fixed role badges", () => {
		expect(sanitizePublicBadge("站长", false)).toEqual({
			badge: "",
			badgeType: "tag",
		});
		expect(sanitizePublicBadge("已认证", false)).toEqual({
			badge: "",
			badgeType: "tag",
		});
		expect(sanitizePublicBadge("认证", false)).toEqual({
			badge: "",
			badgeType: "tag",
		});
		expect(sanitizePublicBadge("访客", false)).toEqual({
			badge: "",
			badgeType: "tag",
		});
		expect(resolveRoleBadge("waline", true)).toEqual({
			badge: "站长",
			badgeType: "host",
		});
		expect(resolveRoleBadge("waline", false)).toEqual({
			badge: "认证",
			badgeType: "accent",
		});
		expect(resolveRoleBadge("guest", false)).toEqual({
			badge: "访客",
			badgeType: "tag",
		});
	});

	it("supports isolated split-guest sessions while strictly protecting admin identity", async () => {
		const blockedAdmin = await issueGuestSession(MOCK_ENV, {
			nickname: "假冒路人",
			email: "admin@example.com",
			allowSplitGuest: true,
		});
		expect(blockedAdmin.ok).toBe(false);
		if (!blockedAdmin.ok) {
			expect(blockedAdmin.status).toBe(403);
			expect(blockedAdmin.code).toBe("WALINE_LOGIN_REQUIRED");
			expect(blockedAdmin.allowSplitGuest).toBe(false);
		}

		const blockedReservedName = await issueGuestSession(MOCK_ENV, {
			nickname: "冷汐",
			email: "other@example.com",
			allowSplitGuest: true,
		});
		expect(blockedReservedName.ok).toBe(false);
		if (!blockedReservedName.ok) {
			expect(blockedReservedName.status).toBe(400);
			expect(blockedReservedName.allowSplitGuest).toBe(false);
		}

		const splitA = await issueGuestSession(MOCK_ENV, {
			nickname: "小明",
			email: "alice@example.com",
			allowSplitGuest: true,
		});
		const splitB = await issueGuestSession(MOCK_ENV, {
			nickname: "小明",
			email: "alice@example.com",
			allowSplitGuest: true,
		});
		expect(splitA.ok).toBe(true);
		expect(splitB.ok).toBe(true);
		if (!splitA.ok || !splitB.ok) return;

		expect(isIsolatedGuestUserKey(splitA.user.userKey)).toBe(true);
		expect(isIsolatedGuestUserKey(splitB.user.userKey)).toBe(true);
		expect(splitA.user.userKey).not.toBe(splitB.user.userKey);
		expect(splitA.user.userKey).not.toBe(
			computeGuestUserKey(
				"alice@example.com",
				MOCK_ENV.CHAT_GUEST_SECRET ?? "",
			),
		);
		expect(splitA.user.isolated).toBe(true);
		expect(splitA.user.notifyEmail).toBe(false);

		const verifiedSplit = await verifyGuestTokenWithEmail(
			MOCK_ENV,
			splitA.token,
		);
		expect(verifiedSplit?.isolated).toBe(true);
		expect(verifiedSplit?.user.isolated).toBe(true);
		expect(verifiedSplit?.user.notifyEmail).toBe(false);
		expect(verifiedSplit?.user.userKey).toBe(splitA.user.userKey);

		expect(
			shouldBlockGuestByWaline({
				isAdminEmail: true,
				hasWalineMember: true,
				isolated: true,
			}),
		).toBe(true);
		expect(
			shouldBlockGuestByWaline({
				isAdminEmail: false,
				hasWalineMember: true,
				isolated: false,
			}),
		).toBe(true);
		expect(
			shouldBlockGuestByWaline({
				isAdminEmail: false,
				hasWalineMember: true,
				isolated: true,
			}),
		).toBe(false);
	});

	it("neutralizes reserved admin display names on non-admin Waline logins", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					errno: 0,
					data: {
						objectId: 777,
						display_name: "站长",
						email: "fake@example.com",
						type: "guest",
					},
				}),
				{ status: 200 },
			),
		);
		const verified = await verifyWalineTokenWithEmail(
			{ ...MOCK_ENV, WALINE_SERVER_URL: "https://waline.example.com" },
			"fake-jwt-token",
		);
		expect(verified?.user.isAdmin).toBe(false);
		expect(verified?.user.name).toBe("用户#777");
	});
});

describe("Stream URL HMAC signing & SSRF defense", () => {
	it("signs and verifies valid external audio stream URLs", async () => {
		const secret = MOCK_ENV.STREAM_SIGN_SECRET ?? "fallback";
		const signed = await signStreamProxyUrl(
			"https://chat-api.lengxiqwq.com",
			"http://ws.stream.qqmusic.qq.com/C400001.m4a?vkey=abc",
			secret,
		);
		const token = new URL(signed).searchParams.get("token") ?? "";
		const verified = await verifyStreamProxyToken(token, secret);
		expect(verified?.url).toBe(
			"http://ws.stream.qqmusic.qq.com/C400001.m4a?vkey=abc",
		);
		expect(await verifyStreamProxyToken(`${token}x`, secret)).toBeNull();
	});

	it("rejects private/loopback stream targets", () => {
		expect(isAllowedStreamTarget("http://127.0.0.1/secret")).toBe(false);
		expect(isAllowedStreamTarget("http://192.168.1.1/test")).toBe(false);
		expect(isAllowedStreamTarget("file:///etc/passwd")).toBe(false);
		expect(
			isAllowedStreamTarget("https://isure.stream.qqmusic.qq.com/a.mp3"),
		).toBe(true);
	});
});

describe("Music provider decoupling & fallback", () => {
	it("falls back to VKeys when CYAPI fails and decodes UTF-8 base64 lyrics", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => {
				const url = String(input);
				if (url.includes("cyapi.top")) {
					return new Response(JSON.stringify({ msg: "busy" }), { status: 200 });
				}
				if (url.includes("api.vkeys.cn")) {
					return new Response(
						JSON.stringify({
							code: 0,
							data: {
								url: "http://ws.stream.qqmusic.qq.com/test.m4a",
								cover: "https://y.gtimg.cn/cover.jpg",
							},
						}),
						{ status: 200 },
					);
				}
				if (url.includes("fcg_query_lyric_new.fcg")) {
					const rawLrc = "[00:01.00]晴天 - 周杰伦";
					const bytes = new TextEncoder().encode(rawLrc);
					let bin = "";
					for (const b of bytes) bin += String.fromCharCode(b);
					return new Response(JSON.stringify({ lyric: btoa(bin) }), {
						status: 200,
					});
				}
				return new Response("{}", { status: 404 });
			});

		const provider = new QQMusicProvider("dummy-key");
		const stream = await provider.resolveStream("0039MnYb0qxYhV");
		expect(stream?.url).toBe("http://ws.stream.qqmusic.qq.com/test.m4a");
		expect(stream?.providerChannel).toBe("vkeys");

		const lyric = await provider.getLyric("0039MnYb0qxYhV");
		expect(lyric).toBe("[00:01.00]晴天 - 周杰伦");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});

describe("Vote skip threshold & fallback playback rules", () => {
	it("requires 2+ votes when 2+ members are online for user-requested tracks, and 1 for solo or fallback", () => {
		expect(computeVoteThreshold(1, false, false)).toBe(1);
		expect(computeVoteThreshold(2, false, true)).toBe(2);
		expect(computeVoteThreshold(2, false, false)).toBe(2);
		expect(computeVoteThreshold(3, false, true)).toBe(2);
		expect(computeVoteThreshold(4, true, false)).toBe(1);
	});

	it("allows anyone to directly skip fallback tracks at any time, while preserving rules for requested tracks", () => {
		expect(
			canDirectSkipTrack({
				isFallback: true,
				isAdmin: false,
				isTrackRequester: false,
				onlineMemberCount: 5,
				soloCooldownUntil: 9_999_999,
				now: 1_000,
			}),
		).toEqual({ allowed: true });

		expect(
			canDirectSkipTrack({
				isFallback: false,
				isAdmin: false,
				isTrackRequester: false,
				onlineMemberCount: 3,
				soloCooldownUntil: 0,
				now: 1_000,
			}).allowed,
		).toBe(false);

		expect(
			canDirectSkipTrack({
				isFallback: false,
				isAdmin: false,
				isTrackRequester: false,
				onlineMemberCount: 1,
				soloCooldownUntil: 5_000,
				now: 1_000,
			}).allowed,
		).toBe(false);

		expect(
			canDirectSkipTrack({
				isFallback: false,
				isAdmin: false,
				isTrackRequester: true,
				onlineMemberCount: 4,
				soloCooldownUntil: 0,
				now: 1_000,
			}),
		).toEqual({ allowed: true });

		// Multiple members online, everyone else is muted -> direct skip allowed immediately
		expect(
			canDirectSkipTrack({
				isFallback: false,
				isAdmin: false,
				isTrackRequester: false,
				onlineMemberCount: 5,
				otherUnmutedCount: 0,
				soloCooldownUntil: 0,
				now: 1_000,
			}),
		).toEqual({ allowed: true });

		// Multiple members online, at least one other member is unmuted -> requires vote
		expect(
			canDirectSkipTrack({
				isFallback: false,
				isAdmin: false,
				isTrackRequester: false,
				onlineMemberCount: 2,
				otherUnmutedCount: 1,
				soloCooldownUntil: 0,
				now: 1_000,
			}).allowed,
		).toBe(false);
	});

	it("cuts over immediately on enqueue when idle or playing fallback, but queues behind user requests", () => {
		expect(
			shouldPlayEnqueuedImmediately({
				hasCurrentPlayback: false,
				currentIsFallback: false,
				existingQueueLength: 0,
			}),
		).toBe(true);
		expect(
			shouldPlayEnqueuedImmediately({
				hasCurrentPlayback: true,
				currentIsFallback: true,
				existingQueueLength: 0,
			}),
		).toBe(true);
		expect(
			shouldPlayEnqueuedImmediately({
				hasCurrentPlayback: true,
				currentIsFallback: false,
				existingQueueLength: 0,
			}),
		).toBe(false);
		expect(
			shouldPlayEnqueuedImmediately({
				hasCurrentPlayback: true,
				currentIsFallback: true,
				existingQueueLength: 1,
			}),
		).toBe(false);
	});
});

describe("CORS & LAN dev origin policy", () => {
	it("allows production domains, pages previews, and private LAN dev origins", () => {
		const allowed =
			"https://lengxiqwq.com,https://*.lengxiqwq-site.pages.dev,http://localhost:4321";
		expect(isOriginAllowed("https://lengxiqwq.com", allowed)).toBe(true);
		expect(
			isOriginAllowed("https://abc.lengxiqwq-site.pages.dev", allowed),
		).toBe(true);
		expect(isOriginAllowed("http://192.168.1.50:4321", allowed)).toBe(true);
		expect(isOriginAllowed("http://10.0.0.15:4321", allowed)).toBe(true);
		expect(isOriginAllowed("https://evil.example.com", allowed)).toBe(false);
	});
});

describe("Offline @mention & reply batch window, alarm merge & target resolution", () => {
	it("sends immediately for admin (0ms) and collects for 5 minutes for regular members", () => {
		expect(getMentionCooldownMs(true)).toBe(0);
		expect(getMentionCooldownMs(false)).toBe(300_000);
	});

	it("merges @mention and reply targets without duplicates or self-notification", () => {
		expect(
			mergeNotificationTargets({
				mentionUserKeys: ["waline:1", "guest:a", "waline:1"],
				replyToUserKey: "guest:a",
				senderUserKey: "guest:self",
			}),
		).toEqual(["waline:1", "guest:a"]);

		expect(
			mergeNotificationTargets({
				mentionUserKeys: [],
				replyToUserKey: "guest:self",
				senderUserKey: "guest:self",
			}),
		).toEqual([]);

		expect(
			mergeNotificationTargets({
				mentionUserKeys: ["waline:1"],
				replyToUserKey: "guest:b",
				senderUserKey: "guest:self",
			}),
		).toEqual(["waline:1", "guest:b"]);
	});

	it("selects the earliest positive timestamp when merging playback & mention alarms", () => {
		expect(computeNextAlarmTimestamp([null, undefined, 0])).toBeNull();
		expect(computeNextAlarmTimestamp([5000, 1200, null])).toBe(1200);
		expect(computeNextAlarmTimestamp([1000, 9000])).toBe(1000);
	});

	it("resolves online-first targets, names with spaces or punctuation, and ignores self/unmentioned keys", () => {
		const res = resolveMentionTargets({
			senderUserKey: "guest:me",
			content: "喂 @Xiao Ming @冷汐OωO，来看看",
			rawTokens: ["Xiao", "冷汐OωO，来看看"],
			explicitKeys: ["guest:ming", "waline:2", "guest:me"],
			candidates: [
				{
					userKey: "guest:me",
					name: "我自己",
					online: true,
					lastSeenAt: 1000,
				},
				{
					userKey: "guest:ming",
					name: "Xiao Ming",
					online: false,
					lastSeenAt: 800,
				},
				{
					userKey: "waline:1",
					name: "冷汐OωO",
					online: false,
					lastSeenAt: 900,
				},
				{
					userKey: "waline:2",
					name: "冷沐",
					online: true,
					lastSeenAt: 950,
				},
			],
		});

		expect(res.targetUserKeys).toEqual(["guest:ming", "waline:1"]);
		expect(res.matchedNames).toContain("Xiao Ming");
		expect(res.matchedNames).toContain("冷汐OωO");
		expect(res.targetUserKeys).not.toContain("waline:2");
		expect(res.targetUserKeys).not.toContain("guest:me");
	});

	it("does not cross-notify duplicate-name accounts when explicitKey selects one identity", () => {
		const res = resolveMentionTargets({
			senderUserKey: "guest:sender",
			content: "@小明 你好",
			rawTokens: ["小明"],
			explicitKeys: ["guest:iso_1234"],
			candidates: [
				{
					userKey: "waline:42",
					name: "小明",
					online: true,
					lastSeenAt: 2000,
				},
				{
					userKey: "guest:iso_1234",
					name: "小明",
					online: false,
					lastSeenAt: 1500,
				},
			],
		});

		expect(res.targetUserKeys).toEqual(["guest:iso_1234"]);
	});
});

describe("Reply preview formatting", () => {
	it("collapses whitespace and truncates long reply previews", () => {
		expect(formatReplyPreview("  hello\n\nworld   test  ")).toBe(
			"hello world test",
		);
		expect(formatReplyPreview("abcdefghij", 5)).toBe("abcde…");
	});
});

describe("Message recall & admin delete permissions", () => {
	it("limits non-admin self recall to 5 minutes", () => {
		const createdAt = 1_000_000;
		expect(
			canRecallMessage({
				msgUserKey: "guest:a",
				msgCreatedAt: createdAt,
				actorUserKey: "guest:a",
				actorIsAdmin: false,
				now: createdAt + MESSAGE_RECALL_WINDOW_MS,
			}),
		).toEqual({ allowed: true });

		expect(
			canRecallMessage({
				msgUserKey: "guest:a",
				msgCreatedAt: createdAt,
				actorUserKey: "guest:a",
				actorIsAdmin: false,
				now: createdAt + MESSAGE_RECALL_WINDOW_MS + 1,
			}),
		).toEqual({
			allowed: false,
			reason: "消息发送已超过 5 分钟，无法撤回",
		});
	});

	it("allows admin to delete any message at any time, and blocks non-admin from recalling others", () => {
		const createdAt = 1_000_000;
		expect(
			canRecallMessage({
				msgUserKey: "waline:admin",
				msgCreatedAt: createdAt,
				actorUserKey: "waline:admin",
				actorIsAdmin: true,
				now: createdAt + MESSAGE_RECALL_WINDOW_MS + 60_000,
			}).allowed,
		).toBe(true);

		expect(
			canRecallMessage({
				msgUserKey: "guest:a",
				msgCreatedAt: createdAt,
				actorUserKey: "waline:admin",
				actorIsAdmin: true,
				now: createdAt + MESSAGE_RECALL_WINDOW_MS + 60_000,
			}).allowed,
		).toBe(true);

		expect(
			canRecallMessage({
				msgUserKey: "guest:a",
				msgCreatedAt: createdAt,
				actorUserKey: "guest:b",
				actorIsAdmin: false,
				now: createdAt + 1000,
			}),
		).toEqual({ allowed: false, reason: "无权撤回他人消息" });
	});

	it("restricts silent delete to admins and formats recall system notices properly", () => {
		expect(
			canSilentDeleteMessage({
				actorUserKey: "guest:a",
				actorIsAdmin: false,
			}),
		).toEqual({ allowed: false, reason: "仅站长可执行静默删除操作" });

		expect(
			canSilentDeleteMessage({
				actorUserKey: "waline:1",
				actorIsAdmin: true,
			}),
		).toEqual({ allowed: true });

		expect(
			buildRecallNoticeContent({
				actorUserKey: "guest:a",
				actorName: "小明",
				msgUserKey: "guest:a",
				msgAuthorName: "小明",
			}),
		).toBe("小明 撤回了一条消息");

		expect(
			buildRecallNoticeContent({
				actorUserKey: "waline:1",
				actorName: "冷汐OωO",
				msgUserKey: "guest:a",
				msgAuthorName: "小明",
			}),
		).toBe("冷汐OωO 撤回了 小明 的一条消息");
	});
});

describe("Playlist store sanitization & cross-platform matching", () => {
	it("sanitizes playlist payloads, filters unsafe covers, enforces limits, and auto-matches QQ songmid", () => {
		const oversizedTracks = Array.from(
			{ length: MAX_TRACKS_PER_PLAYLIST + 20 },
			(_, idx) => ({
				sourcePlatform: idx === 0 ? "qqmusic" : "netease",
				sourceTrackId: idx === 0 ? "0039MnYb0qxYhV" : String(1000 + idx),
				title: `Song ${idx}`,
				artist: `Artist ${idx}`,
				cover:
					idx === 0
						? "https://p2.music.126.net/cover.jpg"
						: "http://insecure.example.com/cover.jpg",
				durationSec: 210,
			}),
		);

		const res = sanitizePlaylistPayload({
			title: "  我的测试歌单  ",
			platform: "NetEase",
			sourceUrl: "https://music.163.com/playlist?id=12345",
			coverUrl: "javascript:alert(1)",
			tracks: oversizedTracks,
		});

		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.data.title).toBe("我的测试歌单");
		expect(res.data.platform).toBe("netease");
		expect(res.data.tracks).toHaveLength(MAX_TRACKS_PER_PLAYLIST);
		expect(res.data.tracks[0]?.matchedTrack?.id).toBe("qq:0039MnYb0qxYhV");
		expect(res.data.tracks[1]?.matchedTrack).toBeNull();
		expect(res.data.tracks[1]?.cover).toBe("");
		expect(res.data.coverUrl).toBe("https://p2.music.126.net/cover.jpg");

		expect(isLikelyQQSongMid("0039MnYb0qxYhV")).toBe(true);
		expect(isLikelyQQSongMid("1234567890")).toBe(false);
	});

	it("scores and picks the closest playable candidate across platforms", () => {
		const candidates = [
			{
				id: "qq:live",
				provider: "qq",
				sourceId: "live",
				title: "晴天 (Live)",
				artist: "周杰伦",
				cover: "",
				durationSec: 320,
			},
			{
				id: "qq:studio",
				provider: "qq",
				sourceId: "studio",
				title: "晴天",
				artist: "周杰伦",
				cover: "",
				durationSec: 269,
			},
			{
				id: "qq:cover",
				provider: "qq",
				sourceId: "cover",
				title: "晴天",
				artist: "翻唱歌手",
				cover: "",
				durationSec: 270,
			},
		];

		const picked = pickBestMatchedTrack(candidates, {
			title: "晴天",
			artist: "周杰伦",
			durationSec: 269,
		});
		expect(picked?.id).toBe("qq:studio");

		const unrelated = pickBestMatchedTrack(candidates, {
			title: "Completely Different Song",
			artist: "Other Artist",
			durationSec: 180,
		});
		expect(unrelated).toBeNull();
	});
});

describe("Guest-to-Waline same-email member merging", () => {
	it("computes consistent deterministic guest keys normalized by email", () => {
		const k1 = computeGuestUserKey(
			"  User@Example.com ",
			MOCK_ENV.CHAT_GUEST_SECRET ?? "",
		);
		const k2 = computeGuestUserKey(
			"user@example.com",
			MOCK_ENV.CHAT_GUEST_SECRET ?? "",
		);
		expect(k1).toMatch(/^guest:[a-f0-9]{20}$/);
		expect(k1).toBe(k2);
	});

	it("inherits guest timestamps/bio/notify preference when Waline account is new, and preserves Waline baseline when Waline row already exists", () => {
		const newWalineMeta = resolveMergedMemberMetadata({
			existingTarget: null,
			guestRows: [
				{
					notifyEmail: 0,
					bio: "爱听歌的访客",
					status: "摸鱼中",
					firstSeenAt: 1_000,
					lastSeenAt: 3_000,
					lastNotifiedAt: 2_000,
					lastReadAt: 2_800,
				},
			],
			now: 5_000,
		});
		expect(newWalineMeta).toEqual({
			notifyInt: 0,
			bio: "爱听歌的访客",
			status: "摸鱼中",
			firstSeenAt: 1_000,
			lastReadAt: 2_800,
			lastNotifiedAt: 2_000,
		});

		const existingWalineMeta = resolveMergedMemberMetadata({
			existingTarget: {
				notifyEmail: 1,
				bio: "正式号签名",
				status: "听歌中",
				firstSeenAt: 4_000,
				lastSeenAt: 4_500,
				lastNotifiedAt: 4_100,
				lastReadAt: 4_200,
			},
			guestRows: [
				{
					notifyEmail: 0,
					bio: "旧访客签名",
					status: "摸鱼中",
					firstSeenAt: 1_000,
					lastSeenAt: 3_000,
					lastNotifiedAt: 2_000,
					lastReadAt: 4_900,
				},
			],
			now: 5_000,
		});
		expect(existingWalineMeta).toEqual({
			notifyInt: 1,
			bio: "正式号签名",
			status: "听歌中",
			firstSeenAt: 1_000,
			lastReadAt: 4_900,
			lastNotifiedAt: 4_100,
		});
	});

	it("remaps mention keys, reply references, and active playback keys without duplicates", () => {
		const guestSet = new Set(["guest:abc123"]);

		expect(
			remapUserKeyList(
				["guest:abc123", "waline:2", "waline:9", "guest:abc123"],
				guestSet,
				"waline:9",
			),
		).toEqual({
			changed: true,
			next: ["waline:9", "waline:2"],
		});

		const replyRes = remapReplyRefJson(
			JSON.stringify({
				msgUid: "m1",
				userKey: "guest:abc123",
				name: "旧访客名",
				content: "你好",
			}),
			guestSet,
			"waline:9",
			"正式昵称",
		);
		expect(replyRes.changed).toBe(true);
		expect(JSON.parse(replyRes.nextJson)).toEqual({
			msgUid: "m1",
			userKey: "waline:9",
			name: "正式昵称",
			content: "你好",
		});

		const playbackRes = remapPlaybackUserKeys(
			{
				requesterKey: "guest:abc123",
				requesterName: "旧访客名",
				isFallback: false,
				skipVotes: ["guest:abc123", "waline:9", "waline:5"],
				errorReports: ["guest:abc123"],
			},
			guestSet,
			"waline:9",
			"正式昵称",
		);
		expect(playbackRes.changed).toBe(true);
		expect(playbackRes.next).toEqual({
			requesterKey: "waline:9",
			requesterName: "正式昵称",
			isFallback: false,
			skipVotes: ["waline:9", "waline:5"],
			errorReports: ["waline:9"],
		});
	});

	it("preserves custom chatroom avatar/name/url across Waline re-logins and allows clearing back to defaults", () => {
		expect(
			resolveEffectiveMemberProfile({
				baseName: "Waline原名",
				baseAvatar: "https://waline.example/default.png",
				baseUrl: "https://waline.example",
				custom: {
					customName: "聊天室自定义昵称",
					customAvatar: "https://img.example/custom.png",
					customUrl: "https://custom.site",
					hasCustomUrl: true,
				},
			}),
		).toEqual({
			name: "聊天室自定义昵称",
			avatar: "https://img.example/custom.png",
			url: "https://custom.site",
		});

		// Resetting avatar back to default restores baseAvatar; explicitly cleared URL stays empty
		expect(
			resolveEffectiveMemberProfile({
				baseName: "Waline原名",
				baseAvatar: "https://waline.example/default.png",
				baseUrl: "https://waline.example",
				custom: {
					customName: "",
					customAvatar: "",
					customUrl: "",
					hasCustomUrl: true,
				},
			}),
		).toEqual({
			name: "Waline原名",
			avatar: "https://waline.example/default.png",
			url: "",
		});

		// Blocks reserved custom names for non-admin users
		expect(
			resolveEffectiveMemberProfile({
				baseName: "普通用户",
				baseAvatar: "https://waline.example/default.png",
				baseUrl: "",
				allowCustomName: false,
				custom: {
					customName: "站长",
					customAvatar: "https://img.example/custom.png",
					customUrl: "",
					hasCustomUrl: false,
				},
			}),
		).toEqual({
			name: "普通用户",
			avatar: "https://img.example/custom.png",
			url: "",
		});
	});

	it("initializes notifyInt to 0 when defaultNotifyEmail is disabled for isolated guests", () => {
		const isolatedMeta = resolveMergedMemberMetadata({
			existingTarget: null,
			guestRows: [],
			defaultNotifyEmail: 0,
			now: 9000,
		});
		expect(isolatedMeta.notifyInt).toBe(0);
	});
});
