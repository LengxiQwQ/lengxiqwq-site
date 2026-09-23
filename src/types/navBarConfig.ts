export type NavBarLink = {
	name: string;
	url: string;
	external?: boolean;
	icon?: string; // 菜单项图标
	children?: NavBarLink[]; // 支持子菜单
	pageKey?: string;
};

export enum NavBarSearchMethod {
	PageFind = 0,
}

export type NavBarSearchConfig = {
	method: NavBarSearchMethod;
};

export type SiteSwitcherItem = {
	title: string;
	url: string;
	key?: string;
	external?: boolean;
};

export type SiteSwitcherConfig = {
	enable: boolean;
	items?: SiteSwitcherItem[];
};

export type NavBarConfig = {
	links: NavBarLink[];
	siteSwitcher?: SiteSwitcherConfig;
};
