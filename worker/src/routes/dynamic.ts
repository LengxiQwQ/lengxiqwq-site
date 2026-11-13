import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth";
import type {
	AppEnv,
	DynamicMomentItem,
	DynamicMomentRecord,
	PublishMomentPayload,
	UpdateMomentPayload,
} from "../types";

const dynamic = new Hono<AppEnv>();

/**
 * 辅助函数：将数据库记录转换为标准的 JSON 接口实体
 */
function mapRecordToItem(record: DynamicMomentRecord): DynamicMomentItem {
	let images: string[] = [];
	try {
		if (record.images) {
			const parsed = JSON.parse(record.images);
			images = Array.isArray(parsed) ? parsed : [];
		}
	} catch {
		images = [];
	}

	return {
		id: record.id,
		content: record.content,
		images,
		pinned: record.pinned === 1,
		location: record.location ?? null,
		createdAt: record.created_at,
		updatedAt: record.updated_at,
	};
}

/**
 * GET /api/dynamic/list
 * 公开只读接口：分页获取说说列表，支持 ?page=1&limit=20
 * 排序逻辑：置顶优先（pinned DESC），再按发布时间倒序（created_at DESC）
 */
dynamic.get("/list", async (c) => {
	const pageQuery = Number.parseInt(c.req.query("page") || "1", 10);
	const limitQuery = Number.parseInt(c.req.query("limit") || "20", 10);

	const page = Number.isInteger(pageQuery) && pageQuery > 0 ? pageQuery : 1;
	const limit =
		Number.isInteger(limitQuery) && limitQuery > 0
			? Math.min(limitQuery, 100)
			: 20;
	const offset = (page - 1) * limit;

	try {
		// 1. 获取总数
		const countRow = await c.env.DB.prepare(
			"SELECT COUNT(*) AS total FROM dynamic_moments",
		).first<{ total: number }>();
		const total = countRow?.total ?? 0;

		// 2. 分页读取记录
		const { results } = await c.env.DB.prepare(
			"SELECT id, content, images, pinned, location, created_at, updated_at FROM dynamic_moments ORDER BY pinned DESC, created_at DESC LIMIT ? OFFSET ?",
		)
			.bind(limit, offset)
			.all<DynamicMomentRecord>();

		const items = (results || []).map(mapRecordToItem);

		c.header(
			"Cache-Control",
			"public, max-age=60, s-maxage=300, stale-while-revalidate=600",
		);
		return c.json({
			code: 200,
			data: {
				total,
				page,
				limit,
				items,
			},
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json(
			{
				code: 500,
				error: `Failed to fetch dynamic moments: ${message || "Database error"}`,
			},
			500,
		);
	}
});

/**
 * POST /api/dynamic/publish
 * 受保护接口：发布新说说
 */
dynamic.post("/publish", authMiddleware, async (c) => {
	const body = await c.req
		.json<PublishMomentPayload>()
		.catch(() => ({}) as PublishMomentPayload);
	const { content, images = [], pinned = false, location = null } = body;

	if (!content || typeof content !== "string" || content.trim().length === 0) {
		return c.json(
			{
				code: 400,
				error: "Validation failed: Content is required",
			},
			400,
		);
	}

	const cleanContent = content.trim();
	const cleanImages = Array.isArray(images)
		? images.filter((img) => typeof img === "string" && img.trim().length > 0)
		: [];
	const cleanPinned = pinned ? 1 : 0;
	const cleanLocation =
		typeof location === "string" && location.trim().length > 0
			? location.trim()
			: null;

	const now = Date.now();
	const id = `m_${now}_${Math.random().toString(36).substring(2, 7)}`;

	try {
		await c.env.DB.prepare(
			"INSERT INTO dynamic_moments (id, content, images, pinned, location, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
			.bind(
				id,
				cleanContent,
				JSON.stringify(cleanImages),
				cleanPinned,
				cleanLocation,
				now,
				now,
			)
			.run();

		const createdItem: DynamicMomentItem = {
			id,
			content: cleanContent,
			images: cleanImages,
			pinned: cleanPinned === 1,
			location: cleanLocation,
			createdAt: now,
			updatedAt: now,
		};

		return c.json({
			code: 200,
			message: "Dynamic moment published successfully",
			data: createdItem,
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json(
			{
				code: 500,
				error: `Failed to insert moment into D1: ${message || "Database error"}`,
			},
			500,
		);
	}
});

/**
 * POST /api/dynamic/upload
 * 受保护接口：上传图片到 Cloudflare R2
 * 接收 multipart/form-data 格式，字段名为 file 或 image
 */
dynamic.post("/upload", authMiddleware, async (c) => {
	let body: Record<string, unknown>;
	try {
		body = await c.req.parseBody();
	} catch (parseErr: unknown) {
		const pMsg =
			parseErr instanceof Error ? parseErr.message : String(parseErr);
		return c.json(
			{
				code: 400,
				error: `Failed to parse multipart form: ${pMsg || "Invalid format"}`,
			},
			400,
		);
	}

	const file = body.file || body.image;

	if (!file || !(file instanceof File)) {
		return c.json(
			{
				code: 400,
				error: 'Missing file: Expected multipart field "file" or "image"',
			},
			400,
		);
	}

	// 单文件限制 10MB
	const MAX_FILE_SIZE = 10 * 1024 * 1024;
	if (file.size > MAX_FILE_SIZE) {
		return c.json(
			{
				code: 400,
				error: "File size exceeds maximum limit of 10MB",
			},
			400,
		);
	}

	// 校验图片格式
	const allowedMimeTypes = [
		"image/jpeg",
		"image/jpg",
		"image/png",
		"image/webp",
		"image/gif",
		"image/avif",
		"image/svg+xml",
	];
	if (!allowedMimeTypes.includes(file.type.toLowerCase())) {
		return c.json(
			{
				code: 400,
				error: `Unsupported image MIME type: ${file.type}`,
			},
			400,
		);
	}

	// 构造规范存储路径：dynamic/YYYYMM/<uuid>.<ext>
	const now = new Date();
	const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
	const fileExt = file.name.includes(".")
		? file.name.split(".").pop()?.toLowerCase() || "webp"
		: "webp";
	const objectName = `${crypto.randomUUID()}.${fileExt}`;
	const r2Key = `dynamic/${yearMonth}/${objectName}`;

	try {
		const arrayBuffer = await file.arrayBuffer();

		await c.env.R2.put(r2Key, arrayBuffer, {
			httpMetadata: {
				contentType: file.type,
			},
			customMetadata: {
				originalFilename: encodeURIComponent(file.name),
				uploadedAt: String(Date.now()),
			},
		});

		const publicDomain = (
			c.env.R2_PUBLIC_DOMAIN || "https://img.lengxiqwq.com"
		).replace(/\/+$/, "");
		const publicUrl = `${publicDomain}/${r2Key}`;

		return c.json({
			code: 200,
			message: "Upload successful",
			data: {
				url: publicUrl,
				key: r2Key,
				filename: file.name,
				size: file.size,
			},
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json(
			{
				code: 500,
				error: `Failed to upload image to R2: ${message || "Storage error"}`,
			},
			500,
		);
	}
});

/**
 * PUT /api/dynamic/:id
 * 受保护接口：更新指定说说的内容、图片、置顶状态或位置标签
 */
dynamic.put("/:id", authMiddleware, async (c) => {
	const id = c.req.param("id");
	const body = await c.req
		.json<UpdateMomentPayload>()
		.catch(() => ({}) as UpdateMomentPayload);

	try {
		// 1. 查询原记录
		const existing = await c.env.DB.prepare(
			"SELECT id, content, images, pinned, location, created_at, updated_at FROM dynamic_moments WHERE id = ?",
		)
			.bind(id)
			.first<DynamicMomentRecord>();

		if (!existing) {
			return c.json(
				{
					code: 404,
					error: `Dynamic moment with ID "${id}" not found`,
				},
				404,
			);
		}

		// 2. 合并更新字段
		let newContent = existing.content;
		if (typeof body.content === "string" && body.content.trim().length > 0) {
			newContent = body.content.trim();
		}

		let newImages = existing.images;
		if (Array.isArray(body.images)) {
			const cleanImages = body.images.filter(
				(img) => typeof img === "string" && img.trim().length > 0,
			);
			newImages = JSON.stringify(cleanImages);
		}

		let newPinned = existing.pinned;
		if (typeof body.pinned === "boolean") {
			newPinned = body.pinned ? 1 : 0;
		}

		let newLocation = existing.location;
		if (body.location !== undefined) {
			newLocation =
				typeof body.location === "string" && body.location.trim().length > 0
					? body.location.trim()
					: null;
		}

		const updatedAt = Date.now();

		// 3. 执行更新
		await c.env.DB.prepare(
			"UPDATE dynamic_moments SET content = ?, images = ?, pinned = ?, location = ?, updated_at = ? WHERE id = ?",
		)
			.bind(newContent, newImages, newPinned, newLocation, updatedAt, id)
			.run();

		const updatedRecord: DynamicMomentRecord = {
			id,
			content: newContent,
			images: newImages,
			pinned: newPinned,
			location: newLocation,
			created_at: existing.created_at,
			updated_at: updatedAt,
		};

		return c.json({
			code: 200,
			message: "Updated successfully",
			data: mapRecordToItem(updatedRecord),
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json(
			{
				code: 500,
				error: `Failed to update dynamic moment: ${message || "Database error"}`,
			},
			500,
		);
	}
});

/**
 * DELETE /api/dynamic/:id
 * 受保护接口：删除指定说说
 */
dynamic.delete("/:id", authMiddleware, async (c) => {
	const id = c.req.param("id");

	try {
		const existing = await c.env.DB.prepare(
			"SELECT id FROM dynamic_moments WHERE id = ?",
		)
			.bind(id)
			.first<{ id: string }>();

		if (!existing) {
			return c.json(
				{
					code: 404,
					error: `Dynamic moment with ID "${id}" not found`,
				},
				404,
			);
		}

		await c.env.DB.prepare("DELETE FROM dynamic_moments WHERE id = ?")
			.bind(id)
			.run();

		return c.json({
			code: 200,
			message: `Dynamic moment "${id}" deleted successfully`,
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json(
			{
				code: 500,
				error: `Failed to delete dynamic moment: ${message || "Database error"}`,
			},
			500,
		);
	}
});

export default dynamic;
