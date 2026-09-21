export type DeviceItem = {
	name: string;
	brand?: string;
	alias?: string;
	description?: string;
	image?: string;
	icon?: string;
	tags?: string[];
};

export type DeviceGroup = {
	id: string;
	title: string;
	description?: string;
	devices: DeviceItem[];
};

export type DevicesConfig = {
	groups: DeviceGroup[];
};
