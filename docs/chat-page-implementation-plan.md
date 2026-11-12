# 聊天室页面前端实现计划

> **用途**：交给 AI 编码助手（如 Gemini Flash）按步骤执行，产出完整可运行的聊天室前端页面。
> **后端不在本文档范围内**——所有消息、用户列表、歌曲数据均使用写死的 Mock 数据，前端只做 UI。

---

## 0. 项目背景速查

| 信息 | 值 |
|------|-----|
| 主代码仓 | `d:\Projects\lengxiqwq-site`（Astro 项目） |
| 内容仓 | `d:\Projects\lengxiqwq-site-content` |
| 框架 | Astro + Svelte（交互组件全部使用 Svelte） |
| CSS | Tailwind CSS v4 + 自定义 CSS 变量（oklch 色彩体系） |
| 布局 | `Layout.astro`（基础壳）→ `MainGridLayout.astro`（博客三栏布局） |
| 主题色 | 通过 `--hue` CSS 变量驱动，oklch 色阶，亮/暗自动切换 |
| 响应式断点 | `768px`（md）, `1280px`（xl） |
| 图标库 | `astro-icon`（`<Icon name="material-symbols:xxx" />`） |
| 滚动条 | `.custom-scrollbar` 类（已有全局样式） |
| 卡片基础类 | `.card-base`（圆角 `--radius-large`=1rem + 背景 `--card-bg` + 过渡） |
| 按钮类 | `.btn-regular`（主题色按钮）、`.btn-plain`（透明按钮）、`.btn-card`（卡片按钮） |

### 必须遵守的项目规则

1. **严禁执行 `pnpm build`、`astro build`**——用户本地有 dev server 在跑，会文件冲突
2. **严禁杀死任何 node/astro/vite 进程**
3. **只允许纯静态检查**：`pnpm type-check`（tsc --noEmit）或 `pnpm lint`（biome check）
4. **严禁擅自 git commit / git push**——改动留本地供用户测试
5. **主代码仓**放组件/样式/页面，**内容仓**放导航配置

---

## 1. 需要创建/修改的文件清单

### 主代码仓 `d:\Projects\lengxiqwq-site`

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/pages/chat.astro` | **新建** | 页面入口 |
| `src/components/pages/chat/ChatApp.svelte` | **新建** | 三栏主容器 + 移动端 Tab 切换 |
| `src/components/pages/chat/RoomPanel.svelte` | **新建** | 左栏：房间列表 + 在线成员 |
| `src/components/pages/chat/ChatWindow.svelte` | **新建** | 中栏：消息流 + 输入区 |
| `src/components/pages/chat/MusicPanel.svelte` | **新建** | 右栏：点歌台 + 歌词 |
| `src/components/pages/chat/ChatMessage.svelte` | **新建** | 单条消息气泡 |
| `src/styles/pages/chat.css` | **新建** | 聊天页专属样式 |
| `src/types/siteConfig.ts` | **修改** | `pages` 类型加 `chat?: boolean` |
| `src/config/siteConfig.ts` | **修改** | `pages` 加 `chat: true` |

### 内容仓 `d:\Projects\lengxiqwq-site-content`

| 文件 | 操作 | 说明 |
|------|------|------|
| `config/navBarConfig.ts` | **修改** | 在"文章"和"社交"之间插入"聊天"链接 |

---

## 2. 逐步实现指令

### Step 1：页面开关注册

**文件**：`src/types/siteConfig.ts`

在 `pages` 类型定义中（约第 89-107 行），加入：

```typescript
chat?: boolean; // 聊天室页面开关
```

**文件**：`src/config/siteConfig.ts`

在 `pages` 对象的 `resolvePageToggles({...})` 中（社交分组下方），加入：

```typescript
// 聊天室页面开关
chat: true,
```

### Step 2：导航栏接入

**文件**：`d:\Projects\lengxiqwq-site-content\config\navBarConfig.ts`

在 `LinkPresets` 对象末尾增加聊天预设：

```typescript
Chat: {
    name: "聊天",
    url: "/chat/",
    icon: "material-symbols:chat-bubble",
    pageKey: "chat",
},
```

在 `getDynamicNavBarConfig()` 函数中，找到"文章"下拉菜单 `links.push(...)` 和"社交"下拉菜单 `links.push(...)` 之间（约第 46-48 行），插入：

```typescript
// 聊天室
links.push(LinkPresets.Chat);
```

### Step 3：创建页面入口 `src/pages/chat.astro`

```astro
---
import { Icon } from "astro-icon/components";
import HeaderTopRow from "@/components/layout/HeaderTopRow.astro";
import NavMenuPanel from "@/components/layout/NavMenuPanel.astro";
import FloatingControls from "@/components/controls/FloatingControls.astro";
import ChatApp from "@/components/pages/chat/ChatApp.svelte";
import { navbarMode, siteConfig } from "@/config";
import { resolveNavMenuLinks } from "@/utils/nav-menu-utils";
import Layout from "@/layouts/Layout.astro";

