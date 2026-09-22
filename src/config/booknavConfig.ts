import type { BooknavGroup, BooknavPageConfig } from "@/types/booknavConfig";

// 书签导航页面配置
export const booknavPageConfig: BooknavPageConfig = {
	// 页面标题，如果留空则使用 i18n 中的翻译
	title: "",

	// 页面描述文本，如果留空则使用 i18n 中的翻译
	description: "",

	// favicon 自动获取配置
	favicon: {
		// 书签未填写 icon 时，是否自动获取目标站点的 favicon 图标
		enabled: true,

		// favicon 接口地址，{domain} 为占位符，会被替换成目标站点域名
		api: "https://a.favicon.im/{domain}",
	},
};

// 书签导航配置
export const booknavConfig: BooknavGroup[] = [
	{
		id: "music",
		name: "音乐与乐谱",
		icon: "material-symbols:music-note-rounded",
		desc: "平时找和弦、扒歌和看吉他谱会用到的网站",
		weight: 100,
		items: [
			{
				title: "ChordU",
				url: "https://chordu.com/",
				desc: "从歌曲里识别和弦，临时想扒一首歌时挺方便",
				weight: 10,
			},
			{
				title: "Chordify",
				url: "https://chordify.net/",
				desc: "边放歌边看和弦，吉他、尤克里里和钢琴都能用",
				weight: 9,
			},
			{
				title: "Songsterr",
				url: "https://www.songsterr.com/",
				desc: "交互式吉他 / 贝斯 / 鼓谱，适合跟着谱直接练",
				weight: 8,
			},
		],
	},
];
