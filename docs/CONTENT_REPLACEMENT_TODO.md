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
- [x] 修复 `new-post` Ownership：文章严格创建至私有内容仓 `content/posts/`，禁止 fallback 写入公开仓，接入配置时区与拼音 slug。
- [x] 验证部署后首页、归档、分类、标签、搜索、RSS 中不再出现模板演示文章。

**建议：**
暂时没准备好正式文章时，宁可让文章列表为空，也不要保留模板演示文章。

### 2. 修正 `sync-content.ts` 的清理范围
- [x] 当前 `cleanableCollections` 包含 `projects`、`posts`、`dynamic`、`spec`。
- [x] 私有仓已补齐 `about.md`、`friends.mdx`、`guestbook.md`，`spec` 已由私有仓完全接管。
- [x] 验证私有仓内容同步后不会和公开仓预设内容混合。

**建议：**
私有仓已完全接管 `posts`、`dynamic`、`projects`、`spec` 以及相册、音乐等媒体覆盖。

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
- [x] 替换 `announcementConfig.ts` 的示例公告（更新为 Live Photo Box 底层重构公告）。
- [x] 决定公告组件长期开启还是只在有重要消息时开启。
- [x] 将个人化后的 `announcementConfig.ts` 放入私有内容仓配置层。

**建议：**
如果近期没有真正公告，直接关闭公告卡片比长期放“欢迎公告”更自然。

### 6. 友链
当前列表：
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
- [x] 已上线《2026 马来西亚国庆布城大游行》正式相册（`merdeka-2026`），包含高清 WebP 媒体及全屏 Live Photo 交互支持

**建议分类：**
二次元收藏、游戏截图、马来西亚/校园日常、桌搭与数码、吉他与音乐、项目开发过程截图。

### 8. 书签导航
- [x] 按自己的真实浏览器书签重建 `booknavConfig.ts`（接入音乐与吉他乐谱工具 ChordU / Chordify / Songsterr）。
- [x] 调整分类与排序。
- [x] 清理模板演示站点与示例链接。

**建议分类：**
开发、AI、开源项目、设计、图片与媒体、音乐、游戏、云服务、站长工具、常用工具。

### 9. 音乐播放器
- [x] 《使一颗心免于哀伤》已替换
- [x] 原模板 MP3 已替换并移出代码仓
- [x] 原模板封面已替换
- [x] 接入酸欠少女 さユり《ミカヅキ -「め」弾期語りver.-》并由私有内容仓接管
- [x] 提取正版专辑《め》封面（300x300）转为 WebP 格式优化接入

**建议：**
先只放 3–10 首最喜欢的歌，避免为了“填满播放器”堆大量媒体文件。

### 10. 留言板正文
当前 `guestbook.md` 已由私有仓接管并完成文案个人化：
- [x] 改为冷汐杂货铺专属欢迎语与留言引导。
- [x] 移入私有内容仓 `content/spec/guestbook.md`。
- [x] 验证 Twikoo 留言正常。

**建议：**
语气保持“冷汐的杂货铺”亲和风格，当评论区使用。

### 11. 首页壁纸
当前：
- [ ] 6 张桌面壁纸全部仍为 Firefly 原图。
- [ ] 6 张移动壁纸全部仍为 Firefly 原图。
- [ ] 用自己的图片替换。
- [ ] 考虑将壁纸媒体迁入私有内容仓管理。

**建议：**
保持同一套视觉语言，桌面和移动端分别裁切，不要简单把桌面图直接缩成手机比例。本轮按原则保留。

---

## P2 — 已隐藏但仍残留模板身份的数据

### 12. Bangumi / VNDB / MyAnimeList 示例账号
当前页面保持关闭，配置中模板作者遗留数据已清理：
- [x] Bangumi：清理示例 `userId`（置空）。
- [x] VNDB：清理示例 `userId`（置空）。
- [x] MyAnimeList：清理 `username: "cuteleaf"`（置空）。
- [x] MyAnimeList：清理原模板 Client ID（置空）。
- [x] 未使用页面继续保持关闭。

**建议：**
没有自己的账号就留空，不要为了“配置完整”而启用不使用的平台。

### 13. 备用评论系统示例配置与配置收口
当前正式使用 Twikoo，备用配置与 Ownership 边界已收口：
- [x] Giscus：清理 `CuteLeaf/Firefly` 仓库及 ID 配置。
- [x] Disqus：清理 `firefly` shortname。
- [x] Artalk：清理 `artalk.example.com` 示例地址。
- [x] Waline：清理示例服务地址。
- [x] 配置收口：正式 Twikoo 配置放入私有仓 `config/commentConfig.ts` 覆盖层，公开仓保持中性 fallback（`type: "none"`）。

**建议：**
Twikoo 已经工作正常，其他评论系统保持关闭即可。

### 14. Dynamic / Memos 示例值
- [x] 清理 `https://memos.example.com` 占位地址。
- [x] 清理 `users/xiaye` 示例用户。
- [x] Memos 未使用时继续保持关闭。

### 15. 看板娘 / Live2D / Spine 示例内容
当前功能关闭，但源码仍带：
- [ ] Firefly Spine 模型。
- [ ] Snow Miku Live2D 模型。
- [ ] Firefly 默认互动文案。
- [ ] 外部黑猫模型示例。

