// 自动化本地端到端测试套件
const BASE_URL = "http://127.0.0.1:8787";
const MASTER_KEY = "lengxi-master-dev-secret-2026";

async function runTests() {
	console.log("🚀 开始执行 Cloudflare Worker API 自动化端到端测试...\n");
	let passed = 0;
	let failed = 0;

	function assert(condition, message) {
		if (condition) {
			console.log(`  ✅ [PASS] ${message}`);
			passed++;
		} else {
			console.error(`  ❌ [FAIL] ${message}`);
			failed++;
		}
	}

	// 1. 测试健康检查 /api/health
	console.log("1. 测试 GET /api/health");
	const healthRes = await fetch(`${BASE_URL}/api/health`);
	const healthJson = await healthRes.json();
	assert(healthRes.status === 200, "状态码应为 200");
	assert(
		healthJson.code === 200 && healthJson.status === "ok",
		"返回 status 应为 ok",
	);
	assert(healthJson.bindings.hasDB === true, "D1 数据库绑定应检测通过");
	assert(healthJson.bindings.hasKV === true, "KV 命名空间绑定应检测通过");
	assert(healthJson.bindings.hasR2 === true, "R2 存储桶绑定应检测通过");
	assert(
		healthJson.bindings.hasMasterKey === true,
		"MASTER_KEY 环境变量应检测通过",
	);

	// 2. 测试错误暗号登录 (应返回 401)
	console.log("\n2. 测试 POST /api/admin/login (错误暗号)");
	const wrongLoginRes = await fetch(`${BASE_URL}/api/admin/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ masterKey: "wrong-password" }),
	});
	assert(wrongLoginRes.status === 401, "错误暗号应返回 401 Unauthorized");

	// 3. 测试正确暗号登录 (应返回 200 与 JWT Token)
	console.log("\n3. 测试 POST /api/admin/login (正确暗号)");
	const loginRes = await fetch(`${BASE_URL}/api/admin/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ masterKey: MASTER_KEY }),
	});
	const loginJson = await loginRes.json();
	assert(loginRes.status === 200, "正确暗号应返回 200 OK");
	assert(
		typeof loginJson.data?.token === "string" &&
			loginJson.data.token.length > 20,
		"应签发合法的 JWT Token",
	);
	const token = loginJson.data?.token;

	// 4. 测试未鉴权发布说说 (应返回 401)
	console.log("\n4. 测试 POST /api/dynamic/publish (未授权拦截)");
	const unauthRes = await fetch(`${BASE_URL}/api/dynamic/publish`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ content: "未授权测试" }),
	});
	assert(unauthRes.status === 401, "未携带 Token 应被拦截并返回 401");

	// 5. 测试已授权发布动态说说 (应写入 D1)
	console.log("\n5. 测试 POST /api/dynamic/publish (授权发布)");
	const publishPayload = {
		content: "第一条通过 Worker D1 自动化测试发布的说说！#测试 #迁移",
		images: [
			"https://img.lengxiqwq.com/test-pic-1.webp",
			"https://img.lengxiqwq.com/test-pic-2.webp",
		],
		pinned: true,
		location: "上海·测试控制台",
	};
	const publishRes = await fetch(`${BASE_URL}/api/dynamic/publish`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(publishPayload),
	});
	const publishJson = await publishRes.json();
	assert(publishRes.status === 200, "发布成功状态码应为 200 OK");
	assert(
		publishJson.code === 200 && publishJson.data?.id,
		"返回数据中应包含生成的消息 ID",
	);
	assert(publishJson.data.pinned === true, "置顶状态应正确解析为布尔 true");
	assert(
		Array.isArray(publishJson.data.images) &&
			publishJson.data.images.length === 2,
		"图片列表应正确解析为数组",
	);
	const createdId = publishJson.data.id;

	// 6. 测试公开查询说说列表 GET /api/dynamic/list
	console.log("\n6. 测试 GET /api/dynamic/list (公开查询)");
	const listRes = await fetch(`${BASE_URL}/api/dynamic/list?page=1&limit=10`);
	const listJson = await listRes.json();
	assert(listRes.status === 200, "查询列表应返回 200 OK");
	assert(
		listJson.data.total >= 1,
		`总条数应大于等于 1 (当前: ${listJson.data.total})`,
	);
	const foundItem = listJson.data.items.find((item) => item.id === createdId);
	assert(foundItem !== undefined, "列表中应能查询到刚才创建的说说");
	assert(
		foundItem?.content === publishPayload.content,
		"列表内容应与发布内容一致",
	);

	// 7. 测试修改说说 PUT /api/dynamic/:id
	console.log("\n7. 测试 PUT /api/dynamic/:id (修改说说)");
	const updatedContent = "这是经过 PUT 接口更新后的说说内容！已修正。";
	const updateRes = await fetch(`${BASE_URL}/api/dynamic/${createdId}`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			content: updatedContent,
			pinned: false,
		}),
	});
	const updateJson = await updateRes.json();
	assert(updateRes.status === 200, "更新接口状态码应为 200 OK");
	assert(
		updateJson.data.content === updatedContent,
		"返回的内容应为修改后的内容",
	);
	assert(updateJson.data.pinned === false, "置顶状态应更新为 false");

	// 8. 测试图片上传 POST /api/dynamic/upload 到 R2
	console.log("\n8. 测试 POST /api/dynamic/upload (R2 图片直传)");
	const formData = new FormData();
	// 模拟一个 1x1 像素的 PNG 图片文件
	const pngBlob = new Blob(
		[
			new Uint8Array([
				0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
				0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
				0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
				0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
				0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
				0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
			]),
		],
		{ type: "image/png" },
	);
	formData.append("file", pngBlob, "test-pixel.png");

	const uploadRes = await fetch(`${BASE_URL}/api/dynamic/upload`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
		},
		body: formData,
	});
	const uploadJson = await uploadRes.json();
	assert(uploadRes.status === 200, "上传成功状态码应为 200 OK");
	assert(
		uploadJson.code === 200 && typeof uploadJson.data?.url === "string",
		"应返回有效的图片 URL",
	);
	assert(
		uploadJson.data.url.includes("test-pixel.png") ||
			uploadJson.data.url.includes(".png"),
		"URL 应包含正确后缀",
	);
	console.log(`    ℹ️ 返回的 R2 上传链接: ${uploadJson.data?.url}`);

	// 9. 测试删除说说 DELETE /api/dynamic/:id
	console.log("\n9. 测试 DELETE /api/dynamic/:id (删除说说)");
	const deleteRes = await fetch(`${BASE_URL}/api/dynamic/${createdId}`, {
		method: "DELETE",
		headers: {
			Authorization: `Bearer ${token}`,
		},
	});
	assert(deleteRes.status === 200, "删除状态码应为 200 OK");

	// 10. 验证删除后不存在
	console.log("\n10. 验证删除后列表状态");
	const afterListRes = await fetch(
		`${BASE_URL}/api/dynamic/list?page=1&limit=10`,
	);
	const afterListJson = await afterListRes.json();
	const deletedItem = afterListJson.data.items.find(
		(item) => item.id === createdId,
	);
	assert(deletedItem === undefined, "被删除的说说已不存在于列表中");

	// 11. 测试 GET /api/fcircle/posts (朋友圈分页列表)
	console.log("\n11. 测试 GET /api/fcircle/posts (朋友圈分页列表)");
	const fcirclePostsRes = await fetch(
		`${BASE_URL}/api/fcircle/posts?page=1&limit=5`,
	);
	const fcirclePostsJson = await fcirclePostsRes.json();
	assert(fcirclePostsRes.status === 200, "朋友圈列表响应状态码应为 200");
	assert(fcirclePostsJson.code === 200, "业务响应码应为 200");
	assert(
		Array.isArray(fcirclePostsJson.data?.items) &&
			fcirclePostsJson.data.items.length > 0,
		"应成功返回非空文章数组",
	);
	const samplePost = fcirclePostsJson.data.items[0];
	assert(typeof samplePost.id === "string", "文章应包含合法字符串 ID");
	assert(
		typeof samplePost.friendName === "string" &&
			samplePost.friendName.length > 0,
		"文章应包含友链博主名称",
	);
	assert(
		typeof samplePost.title === "string" && samplePost.title.length > 0,
		"文章应包含有效标题",
	);
	assert(
		typeof samplePost.link === "string" && samplePost.link.startsWith("http"),
		"文章链接应为合法的 HTTP(S) 地址",
	);
	assert(
		!Number.isNaN(new Date(samplePost.pubDate).getTime()),
		"文章发布时间应为有效日期格式",
	);
	assert(
		typeof fcirclePostsJson.data.total === "number" &&
			fcirclePostsJson.data.total >= fcirclePostsJson.data.items.length,
		"总条数 total 应大于等于当前页条数",
	);
	assert(
		fcirclePostsJson.data.page === 1 && fcirclePostsJson.data.limit === 5,
		"分页参数 page 与 limit 应正确回显",
	);

	// 12. 测试 GET /api/fcircle/stats (朋友圈概览统计)
	console.log("\n12. 测试 GET /api/fcircle/stats (朋友圈概览统计)");
	const fcircleStatsRes = await fetch(`${BASE_URL}/api/fcircle/stats`);
	const fcircleStatsJson = await fcircleStatsRes.json();
	assert(fcircleStatsRes.status === 200, "统计接口响应状态码应为 200");
	assert(fcircleStatsJson.code === 200, "业务状态码应为 200");
	assert(
		typeof fcircleStatsJson.data?.friendCount === "number" ||
			typeof fcircleStatsJson.data?.totalFriends === "number",
		"友链总数指标应有效返回",
	);
	assert(
		typeof fcircleStatsJson.data?.activeCount === "number" ||
			typeof fcircleStatsJson.data?.activeFriends === "number",
		"活跃友链指标应有效返回",
	);
	assert(
		typeof fcircleStatsJson.data?.todayCount === "number" ||
			typeof fcircleStatsJson.data?.todayUpdates === "number",
		"今日更新指标应有效返回",
	);
	assert(
		typeof fcircleStatsJson.data?.updatedAt === "number" ||
			typeof fcircleStatsJson.data?.lastUpdated === "number",
		"最后更新时间戳应有效返回",
	);

	// 13. 测试 POST /api/fcircle/sync (未授权拦截)
	console.log("\n13. 测试 POST /api/fcircle/sync (未授权拦截)");
	const unauthSyncRes = await fetch(`${BASE_URL}/api/fcircle/sync`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
	});
	assert(unauthSyncRes.status === 401, "未携带 Token 应被拦截并返回 401");

	// 14. 测试 POST /api/fcircle/sync (授权手动同步触发)
	console.log("\n14. 测试 POST /api/fcircle/sync (授权手动同步)");
	const authSyncRes = await fetch(`${BASE_URL}/api/fcircle/sync`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
	});
	const authSyncJson = await authSyncRes.json();
	assert(authSyncRes.status === 200, "手动同步接口响应状态码应为 200 OK");
	assert(authSyncJson.code === 200, "同步业务状态码应为 200");
	assert(
		typeof authSyncJson.data?.total === "number" &&
			authSyncJson.data.total >= 1,
		"同步后抓取文章总数应大于等于 1",
	);
	assert(authSyncJson.data?.stats !== undefined, "同步响应应包含实时统计信息");

	// 15. 测试 GET /api/github/repo (参数校验拦截)
	console.log("\n15. 测试 GET /api/github/repo (参数校验拦截)");
	const invalidGithubRes = await fetch(
		`${BASE_URL}/api/github/repo?name=invalid-name`,
	);
	assert(invalidGithubRes.status === 400, "无效仓库名应返回 400 Bad Request");

	// 16. 测试 GET /api/github/repo (代理查询官方仓库)
	console.log("\n16. 测试 GET /api/github/repo (查询 withastro/astro)");
	const githubRes = await fetch(
		`${BASE_URL}/api/github/repo?name=withastro/astro`,
	);
	const githubJson = await githubRes.json();
	assert(githubRes.status === 200, "代理接口应返回 200 OK");
	assert(githubJson.code === 200, "业务响应码应为 200");
	assert(
		githubJson.data?.name?.toLowerCase().includes("withastro/astro"),
		"仓库全名应包含 withastro/astro",
	);
	assert(
		typeof githubJson.data?.stars === "number" && githubJson.data.stars > 1000,
		"Star 数应为大于 1000 的合法数字",
	);
	assert(
		typeof githubJson.data?.forks === "number" && githubJson.data.forks > 100,
		"Fork 数应为大于 100 的合法数字",
	);
	assert(
		typeof githubJson.data?.avatarUrl === "string" &&
			githubJson.data.avatarUrl.startsWith("http"),
		"头像地址应为合法图片 URL",
	);
	const cacheControlHeader = githubRes.headers.get("cache-control");
	assert(
		cacheControlHeader?.includes("public"),
		"响应标头应包含 public Cache-Control 缓存控制",
	);

	// 17. 测试 GET /api/github/repo (验证 KV 缓存命中)
	console.log("\n17. 测试 GET /api/github/repo (验证 KV 缓存命中)");
	const cachedGithubRes = await fetch(
		`${BASE_URL}/api/github/repo?name=withastro/astro`,
	);
	const cachedGithubJson = await cachedGithubRes.json();
	assert(cachedGithubRes.status === 200, "缓存接口应返回 200 OK");
	assert(
		cachedGithubJson.fromCache === true,
		"第二次请求同一仓库应直接命中 KV 缓存 (fromCache: true)",
	);

	// 18. 测试 GET /api/stats/realtime (实时在线人数)
	console.log("\n18. 测试 GET /api/stats/realtime (实时在线人数)");
	const realtimeRes = await fetch(`${BASE_URL}/api/stats/realtime`);
	const realtimeJson = await realtimeRes.json();
	assert(realtimeRes.status === 200, "实时统计接口应返回 200 OK");
	assert(realtimeJson.code === 200, "业务状态码应为 200");
	assert(
		typeof realtimeJson.data?.activeUsers === "number" &&
			realtimeJson.data.activeUsers >= 1,
		`在线人数应为大于等于 1 的数字 (当前: ${realtimeJson.data?.activeUsers})`,
	);
	assert(
		typeof realtimeJson.data?.timestamp === "number",
		"应包含毫秒时间戳",
	);

	// 19. 测试 GET /api/stats/summary (30天访问走势)
	console.log("\n19. 测试 GET /api/stats/summary (30天访问走势)");
	const summaryRes = await fetch(`${BASE_URL}/api/stats/summary`);
	const summaryJson = await summaryRes.json();
	assert(summaryRes.status === 200, "概览走势接口应返回 200 OK");
	assert(summaryJson.code === 200, "业务状态码应为 200");
	assert(
		typeof summaryJson.data?.totalPv === "number" &&
			summaryJson.data.totalPv > 0,
		"总 PV 数应大于 0",
	);
	assert(
		typeof summaryJson.data?.totalUv === "number" &&
			summaryJson.data.totalUv > 0,
		"总 UV 数应大于 0",
	);
	assert(
		Array.isArray(summaryJson.data?.chart) &&
			summaryJson.data.chart.length === 30,
		"走势图数组应精确包含过去 30 天数据",
	);

	// 20. 测试 GET /api/stats/insights (画像与热门文章洞察)
	console.log("\n20. 测试 GET /api/stats/insights (画像与热门文章洞察)");
	const insightsRes = await fetch(`${BASE_URL}/api/stats/insights`);
	const insightsJson = await insightsRes.json();
	assert(insightsRes.status === 200, "画像洞察接口应返回 200 OK");
	assert(insightsJson.code === 200, "业务状态码应为 200");
	assert(
		Array.isArray(insightsJson.data?.topPages) &&
			insightsJson.data.topPages.length >= 5,
		"热门文章榜单应包含至少 5 篇文章",
	);
	assert(
		Array.isArray(insightsJson.data?.countries) &&
			insightsJson.data.countries.length > 0,
		"应包含国家与地域分布数据",
	);
	assert(
		Array.isArray(insightsJson.data?.browsers) &&
			insightsJson.data.browsers.length > 0,
		"应包含客户端浏览器分布数据",
	);
	assert(
		Array.isArray(insightsJson.data?.os) &&
			insightsJson.data.os.length > 0,
		"应包含操作系统分布数据",
	);

	// 21. 测试 POST /api/admin/commit-post (未授权拦截)
	console.log("\n21. 测试 POST /api/admin/commit-post (未授权拦截)");
	const unauthCommitRes = await fetch(`${BASE_URL}/api/admin/commit-post`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			title: "未授权测试文章",
			slug: "unauthorized-test",
			content: "正文内容",
		}),
	});
	assert(unauthCommitRes.status === 401, "未授权提交文章应被拦截并返回 401");

	// 22. 测试 POST /api/admin/commit-post (授权提交 Markdown 文章)
	console.log("\n22. 测试 POST /api/admin/commit-post (授权提交 Markdown 文章)");
	const commitPostPayload = {
		title: "自动化测试文章：Cloudflare Worker 深度融合实践",
		slug: "test-cf-worker-integration",
		content: "这是通过自动化测试套件调用 Worker Admin 接口生成的 Markdown 正文！",
		category: "技术笔记",
		tags: ["自动化测试", "Worker", "D1"],
		cover: "https://img.lengxiqwq.com/test-cover.webp",
		excerpt: "本篇测试文章验证自动化 YAML Frontmatter 与提交逻辑",
		draft: false,
	};
	const authCommitRes = await fetch(`${BASE_URL}/api/admin/commit-post`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(commitPostPayload),
	});
	const authCommitJson = await authCommitRes.json();
	assert(authCommitRes.status === 200, "授权提交状态码应为 200 OK");
	assert(authCommitJson.code === 200, "业务状态码应为 200");
	assert(
		authCommitJson.data?.path === "content/posts/test-cf-worker-integration.md",
		"应正确生成 content/posts/test-cf-worker-integration.md 路径",
	);

	// 23. 测试 POST /api/admin/trigger-friend-check (未授权拦截)
	console.log("\n23. 测试 POST /api/admin/trigger-friend-check (未授权拦截)");
	const unauthFriendCheckRes = await fetch(
		`${BASE_URL}/api/admin/trigger-friend-check`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
		},
	);
	assert(
		unauthFriendCheckRes.status === 401,
		"未授权触发友链巡检应被拦截并返回 401",
	);

	// 24. 测试 POST /api/admin/trigger-friend-check (授权触发巡检)
	console.log("\n24. 测试 POST /api/admin/trigger-friend-check (授权触发巡检)");
	const authFriendCheckRes = await fetch(
		`${BASE_URL}/api/admin/trigger-friend-check`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
		},
	);
	const authFriendCheckJson = await authFriendCheckRes.json();
	assert(authFriendCheckRes.status === 200, "授权触发巡检状态码应为 200 OK");
	assert(authFriendCheckJson.code === 200, "业务响应码应为 200");
	assert(
		authFriendCheckJson.data?.workflow === "check-friends.yml",
		"工作流名称应为 check-friends.yml",
	);

	console.log("\n==============================================");
	console.log(
		`📊 测试汇总: 共 ${passed + failed} 项测试 | ✅ 成功: ${passed} | ❌ 失败: ${failed}`,
	);
	console.log("==============================================\n");

	if (failed > 0) {
		process.exit(1);
	}
}

runTests().catch((err) => {
	console.error("测试执行异常:", err);
	process.exit(1);
});
