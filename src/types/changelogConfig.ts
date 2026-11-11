/**
 * 博客日志（Changelog）相关类型定义
 */

export type ChangelogChangeType =
	| "feat" // 新功能
	| "fix" // 缺陷修复
	| "perf" // 性能优化
	| "style" // 界面与样式调整
	| "refactor" // 架构重构
	| "chore" // 依赖升级与工作流维护
	| "docs"; // 文档更新

export interface ChangelogChangeItem {
	/** 变更类型标签 */
	type?: ChangelogChangeType;
	/** 功能变更标题 / 概括 */
	title: string;
	/** 详细说明或背景原因（可选） */
	description?: string;
	/** 细项要点列表（可选） */
	details?: string[];
	/** 关联链接（可选，如 Commit 链接、GitHub PR、Issue 或相关文章） */
	link?: {
		label?: string;
		url: string;
	};
}

export interface ChangelogDailyEntry {
	/** 具体日期，格式如 "2024-09-20" */
	date: string;
	/** 当天主题/概览（可选，如 "主站正式上线并启用双仓架构"） */
	title?: string;
	/** 当天提交次数（可选，如 5 次提交） */
	commitsCount?: number;
	/** 是否为重大里程碑节点（高亮外框与发光质感） */
	featured?: boolean;
	/** 当天发生的所有功能性改变与事项列表 */
	items: ChangelogChangeItem[];
}

export interface ChangelogConfig {
	/** 页面总开关；false 时隐藏导航入口，访问 /changelog/ 跳转 404 */
	enable: boolean;
	/** 页面标题 */
	title?: string;
	/** 页面描述 */
	description?: string;
	/** 排序方向：默认 "desc"（倒序，最新的一天在最前） */
	order?: "desc" | "asc";
	/** 日志条目数据列表 */
	entries: ChangelogDailyEntry[];
}
