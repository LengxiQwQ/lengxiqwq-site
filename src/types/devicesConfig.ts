export type SetupPhoto = {
	src: string;
	title?: string;
	description?: string;
};

export type DeviceItem = {
	name: string;
	brand?: string;
	alias?: string;
	description?: string;
	image?: string;
	icon?: string;
	tags?: string[];
	url?: string;
	status?: string;
	imageFit?: "cover" | "contain";
};

export type DeviceGroup = {
	id: string;
	title: string;
	description?: string;
	devices: DeviceItem[];
};

export type DevicesConfig = {
	showcase?: {
		title?: string;
		description?: string;
		photos: SetupPhoto[];
	};
	groups: DeviceGroup[];
};
