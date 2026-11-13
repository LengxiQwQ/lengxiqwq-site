# LengxiQwQ Site — 项目规则与协作手册（AGENTS.md）

> 本文件是 **主代码仓** 的项目宪法。任何 AI Agent（DeepSeek / Claude / Codex 等）在本仓库开会话时都会自动加载它。
> 私有内容仓 `d:\Projects\lengxiqwq-site-content` 有独立的 `AGENTS.md`；两仓规则不一致时，以**更严格**的一条为准。
> 本文件由早期 Antigravity 规则（`~/.gemini/config/rules/lengxiqwq-site-rules.md`）与项目实际约定合并而成，规则条目只增不减。

---

## 0. 10 秒速览（开工前先看这里）

- **站点**：LengxiQwQ / 冷汐 的个人网站，正式地址 <https://lengxiqwq.com>。
- **技术栈**：Astro 7 + Svelte 5 + TypeScript 6 + Tailwind CSS 4 + Biome 2；Node `>=22.23.0`，pnpm `11.22.0`。
- **双仓库**：
  - 主代码仓（本目录）：`LengxiQwQ/lengxiqwq-site` —— 管“网站怎么运行”。
  - 私有内容仓（同级目录）：`LengxiQwQ/lengxiqwq-site-content` —— 管“网站里放什么”。
- **第一问**：这次要改的是 **内容/配置/媒体**，还是 **代码/样式/脚本**？改错仓库会被同步直接覆盖。
- **本地 dev**：由用户自己在终端跑 `pnpm dev`（http://localhost:4321）。Agent 不启动、不重启、不终止它。
- **不要擅自 build**：样式、数值、文案、排版改动靠 HMR 即时生效；全量构建只在用户明确要求时执行。
- **不要擅自提交**：只有用户说“做完了”或“提交推送”才允许 `git commit` / `git push`。

---

## 1. 双仓库职责与修改目标辨析（修改前必查！绝对禁止改错仓库）

主代码仓与内容仓完全解耦，每次接收任务时**必须首先分析任务性质，精准锁定目标仓库**，绝对禁止在代码仓改文章或在内容仓改组件！

### A. 私有内容仓：`d:\Projects\lengxiqwq-site-content`

**凡涉及“数据、正文、个人偏好、私密配置、媒体资源”，必须且只能在内容仓修改！**

- 📝 **文章正文与文稿**：`content/posts/`（所有 Markdown / MDX 博客正文）
- 💬 **动态与说说**：`content/dynamic/`
- 💼 **个人项目数据**：`content/projects/`
- 📄 **专属单页文案**：`content/spec/`（`about.md`、`friends.mdx`、`guestbook.md` 等）
- ⚙️ **个人专属私有配置**：`config/`
  - `siteConfig.ts`（站名、作者名称、头像、Bio、个人多站点切换列表等）
  - `musicConfig.ts`（个人音乐歌单与播放源）
  - `friendsConfig.ts`（个人友链名单与分类）
  - `navBarConfig.ts`（个人导航栏排序、个人特定菜单项）
  - `steamConfig.ts`（包含真实个人 Steam API Key、Steam ID 的私密配置）
- 🖼️ **静态媒体资源**：`public/`
  - 个人相册：`public/gallery/`
  - 电脑/手机壁纸：`public/wallpapers/`
  - 音乐音频文件：`public/assets/music/`
  - 正文与说说引用的图片等

> ⚠️ **红线警告**：严禁在主代码仓的 `src/content/` 或 `src/config/` 修改上述内容！因为代码仓里的这些文件只是构建或本地运行时从内容仓临时物化同步过来的**影子**，一旦执行同步或 CI 构建，代码仓中的改动会被内容仓瞬间覆盖抹掉！

### B. 开源主代码仓：`d:\Projects\lengxiqwq-site`

**凡涉及“功能、样式、页面框架、组件逻辑、构建脚本”，必须在主代码仓修改！**

