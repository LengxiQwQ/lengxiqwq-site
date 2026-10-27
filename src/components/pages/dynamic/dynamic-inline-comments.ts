import {
	type DynamicCommentItem,
	fetchDynamicComments,
} from "@/utils/dynamic-comments-adapter";

const PREVIEW_LIMIT = 4;

const DEFAULT_AVATAR =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2394a3b8'%3E%3Cpath d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

const SVG_CHAT =
	'<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4 18q-.825 0-1.412-.587T2 16V4q0-.825.588-1.412T4 2h16q.825 0 1.413.588T22 4v12q0 .825-.587 1.413T20 18H6.8L4 20.8V18Zm1.15-2H20V4H4v13.15L5.15 16ZM4 16V4v12Z"/></svg>';

const SVG_WRITE =
	'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M5 19h1.425L16.2 9.225l-1.425-1.425L5 17.575V19Zm-2 2v-4.25L16.2 3.575q.3-.275.663-.425t.762-.15q.4 0 .775.15t.65.45L20.425 5q.3.275.437.65t.138.75q0 .4-.138.775t-.437.675L7.25 21H3ZM19 6.4 17.6 5 19 6.4Zm-3.525 2.125-.7-.725 1.425 1.425-.725-.7Z"/></svg>';

const SVG_EXPAND =
	'<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14.95q-.2 0-.375-.063t-.325-.212L6.3 9.675q-.275-.275-.275-.7t.275-.7q.275-.275.7-.275t.7.275l4.3 4.3 4.3-4.3q.275-.275.7-.275t.7.275q.275.275.275.7t-.275.7l-5 5q-.15.15-.325.213t-.375.062Z"/></svg>';

const SVG_COLLAPSE =
	'<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6.3 14.95q-.275-.275-.275-.7t.275-.7l5-5q.15-.15.325-.213t.375-.062q.2 0 .375.063t.325.212l5 5q.275.275.275.7t-.275.7q-.275.275-.7.275t-.7-.275L12 10.95l-4.3 4.3q-.275.275-.7.275t-.7-.3Z"/></svg>';

const SVG_ARROW_RIGHT =
	'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16.175 13H4v-2h12.175l-5.6-5.6L12 4l8 8-8 8-1.425-1.4 5.6-5.6Z"/></svg>';

