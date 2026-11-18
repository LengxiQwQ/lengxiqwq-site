# 聊天室音乐同步发布记录（2026-11-19）

## 本次发布

后端在一次切歌时确定未来 2 秒的起播时间并广播；客户端按统一时间轴自行对齐，不等待设备 ready 回执，不轮询设备进度。旧客户端正在收听时保留立即起播兼容路径，刷新升级后采用新的起播方式。

前端新增独立播放控制器和单调时钟校准，支持下一首预载、省流量模式、微调速率、受控追赶、有限重试和明确的播放状态。服务端复用并发预取，拆分首包与传输空闲超时，单设备报错不再触发全房跳歌；同地址恢复也广播新版本让客户端重新加载。

已保留部署前刚上线的点歌投票、插播和点歌统计修复，未修改内容仓、消息数据和身份数据。

## VPS 部署

本轮已授权部署，5 个文件已安装并重启 chat-server，健康检查通过：

- server.mjs（仅修改音乐集成代码，完整文件包含私密配置，不入公开仓）
- src/music/music-manager.mjs
- src/music/stream-cache.mjs
- src/music/registry.mjs
- src/music/stream-timeouts.mjs

线上备份：`/opt/chat-server/releases/music-sync-20261119-v1/backup`。
部署基线为 baseline-sha256.json，安装前已复核哈希。部署包中的 deploy.py 会在首次健康检查失败时自动恢复备份。本地有效候选为被 Git 忽略的 `.temp-chat-music-release-v2/`；此前 `.temp-chat-music-final/` 等旧候选禁止用于上线。

后续回退需恢复该备份中的同名文件并重启 chat-server；新前端兼容旧后端。不要改写 data 目录。重复发布先获取新的线上快照并刷新基线，不能重复套用旧基线。

## 已执行验证

- 14 项逻辑回归、1 项内存传输集成测试通过。
- 类型检查、新核心 Biome 检查通过；修改的 4 个 Svelte 组件纯内存编译通过。
- 合并后的 4 个投票/队列方法与部署前线上实现逐字相同。
- 部署后两个房间均返回 v2 状态和带标识的校时 pong；当前有歌的互联房间签名音频返回准确的 Range 206、1024 字节且命中缓存。
- 独立 Chromium 页面已验证真实播放器共同起播与追赶；同浏览器两音频元素的少量测试不是跨设备、跨网络性能承诺。

验证命令（不启动开发服务或运行站点构建）：

```powershell
pnpm type-check
pnpm exec tsx --test scripts/chat-music-sync/regression.test.mjs
pnpm exec node --experimental-vm-modules --test scripts/chat-music-sync/transport.test.mjs
pnpm exec node scripts/chat-music-sync/smoke.mjs
```

## 仍有的边界

本次是同步和稳定性改进版本，不能宣称近乎完美体验已经验收。尚未完成上一首结束前的完整起播安排与旧曲持续播放，因此不是无缝衔接；当前网络准备余量固定为 2 秒，慢设备仍可能需要追赶。稳定媒体版本缓存键、全链路指标、按真实地区网络调参、完整命令 ID 幂等协议尚未实现。

Safari/Android 真机、锁屏恢复、国内外实际网络、连续切歌 P95 和声学同步仍待验证。没有新增 CDN、地区分流或改变音源提供方。缓存等待超过 2.5 秒后仍有独立上游回退，不保证所有情况下只有一次下载。

## 候选工具

prepare-candidate.mjs 校验传入本地快照的哈希并生成私密覆盖目录，拒绝覆盖既有目录；它不会上传或重启。server-integration.mjs 使用精确匹配修改网关，不处理聊天、Matrix 或私密配置。browser-fixture.mjs 将真实 MusicPanel 和隔离数据在内存中打包，用于无线上副作用的浏览器检查。
