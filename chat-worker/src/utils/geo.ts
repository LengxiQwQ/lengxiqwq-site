/**
 * IP 归属地解析工具。
 * - 国内显示省份/直辖市/自治区（如"广东"、"北京"）；
 * - 港澳台规范显示为"中国香港"、"中国澳门"、"中国台湾"；
 * - 国外显示国家名称（如"美国"、"日本"、"新加坡"）；
 * - 纯文字显示，不附带国旗 emoji。
 */

const CN_PROVINCE_BY_CODE: Record<string, string> = {
	BJ: "北京",
	SH: "上海",
	TJ: "天津",
	CQ: "重庆",
	HE: "河北",
	SX: "山西",
	NM: "内蒙古",
	LN: "辽宁",
	JL: "吉林",
	HL: "黑龙江",
	JS: "江苏",
	ZJ: "浙江",
	AH: "安徽",
	FJ: "福建",
	JX: "江西",
	SD: "山东",
	HA: "河南",
	HEN: "河南",
	HB: "湖北",
	HUB: "湖北",
	HN: "湖南",
	HUN: "湖南",
	GD: "广东",
	GX: "广西",
	HI: "海南",
	SC: "四川",
	GZ: "贵州",
	YN: "云南",
	XZ: "西藏",
	SN: "陕西",
	SAA: "陕西",
	GS: "甘肃",
	QH: "青海",
	NX: "宁夏",
	XJ: "新疆",
};

const CN_PROVINCE_BY_NAME: Record<string, string> = {
	beijing: "北京",
	shanghai: "上海",
	tianjin: "天津",
	chongqing: "重庆",
	hebei: "河北",
	shanxi: "山西",
	"inner mongolia": "内蒙古",
	neimenggu: "内蒙古",
	liaoning: "辽宁",
	jilin: "吉林",
	heilongjiang: "黑龙江",
	jiangsu: "江苏",
	zhejiang: "浙江",
	anhui: "安徽",
	fujian: "福建",
	jiangxi: "江西",
	shandong: "山东",
	henan: "河南",
	hubei: "湖北",
	hunan: "湖南",
	guangdong: "广东",
	guangxi: "广西",
	hainan: "海南",
	sichuan: "四川",
	guizhou: "贵州",
	yunnan: "云南",
	tibet: "西藏",
	xizang: "西藏",
	shaanxi: "陕西",
	gansu: "甘肃",
	qinghai: "青海",
	ningxia: "宁夏",
	xinjiang: "新疆",
};

let cachedDisplayNames: Intl.DisplayNames | null = null;
function getRegionDisplayNames(): Intl.DisplayNames | null {
	if (!cachedDisplayNames) {
		try {
			cachedDisplayNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
		} catch {
			cachedDisplayNames = null;
		}
	}
	return cachedDisplayNames;
}

export interface ClientGeoInfo {
	country?: string | null;
	region?: string | null;
	regionCode?: string | null;
}

export function resolveLocation(cf?: ClientGeoInfo | null): string {
	if (!cf?.country) return "";
	const country = cf.country.trim().toUpperCase();
	if (!country) return "";

	// 港澳台特殊规范
	if (country === "TW") return "中国台湾";
	if (country === "HK") return "中国香港";
	if (country === "MO") return "中国澳门";

	// 国内显示省份/直辖市/自治区
	if (country === "CN") {
		const regionCode = (cf.regionCode || "").trim().toUpperCase();
		if (regionCode && CN_PROVINCE_BY_CODE[regionCode]) {
			return CN_PROVINCE_BY_CODE[regionCode];
		}
		const regionName = (cf.region || "").trim().toLowerCase();
		if (regionName && CN_PROVINCE_BY_NAME[regionName]) {
			return CN_PROVINCE_BY_NAME[regionName];
		}
		return "中国";
	}

	// 国外显示国家中文名称
	const displayNames = getRegionDisplayNames();
	if (displayNames) {
		try {
			const name = displayNames.of(country);
			if (name) {
				return name.replace(/特别行政区$/, "").trim();
			}
		} catch {
			// Fallback to country code
		}
	}
	return country;
}