- 🎨 **样式与主题**：`src/styles/`、Tailwind CSS 类名、CSS 变量、主题配色
- 🧩 **UI 组件与页面**：`src/components/`（Svelte / Astro 组件）、`src/pages/`、`src/layouts/`
- 🌐 **语言与国际化字典**：`src/i18n/`（系统通用词条翻译，非文章正文）
- 🛠️ **底层逻辑与工具函数**：`src/utils/`、`src/plugins/`
- 🤖 **构建与自动化脚本**：`scripts/`、`.github/workflows/`
- 📋 **纯净模板预设**：`src/config/`（仅保留开源主题默认预设/占位符，严禁反向污染个人私密数据）

### C. 两边都要改时

先改内容仓的“数据源”，再改主仓的“消费代码”；本地 `pnpm dev` 的 `predev` 会把内容仓重新物化到主仓。**永远不要反向操作**（先改主仓影子再指望它留下）。

---

## 2. Git 提交与双仓联动推送规则（核心铁律）

- **单次授权原则**：用户要求“提交推送”仅为对该次操作的**单次授权**，绝对不得视作后续修改的长期许可。平时修改后**严禁擅自执行 `git commit` 或 `git push`**，改动必须留在本地供用户测试。
- **唯二允许提交推送的时机**：
  1. 用户明确说 **“做完了”**；
  2. 用户明确下达 **“提交推送”**（或“提交代码”、“push”）的指令。
- **双仓联动检查机制**：
  - 当收到推送指令时，除非用户特别指定单一仓库，必须**同时检查两个仓库**的 Git 状态：
    - 主代码仓：`d:\Projects\lengxiqwq-site`
    - 私有内容仓：`d:\Projects\lengxiqwq-site-content`
- **防重复构建与冲突的时序铁律（双仓联动推送）**：
  - **双仓均有修改时**：
    1. **第 1 步（内容仓带 `[skip ci]`）**：先暂存、提交并推送到**内容仓**（`lengxiqwq-site-content`），**Commit 消息必须包含 `[skip ci]`**（例如：`git commit -m "docs: 更新内容配置 [skip ci]"`）。
       - *核心原理*：阻止内容仓自带的 GitHub Actions 发送 dispatch 触发多余的第一重构建。
    2. **第 2 步（代码仓正常推送触发）**：间隔 2~3 秒后，再暂存、提交并推送到**主代码仓**（`lengxiqwq-site`），正常触发代码仓的部署流水线。
       - *核心原理*：主代码仓构建步骤会自动拉取内容仓的最新 `main` 分支。因为第 1 步已推送到内容仓，拉取到的必定是最新完整内容，最终**只跑单次全量构建**，杜绝并发冲突和重复构建。
  - **仅内容仓有修改时**：
    - 正常提交并推送内容仓，**不要**加 `[skip ci]`，以便其自动触发主站部署流水线。
  - **仅主代码仓有修改时**：
    - 正常提交并推送主代码仓即可。
- **提交前自检**：主仓 `git status` 里通常有大量 `src/config/`、`src/content/`、`public/` 的“已修改/已删除/未跟踪”条目——那是 dev 同步出来的影子，**不要整目录 `git add .`**。只提交本次真正改动的源码文件，并逐文件看 `git diff`。

---

## 3. 本地开发服务器保护与免冲突规则（Local Dev Server Protection）

