# VPS 点歌台维护

线上网关入口是 `/opt/chat-server/server.mjs`。本目录保存点歌台模块和网关集成补丁。网关的 Matrix、Waline 等生产配置保存在 VPS。

- 模块回归用 `node --test chat-server/test/music.test.mjs`。
- 网关回归用 `CHAT_GATEWAY_MODULES=/opt/chat-server/node_modules node test/gateway-regression.mjs <已应用补丁的网关文件> .`。测试使用临时目录和模拟上游。
- 将本目录上传到 VPS 的独立发布目录后，先运行 `bash deploy-music.sh --check`，再运行 `bash deploy-music.sh --deploy`。首次发布会从在运行的网关保存每房队列。脚本会备份旧入口和模块，启动检查失败时恢复旧代码。
- 发布脚本锁定了这次使用的网关版本。再次发布时，先根据 VPS 当前入口重新核对和更新集成补丁及校验值。

用户歌单全站共享，精选和轮播配置按房间保存。播放、待播队列与点歌历史也分别按房间保存。
站长可以按房间关闭冷场轮播、随机播放全部公开歌单，或指定一份公开歌单。没有开启轮播时，待播队列播完后点歌台进入空闲。
