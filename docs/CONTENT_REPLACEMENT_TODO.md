# LengxiQwQ Site 内容替换与去模板化总待办

> 目标：把当前站点从“Firefly 模板 + LengxiQwQ 定制”完整收口为“LengxiQwQ 个人站，技术底座基于 Firefly”。
>
> 原则：
> - 用户个人内容、个人配置、媒体资产优先进入私有内容仓 `LengxiQwQ/lengxiqwq-site-content`。
> - 公开仓 `LengxiQwQ/lengxiqwq-site` 主要保留主题代码、构建逻辑、部署流程和必要的公开项目文档。
> - 不删除 Firefly / Fuwari 的许可证与必要版权归属。
> - 每完成一项后进行构建验证，再勾选，不批量盲改。
>
> 状态更新时间：2026-09-21

---

## P0 — 先修内容同步边界（最高优先级）

### 1. 私有内容仓接管文章
- [x] 在 `lengxiqwq-site-content/content/posts/` 建立正式文章目录。
- [x] 即使暂时没有文章，也保留空目录占位方式，确保构建时不会继续使用公开仓 Firefly 示例文章。
- [x] 验证部署后首页、归档、分类、标签、搜索、RSS 中不再出现模板演示文章。

**建议：**
暂时没准备好正式文章时，宁可让文章列表为空，也不要保留模板演示文章。

### 2. 修正 `sync-content.ts` 的清理范围
- [x] 当前 `cleanableCollections` 只有 `projects`、`posts`，增加 `dynamic`。
- [x] 在私有仓补齐 `content/spec/guestbook.md` 后，再考虑让 `spec` 也采用“私有仓完全接管”策略。
- [x] 验证私有仓内容同步后不会和公开仓预设内容混合。

**建议：**
先采用：
```text
projects
posts
dynamic
```
等 `about / friends / guestbook` 三个 spec 页面都进入私有仓后，再把 `spec` 纳入完全清理范围。

---

## P1 — 正式网站上仍可见的模板内容

### 3. 博客文章
当前公开仓仍有 Firefly 示例文章：
- [ ] `code-examples.md`
- [ ] `encrypted-demo.md`
- [ ] `firefly.md`
- [ ] `guide/firefly-layout-system.md`
- [ ] `guide/firefly-wiki-link.md`
- [ ] `guide/index.md`
- [ ] `katex-math-example.md`
- [ ] `markdown-extended.md`
- [ ] `markdown-mermaid.md`
- [ ] `markdown-plantuml.md`
- [ ] `markdown-tutorial.md`
- [ ] `mdx-example.mdx`
- [ ] `video.md`
- [ ] 对应示例文章图片不再进入正式构建。

**建议：**
这些可以继续留在主题仓作为“开发测试素材”，但正式构建必须被私有 `posts` 完全覆盖；如果以后确定不再需要，也可以迁到 `docs/examples/`。

### 4. 动态 / 说说
- [x] Firefly 四条模板动态已清除
- [x] 私有仓 `content/dynamic/` 已建立
- [x] 已录入自己的正式动态

**建议内容方向：**
项目更新、开发碎碎念、游戏截图、音乐/吉他、校园日常、数码折腾、网站更新记录都适合，不需要写成正式文章。

### 5. 公告
当前：
> 欢迎来到我的博客！这是一则示例公告。

- [x] 替换 `announcementConfig.ts` 的示例公告。
- [x] 决定公告组件长期开启还是只在有重要消息时开启。
- [x] 将个人化后的 `announcementConfig.ts` 放入私有内容仓配置层。

**建议：**
如果近期没有真正公告，直接关闭公告卡片比长期放“欢迎公告”更自然。

### 6. 友链
当前列表仍为：
- [x] 删除模板默认友链。
- [x] 当前没有真实友链，因此保持空列表。
- [x] 保留已经完成的“申请友链”页面和本站信息卡。