- **严禁终止本地开发服务**：绝对严禁执行 `Stop-Process`、`kill`、`taskkill` 等命令杀死本地正在运行的 `node`、`astro`、`vite`、`pnpm dev` 等开发服务进程！
- **保障 Localhost 持续可用**：用户在本地始终保持 `localhost` 开发服务（`astro dev` 端口 4321）用于实时预览与调试页面效果，任何操作绝不可中断用户的本地测试环境。
- **职责彻底分离（动静分离原则）**：
  - **用户专享**：用户负责在本地终端运行 `pnpm dev`，拥有对本地 `localhost` 开发服务器的唯一控制权。
  - **Agent 纯写码**：Agent 专职进行源码与文本编辑（`edit` / `write`）。
  - **Agent 严禁在本地执行全量构建或清理脚本**：Agent 严禁在本地执行 `pnpm build`、`astro build`、`scripts/sync-content.ts`、`scripts/reset-content.ts`。Windows 下运行中的 dev server 会持有文件句柄，清理或并发构建会直接触发 `EPERM` 文件锁定报错，并打烂本地开发缓存与热重载。
  - **合规静态检查方式**：修改复杂逻辑后需要验证合法性时，**只允许使用只读的纯内存静态检查**：
    - `pnpm type-check`（`tsc --noEmit --isolatedDeclarations`）
    - `pnpm exec biome check ./src ./scripts`（只读检查）
    - ⚠️ 注意：`pnpm lint` 实际是 `biome check --write`，会**写盘自动修复**；`pnpm format` 也会写盘。需要“只读”时不要用这两个。
    - ⚠️ `pnpm check` 会先跑 `precheck`（内容同步，写盘），dev server 运行时不要执行。

---

## 4. 轻量与数值级修改免编译规则（No Full Build for Minor/Style/Value Changes）

- **充分利用 HMR 实时热更新**：调整样式（Tailwind CSS 类名）、数值、间距（margin / padding）、组件排版布局、纯文案修改等轻量改动，本地 `astro dev` / `vite` 具备毫秒级 HMR 热更新能力，保存即生效，**绝对不要重新跑整个项目的编译或打包流程**。
- **严禁擅自执行全量构建**：严禁在简单数值、排版或样式调整后执行 `pnpm build` 等笨重耗时的全量编译命令，这不仅白白浪费 1~2 分钟时间，还会因并发占用本地资源和产生临时文件锁破坏本地开发环境。
- **构建命令触发条件**：仅在用户明确下达“测试构建”、“跑一下打包看有没有错”，或进行了大规模核心依赖升级/底层架构重构且需要校验类型时，方可按需执行构建。
- **内容类改动**：不需要任何构建，dev server 会自动重建内容集合；改完刷新页面即可。

---

## 5. 常用命令与“读/写”属性（Development Commands）

> 工作目录：主代码仓。所有命令都通过 pnpm 执行。

| 命令 | 实际行为 | 是否写盘 | 使用建议 |
| --- | --- | --- | --- |
| `pnpm dev` | `predev` 同步内容 → `astro dev --host`（4321） | 是 | **用户自己跑**，Agent 不启动 |
| `pnpm start` | 同 `dev` | 是 | 同上 |
| `pnpm build` | 同步内容 + 生成 Steam/GitHub 卡片/LQIP/VNDB + `astro build` + 字体子集 + Pagefind + `postbuild` 还原 | 是（大量） | **仅用户明确要求时** |
| `pnpm preview` | 预览 `dist` | 否 | 需已有构建产物 |
| `pnpm type-check` | `tsc --noEmit --isolatedDeclarations` | 否 | ✅ Agent 首选静态检查 |
| `pnpm exec biome check ./src ./scripts` | Biome 只读检查 | 否 | ✅ 代码/样式只读检查 |
| `pnpm lint` | `biome check --write ./src ./scripts` | 是 | 会**自动改文件**，慎用 |
| `pnpm format` | `biome format --write ./src ./scripts` | 是 | 会**自动改文件**，慎用 |
| `pnpm check` | `precheck` 同步 → `astro check` | 是 | 含同步，dev 运行时避免 |
| `pnpm content:sync` | 从内容仓物化 `content/config/public` | 是 | dev 运行时避免 |
| `pnpm content:reset` | 还原纯净模板 | 是（删文件） | **严禁**在 dev 运行时执行 |
| `pnpm new-post` | 在**内容仓** `content/posts/` 新建文章 | 是 | 内容创作首选 |
| `pnpm new-dynamic <文本>` | 在**内容仓** `content/dynamic/` 新建说说 | 是 | 内容创作首选 |
| `pnpm add-friend` / `add-sub` / `add-sponsor` | 维护友链 / 订阅 / 赞助名单 | 是 | 按脚本提示操作 |
| `pnpm check:friends` | 友链双向巡检（全量或 `--site <url>`） | 是（更新审计 JSON） | 见 `docs/friends-management.md` |
| `pnpm check:friends-health` | 友链健康检查 | 是（更新健康 JSON） | 同上 |
| `pnpm update:steam` | 生成 Steam 数据（需私密配置） | 是 | 一般由 CI 做 |
| `pnpm lqips` / `github-cards` | 生成 LQIP / GitHub 卡片数据 | 是 | 构建辅助 |
| `pnpm upload:covers` / `upload:img` | 上传封面 / 正文图片 | 是（远端） | 按脚本提示操作 |

