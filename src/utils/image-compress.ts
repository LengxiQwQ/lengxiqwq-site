/**
 * 客户端图片智能压缩与 WebP 转换工具
 * - 自动将 JPEG, PNG, BMP 等图片转为现代高效的 WebP 格式
 * - 默认质量 90% (0.90)
 * - 智能限制最大分辨率（默认最大宽度/高度 2560px），保持超清画质的同时防止手机超大原图膨胀
 * - GIF 动图与 SVG 矢量图智能跳过转码以保留动态与清晰矢量特性
 */

export interface CompressImageOptions {
	quality?: number; // 默认 0.9 (90% 清晰度)
	maxWidth?: number; // 默认 2560px
	maxHeight?: number; // 默认 2560px
}

export interface CompressResult {
	file: File;
	originalSize: number;
	compressedSize: number;
	ratio: number; // 压缩百分比，如 65 (缩小了 65%)
	convertedToWebp: boolean;
}

export async function compressAndConvertToWebp(
	file: File,
	options: CompressImageOptions = {},
): Promise<CompressResult> {
	const { quality = 0.9, maxWidth = 2560, maxHeight = 2560 } = options;
	const originalSize = file.size;

	// 1. 如果不是运行在浏览器环境中，直接返回原文件
	if (typeof window === "undefined" || typeof document === "undefined") {
		return {
			file,
			originalSize,
			compressedSize: originalSize,
			ratio: 0,
			convertedToWebp: false,
		};
	}

	// 2. 如果是动图 GIF 或 SVG 矢量图，直接保留原文件，不破坏动画和矢量
	if (file.type === "image/gif" || file.type === "image/svg+xml") {
		return {
			file,
			originalSize,
			compressedSize: originalSize,
			ratio: 0,
			convertedToWebp: false,
		};
	}

	// 3. 利用 Canvas 硬件加速进行格式转码与质量压缩
	return new Promise((resolve) => {
		const img = new Image();
		const objectUrl = URL.createObjectURL(file);

		img.onload = () => {
			URL.revokeObjectURL(objectUrl);

			let { width, height } = img;

			// 等比例智能缩放（若超过最大限制 2560px）
			if (width > maxWidth || height > maxHeight) {
				const scaleRatio = Math.min(maxWidth / width, maxHeight / height);
				width = Math.round(width * scaleRatio);
				height = Math.round(height * scaleRatio);
			}

			const canvas = document.createElement("canvas");
			canvas.width = width;
			canvas.height = height;

			const ctx = canvas.getContext("2d");
			if (!ctx) {
				resolve({
					file,
					originalSize,
					compressedSize: originalSize,
					ratio: 0,
					convertedToWebp: false,
				});
				return;
			}

			// 绘制图像（PNG 的透明通道会被完整保留）
			ctx.drawImage(img, 0, 0, width, height);

			canvas.toBlob(
				(blob) => {
					if (!blob) {
						resolve({
							file,
							originalSize,
							compressedSize: originalSize,
							ratio: 0,
							convertedToWebp: false,
						});
						return;
					}

					const cleanBaseName = file.name.replace(/\.[^/.]+$/, "");
					const newFileName = `${cleanBaseName}.webp`;
					const compressedFile = new File([blob], newFileName, {
						type: "image/webp",
						lastModified: Date.now(),
					});

					const compressedSize = compressedFile.size;
					const savedPercent = Math.max(
						0,
						Math.round(((originalSize - compressedSize) / originalSize) * 100),
					);

					resolve({
						file: compressedFile,
						originalSize,
						compressedSize,
						ratio: savedPercent,
						convertedToWebp: true,
					});
				},
				"image/webp",
				quality,
			);
		};

		img.onerror = () => {
			URL.revokeObjectURL(objectUrl);
			// 容灾降级：若图片无法被 canvas 解析，原样返回
			resolve({
				file,
				originalSize,
				compressedSize: originalSize,
				ratio: 0,
				convertedToWebp: false,
			});
		};

		img.src = objectUrl;
	});
}