import "@/styles/pages/chat.css";

// 页面开关检查
if (!siteConfig.pages.chat) {
    return Astro.redirect("/404/");
}

const navbarWidthFull = siteConfig.navbar.widthFull ?? false;
---

<Layout title="聊天" description="实时聊天室">
    <HeaderTopRow navbarMode={navbarMode} navbarWidthFull={navbarWidthFull} />

    <div id="chat-page" class="chat-page-container">
        <ChatApp client:load />
    </div>

    <FloatingControls headings={[]} encrypted={false} />
    <NavMenuPanel links={resolveNavMenuLinks()} />
</Layout>
```

关键要点：
- **使用 `Layout.astro` 而非 `MainGridLayout.astro`**——跳过博客侧栏/Footer/Banner
- **保留 `HeaderTopRow`**——导航栏与全站一致
- **保留 `NavMenuPanel`**——移动端抽屉菜单正常工作
- **保留 `FloatingControls`**——主题切换/回到顶部等浮动按钮
- **`client:load`**——Svelte 组件立即 hydrate

### Step 4：创建聊天页专属样式 `src/styles/pages/chat.css`

```css
/* 聊天室页面：全屏沉浸式布局 */

/* 容器：填满导航栏下方的剩余视口高度 */
.chat-page-container {
    position: fixed;
    top: 4.5rem; /* 导航栏高度 */
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    display: flex;
    align-items: stretch;
    padding: 0.75rem;
    gap: 0.75rem;
    background: var(--page-bg);
    overflow: hidden;
}

/* 三栏面板通用样式 */
.chat-panel {
    border-radius: var(--radius-large);
    background: var(--card-bg);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: background-color 150ms;
}

/* 左右面板开启卡片边框时跟随 */
.enable-card-border .chat-panel {
    border: 1px solid var(--line-divider);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.05);
}

/* 壁纸透明模式下聊天面板也走透明 */
.wallpaper-transparent .chat-panel {
    background-color: var(--card-bg-transparent) !important;
}

/* 三栏具体宽度 */
.chat-panel-left {
    width: 260px;
    flex-shrink: 0;
}
.chat-panel-center {
    flex: 1;
    min-width: 0;
}
.chat-panel-right {
    width: 300px;
    flex-shrink: 0;
}

/* ── 消息气泡 ── */
.chat-bubble {
    max-width: 70%;
    padding: 0.625rem 0.875rem;
    font-size: 0.875rem;
    line-height: 1.5;
    word-break: break-word;
}

.chat-bubble-other {
    background: var(--btn-regular-bg);
    color: var(--deep-text);
    border-radius: 1.125rem 1.125rem 1.125rem 0.25rem;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.06);
}

