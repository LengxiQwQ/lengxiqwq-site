---
title: "PlaylistOut"
slug: playlistout
published: 2025-10-01
draft: false
order: 90
description: "跨平台歌单解析与多格式导出工具。支持 QQ 音乐（含批量导出）、网易云、酷狗与汽水音乐；支持 TXT / CSV / Excel / JSON 格式与剪贴板复制，并提供本地 CLI 工具与对外开放的歌单 JSON 解析 API。"
image: ""
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
    value: "https://playlistout.com"
lang: "zh_CN"
---

## ✦ 项目简介

**PlaylistOut** 是一个现代化、轻巧高效的跨平台歌单解析与导出全栈工具。

最初为了解决个人歌单在各音乐客户端之间迁移备份繁琐的痛点，该项目从最初的 Python 自动化脚本演进为包含现代 Web 界面、无服务器边缘云函数、本地 CLI 终端工具以及开放 API 服务的完整产品形态。

---

## ✦ 核心特性

- **多平台广泛兼容**：支持 QQ 音乐（含批量歌单导出）、网易云音乐、酷狗音乐、汽水音乐等主流流媒体平台。
- **全格式导出支持**：支持导出为 TXT、CSV、Excel (`.xlsx`) 以及 JSON 数据文件，同时提供一键复制歌单文本到剪贴板功能。
- **隐私保护与本地计算**：导出文件全部由客户端纯内存即时组装生成，无敏感个人信息存储或留存。
- **开放生态与开发者友好**：
  - 提供跨平台的本地命令行脚本（CLI），方便批量操作。
  - 对外提供公开稳定的歌单解析 RESTful API，直接返回结构化 JSON 音乐列表，方便二次开发。