**建议：**
Firefly Docs 如果你确实日常使用，可以放进“书签导航”，但不应该作为“朋友”留在友链列表。

### 7. 相册
当前状态：
- [x] “可爱流萤”示例相册已清理
- [x] “加密相册示例”已清理
- [x] 示例密码 123456 / passwordHint 已清理
- [x] public/gallery/firefly-2026 已清理
- [x] public/gallery/encrypted-test 已清理
- [x] 私有仓已建立 Gallery 配置和媒体目录
- [x] 当前没有正式相册，因此保持 0 相册空状态


**建议分类：**
二次元收藏、游戏截图、马来西亚/校园日常、桌搭与数码、吉他与音乐、项目开发过程截图。

### 8. 书签导航
当前仍主要是 Firefly 原始示例：
- [ ] GitHub / MDN / Astro / Svelte / Tailwind 示例组合
- [ ] Firefly
- [ ] Iconify / iconfont
- [ ] TinyPNG / Squoosh / Carbon
- [ ] Firefly Docs / 夏夜流萤

需要：
- [ ] 按自己的真实浏览器书签重建 `booknavConfig.ts`。
- [ ] 调整分类与排序。
- [ ] 删除不实际使用的示例站点。

**建议分类：**
开发、AI、开源项目、设计、图片与媒体、音乐、游戏、云服务、站长工具、常用工具。

### 9. 音乐播放器
- [x] 《使一颗心免于哀伤》已替换
- [x] 原模板 MP3 已替换并移出代码仓
- [x] 原模板封面已替换
- [x] 接入酸欠少女 さユり《ミカヅキ -「め」弾き語りver.-》并由私有内容仓接管
- [x] 提取正版专辑《め》封面（300x300）转为 WebP 格式优化接入

**建议：**
先只放 3–10 首最喜欢的歌，避免为了“填满播放器”堆大量媒体文件。

### 10. 留言板正文
当前 `guestbook.md` 仍为 Firefly 默认文案：
- [ ] 改成自己的欢迎语和规则。
- [ ] 移入私有内容仓 `content/spec/guestbook.md`。
- [ ] 验证 Twikoo 留言正常。

**建议：**
语气可以更像“冷汐的杂货铺”，不用写成正式社区守则。

### 11. 首页壁纸
当前：
- [ ] 6 张桌面壁纸全部仍为 Firefly 原图。
- [ ] 6 张移动壁纸全部仍为 Firefly 原图。
- [ ] 用自己的图片替换。
- [ ] 考虑将壁纸媒体迁入私有内容仓管理。

**建议：**
保持同一套视觉语言，桌面和移动端分别裁切，不要简单把桌面图直接缩成手机比例。

---

## P2 — 已隐藏但仍残留模板身份的数据

### 12. Bangumi / VNDB / MyAnimeList 示例账号
当前页面虽然关闭，但配置仍保留 Firefly 作者数据：
- [ ] Bangumi：清理示例 `userId`。
- [ ] VNDB：清理示例 `userId`。
- [ ] MyAnimeList：清理 `username: "cuteleaf"`。
- [ ] MyAnimeList：清理原模板 Client ID。
- [ ] 未使用页面继续保持关闭。

**建议：**
没有自己的账号就留空，不要为了“配置完整”而启用不使用的平台。

### 13. 备用评论系统示例配置
当前正式使用 Twikoo，但备用配置仍有模板示例：
- [ ] Giscus：清理 `CuteLeaf/Firefly` 仓库配置。
- [ ] Disqus：清理 `firefly` shortname。
- [ ] Artalk：清理 `artalk.example.com`。
- [ ] Waline：确认示例服务地址仅作为占位，不会误启用。

**建议：**
Twikoo 已经工作正常，其他评论系统保持关闭即可，只需要移除“属于别人的真实配置”。

### 14. Dynamic / Memos 示例值
- [ ] 清理 `https://memos.example.com` 占位地址。
- [ ] 清理 `users/xiaye` 示例用户。
- [ ] Memos 未使用时继续保持关闭。