> **原则**：凡是会写盘、会清理、会联网上传的命令，默认都不由 Agent 自行发起；需要时先征得用户同意。

---

## 6. 提交信息规范（Commit Message Guidelines）

统一遵循 Conventional Commits 规范，所有 commit 描述必须使用中文：

- `feat: ...`：新功能、新组件
- `fix: ...`：缺陷修复、样式异常修正
- `style: ...`：纯样式、排版或数值调整（不影响业务逻辑）
- `chore: ...`：工作流、规则、配置文件或构建依赖维护
- `docs: ...`：文档修改
- `refactor: ...`：不改变外部行为的重构
- `perf: ...`：性能优化

示例：`feat: 新增聊天室点歌台`、`fix: 修复移动端导航栏遮挡`、`docs: 更新项目规则 [skip ci]`。

---

## 7. 友情链接与智能爬虫系统维护规则（Friend Links Management SOP）

- **单一事实源原则**：全站所有友链双向探测、连通性检查与 WAF 穿透逻辑统一收敛于 [`scripts/check-friends-reciprocal.ts`](scripts/check-friends-reciprocal.ts)（支持全量批量巡检与 `--site <url>` 单站现场重测）。
- **严禁重复编写抓取代码**：`scripts/process-friend-apply.ts`（GitHub Issues 申请自动化机器人）与 `astro.config.mjs`（本地审查面板重测 API）均直接调度复用该核心引擎，**改动 1 处自动确保 3 处同时生效**。
- **详细架构与排查手册**：遇到反爬阻断、SPA 动态 API 嗅探或维护需求时，请务必首先查阅项目专用指南文档 [`docs/friends-management.md`](docs/friends-management.md)。

---

## 8. 项目地图（目录职责）

```text
lengxiqwq-site/
├── src/
│   ├── components/        # Astro + Svelte 组件（布局、卡片、控件、评论、特效等）
│   ├── layouts/           # 页面骨架布局
│   ├── pages/             # 路由页面（首页、文章、归档、友链、相册、聊天室、API 等）
│   ├── content/           # 【影子】dev/build 时由内容仓物化，禁止手改
│   ├── config/            # 【影子】主题默认预设 + 内容仓覆盖，禁止提交私密值
│   ├── i18n/              # i18nKey.ts 词条键 + translation.ts 翻译字典
│   ├── styles/            # 全局 CSS、Tailwind 主题变量
│   ├── utils/             # 日期、内容、路径、性能等工具函数
│   ├── plugins/           # Markdown / 构建插件
│   ├── types/             # 配置与内容类型定义
│   ├── constants/         # 生成产物（LQIP、图标、友链审计缓存等）
│   └── content.config.ts  # 四个集合的 Zod schema（posts/dynamic/projects/spec）
├── scripts/               # 同步、构建、生成、友链巡检、发布辅助脚本
├── docs/                  # 项目级设计与排查文档
├── public/                # 【部分影子】字体、图标、静态资源；相册/壁纸/音乐由内容仓覆盖
├── worker/                # Cloudflare Worker 统一边缘网关（说说/朋友圈/媒体直传）
├── .github/workflows/     # 构建、部署、友链巡检、朋友圈抓取、赞助等自动化
├── astro.config.mjs       # Astro 主配置（集成、Markdown、代码高亮、i18n 等）
└── AGENTS.md              # 本文件
```