.chat-bubble-self {
    background: var(--primary);
    color: white;
    border-radius: 1.125rem 1.125rem 0.25rem 1.125rem;
    box-shadow: 0 2px 8px oklch(0.70 0.14 var(--hue) / 0.25);
}

:root.dark .chat-bubble-self {
    color: rgb(0 0 0 / 70%);
}

/* ── 系统消息 ── */
.chat-system-msg {
    text-align: center;
    font-size: 0.75rem;
    color: var(--content-meta);
    padding: 0.375rem 0.75rem;
    background: var(--btn-regular-bg);
    border-radius: var(--radius-full);
    display: inline-block;
    margin: 0.5rem auto;
}

/* ── 输入区 ── */
.chat-input-area {
    border-top: 1px solid var(--line-divider);
    padding: 0.75rem;
    background: var(--card-bg);
}

.chat-input-box {
    width: 100%;
    resize: none;
    border: 1.5px solid var(--line-divider);
    border-radius: 0.75rem;
    padding: 0.625rem 0.875rem;
    font-size: 0.875rem;
    background: var(--muted);
    color: var(--deep-text);
    outline: none;
    transition: border-color 200ms, box-shadow 200ms;
    font-family: inherit;
}

.chat-input-box:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px oklch(0.70 0.14 var(--hue) / 0.15);
}

.chat-send-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 0.5rem 1.25rem;
    border-radius: var(--radius-full);
    background: var(--primary);
    color: white;
    font-size: 0.875rem;
    font-weight: 600;
    border: none;
    cursor: pointer;
    transition: all 200ms var(--ease-standard);
}

:root.dark .chat-send-btn {
    color: rgb(0 0 0 / 70%);
}

.chat-send-btn:hover {
    transform: scale(1.06);
    box-shadow: 0 4px 16px oklch(0.70 0.14 var(--hue) / 0.35);
}

.chat-send-btn:active {
    transform: scale(0.95);
}

/* ── 房间列表项 ── */
.chat-room-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    cursor: pointer;
    transition: background-color 150ms;
    font-size: 0.875rem;
    color: var(--deep-text);
}

.chat-room-item:hover {
    background: var(--btn-plain-bg-hover);
}

.chat-room-item.active {
    background: var(--btn-regular-bg);
    color: var(--primary);
    font-weight: 600;
}

/* ── 在线用户项 ── */
.chat-user-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.8125rem;
    color: var(--deep-text);
    transition: background-color 150ms;
}

.chat-user-item:hover {
    background: var(--btn-plain-bg-hover);
}

.chat-online-dot {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-full);
    background: oklch(0.72 0.19 145);
    box-shadow: 0 0 6px oklch(0.72 0.19 145 / 0.6);
    flex-shrink: 0;
    animation: chat-pulse-glow 2s ease-in-out infinite;
}

@keyframes chat-pulse-glow {
    0%, 100% { opacity: 1; box-shadow: 0 0 6px oklch(0.72 0.19 145 / 0.6); }
    50% { opacity: 0.7; box-shadow: 0 0 3px oklch(0.72 0.19 145 / 0.3); }
}

/* ── 用户头像 ── */
.chat-avatar {
    width: 2.25rem;
    height: 2.25rem;
    border-radius: var(--radius-full);
    object-fit: cover;
    flex-shrink: 0;
    background: var(--btn-regular-bg);
}

.chat-avatar-sm {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: var(--radius-full);
    object-fit: cover;
    flex-shrink: 0;
    background: var(--btn-regular-bg);
}

/* ── 点歌台 ── */
.chat-music-search {
    width: 100%;
    border: 1.5px solid var(--line-divider);
    border-radius: var(--radius-full);
    padding: 0.5rem 0.875rem 0.5rem 2.25rem;
    font-size: 0.8125rem;
    background: var(--muted);
    color: var(--deep-text);
    outline: none;
    transition: border-color 200ms;
}

.chat-music-search:focus {
    border-color: var(--primary);
}

