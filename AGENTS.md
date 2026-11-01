# 项目开发与工作流规则（Development & Workflow Rules）

适用于 `d:\Projects\lengxiqwq-site`（主代码仓）与 `d:\Projects\lengxiqwq-site-content`（内容仓）及相关开发：

## 0. 双仓库职责与修改目标辨析规则（修改前必查！绝对禁止改错仓库）

主代码仓与内容仓完全解耦，每次接收任务时**必须首先分析任务性质，精准锁定目标仓库**，绝对禁止在代码仓改文章或在内容仓改组件！

### A. 私有内容仓：`d:\Projects\lengxiqwq-site-content`
**凡涉及“数据、正文、个人偏好、私密配置、媒体资源”，必须且只能在内容仓修改！**
- 📝 **文章正文与文稿**：`content/posts/`（所有 Markdown / MDX 博客正文）
- 💬 **动态与说说**：`content/dynamic/`
- 💼 **个人项目数据**：`content/projects/`
- 📄 **专属单页文案**：`content/spec/`
- ⚙️ **个人专属私有配置**：`config/`
  - `siteConfig.ts`（站名、作者名称、头像、Bio、个人多站点切换列表等）
  - `musicConfig.ts`（个人音乐歌单与播放源）
  - `linksConfig.ts` / `friendsConfig.ts`（个人友链名单与分类）
  - `navBarConfig.ts`（个人导航栏排序、个人特定菜单项）
  - `steamConfig.ts`（包含真实个人 Steam API Key、Steam ID 的私密配置）
- 🖼️ **静态媒体资源**：`public/`
  - 个人相册：`public/gallery/`
  - 电脑/手机壁纸：`public/wallpapers/`
  - 音乐音频文件：`public/assets/music/`
  - 正文与说说引用的图片等

⚠️ **红线警告**：严禁在主代码仓的 `src/content/` 或 `src/config/` 修改上述内容！因为代码仓里的这些文件只是构建或本地运行时从内容仓临时物化同步过来的影子，一旦执行同步或 CI 构建，代码仓中的改动会被内容仓瞬间覆盖抹掉！

---

### B. 开源主代码仓：`d:\Projects\lengxiqwq-site`
**凡涉及“功能、样式、页面框架、组件逻辑、构建脚本”，必须在主代码仓修改！**
- 🎨 **样式与主题**：`src/styles/`、Tailwind CSS 类名、CSS 变量、主题配色
- 🧩 **UI 组件与页面**：`src/components/`（Svelte / Astro 组件）、`src/pages/`、`src/layouts/`
- 🌐 **语言与国际化字典**：`src/i18n/`（系统通用词条翻译，非文章正文）
- 🛠️ **底层逻辑与工具函数**：`src/utils/`、`src/plugins/`
- 🤖 **构建与自动化脚本**：`scripts/`、`.github/workflows/`
- 📋 **纯净模板预设**：`src/config/`（仅保留开源主题默认预设/占位符，严禁反向污染个人私密数据）

---

## 1. Git 提交与双仓联动推送规则（核心铁律）
- **单次授权原则**：用户要求“提交推送”仅为对该次操作的**单次授权**，绝对不得视作后续修改的长期许可。平时修改后**严禁擅自执行 git commit 或 git push**，改动必须留在本地供用户测试。
- **唯二允许提交推送的时机**：
  1. 用户明确说**“做完了”**；
  2. 用户明确下达**“提交推送”**（或“提交代码”、“push”）的指令。
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

## 2. 本地开发服务器保护与免冲突规则（Local Dev Server Protection）
- **严禁终止本地开发服务**：绝对严禁执行 `Stop-Process`、`kill`、`taskkill` 等命令杀死本地正在运行的 `node`、`astro`、`vite`、`pnpm dev` 等开发服务进程！
- **保障 Localhost 持续可用**：用户在本地始终保持 `localhost` 开发服务（如 `astro dev` 端口 4321）用于实时预览与调试页面效果，任何操作绝不可中断用户的本地测试环境。
- **职责彻底分离（动静分离原则）**：
  - **用户专享**：用户负责在本地终端运行 `pnpm dev`，拥有对本地 `localhost` 开发服务器的唯一控制权。
  - **Agent 纯写码**：Agent 专职进行源码与文本编辑（`edit_file` / `write_file`）。
  - **Agent 严禁在本地执行全量构建或清理脚本**：Agent 严禁在本地执行 `pnpm build`、`astro build` 或 `scripts/sync-content.ts`、`scripts/reset-content.ts`。因为 Windows 下运行中的 dev server 会持有文件句柄，任何清理或并发构建都会直接触发 `EPERM` 文件锁定报错，并打烂用户的本地开发缓存与热重载。
  - **合规静态检查方式**：若 Agent 修改完复杂逻辑需要验证代码合法性，**只允许使用只读的纯内存静态检查**（如 `pnpm type-check` 即 `tsc --noEmit`，或 `pnpm lint` 即 `biome check`）。这类命令不写磁盘、不碰文件锁、不占端口，100% 不会影响用户的 `localhost`。

## 3. 轻量与数值级修改免编译规则（No Full Build for Minor/Style/Value Changes）
- **充分利用 HMR 实时热更新**：调整样式（Tailwind CSS 类名）、数值、间距（margin / padding）、组件排版布局、纯文案修改等轻量改动，本地 `astro dev` / `vite` 具备毫秒级 HMR 热更新能力，保存即生效，**绝对不要重新跑整个项目的编译或打包流程**。
- **严禁擅自执行全量构建**：严禁在简单数值、排版或样式调整后执行 `pnpm build` 等笨重耗时的全量编译命令，这不仅白白浪费 1~2 分钟时间，还会因并发占用本地资源和产生临时文件锁破坏本地开发环境。
- **构建命令触发条件**：仅在用户明确下达“测试构建”、“跑一下打包看有没有错”，或进行了大规模核心依赖升级/底层架构重构且需要校验类型时，方可按需执行构建。


## 4. 常用开发与静态检查命令（Development Commands）
- `pnpm dev`：启动本地开发服务器（http://localhost:4321，由用户终端独占控制）。
- `pnpm type-check`：TypeScript 类型检查（`tsc --noEmit --isolatedDeclarations`，纯只读不占文件锁）。
- `pnpm lint`：Biome 静态代码与样式检查（`biome check`）。
- `pnpm format`：Biome 自动代码格式化（`biome format --write ./src ./scripts`）。

## 5. 提交信息规范（Commit Message Guidelines）
- 统一遵循 Conventional Commits 规范，所有 commit 描述必须使用中文：
  - `feat: ...`：新功能、新组件
  - `fix: ...`：缺陷修复、样式异常修正
  - `style: ...`：纯样式、排版或数值调整（不影响业务逻辑）
  - `chore: ...`：工作流、规则、配置文件或构建依赖维护
  - `docs: ...`：文档修改
