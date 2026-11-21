# VPS 点歌台维护

线上网关入口是 `/opt/chat-server/server.mjs`。本目录保存点歌台模块和网关集成补丁。网关的 Matrix、Waline 等生产配置保存在 VPS。

- 模块回归用 `node --test chat-server/test/music.test.mjs`。
- 网关回归用 `CHAT_GATEWAY_MODULES=/opt/chat-server/node_modules node test/gateway-regression.mjs <已应用补丁的网关文件> .`。测试使用临时目录和模拟上游。
- 将本目录上传到 VPS 的独立发布目录后，先运行 `bash deploy-music.sh --check`，再运行 `bash deploy-music.sh --deploy`。首次发布会从在运行的网关保存每房队列。脚本会备份旧入口和模块，启动检查失败时恢复旧代码。
- 发布脚本锁定了这次使用的网关版本。再次发布时，先根据 VPS 当前入口重新核对和更新集成补丁及校验值。

用户歌单全站共享，精选和轮播配置按房间保存。播放、待播队列与点歌历史也分别按房间保存。

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
