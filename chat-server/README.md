# VPS 点歌台维护

线上网关入口是 `/opt/chat-server/server.mjs`。本目录保存点歌台模块和网关集成补丁。网关的 Matrix、Waline 等生产配置保存在 VPS。

- 模块回归用 `node --test chat-server/test/music.test.mjs`。
- 网关回归用 `CHAT_GATEWAY_MODULES=/opt/chat-server/node_modules node test/gateway-regression.mjs <已应用补丁的网关文件> .`。测试使用临时目录和模拟上游。
- 将本目录上传到 VPS 的独立发布目录后，先运行 `bash deploy-music.sh --check`，再运行 `bash deploy-music.sh --deploy`。首次发布会从在运行的网关保存每房队列。脚本会备份旧入口和模块，启动检查失败时恢复旧代码。
- 发布脚本锁定了这次使用的网关版本。再次发布时，先根据 VPS 当前入口重新核对和更新集成补丁及校验值。

用户歌单全站共享，精选和轮播配置按房间保存。播放、待播队列与点歌历史也分别按房间保存。

## 轮播换源与替代版本

先发布网关，再发布静态站。网关保留旧版手动轮播指令，新版根据轮播条目 ID 请求播放。只有发起者会收到候选回执，确认后才向房间广播实际播放的曲目。候选在 90 秒后失效，换房、轮播设置或播放状态变化也会使旧的轮播确认失效。歌单、搜索、收藏和历史的点歌共用同一个网关入口，缺少原始音源时会返回候选，确认后按正常点歌规则入队或立即播放。

从新版起，发布脚本会对当前线上基线应用 `rotation-fallback.patch` 并校验结果。针对当前线上版本，只替换轮播管理、匹配器和 QQ 音乐提供器，沿用在线的流缓存、签名和超时模块。`request-fallback.patch` 在轮播补丁上加上点歌入口。随机点歌由 `random-request.patch` 接入网关，可在同一歌单内重新抽取，或使用同曲、同歌手且版本一致的可播匹配。其他网关版本出现冲突时，先核对线上入口，再更新补丁和对应校验值。

验证通过的同版本匹配会短期缓存。手动确认的选择使用现有 SQLite KV，按用户和来源曲目保存 QQ 曲目资料。再次点歌先复核已选音源，失败时重新匹配。两类记录均不存音频链接。

## 多音源

多音源网关集成由 `multi-source.patch` 提供。已启用的原生平台优先按曲目 ID 取源。首选没有可靠结果或超过 450 毫秒时启动其余已启用音源，低顺位拿到可播录音时最多额外给高顺位 350 毫秒。所有查询共享入口传入的总预算。

- 网易云默认开启，可设置 `CHAT_MUSIC_ENABLE_NETEASE=0` 关闭。只沿官方外链取 CDN 音源，要求支持 HTTP Range 并验证音频头。
- 酷狗默认关闭。确认搜索和音源都能在当前部署地域稳定使用后，可设置 `CHAT_MUSIC_ENABLE_KUGOU=1`。
- 可信跨平台匹配在 SQLite 保存 30 天，记录曲目身份和匹配规则版本。公开歌单在启动后 90 秒处理首批，之后每 30 分钟最多试 8 首。设置 `CHAT_MUSIC_PREMATCH=0` 可停用后台预匹配。
- 手动点歌的版本面板可跳转官方 YouTube 搜索。配置 `YOUTUBE_DATA_API_KEY` 后，面板也可通过官方接口按需列出候选视频，用户点击后前往 YouTube 播放。

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