几个容易找错的地方：

- 站点标题、作者、头像、Bio、导航项、歌单、友链名单：**内容仓 `config/`**。
- 页面大标题、按钮、通用提示词：主仓 `src/i18n/`（改键值要两边对齐，别只改一边）。
- 文章 schema：主仓 `src/content.config.ts`；文章数据：内容仓 `content/posts/`。
- 友链抓取核心：主仓 `scripts/check-friends-reciprocal.ts`；友链名单：内容仓 `config/friendsConfig.ts`。
- 评论前端配置：内容仓 `config/commentConfig.ts`；Waline 后端：内容仓 `waline/`。

---

## 9. 内容模型与写作约定（供判断“该改哪”）

四个集合定义于 `src/content.config.ts`：

### 9.1 文章 `content/posts/**/*.{md,mdx}`

常用 frontmatter：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `title` | string | 必填，文章标题 |
| `published` | date | 必填；`YYYY-MM-DD HH:mm:ss` 无时区时按 **+08:00** 解析 |
| `updated` | date | 可选，更新时间 |
| `draft` | boolean | 默认 `false`；`true` 不参与构建 |
| `description` | string | 摘要/SEO 描述 |
| `image` | string | 封面图路径（通常 `/assets/images/posts/...`） |
| `tags` | string[] | 标签 |
| `category` | string \| null | 分类 |
| `lang` | string | 语言标记 |
| `pinned` | boolean | 是否置顶 |
| `author` / `sourceLink` / `licenseName` / `licenseUrl` | string | 署名与版权 |
| `comment` | boolean | 默认 `true`，是否允许评论 |
| `password` / `passwordHint` | string | 加密文章口令与提示 |
| `series` / `seriesOrder` | string / number | 系列文章与顺序 |

- 正文图片放在 `public/assets/images/posts/<文章名>/`，引用 `/assets/images/posts/...`。
- 支持 MDX、KaTeX、Mermaid、PlantUML、代码组、Callout 等扩展语法。
- 新增文章优先用 `pnpm new-post`（写入内容仓），不要手写错目录。

### 9.2 说说 `content/dynamic/*.md`

- 文件名：`YYYY-MM-DD-HHmmss.md`。
- frontmatter：`published`（必填）、`pinned`、`location`、`tags`。
- 图片放 `public/assets/images/dynamic/`，引用 `/assets/images/dynamic/...`。

### 9.3 项目 `content/projects/**/*.{md,mdx}`

- frontmatter：`title`、`slug`、`published`、`draft`、`order`、`description`、`image`（相对路径如 `./images/x.webp`）、`tags`、`status`、`lang`、`comment`。
- `link` 为数组：`{ label, icon, value, disabled? }`，图标用 Iconify 名（如 `fa7-brands:github`）。
- 项目封面图放 `content/projects/images/`。

### 9.4 单页 `content/spec/*.{md,mdx}`

- `about.md`、`friends.mdx`、`guestbook.md` 等，无 frontmatter schema；正文即页面内容。

### 9.5 写作风格

- 用户是中文母语者，正文以中文为主，语气自然、口语化，拒绝“AI 味”和空洞排比。
- 改动用户原文时只做必要的最小编辑，不要擅自重写观点、删减段落或统一文风。
- 引用外部内容时保留原始链接；图片必须给出可访问路径。

---

## 10. 同步与部署链路（理解“为什么不能乱改”）

### 10.1 本地物化

`predev` / `precheck` / `prebuild` 会执行 `scripts/sync-content.ts`：

```text
内容仓 content/  -> 主仓 src/content/
内容仓 config/   -> 主仓 src/config/
内容仓 public/   -> 主仓 public/
```