.chat-vinyl {
    width: 6rem;
    height: 6rem;
    border-radius: var(--radius-full);
    border: 3px solid var(--line-divider);
    object-fit: cover;
    animation: chat-vinyl-spin 8s linear infinite;
    animation-play-state: var(--vinyl-state, running);
}

@keyframes chat-vinyl-spin {
    to { transform: rotate(360deg); }
}

.chat-progress-bar {
    width: 100%;
    height: 4px;
    border-radius: var(--radius-full);
    background: var(--btn-regular-bg);
    overflow: hidden;
}

.chat-progress-fill {
    height: 100%;
    border-radius: var(--radius-full);
    background: var(--primary);
    transition: width 300ms linear;
}

/* ── 歌词视窗 ── */
.chat-lyric-line {
    text-align: center;
    padding: 0.375rem 0;
    font-size: 0.8125rem;
    color: var(--content-meta);
    opacity: 0.5;
    transition: all 400ms var(--ease-decelerate);
}

.chat-lyric-line.active {
    opacity: 1;
    font-size: 1rem;
    font-weight: 600;
    color: var(--primary);
    transform: scale(1.05);
}

/* ── 候播歌单项 ── */
.chat-queue-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.625rem;
    border-radius: 0.5rem;
    font-size: 0.8125rem;
    background: var(--btn-regular-bg);
    color: var(--deep-text);
}

/* ── 分区标题 ── */
.chat-section-title {
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--content-meta);
    padding: 0.5rem 0.75rem 0.25rem;
}

/* ── 分割线 ── */
.chat-divider {
    height: 1px;
    background: var(--line-divider);
    margin: 0.5rem 0.75rem;
}

/* ── 工具栏小按钮 ── */
.chat-tool-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 0.5rem;
    color: var(--content-meta);
    transition: all 150ms;
    cursor: pointer;
    border: none;
    background: none;
    font-size: 1.125rem;
}

.chat-tool-btn:hover {
    background: var(--btn-plain-bg-hover);
    color: var(--primary);
}

/* ── 点歌按钮 ── */
.chat-add-song-btn {
    padding: 0.25rem 0.625rem;
    border-radius: var(--radius-full);
    background: var(--btn-regular-bg);
    color: var(--btn-content);
    font-size: 0.75rem;
    font-weight: 600;
    border: none;
    cursor: pointer;
    transition: all 150ms;
}

.chat-add-song-btn:hover {
    background: var(--btn-regular-bg-hover);
}

/* ==========================================================================
   移动端适配（< 768px）：底部 Tab 切换
   ========================================================================== */
@media (max-width: 767px) {
    .chat-page-container {
        padding: 0;
        gap: 0;
        flex-direction: column;
    }

    .chat-panel-left,
    .chat-panel-right {
        width: 100%;
        flex-shrink: 1;
    }

    .chat-panel-center {
        flex: 1;
    }

    /* 三个面板默认隐藏，active 的显示 */
    .chat-panel-left,
    .chat-panel-center,
    .chat-panel-right {
        display: none;
        border-radius: 0;
    }

    .chat-panel-left.mobile-active,
    .chat-panel-center.mobile-active,
    .chat-panel-right.mobile-active {
        display: flex;
        flex: 1;
    }

    /* 底部 Tab 栏 */
    .chat-mobile-tabs {
        display: flex !important;
        background: var(--card-bg);
        border-top: 1px solid var(--line-divider);
        padding-bottom: env(safe-area-inset-bottom, 0px);
        flex-shrink: 0;
    }

    .chat-mobile-tab {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.125rem;
        padding: 0.5rem 0;
        font-size: 0.6875rem;
        color: var(--content-meta);
        cursor: pointer;
        transition: color 150ms;
        border: none;
        background: none;
        position: relative;
    }

    .chat-mobile-tab.active {
        color: var(--primary);
        font-weight: 600;
    }

    .chat-mobile-tab.active::after {
        content: '';
        position: absolute;
        top: 0;
        left: 50%;
        transform: translateX(-50%);
        width: 20px;
        height: 3px;
        border-radius: var(--radius-full);
        background: var(--primary);
    }

    .chat-mobile-tab-icon {
        font-size: 1.25rem;
    }
}