### 15. 看板娘 / Live2D / Spine 示例内容
当前功能关闭，但源码仍带：
- [ ] Firefly Spine 模型。
- [ ] Snow Miku Live2D 模型。
- [ ] Firefly 默认互动文案。
- [ ] 外部黑猫模型示例。

**建议：**
如果短期确定不用看板娘，可以只保留功能代码，删除大体积示例模型资产；如果以后想用，再换成自己的角色。

### 16. 示例广告
- [ ] 清理未启用广告组件中的 `ad1.webp` 和示例链接。
- [ ] 保留广告组件能力，但不要留第三方模板广告数据。

### 17. 原模板视觉残留资源
- [ ] 检查 `src/assets/images/avatar.avif` 是否仍被引用。
- [ ] 检查 `src/assets/images/logo/firefly-dark.png` 是否仍被引用。
- [ ] 检查 `src/assets/images/logo/firefly-light.png` 是否仍被引用。
- [ ] 清理不再使用的 `public/favicon/firefly-*.png`。
- [ ] 清理因为 README 替换后不再需要的模板截图/文档图片。

**建议：**
只删“确认无引用”的文件，避免为了去模板化误删主题运行所需资源。

---

## P3 — GitHub 仓库本身的模板身份

### 18. 根 README
当前仍是完整 Firefly 官方 README：
- [ ] 重写 `README.md` 为 LengxiQwQ Site 项目说明。
- [ ] 处理或删除 `README.en.md`。
- [ ] 处理 `docs/README.ja.md`、`README.ko.md`、`README.zh-TW.md`。
- [ ] README 中保留 Firefly / Fuwari Credits 与许可证说明。

**建议结构：**
项目简介 → 在线地址 → 技术栈 → 双仓架构 → 本地开发 → 部署 → 内容仓说明 → Credits → License。

### 19. GitHub Funding
当前仍指向 CuteLeaf：
- [ ] `.github/FUNDING.yml` 的 Ko-fi 改成 LengxiQwQ。
- [ ] 爱发电链接改成 LengxiQwQ。

### 20. Issue 模板
- [ ] Bug Report 默认 assignee 从 `CuteLeaf` 改为自己或留空。
- [ ] Feature Request 默认 assignee 从 `CuteLeaf` 改为自己或留空。
- [ ] 删除 Feature Request 中 `@saicaca` 是仓库 owner 的错误文案。
- [ ] 根据个人站项目调整 Issue 提示语。

### 21. Pull Request 模板
- [ ] 删除指向 `CuteLeaf/Firefly` CONTRIBUTING 的链接。
- [ ] 删除“不允许 personal changes”这类主题仓专用规则。
- [ ] 改成 LengxiQwQ Site 自己的 PR 检查项。

### 22. package.json
- [ ] 评估将 `name: "firefly"` 改成 `lengxiqwq-site`。
- [ ] 评估版本号是否继续跟随 Firefly 上游，还是改成站点自身版本策略。

**建议：**
包名可以立即改；版本策略先别急着脱离上游，除非以后不再持续同步 Firefly。

### 23. Agent / AI 开发说明
- [ ] `AGENTS.md` 从“Firefly 项目”改为“LengxiQwQ Site，基于 Firefly”。
- [ ] `CLAUDE.md` 同步调整项目身份。
- [ ] 明确双仓架构和“个人内容优先放私有内容仓”的边界。

### 24. 仓库元信息
- [ ] 检查 GitHub Repository Description。
- [ ] 检查 Homepage URL 是否为 `https://lengxiqwq.com`。
- [ ] 检查 Topics 是否符合个人站（Astro / personal-website / blog 等）。
- [ ] 检查 Social Preview 是否仍是模板默认视觉。

---

## P4 — 站点配置进一步个人化

### 25. 时区
当前：
```text
Asia/Shanghai
```