同步时会**清理**主仓的 `src/content/{posts,dynamic,projects,spec}`、`public/{gallery,wallpapers}`、`public/assets/music`，再以内容仓为准复制。`postbuild` 再执行 `reset-content.ts` 把主仓还原为纯净模板。

因此：

- 主仓 `src/content/`、`src/config/` 里的个人内容都是**临时影子**。
- 直接改影子 = 下次同步/构建必然丢失。
- 主仓 `git status` 里影子文件的改动**不属于本次代码改动**，不要提交。

### 10.2 CI 部署

- 主仓 `.github/workflows/deploy.yml`：push `main`（忽略纯 `*.md`）、`repository_dispatch: content-updated`、每日 cron、手动触发。
- 构建时把内容仓 checkout 到 `.content-src`，以 `CONTENT_DIR=.content-src` 运行同步与构建，部署到 GitHub Pages。
- 内容仓 `.github/workflows/trigger-build.yml`：push `content/**`、`config/**`、`public/**` 时向主仓发送 `content-updated` dispatch。
- 内容仓 commit 带 `[skip ci]` 时，GitHub Actions 跳过该次 workflow，从而避免双仓同时推送时的重复构建。

### 10.3 双仓推送的标准顺序

1. 内容仓：`git add ... && git commit -m "docs: ... [skip ci]" && git push`
2. 等 2~3 秒。
3. 主仓：`git add ... && git commit -m "feat: ..." && git push`

这样主仓构建拉到的就是刚推的内容仓最新 `main`，只跑一次全量构建。

---

## 11. Windows / 本机环境注意事项

- 系统：Windows 11；终端：PowerShell 7（`pwsh`）。路径使用 `D:\...`，命令里注意引号与中文路径。
- Node `>=22.23.0`，pnpm `11.22.0`（`packageManager` 已锁定，`preinstall` 强制 pnpm）。
- dev server 端口 **4321**；`scripts/dev-process-utils.ts` 会检测已有实例并阻止重复启动（`.dev.lock`）。
- Windows 文件锁常见 `EPERM` / `errno 1224`：同步脚本已做跳过与容错，Agent 不要再叠加清理操作。
- 不要在 dev server 运行时删除 `.astro/`、`dist/`、`node_modules/.vite` 或执行 `content:reset`。
- 长路径/中文文件名在 Git 中会显示为八进制转义，这是正常的，不要因此重命名用户文件。
- 涉及密钥（Steam API Key、Waline 配置、Token）时只读不打印；不要写入日志、提交或截图。

---

## 12. 任务路由表（“我要改 X” → “去 Y”）

| 用户需求 | 目标仓库 | 主要文件 |
| --- | --- | --- |
| 写/改文章、修错别字、换封面 | 内容仓 | `content/posts/...`、`public/assets/images/posts/...` |
| 发说说、改说说 | 内容仓 | `content/dynamic/...`、`public/assets/images/dynamic/...` |
| 改项目介绍、项目链接 | 内容仓 | `content/projects/...` |
| 改 About / 友链页 / 留言板文案 | 内容仓 | `content/spec/...` |
| 改站名、作者、头像、Bio、社交链接 | 内容仓 | `config/siteConfig.ts`、`config/profileConfig.ts` |
| 改导航栏、菜单排序、站点切换 | 内容仓 | `config/navBarConfig.ts`、`config/siteConfig.ts` |
| 改歌单、播放源、歌词 | 内容仓 | `config/musicConfig.ts`、`public/assets/music/` |
| 加/改友链名单与分组 | 内容仓 | `config/friendsConfig.ts` |
| 改 Steam 展示数据 | 内容仓（密钥） | `config/steamConfig.ts` |
| 换壁纸、相册、头像资源 | 内容仓 | `public/wallpapers/`、`public/gallery/`、`public/avatar*` |
| 改组件结构、交互、动画 | 主仓 | `src/components/`、`src/layouts/` |
| 改页面布局、路由、SEO | 主仓 | `src/pages/`、`astro.config.mjs` |
| 改颜色、间距、字号、圆角 | 主仓 | `src/styles/`、组件内 Tailwind 类 |
| 改通用按钮/提示文案 | 主仓 | `src/i18n/` |
| 改文章字段、校验规则 | 主仓 | `src/content.config.ts`、`src/types/` |
| 改友链抓取、巡检、WAF 穿透 | 主仓 | `scripts/check-friends-reciprocal.ts` |
| 改构建、部署、自动化 | 主仓 | `scripts/`、`.github/workflows/` |
| 改评论后端 | 内容仓 | `waline/`、`config/commentConfig.ts` |
| 改聊天室前端 / 点歌台 | 主仓 | `src/pages/chat.astro`、相关组件与配置 |
| 改说说/朋友圈 API、媒体直传 | 主仓 | `worker/`（Hono + D1/KV/R2） |