/* 桌面端隐藏底部 Tab */
@media (min-width: 768px) {
    .chat-mobile-tabs {
        display: none !important;
    }
}

/* 中等屏幕（768px ~ 1024px）：右栏收窄 */
@media (min-width: 768px) and (max-width: 1024px) {
    .chat-panel-left {
        width: 200px;
    }
    .chat-panel-right {
        width: 240px;
    }
}
```

### Step 5：创建 Svelte 组件

以下是各 Svelte 组件的完整实现规范。**请严格使用下列 CSS 类名**（已在 `chat.css` 中定义），不要发明新的 class 或使用 Tailwind @apply 替代。行内只允许使用 Tailwind 的间距/flex/文字 utility（如 `flex`, `gap-2`, `text-sm`, `mb-2`, `px-3`, `items-center`, `overflow-y-auto`）作为补充。

#### 5.1 `ChatApp.svelte`（三栏主容器）

职责：
- 承载左、中、右三个面板
- 管理移动端 Tab 切换状态（`activeTab`：`'room'` | `'chat'` | `'music'`，默认 `'chat'`）
- 所有面板桌面端同时显示，移动端根据 `activeTab` 添加 `.mobile-active` 类

结构骨架：

```svelte
<script>
  let activeTab = 'chat';
</script>

<div class="flex flex-col h-full w-full">
  <div class="flex flex-1 min-h-0 gap-3 p-0 md:p-0" style="height: 100%;">
    <div class="chat-panel chat-panel-left {activeTab === 'room' ? 'mobile-active' : ''}">
      <RoomPanel />
    </div>
    <div class="chat-panel chat-panel-center {activeTab === 'chat' ? 'mobile-active' : ''}">
      <ChatWindow />
    </div>
    <div class="chat-panel chat-panel-right {activeTab === 'music' ? 'mobile-active' : ''}">
      <MusicPanel />
    </div>
  </div>

  <!-- 移动端底部 Tab -->
  <div class="chat-mobile-tabs">
    <button class="chat-mobile-tab {activeTab === 'room' ? 'active' : ''}" on:click={() => activeTab = 'room'}>
      <span class="chat-mobile-tab-icon">🏠</span>
      <span>房间</span>
    </button>
    <button class="chat-mobile-tab {activeTab === 'chat' ? 'active' : ''}" on:click={() => activeTab = 'chat'}>
      <span class="chat-mobile-tab-icon">💬</span>
      <span>聊天</span>
    </button>
    <button class="chat-mobile-tab {activeTab === 'music' ? 'active' : ''}" on:click={() => activeTab = 'music'}>
      <span class="chat-mobile-tab-icon">🎵</span>
      <span>点歌</span>
    </button>
  </div>
</div>
```

#### 5.2 `RoomPanel.svelte`（左栏）

结构从上到下：
1. **面板标题**：「聊天室」，小文字
2. **房间列表**（使用 `.chat-section-title` + `.chat-room-item` + `.active`）
   - Mock 数据：`闲聊`、`自习室`、`电台` 三个房间，第一个默认 active
   - 每个房间前面有个 `#` 号或图标
3. **`.chat-divider`** 分割线
4. **在线成员标题**（`.chat-section-title`）+ 成员数
5. **在线成员列表**（使用 `.chat-user-item`），这部分 `overflow-y: auto` + `.custom-scrollbar`
   - Mock 5-8 个用户，每个有：`.chat-avatar-sm`（随机颜色背景 + 首字母）、名字、`.chat-online-dot`、一个 `@` 小图标按钮
6. **底部**（`margin-top: auto`）：自己的信息卡片，`.chat-avatar` + 名字 + "在线" 小字