- [ ] 决定是否改为 `Asia/Kuala_Lumpur`。

**建议：**
如果网站的动态、RSS、构建时间想对应当前学习生活所在地，使用 `Asia/Kuala_Lumpur`；如果你希望始终按中国时间展示，则继续保留上海时区。

### 26. SEO Keywords
当前关键词中包含 `Firefly`：
- [ ] 评估是否从主要 SEO Keywords 中移除 `Firefly`。
- [ ] 补充更符合个人站的关键词。

**建议：**
Firefly 应保留在 Credits，而不是作为个人站主要 SEO 定位关键词。

### 27. Microsoft Clarity
当前：
```text
microsoftClarityId: ""
```

- [ ] 创建 / 确认 Microsoft Clarity Project。
- [ ] 填入自己的 Clarity Project ID。
- [ ] 部署后验证实时访问、页面、热图、录屏是否正常。
- [ ] 检查隐私声明是否需要补充统计说明。

**建议：**
既然已经决定主用 Microsoft Clarity，就先只接 Clarity；Google Analytics、Umami、51la 不需要为了“配置齐全”全部启用。

### 28. Analytics 其他平台
- [ ] Google Analytics：保持未启用，除非以后明确需要。
- [ ] Umami：保持未启用，除非以后需要自托管/第二统计源。
- [ ] 51la：保持未启用，除非以后需要国内访问分析。

---

## P5 — 已准备好但尚未接到网站的个人内容

### 29. Devices / 我的设备
私有仓 `docs/PENDING_MIGRATION.md` 已有完整设备数据：
- [ ] 决定并入 About 还是单独做 Devices 页面。
- [ ] 展示电脑、手机、平板、外设、耳机、吉他、音箱等。
- [ ] 设计卡片布局和分类。

**建议：**
第一版并入 About，避免为了一个页面额外维护复杂路由；内容丰富后再拆独立页面。

### 30. Timeline / 个人时间线
私有仓已记录：
- [ ] GitHub 起点。
- [ ] 大学项目。
- [ ] CapsLock IME Switcher。
- [ ] Live Photo Box。
- [ ] PlaylistOut。
- [ ] 个人网站上线。

**建议：**
优先并入 About 页面，形成“关于我 → 项目 → 时间线”的自然结构。

---

## P6 — 最终验收

完成所有替换后：

- [ ] 首页不再出现 Firefly / CuteLeaf 的用户内容。
- [ ] 文章页没有模板演示文章。
- [ ] 动态页没有模板动态。
- [ ] 相册没有模板图片和示例密码。
- [ ] 友链没有模板默认站点。
- [ ] 书签导航只保留自己真实使用的内容。
- [ ] 音乐播放器不再播放模板媒体。
- [ ] 留言板、公告均为自己的文案。
- [ ] GitHub Funding 不再指向模板作者。
- [ ] Issue / PR 不再自动指向 CuteLeaf / saicaca。
- [ ] README 清楚说明本站身份，同时保留 Firefly / Fuwari Credits。
- [ ] 未启用模块不存在他人的真实账号和 ID。
- [ ] 私有内容仓成为文章、动态、项目、个人页面和个人媒体的主要内容源。
- [ ] `pnpm check` 通过。
- [ ] `pnpm type-check` 通过。
- [ ] `pnpm build` 通过。
- [ ] GitHub Pages 正式站逐页人工检查。
- [ ] 移动端再检查一遍导航、壁纸、相册、评论、音乐和布局。

---

## 推荐执行顺序

```text
P0 同步机制
↓
文章
↓
动态
↓
公告
↓
友链
↓
相册
↓
书签导航
↓
音乐
↓
留言板
↓
首页壁纸
↓
隐藏模板账号/示例配置
↓
GitHub README / Funding / Issue / PR
↓
Clarity
↓
Devices / Timeline
↓
最终验收
```

> 每次只处理一个模块；完成后构建、检查正式页面、勾选对应待办，再进入下一项。
