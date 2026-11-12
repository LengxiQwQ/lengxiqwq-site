# 聊天室页面实现提示词

> 将此提示词直接发给 AI，让它按照计划文档开始执行。

---

## 提示词

请严格按照项目文档 `docs/chat-page-implementation-plan.md` 的 Step 1 ~ Step 7，为我的 Astro + Svelte 博客站点实现一个沉浸式聊天室页面 `/chat/`。

核心要求：
1. **使用 `Layout.astro` 而非 `MainGridLayout.astro`**——聊天室是全屏不可滚动的三栏布局，不需要博客的侧栏/Banner/Footer
2. **保留顶部导航栏（HeaderTopRow）**，让用户随时可以导航回博客其他页面
3. **100% 使用项目已有的 CSS 变量**（`--primary`、`--card-bg`、`--page-bg`、`--hue` 等 oklch 色阶），做到亮色/暗色/主题色切换与全站完全一致，禁止硬编码任何颜色值
4. **复用项目已有的 CSS 类**（`.card-base` 的圆角和背景理念、`.custom-scrollbar`、`.btn-regular`/`.btn-plain` 的交互风格）
5. **所有交互组件使用 Svelte**（与项目技术栈统一）
6. **先用写死的 Mock 数据**填充消息、用户、歌曲，展示完整的 UI 效果
7. **移动端**（`< 768px`）三栏折叠为底部 Tab 切换
8. **视觉精致度**是重点：气泡阴影、在线绿灯呼吸动画、旋转唱片机、歌词高亮缩放、发送按钮 hover/active 弹性动效——都在计划文档的 CSS 中已经定义好了

先仔细阅读 `docs/chat-page-implementation-plan.md` 的全部内容，然后按 Step 1 → 2 → 3 → 4 → 5 → 6 → 7 的顺序逐步执行，每步完成后再进入下一步。最后只跑 `pnpm type-check` 和 `pnpm lint`，不要执行 build、不要 commit、不要 push。
