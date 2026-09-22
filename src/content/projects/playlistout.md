---
title: "Playlist Out"
slug: playlistout
published: 2025-10-01
draft: false
order: 90
description: "把 QQ 音乐、网易云音乐、酷狗音乐和汽水音乐的歌单解析成可以带走的数据，支持 TXT / CSV / Excel / JSON 导出、批量歌单、剪贴板复制、本地 CLI 和开放 API。可以用于导入开源音乐软件或者国外流媒体平台（通过 turn my song 等应用）"
image: "./images/playlistout.webp"
status: "published"
tags:
  - TypeScript
  - React
  - Cloudflare Workers
  - Open API
  - CLI
link:
  - label: "GitHub"
    icon: "fa7-brands:github"
    value: "https://github.com/LengxiQwQ/playlistout"
  - label: "官网"
    icon: "material-symbols:link"
    value: "https://playlistout.lengxiqwq.com"
lang: "zh_CN"
---

## ✦ 这是做什么的？

**Playlist Out** 用来把音乐平台里的歌单导出来。

平时换音乐软件、备份歌单，或者想把几百上千首歌整理成表格时，最麻烦的不是音乐本身，而是歌单数据很难完整拿出来。PlaylistOut 做的事情很直接：**粘贴歌单链接或用户主页，解析歌曲列表，然后把数据导成你自己能保存、整理和继续使用的格式。**

它不下载音乐，也不是播放器。重点就是把歌单里的歌曲名、歌手、专辑、状态等信息整理出来，方便备份、迁移和二次处理。

通过 turn my song 等应用，可以用于导入开源音乐软件或者国外流媒体平台，例如 Apple Music、Spotify 等。

## ✦ 现在能做什么？

- **多个音乐平台**：支持 QQ 音乐、网易云音乐、酷狗音乐和汽水音乐，后续考虑支持更多。
- **单歌单与批量歌单**：除了一个歌单，也可以读取 QQ 音乐、网易云等用户主页里的公开歌单并批量导出。
- **多种导出格式**：支持 TXT、CSV、Excel（`.xlsx`）和 JSON，也可以直接复制到剪贴板。
- **大歌单处理**：针对长歌单做了分页和完整性处理，尽量避免只拿到前几十或前几百首。
- **歌曲状态信息**：导出时可以保留 VIP、下架 / 无版权等状态，方便迁移前检查。
- **酷狗授权**：由于酷狗音乐限制，公开预览只能读取歌单10首歌曲，需要通过扫码取得临时凭据来读取完整歌单。
- **开放 API**：提供统一的歌单解析 API，第三方工具或脚本可以直接拿结构化 JSON。
- **本地 CLI**：除了网页，也提供命令行方式，方便批处理和自动化。

导出文件是在浏览器本地生成的，不需要把生成好的 Excel、CSV 或 JSON 再上传到服务器保存。

## ✦ 为什么会有这个项目？

最开始它只是我为了导出 QQ 音乐歌单写的一个 Python 小脚本。

后来发现“歌单被困在某个平台里”并不只是 QQ 音乐的问题，所以才慢慢把它做成现在这个网站，并继续补上其他平台、批量导出、API 和 CLI。最终目标也很简单：**先把自己的歌单数据完整拿出来，后面不管是备份、整理，还是交给别的迁移工具，都更自由一点。**
