# 待播歌曲切播投票候选

基于 2026-11-19 获取的线上网关代码制作，同日已部署。`music-manager.patch` 和 `server.patch` 需一起应用；应用前必须重新核对线上版本与其他待部署的音乐同步改动，避免覆盖。

线上 music-manager.mjs 基线 SHA-256：`a7661bc5033053f208d31f8868415ca1e452d834b5a949686ba8671656313fc4`。

验证：`node --test scripts/chat-queue-vote-candidate/regression.test.mjs`。
