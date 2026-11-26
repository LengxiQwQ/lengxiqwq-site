import rawRemoteMembers from "@/constants/interconnect-members.json";
import type {
	InterconnectSite,
	InterconnectSiteConfig,
} from "@/types/chatConfig";
import { normalizeInterconnectSites } from "@/utils/interconnect";

/**
 * 🏠 当前本站专属配置（固定置于互联名单第一项）
 * 可按需在内容仓随时修改名称、简介、头像或个性化设置，不受上游任何变动影响。
 */
export const selfInterconnectSite: InterconnectSiteConfig = {
	name: "冷汐的杂货铺",
	owner: "冷汐OωO",
	siteUrl: "https://lengxiqwq.com",
	chatUrl: "/chat/",
	homeserver: "matrix.lengxiqwq.com",
	avatar: "/assets/images/avatar.webp",
	desc: "你好谢谢小笼包再见",
	badge: "杂货铺",
	isSelf: true,
};

/**
 * 🍵 互联茶室友站专属配置列表
 *
 * 1. 本站配置（selfInterconnectSite）始终置于第一项；
 * 2. 其余友站数据自动从上游官方成员库（Jarvis0227/federated-chat）每日离线抓取生成；
 * 3. 抓取逻辑已通过域名过滤自动剔除本站重复项，确保本站始终以本地定制配置为准。
 */
export const rawInterconnectSites: InterconnectSiteConfig[] = [
	selfInterconnectSite,
	...(rawRemoteMembers as InterconnectSiteConfig[]),
];

export const interconnectSites: InterconnectSite[] =
	normalizeInterconnectSites(rawInterconnectSites);
