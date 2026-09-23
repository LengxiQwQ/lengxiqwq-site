export type ProfileConfig = {
	avatar?: string;
	avatarUrl?: string; // 公开外链头像（如 WeAvatar / CDN），用于友链展示等场景
	name: string;
	bio?: string;
	contact?: {
		email?: string;
		qq?: string;
	};
	links: {
		name: string;
		url: string;
		icon: string;
		showName?: boolean;
	}[];
};