export function registerDynamicInlineComments(): void {
	if (customElements.get("dynamic-inline-comments")) return;

	class DynamicInlineComments extends HTMLElement {
		private isLoaded = false;
		private isExpanded = false;
		private observer?: IntersectionObserver;
		private comments: DynamicCommentItem[] = [];
		private totalCount = 0;

		connectedCallback() {
			if (this.dataset.ready === "true") return;

			const commentType = this.dataset.commentType;
			const path = this.dataset.path;

			// 若未开启评论系统或无路径，直接移除
			if (!commentType || commentType === "none" || !path) {
				this.remove();
				return;
			}

			// 视口懒加载：仅在卡片滚入视口时触发评论请求
			this.observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (entry.isIntersecting) {
							this.observer?.disconnect();
							this.observer = undefined;
							void this.loadComments();
							break;
						}
					}
				},
				{ rootMargin: "250px 0px" },
			);

			this.observer.observe(this);
			this.dataset.ready = "true";
		}

		disconnectedCallback() {
			this.observer?.disconnect();
		}

		private get detailUrl(): string {
			const slug = this.dataset.slug || "";
			return this.dataset.detailUrl || (slug ? `/dynamic/${slug}/` : "#");
		}

		private async loadComments() {
			const commentType = this.dataset.commentType || "";
			const serverUrl = this.dataset.serverUrl || "";
			const path = this.dataset.path || "";
			const authorName = this.dataset.authorName || "";

			try {
				const res = await fetchDynamicComments(
					commentType,
					serverUrl,
					path,
					authorName,
					50,
				);
				this.totalCount = res.totalCount;
				this.comments = res.comments;
			} catch (e) {
				console.warn("[Dynamic Comments] Failed to load inline comments:", e);
				this.totalCount = 0;
				this.comments = [];
			} finally {
				this.isLoaded = true;
				this.render();
			}
		}

		private render() {
			const container =
				this.querySelector<HTMLElement>("[data-comment-container]") || this;
			if (!container) return;

			if (!this.isLoaded) return;

			const i18nComments = this.dataset.i18nComments || "评论";
			const i18nNoComments =
				this.dataset.i18nNoComments || "暂无评论，来抢个沙发吧";
			const i18nWrite = this.dataset.i18nWriteComment || "写评论";
			const i18nExpand = this.dataset.i18nExpandComments || "展开更多评论";
			const i18nCollapse = this.dataset.i18nCollapseComments || "收起评论";
			const i18nDetailComments =
				this.dataset.i18nDetailComments || "前往详情页参与讨论";

			const detailTargetUrl = `${this.detailUrl}?to=comment`;

			// 1. 无评论状态：渲染精美轻量胶囊栏
			if (this.totalCount === 0) {
				container.innerHTML = `
					<div class="dynamic-empty-comments-bar card-base">
						<a href="${detailTargetUrl}" class="dynamic-empty-hint" data-action-comment title="${i18nNoComments}">
							<span class="dynamic-hint-icon">${SVG_CHAT}</span>
							<span class="dynamic-hint-text">${i18nNoComments}</span>
						</a>
						<a href="${detailTargetUrl}" class="dynamic-write-btn btn-plain" data-action-comment>
							<span class="dynamic-write-icon">${SVG_WRITE}</span>
							<span>${i18nWrite}</span>
						</a>
					</div>
				`;
				container
					.querySelectorAll<HTMLAnchorElement>("[data-action-comment]")
					.forEach((link) => {
						link.addEventListener("click", () => {
							try {
								sessionStorage.setItem("dynamic-scroll-to-comment", "true");
							} catch {}
						});
					});
				return;
			}

			// 2. 有评论状态：渲染头部、评论预览列表及底部操作栏
			const visibleComments = this.isExpanded
				? this.comments
				: this.comments.slice(0, PREVIEW_LIMIT);

			const hasMore = this.totalCount > PREVIEW_LIMIT;
			const remainingCount = Math.max(0, this.totalCount - PREVIEW_LIMIT);

			const commentsHtml = visibleComments
				.map((item) => {
					const adminBadge = item.isAdmin
						? '<span class="dynamic-comment-admin-badge">博主</span>'
						: "";
					const authorLinkStart = item.link
						? `<a href="${item.link}" target="_blank" rel="noopener noreferrer" class="dynamic-comment-author-link">`
						: '<span class="dynamic-comment-author-name">';
					const authorLinkEnd = item.link ? "</a>" : "</span>";

					return `
						<div class="dynamic-comment-row" data-comment-id="${item.id}">
							<div class="dynamic-comment-avatar">
								<img src="${item.avatar || DEFAULT_AVATAR}" alt="${item.nick}" loading="lazy" onerror="this.src='${DEFAULT_AVATAR}'" />
							</div>
							<div class="dynamic-comment-main">
								<div class="dynamic-comment-head">
									${authorLinkStart}${item.nick}${authorLinkEnd}
									${adminBadge}
									<time class="dynamic-comment-date">${item.relativeTime}</time>
								</div>
								<div class="dynamic-comment-content custom-md">${item.contentHtml}</div>
							</div>
						</div>
					`;
				})
				.join("");

			let footerHtml = "";
			if (hasMore) {
				if (!this.isExpanded) {
					footerHtml = `
						<div class="dynamic-comments-footer">
							<button type="button" class="dynamic-expand-btn btn-plain" data-action-expand>
								<span>${i18nExpand} (${remainingCount})</span>
								<span class="dynamic-btn-icon">${SVG_EXPAND}</span>
							</button>
							<a href="${detailTargetUrl}" class="dynamic-to-detail-link btn-plain" data-action-comment>
								<span>${i18nDetailComments}</span>
								<span class="dynamic-btn-icon">${SVG_ARROW_RIGHT}</span>
							</a>
						</div>
					`;
				} else {
					footerHtml = `
						<div class="dynamic-comments-footer">
							<button type="button" class="dynamic-collapse-btn btn-plain" data-action-collapse>
								<span>${i18nCollapse}</span>
								<span class="dynamic-btn-icon">${SVG_COLLAPSE}</span>
							</button>
							<a href="${detailTargetUrl}" class="dynamic-to-detail-link btn-plain" data-action-comment>
								<span>${i18nDetailComments}</span>
								<span class="dynamic-btn-icon">${SVG_ARROW_RIGHT}</span>
							</a>
						</div>
					`;
				}
			} else {
				footerHtml = `
					<div class="dynamic-comments-footer">
						<a href="${detailTargetUrl}" class="dynamic-to-detail-link btn-plain" data-action-comment>
							<span>${i18nDetailComments}</span>
							<span class="dynamic-btn-icon">${SVG_ARROW_RIGHT}</span>
						</a>
					</div>
				`;
			}

			container.innerHTML = `
				<div class="dynamic-comments-preview-box card-base">
					<div class="dynamic-comments-header">
						<div class="dynamic-header-label">
							<span class="dynamic-label-icon">${SVG_CHAT}</span>
							<strong>${this.totalCount}</strong>
							<span>条${i18nComments}</span>
						</div>
						<a href="${detailTargetUrl}" class="dynamic-header-write btn-plain" data-action-comment>
							<span class="dynamic-write-icon">${SVG_WRITE}</span>
							<span>${i18nWrite}</span>
						</a>
					</div>
					<div class="dynamic-comments-list">
						${commentsHtml}
					</div>
					${footerHtml}
				</div>
			`;

			container
				.querySelectorAll<HTMLAnchorElement>("[data-action-comment]")
				.forEach((link) => {
					link.addEventListener("click", () => {
						try {
							sessionStorage.setItem("dynamic-scroll-to-comment", "true");
						} catch {}
					});
				});

			// 绑定展开/折叠事件
			container
				.querySelector("[data-action-expand]")
				?.addEventListener("click", () => {
					this.isExpanded = true;
					this.render();
				});

			container
				.querySelector("[data-action-collapse]")
				?.addEventListener("click", () => {
					this.isExpanded = false;
					this.render();
				});
		}
	}

	customElements.define("dynamic-inline-comments", DynamicInlineComments);
}
