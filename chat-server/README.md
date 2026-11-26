# VPS 点歌台维护

线上网关入口是 `/opt/chat-server/server.mjs`。本目录保存点歌台模块和网关集成补丁。网关的 Matrix、Waline 等生产配置保存在 VPS。

- 模块回归用 `node --test chat-server/test/music.test.mjs chat-server/test/music-card.test.mjs`。
- 网关回归用 `CHAT_GATEWAY_MODULES=/opt/chat-server/node_modules node test/gateway-regression.mjs <已应用补丁的网关文件> .`。测试使用临时目录和模拟上游。
- 将本目录上传到 VPS 的独立发布目录后，先运行 `bash deploy-music.sh --check`，再运行 `bash deploy-music.sh --deploy`。首次发布会从在运行的网关保存每房队列。脚本会备份旧入口和模块，启动检查失败时恢复旧代码。
- 发布脚本锁定了这次使用的网关版本。再次发布时，先根据 VPS 当前入口重新核对和更新集成补丁及校验值。

用户歌单全站共享，精选和轮播配置按房间保存。播放、待播队列与点歌历史也分别按房间保存。

## 轮播换源与替代版本

先发布网关，再发布静态站。网关保留旧版手动轮播指令，新版根据轮播条目 ID 请求播放。只有发起者会收到候选回执，确认后才向房间广播实际播放的曲目。候选在 90 秒后失效，换房、轮播设置或播放状态变化也会使旧的轮播确认失效。歌单、搜索、收藏和历史的点歌共用同一个网关入口，缺少原始音源时会返回候选，确认后按正常点歌规则入队或立即播放。

从新版起，发布脚本会对当前线上基线应用 `rotation-fallback.patch` 并校验结果。针对当前线上版本，只替换轮播管理、匹配器和 QQ 音乐提供器，沿用在线的流缓存、签名和超时模块。`request-fallback.patch` 在轮播补丁上加上点歌入口。随机点歌由 `random-request.patch` 接入网关，可在同一歌单内重新抽取，或使用同曲、同歌手且版本一致的可播匹配。其他网关版本出现冲突时，先核对线上入口，再更新补丁和对应校验值。

验证通过的同版本匹配会短期缓存。手动确认的选择使用现有 SQLite KV，按用户和来源曲目保存 QQ 曲目资料。再次点歌先复核已选音源，失败时重新匹配。两类记录均不存音频链接。

## 多音源

原生歌单优先按原平台曲目 ID 取源。Apple Music 和 Spotify 依次优先 QQ、网易云、YouTube Music、酷狗。QQ 有两条供应线路。跨平台查找按 300 毫秒间隔启动，某个平台明确失败时立即推进。已有可播结果时，给仍在查找的高顺位平台最多 1.6 秒。YouTube Music 的搜索和下载分开，下载优先使用 VPS 已有文件。

`gateway-music-card.patch` 将分享和卡片试听接入同版录音匹配。分享先复用完整音频，写入时核验大小与音频文件头；只有分享文件准备好才返回成功。网关在房间收消息前复核地址，兼容旧客户端。候选发布使用本目录的 `deploy-music.sh --check`。

- 可信跨平台匹配在 SQLite 保存 30 天，记录曲目身份和匹配规则版本。公开歌单在启动后 90 秒处理首批，之后每 30 分钟最多试 8 首。设置 `CHAT_MUSIC_PREMATCH=0` 可停用后台预匹配。
- 手动点歌优先播放同一录音。暂未找到原曲时可确认进入搜索，临时取链失败不弹版本选择。

歌手跨语言匹配先使用本地别名和曲库的歌手资料。歌名、版本与时长吻合但单人署名跨文字体系时，再查询 MusicBrainz 的艺名别名。请求按进程合并并限为每 1.1 秒最多一次，成功的映射保存 30 天。同一连接连续点歌时并行找音源，按点击顺序入队。超过两秒的曲库搜索或音频解析会在 VPS 留下 `[MusicLookup]` 阶段计时。

## 聊天图片尺寸

`gateway-image-dimensions.patch` 针对当前 VPS 网关入口制作。发布候选先对网关备份运行 `git apply --check`，把 `src/chat-image-dimensions.mjs` 与网关补丁同时纳入候选，并测试历史分页与 Matrix 双向收发。新附件的宽高沿用消息的 `attachments_json`。

历史分页仍读取网关从消息 JSON 加载的记录。旧图尺寸可先在数据副本上回填。脚本需要支持 AVIF 的 Pillow，默认试探最近最多 50 个未缓存 URL，指定 `--write` 才写独立的 `chat_image_dimensions.json`。它按 URL 去重、串行请求、不跟随重定向，不改消息数据。可用 `--offset` 跳过连续失效的旧链接。每次只运行一份回填脚本。

```sh
python3 scripts/backfill-chat-image-dimensions.py /path/to/chat-data-copy \
  --allow-host img.lengxiqwq.com --allow-host chat-server.lengxiqwq.com \
  --allow-host chat-api.lengxiqwq.com --write
```

