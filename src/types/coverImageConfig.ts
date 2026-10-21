export type CoverImageConfig = {
	enableInPost: boolean; // 是否在文章详情页显示封面图
	enableInPostOverlay?: boolean; // 是否使用标题和元数据叠加在封面上的布局
	showLoading?: boolean; // 是否显示加载动画
	randomCoverImage: {
		enable: boolean; // 是否启用随机图功能
		version?: number | string; // 随机图种子版本号，改动此值可全站统一换一批随机图
		apis: string[]; // 随机图API列表
	};
};