#### 5.3 `ChatWindow.svelte`（中栏 — 核心）

结构从上到下：
1. **顶栏**：当前房间名（居左，加粗） + 房间在线人数（居右，小字灰色），底部 `1px border`
2. **消息流区域**（`flex: 1; overflow-y: auto; .custom-scrollbar`）
   - 使用 `ChatMessage` 组件渲染每条消息
   - Mock 10-15 条消息，混合"别人的消息"、"自己的消息"、"系统消息"
   - 消息之间间距 `0.75rem`
   - 消息带时间戳（灰色小字，放在气泡下方 `0.25rem`）
3. **输入工具栏**：一排 `.chat-tool-btn`，放表情图标 `😀`、清屏图标 `🧹`、图片图标 `🖼️`
4. **输入区**：`.chat-input-area` 内部 flex 布局
   - 左侧：`.chat-input-box`（`<textarea rows="1">`）
   - 右侧：`.chat-send-btn`（文字"发送" + 一个小箭头图标）

#### 5.4 `ChatMessage.svelte`（消息气泡组件）

Props：
```typescript
type: 'other' | 'self' | 'system'
avatar?: string       // 头像URL或首字母
name?: string         // 发送者名字
content: string       // 消息内容
time: string          // 时间字符串如 "23:14"
```

渲染逻辑：
- `type === 'system'`：居中渲染 `.chat-system-msg`
- `type === 'other'`：左对齐，`flex` 行，头像在左 → 右侧竖排（名字 + `.chat-bubble.chat-bubble-other` + 时间）
- `type === 'self'`：右对齐，`flex flex-row-reverse`，头像在右 → 左侧竖排（`.chat-bubble.chat-bubble-self` + 时间右对齐）
- **自己的消息不显示名字**，别人的消息在气泡上方显示名字（小字灰色）

#### 5.5 `MusicPanel.svelte`（右栏）

结构从上到下（全部在一个 `flex flex-col h-full` 容器内）：

1. **搜歌区**（固定高度区块）
   - `.chat-section-title`："点歌台"
   - 搜索框：`.chat-music-search`（带搜索图标，用 `position: relative` + 绝对定位图标）
   - 搜索结果列表：Mock 3 首歌，每首显示 歌名 + 歌手 + `.chat-add-song-btn`（"+ 点歌"）
   - `.chat-divider`

2. **正在播放区**（固定高度区块，居中布局）
   - `.chat-section-title`："正在播放"
   - 居中放旋转唱片：`.chat-vinyl`（使用一张 Mock 封面图 URL，或纯渐变背景）
   - 歌名（加粗）+ 歌手（灰色小字）+ 点歌人（灰色微型字"xxx 点播"）
   - `.chat-progress-bar` + `.chat-progress-fill`（Mock 进度 60%）
   - 播放控制：上一首 / 暂停 / 下一首，三个 `.chat-tool-btn`
   - `.chat-divider`

3. **歌词视窗**（`flex: 1; overflow-y: auto; .custom-scrollbar`，这是关键的可滚动区域）
   - `.chat-section-title`："歌词"
   - 一组 `.chat-lyric-line`，Mock 12-15 行歌词，其中第 5 行加 `.active` 类
   - `.chat-divider`

4. **候播歌单**（底部固定区域）
   - `.chat-section-title`："即将播放"
   - 2 个 `.chat-queue-item`，每个显示 序号 + 歌名 + 点歌人

### Step 6：Mock 数据定义

直接在各 Svelte 组件内写死 Mock 数据，不需要单独的数据文件。确保内容有足够多样性来展示各种 UI 状态：

**Mock 用户列表**：
```javascript
const users = [
  { name: '小明', avatar: '🧑', online: true },
  { name: '思思', avatar: '👧', online: true },
  { name: '阿杰', avatar: '👨', online: true },
  { name: '冷汐', avatar: '🐱', online: true, isSelf: true },
  { name: '月月', avatar: '🌙', online: true },
  { name: '大胖', avatar: '🐻', online: true },
];
```