发布时将生成的尺寸文件随网关候选放到数据目录。网关启动时读取该文件，并在历史分页中附带尺寸。
站长可以按房间关闭歌单轮播、随机播放全部公开歌单，或指定一份公开歌单。没有开启轮播时，待播队列播完后点歌台进入空闲。

## 浏览器推送

生产网关需要固定版本依赖 `web-push@4.0.0`。针对当前网关先校验并应用 `gateway-web-push.patch`，将 `src/web-push.mjs` 安装到网关的 `src/notify/web-push.mjs`，然后运行 `node --check server.mjs`。先发布网关并检查 `GET /api/chat/push/config`，再发布静态站。生产站和本地开发的浏览器订阅按网站来源隔离。

网关首次启动在数据目录生成 `web-push-vapid.json`，订阅写入 `web-push-subscriptions.json`。这两个文件随服务保留并按私密数据备份。更换 VAPID 密钥后，已启用的浏览器需要重新订阅。回滚时恢复网关入口并重启，保留数据文件。

定向回归用 `node --test chat-server/test/web-push.test.mjs`。送达验收从「个人资料 → 浏览器推送」启用，在对应浏览器点击「发送测试推送」，并用第二个账号验证关掉本站标签页后仍能收到实际聊天消息。

## Matrix 媒体和回复引用

`gateway-matrix-media.patch` 对应当前 VPS 网关。候选发布目录需包含 `src/matrix-media.mjs` 和 `src/chat-attachment-kind.mjs`。先对当前入口的副本执行 `git apply --check`，应用后用 `node --check server.mjs` 校验。两个模块可用 `node --test chat-server/test/matrix-media.test.mjs` 验证。发布时先更新网关，再更新静态站。历史媒体地址和消息文件无需迁移，旧引用会在读取时从原消息恢复附件类型。

发布验收时，用同一张联邦 PNG 检查消息小图与原图，用同一段联邦 MP4 检查起播和拖动。在网站回复这个视频后，核对网站和 Element 的引用均指向同一条视频。若需回滚，恢复备份中的网关入口和静态站版本。

## Lottie 贴纸预览

`gateway-lottie-preview.patch` 对应当前 VPS 网关。Matrix 出站贴纸只能携带一张图片，不能直接引用 Lottie JSON；旧逻辑把 1152×960 的 `preview-sprite.webp` 合集图当成一枚贴纸上载，Element 等客户端会显示整张表情墙。

现在的取图顺序（`resolveSingleSticker` 返回 `candidates` 逐个尝试，成功即停）：

1. **GIF 动图（首选）**：`https://lengxiqwq.com/assets/stickers/lottie/<name>.gif`，由 `pnpm lottie:render`（`scripts/render-lottie-stickers.mjs`）离线渲染，产物提交在内容仓 `public/assets/stickers/lottie/`，随静态站发布。渲染用本机 Chrome/Edge + lottie-web + ffmpeg，输出 192×192、15fps 的 GIF（与互联大厅里其他站点的做法一致，所有客户端都能直接播放），只在表情包变动时手动执行，构建流程不会调用。
2. **旧版 WebP 动图（过渡）**：同一目录的 `<name>.webp`。静态站尚未发布新 GIF 时用它，保证发送出来的仍是动图而不是静态首帧。
3. **静态兜底**：以上都缺失或上传失败时，改用网关的 `GET /api/lottie/:name.webp`——按 `LOTTIE_SPRITE_KEYS` 的格子顺序（12 列、每格 96px）用 ffmpeg 从 `data/lottie_cache/preview-sprite.webp` 裁单格并放大到 192×192，缓存进 `data/lottie_cache/lottie_preview/`。走兜底时事件里的 `info.mimetype` 会自动改成 `image/webp`。

`server.mjs` 里的 `LOTTIE_SPRITE_KEYS` 必须与 `src/components/pages/chat/stickerLoader.ts` 的同名数组保持一致，增删或调整表情顺序时要同时更新两处，并重新跑一次 `pnpm lottie:render`。

出站 `m.sticker` 只在拿到真实 `mxc://` 时才发送；三步都失败时退回文字短码，不再发送占位的假 mxc 地址。网关侧依赖 VPS 自带 `/usr/bin/ffmpeg`（含 libwebp），可用 `curl -I https://chat-server.lengxiqwq.com/api/lottie/aini.webp` 验收兜底图。历史消息里已经上载的合集图不会自动修正。
### Matrix 房间动态

`gateway-matrix-room-activity.patch` 配合 `src/matrix-room-activity.mjs` 发布。补丁将 Matrix 实时事件及历史翻页中的房间动态写入互联茶室时间线。新版网关启动时检查最近三页 Matrix 历史，每页最多 100 个事件。发布候选先在当前网关入口副本校验补丁，再运行 `node --check server.mjs`。
