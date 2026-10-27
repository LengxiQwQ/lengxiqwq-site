export type CommentConfig = {
	/**
	 * 当前启用的评论系统类型
	 * "none" | "twikoo" | "waline" | "giscus" | "disqus" | 'artalk'
	 */
	type: "none" | "twikoo" | "waline" | "giscus" | "disqus" | "artalk";
	twikoo?: {
		envId: string;
		region?: string;
		lang?: string;
		visitorCount?: boolean;
		/**
		 * Twikoo JS 文件地址，支持 CDN 链接
		 * 国内推荐: https://registry.npmmirror.com/twikoo/1.7.9/files/dist/twikoo.min.js
		 * 国际推荐: https://cdn.jsdelivr.net/npm/twikoo@1.7.9/dist/twikoo.min.js
		 */
		jsUrl?: string;
		/**
		 * Twikoo 自定义 CSS 文件地址，为空则不加载
		 */
		cssUrl?: string;
	};
	waline?: {
		serverURL: string;
		lang?: string;
		/**
		 * Waline 表情预设，支持以下两种格式混用：
		 * - string: 指向预设目录的 CDN URL（如 "@waline/emojis" 官方包）
		 * - object: 内联颜文字/文本表情预设，无需图片和 CDN
		 *   - name: string        Tab 显示名称
		 *   - icon: string        Tab 图标（填预设中第一个颜文字即可）
		 *   - items: string[]     颜文字列表
		 */
		emoji: (
			| string
			| {
					name: string;
					icon: string;
					items: string[];
			  }
		)[];
		login?: "enable" | "force" | "disable";
		visitorCount?: boolean; // 是否统计访问量，true 启用访问量，false 关闭
		imageUploader?: boolean; // 是否启用评论区图片上传功能，设为 false 可禁用图片上传按钮
	};
	artalk?: {
		// 后端程序 API 地址
		server: string;
		/**
		 * 语言，支持语言如下：
		 * - "en" (English)
		 * - "zh-CN" (简体中文)
		 * - "zh-TW" (繁体中文)
		 * - "ja" (日本語)
		 * - "ko" (한국어)
		 * - "fr" (Français)
		 * - "ru" (Русский)
		 * */
		locale: string | "auto";
		// 是否统计访问量，true 启用访问量，false 关闭
		visitorCount?: boolean;
	};
	giscus?: {
		repo: string;
		repoId: string;
		category: string;
		categoryId: string;
		mapping: string;
		strict: string;
		reactionsEnabled: string;
		emitMetadata: string;
		inputPosition: string;
		lang: string;
		loading: string;
	};
	disqus?: {
		shortname: string;
	};
};