---

## 13. 新会话开工清单（Agent Checklist）

1. **读规则**：本文件 + 内容仓 `AGENTS.md`（若任务涉及内容）。
2. **看状态**：`git status --short` 两个仓库；区分“影子同步”与“真实改动”，不要误提交影子。
3. **定仓库**：按第 12 节路由表确认目标仓库；不确定时先问用户，不要猜。
4. **先读后改**：改任何文件前先 `read`，不要凭记忆重写；改动保持最小 diff。
5. **不改无关文件**：不做顺手重构、不统一格式、不升级依赖，除非用户明确要求。
6. **验证**：逻辑改动跑 `pnpm type-check`；样式/文案靠 HMR，不 build；不杀 dev server。
7. **提交**：没有“做完了/提交推送”就停在本地，并告诉用户改了哪些文件、怎么预览。
8. **汇报**：中文、说人话；涉及多文件时列清单；不要贴大段无关日志。

---

## 14. 常见误区（踩过的坑）

- ❌ 在主仓 `src/config/siteConfig.ts` 改站名 → ✅ 改内容仓 `config/siteConfig.ts`。
- ❌ 在主仓 `src/content/posts/` 新建文章 → ✅ 在内容仓 `content/posts/` 新建，或用 `pnpm new-post`。
- ❌ 改完样式跑 `pnpm build` 验证 → ✅ 保存后看 localhost:4321 的 HMR。
- ❌ 为了“干净”执行 `pnpm content:reset` → ✅ 用户没要求就不要动，重置会删掉本地物化内容。
- ❌ 双仓都改时先推主仓 → ✅ 先推内容仓（带 `[skip ci]`），再推主仓。
- ❌ 把 `src/config/` 里的个人 Steam Key、友链、歌单提交到公开仓 → ✅ 这些只属于内容仓。
- ❌ 用 `pnpm lint` 做“只读检查” → ✅ 用 `pnpm exec biome check ./src ./scripts`。

---

## 15. 相关文档索引

- 项目说明与双仓架构：[`README.md`](README.md)
- 主题配置项说明：[`src/config/README.md`](src/config/README.md)
- 友链系统架构与排查：[`docs/friends-management.md`](docs/friends-management.md)
- 聊天室实现计划：[`docs/chat-page-implementation-plan.md`](docs/chat-page-implementation-plan.md)
- Cloudflare Workers 迁移计划：[`docs/cloudflare-workers-migration-plan.md`](docs/cloudflare-workers-migration-plan.md)
- 内容替换待办：[`docs/CONTENT_REPLACEMENT_TODO.md`](docs/CONTENT_REPLACEMENT_TODO.md)
- 私有内容仓规则：`../lengxiqwq-site-content/AGENTS.md`

---

## Codex 补充规则

Codex 的协作细节见 [`CODEX.md`](CODEX.md)。每次任务仍以本文件的仓库边界、安全要求和操作限制为准；本文件与补充规则不一致时，遵守更严格的一条。

> 规则维护：新增约定请直接追加到对应章节，并在提交信息中用 `docs:` 或 `chore:` 标注。不要删除历史铁律；确需调整时先与用户确认。