**建议：**
如果短期确定不用看板娘，可以只保留功能代码，删除大体积示例模型资产；如果以后想用，再换成自己的角色。本轮按原则保留。

### 16. 示例广告
- [x] 清理未启用广告组件中的 `ad1.webp` 和示例推广链接（`haoka.lot-ml.com`、`agentid=1423316`）。
- [x] 删除模板广告素材 `public/assets/images/ad/ad1.webp`。
- [x] 保留广告组件能力与代码，清除模板广告数据。

### 17. 原模板视觉残留资源
- [ ] 检查 `src/assets/images/avatar.avif` 是否仍被引用。
- [ ] 检查 `src/assets/images/logo/firefly-dark.png` 是否仍被引用。
- [ ] 检查 `src/assets/images/logo/firefly-light.png` 是否仍被引用。
- [ ] 清理不再使用的 `public/favicon/firefly-*.png`。
- [x] 清理因为 README 替换后不再需要的模板截图/文档图片（`docs/images/` 已清理）。

**建议：**
只删“确认无引用”的文件，避免为了去模板化误删主题运行所需资源。

---

## P3 — GitHub 仓库本身的模板身份

### 18. 根 README
- [x] 重写 `README.md` 为 LengxiQwQ Site 项目说明（双仓架构、命令、部署等）。
- [x] 清理旧多语言副本 `README.en.md`、`docs/README.ja.md`、`README.ko.md`、`README.zh-TW.md`。
- [x] README 中保留 Firefly / Fuwari Credits 与许可证说明。

### 19. GitHub Funding
已切换为 LengxiQwQ 账号：
- [x] `.github/FUNDING.yml` 的 Ko-fi 改为 `lengxiqwq`。
- [x] 爱发电链接改为 `https://afdian.com/a/lengxiqwq`。

### 20. Issue 模板
- [x] Bug Report 默认 assignee 从 `CuteLeaf` 移除，更新为个人站 Issue 规范。
- [x] Feature Request 默认 assignee 从 `CuteLeaf` 移除，删除 `@saicaca` 是仓库 owner 的错误文案。
- [x] Custom Issue 统一中文规范。
- [x] 根据个人站项目调整 Issue 提示语。

### 21. Pull Request 模板
- [x] 删除指向 `CuteLeaf/Firefly` CONTRIBUTING 的链接。
- [x] 删除“不允许 personal changes”这类主题仓专用规则。
- [x] 改成符合双仓边界原则与代码质量检查的 PR 模板。

### 22. package.json
- [x] 将 `name: "firefly"` 改成 `lengxiqwq-site`。
- [x] 保留当前版本策略，同步 lockfile。

### 23. Agent / AI 开发说明
- [ ] `AGENTS.md` 从“Firefly 项目”改为“LengxiQwQ Site，基于 Firefly”。
- [ ] `CLAUDE.md` 同步调整项目身份。
- [ ] 明确双仓架构和“个人内容优先放私有内容仓”的边界。

### 24. 仓库元信息
- [x] 确认 GitHub Repository Description 为 `Personal site of LengxiQwQ, powered by Firefly`。
- [x] 修正 Homepage URL 为 `https://lengxiqwq.com`。
- [x] 配置 Topics：`astro`, `personal-website`, `blog`, `typescript`, `svelte`, `firefly`。
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
当前状态：
- [x] 已配置真实 Microsoft Clarity Project ID (`ylmp70p0eu` / 环境变量优先)。
- [x] 接入增强事件追踪（切页PV、邮件/QQ复制、外部链接点击、导航与项目交互等）。
- [x] 部署后验证实时访问、页面、热图、录屏正常运行。

### 28. Analytics 其他平台
- [ ] Google Analytics：保持未启用，除非以后明确需要。
- [ ] Umami：保持未启用，除非以后需要自托管/第二统计源。
- [ ] 51la：保持未启用，除非以后需要国内访问分析。

---

## P5 — 已准备好但尚未接到网站的个人内容

### 29. Devices / 我的设备
私有仓 `docs/PENDING_MIGRATION.md` 已有完整设备数据：
- [x] Devices 已从旧站数据迁移。
- [x] 已建立独立 `/devices/` 页面。
- [x] 已按轻量卡片展示。
- [x] 已接入私有设备配置。
- [x] 已加入导航入口。

**说明：**
已建立独立 `/devices/` 页面，按轻量卡片与三大分类（主力设备、桌面日常、音乐角落）展示，设备数据由私有内容仓接管，导航栏已加入入口。

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
- [x] 相册没有模板图片和示例密码。
- [x] 友链没有模板默认站点。
- [x] 书签导航只保留自己真实使用的内容。
- [x] 音乐播放器不再播放模板媒体。
- [x] 留言板、公告均为自己的文案。
- [x] GitHub Funding 不再指向模板作者。
- [x] Issue / PR 不再自动指向 CuteLeaf / saicaca。
- [x] README 清楚说明本站身份，同时保留 Firefly / Fuwari Credits。
- [x] 未启用模块不存在他人的真实账号和 ID。
- [x] 私有内容仓成为文章、动态、项目、个人页面和个人媒体的主要内容源。
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
