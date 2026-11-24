/**
 * DiceBear Glass (高斯模糊毛玻璃艺术风格) 头像生成与解析工具
 * 官方样式：@dicebear/glass (https://www.dicebear.com/styles/glass/)
 */

const DICEBEAR_GLASS_BASE = "https://api.dicebear.com/9.x/glass/svg";

/**
 * 根据种子（用户名、邮箱或用户标识）生成确定性的 DiceBear Glass 高斯模糊矢量头像地址
 * @param seed 用户名 / 邮箱 / 访客标识
 * @returns 完整的 SVG 头像 CDN 地址
 */
export function getDiceBearGlassAvatar(seed?: string): string {
	const clean = (seed || "").trim();
	const safeSeed = clean || "guest";
	return `${DICEBEAR_GLASS_BASE}?seed=${encodeURIComponent(safeSeed)}`;
}
