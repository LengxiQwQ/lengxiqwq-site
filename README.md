# LengxiQwQ Site

这是 **LengxiQwQ / 冷汐** 的个人网站项目。

正式站点：[https://lengxiqwq.com](https://lengxiqwq.com)

---

## 🛠️ 技术栈

- **框架**：[Astro 7](https://astro.build/)
- **交互组件**：[Svelte 5](https://svelte.dev/)
- **类型检查**：[TypeScript](https://www.typescriptlang.org/)
- **样式方案**：[Tailwind CSS](https://tailwindcss.com/)
- **代码规范**：[Biome](https://biomejs.dev/)
- **部署与网络**：[GitHub Pages](https://pages.github.com/) + [Cloudflare](https://www.cloudflare.com/)

---

## 🏛️ 双仓架构与 Content Ownership

本项目采用**公开代码仓与私有内容仓分离**的架构：

- **公开代码仓**（`LengxiQwQ/lengxiqwq-site`）：包含站点主题代码、页面布局、通用 UI 组件、插件以及构建与 CI 自动化脚本。
- **私有内容仓**（`LengxiQwQ/lengxiqwq-site-content`）：包含个人文章（posts）、说说动态（dynamic）、项目（projects）、个人说明页面（spec）、相册媒体以及个人覆盖配置（config overlay）。

### 核心架构原则

> **Content 独占，Config/Public 覆盖，Theme Code 继承。**

1. **Content 独占**：个人创作内容（文章、动态、项目等）完全由私有内容仓独占维护。`pnpm new-post` 和 `pnpm new-dynamic` 等脚本严格写入私有仓，禁止向公开仓提交或回退写入私有内容。
2. **Config / Public 覆盖**：私有仓中的 `config/` 与 `public/` 资源在同步阶段将作为覆盖层（Overlay）物化到站点中，实现个人配置与上游主题默认配置的解耦。
3. **Theme Code 继承**：公开仓保持整洁的主题与工程代码，便于持续跟进上游修复与新特性。

---

## 💻 本地开发

### 环境要求

- Node.js `>= 22.23.0`
- [pnpm](https://pnpm.io/) `>= 11.0.0`

### 推荐目录结构

建议将公开代码仓与私有内容仓置于同级目录下：

```text
Projects/
├── lengxiqwq-site/         # 本公开代码仓
└── lengxiqwq-site-content/ # 私有内容仓
```

### 开发流程

1. **安装依赖**：
   ```bash
   pnpm install
   ```

2. **内容同步**：
   若私有内容仓位于同级目录，脚本会自动识别；亦可通过 `CONTENT_DIR` 环境变量指定路径：
   ```bash
   pnpm content:sync
   ```

3. **启动开发服务器**：
   ```bash
   pnpm dev
   ```
   本地预览地址通常为 `http://localhost:4321/`。

---

## ⌨️ 常用命令

| 命令 | 说明 |
|---|---|
| `pnpm dev` | 启动本地 Astro 开发服务器（启动前自动执行 `content:sync`） |
| `pnpm build` | 执行完整生产构建（生成卡片、LQIP、VNDB封面、Astro 构建、字体子集化、Pagefind 索引） |
| `pnpm preview` | 本地预览构建产物 |
| `pnpm check` | 执行 Astro 组件诊断检查 |
| `pnpm type-check` | 执行 TypeScript 全局类型校验（覆盖 `src/` 与 `scripts/`） |
| `pnpm lint` | 执行 Biome 代码检查与安全修复 |
| `pnpm format` | 执行 Biome 代码格式化 |
| `pnpm content:sync` | 从私有内容仓物化内容、配置与静态资源到公开仓 |
| `pnpm new-post <title>` | 在私有内容仓 `content/posts/` 创建新文章（自动拼音 slug 与当前时区日期） |
| `pnpm new-dynamic <content>` | 在私有内容仓 `content/dynamic/` 创建新说说动态 |

---

## 🚀 自动部署

本项目使用 GitHub Actions 实现 CI/CD 自动化流水线：

1. 当公开代码仓发生推送，或通过私有内容仓的 Webhook 触发协同流水线时，工作流启动；
2. 构建流水线检出公开代码，并安全拉取私有内容仓内容执行 `content:sync`；
3. 执行构建生成生产静态文件；
4. 自动部署至 GitHub Pages，并由 Cloudflare 提供全球边缘缓存、DNS 解析与 HTTPS 加密。

---

## 💖 致谢 (Credits)

- 本站主题基于 [CuteLeaf/Firefly](https://github.com/CuteLeaf/Firefly) 模板二次开发与定制。
- Firefly 基于 [saicaca/fuwari](https://github.com/saicaca/fuwari)。
- 感谢所有开源库与开源社区贡献者的无私分享。

---

## 📄 许可证 (License)

本项目开源代码部分遵循 [MIT License](LICENSE)。保留上游原作者版权声明。个人文章、动态、照片媒体及文字内容版权归作者本人所有。