**Mock 消息列表**（混合三种类型，至少 12 条）：
```javascript
const messages = [
  { type: 'system', content: '冷汐 加入了闲聊房间' },
  { type: 'other', name: '小明', avatar: '🧑', content: '大家晚上好呀~', time: '22:30' },
  { type: 'other', name: '思思', avatar: '👧', content: '好久不见！最近在忙什么呢', time: '22:31' },
  { type: 'self', avatar: '🐱', content: '嗨嗨，最近在折腾博客的聊天室功能哈哈', time: '22:32' },
  { type: 'other', name: '阿杰', avatar: '👨', content: '哦？听起来很有意思，是自己写的后端吗', time: '22:33' },
  { type: 'self', avatar: '🐱', content: '对的，前后端都自己搞，先把前端页面做出来', time: '22:33' },
  { type: 'system', content: '月月 点播了一首《晴天》' },
  { type: 'other', name: '月月', avatar: '🌙', content: '来听首歌放松一下吧 🎵', time: '22:35' },
  { type: 'other', name: '大胖', avatar: '🐻', content: '好歌！周杰伦永远的神', time: '22:36' },
  { type: 'self', avatar: '🐱', content: '确实，每次听到前奏就起鸡皮疙瘩', time: '22:36' },
  { type: 'other', name: '小明', avatar: '🧑', content: '话说你们有没有推荐的开源聊天框架？我也想给我的项目加一个', time: '22:38' },
  { type: 'self', avatar: '🐱', content: '可以看看 Socket.IO，上手比较简单，文档也很全', time: '22:39' },
  { type: 'other', name: '思思', avatar: '👧', content: '我之前用过 LiveKit，也挺好的，还支持音视频', time: '22:40' },
  { type: 'system', content: '阿杰 点播了一首《稻香》' },
];
```

**Mock 歌曲/歌词**：正在播放周杰伦《晴天》，歌词至少 12 行。

### Step 7：验证清单

完成所有文件后，执行以下检查（**只允许这些命令**）：

```powershell
# 1. TypeScript 类型检查
cd d:\Projects\lengxiqwq-site
pnpm type-check

# 2. 代码风格检查
pnpm lint
```

修复所有报错后，**不要 commit，不要 push**，让用户在 localhost:4321/chat/ 自行预览。

---

## 3. 视觉一致性保障清单

以下是确保聊天页与博客整体风格融为一体的关键点，**每一条都必须严格遵守**：

- [ ] **颜色**：所有颜色只使用 CSS 变量（`--primary`、`--card-bg`、`--page-bg`、`--btn-regular-bg`、`--line-divider`、`--content-meta`、`--deep-text`、`--muted`、`--btn-content` 等），**零硬编码色值**（除了在线绿灯 oklch 和白色文字）
- [ ] **圆角**：面板用 `--radius-large`（1rem），气泡用 `1.125rem`，按钮用 `--radius-full` 或 `0.5rem`
- [ ] **暗色模式**：通过 `:root.dark` 选择器和 CSS 变量自动适配，不需要额外 JS 切换
- [ ] **字体**：继承全局 `--font-sans`，不引入新字体
- [ ] **滚动条**：所有可滚动区域加 `.custom-scrollbar` 类
- [ ] **过渡动画**：使用 `--ease-standard`、`--ease-decelerate` 等预设缓动函数
- [ ] **间距**：面板间 `gap: 0.75rem`，内边距 `0.75rem`~`1rem`，与博客 `#main-grid` 的 `gap-4 px-2 md:px-4` 体感接近
- [ ] **卡片边框**：`.enable-card-border .chat-panel` 已处理，跟随全局卡片边框开关
- [ ] **壁纸模式**：`.wallpaper-transparent .chat-panel` 已处理，跟随壁纸透明度
