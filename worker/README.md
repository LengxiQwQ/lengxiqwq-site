# lengxiqwq-api (Cloudflare Worker 统一边缘网关)

基于 **Hono.js** 与 **Cloudflare Workers / D1 / KV / R2** 打造的高性能轻量 Serverless 后端网关，为博客提供全动态说说、朋友圈抓取、媒体直传与管理中枢支持。

---

## 一、 核心架构与功能

1. **统一路由网关**：基于 Hono.js 构建，毫秒级冷启动，支持全域跨域（CORS）与自动化 OPTIONS 预检。
2. **D1 动态说说数据库**：接管博客日常碎片动态（Moments），支持置顶、图片集、地理位置标签，免除 Git 提交与 3 分钟 CI 打包，0 秒即时呈现。
3. **R2 媒体直传**：支持拖拽/相册图片直传至 Cloudflare R2，免出站流量费。
4. **Master Key / JWT 鉴权体系**：支持博主专属暗号（`MASTER_KEY`）登录，签发 7 天有效期的安全 JWT Token，守护全部写操作接口。

---

## 二、 接口契约清单 (API Contracts)

网关服务统一部署于 `https://api.lengxiqwq.com`（或开发调试时的 `http://localhost:8787`）。

### 1. 健康检查与状态
- `GET /api/health`：公开接口，检查 Worker 运行状态与 D1/KV/R2 绑定健康度。
- `GET /`：根路由网关欢迎与元信息。

### 2. 身份鉴权
- `POST /api/admin/login`：公开接口，传入 `{ "masterKey": "你的主暗号" }`。校验通过后返回签名的 JWT Token 及过期时间戳。

### 3. 动态说说 (Moments)
- `GET /api/dynamic/list?page=1&limit=20`：公开接口，分页读取说说列表（按 `pinned DESC, created_at DESC` 排序）。
- `POST /api/dynamic/publish`：受保护接口（需携带 Bearer Token 或 X-Master-Key），发布新说说。
- `POST /api/dynamic/upload`：受保护接口，接收 `multipart/form-data`（字段名为 `file` 或 `image`），直传 Cloudflare R2。
- `PUT /api/dynamic/:id`：受保护接口，更新指定说说的正文、配图、置顶状态或位置标签。
- `DELETE /api/dynamic/:id`：受保护接口，删除指定说说。

---

## 三、 Cloudflare 资源创建与初始化指引 (SOP)

在首次部署或上线前，博主需在 Cloudflare 平台创建 D1、KV 和 R2 存储桶，并在 `wrangler.jsonc` 中填入对应资源 ID。

### 方式 A：通过 Wrangler CLI 快捷创建（推荐）

打开本地终端，进入项目根目录：

#### 1. 创建 D1 数据库
```bash
npx wrangler d1 create lengxiqwq-db
```
执行后终端会输出类似如下内容：
```
[[d1_databases]]
binding = "DB"
database_name = "lengxiqwq-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```
将该 `database_id` 填入 `worker/wrangler.jsonc` 的 `d1_databases[0].database_id`。

#### 2. 初始化 D1 表结构
- **本地开发环境初始化**：
  ```bash
  pnpm --filter lengxiqwq-api db:init
  ```
- **云端线上数据库初始化**：
  ```bash
  pnpm --filter lengxiqwq-api db:init:remote
  ```

#### 3. 创建 KV 命名空间（用于后续朋友圈缓存等）
```bash
npx wrangler kv namespace create KV
```
执行后将生成的 `id` 填入 `worker/wrangler.jsonc` 的 `kv_namespaces[0].id`。

#### 4. 创建 R2 存储桶（说说配图与媒体）
```bash
npx wrangler r2 bucket create lengxiqwq-assets
```
若需自定义域名访问图片（如 `https://img.lengxiqwq.com`），请在 Cloudflare Dashboard -> R2 -> `lengxiqwq-assets` -> Settings -> Custom Domains 中绑定你的二级域名。

#### 5. 设置云端安全暗号 (Secrets)
千万不要将真实暗号明文写入 `wrangler.jsonc`！通过以下命令将暗号加密存入 Cloudflare：
```bash
# 设置管理主暗号
npx wrangler secret put MASTER_KEY --config worker/wrangler.jsonc

# 设置 JWT 签名密钥（可选，默认使用 MASTER_KEY）
npx wrangler secret put JWT_SECRET --config worker/wrangler.jsonc
```

---

### 方式 B：通过 Cloudflare Dashboard 控制台创建
1. **D1 数据库**：
   - 登录 Cloudflare -> 侧边栏进入 **Storage & Databases** -> **D1 SQL Database** -> **Create Database**。
   - 输入名称 `lengxiqwq-db`，创建后复制 `Database ID` 填入 `wrangler.jsonc`。
   - 在该数据库页面的 **Console** 选项卡中，复制 `worker/schema.sql` 的建表语句粘贴执行即可。
2. **KV 命名空间**：
   - 进入 **Storage & Databases** -> **KV** -> **Create a namespace**。
   - 输入名称 `lengxiqwq-kv`，复制 `Namespace ID` 填入 `wrangler.jsonc`。
3. **R2 存储桶**：
   - 进入 **Storage & Databases** -> **R2 Object Storage** -> **Create bucket**。
   - 桶名填写 `lengxiqwq-assets`，并在设置中关联自定义域名。

---

## 四、 本地调试与测试运行

### 1. 启动本地 Worker 调试服务
```bash
# 启动 worker 本地服务（默认运行在 http://localhost:8787）
pnpm --filter lengxiqwq-api dev
```

### 2. 纯只读类型检查
```bash
pnpm --filter lengxiqwq-api type-check
```

### 3. 一键部署到 Cloudflare Workers
```bash
pnpm --filter lengxiqwq-api deploy
```
部署完成后，在 Cloudflare Worker 设置中为该 Worker 绑定自定义域名（如 `api.lengxiqwq.com`），即完成全量网关上线！
