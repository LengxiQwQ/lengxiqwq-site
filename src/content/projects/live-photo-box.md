---
title: "Live Photo Box"
slug: live-photo-box
published: 2026-03-01
draft: false
order: 100
description: "面向 Windows 的现代化实况照片处理工具。告别依赖外部命令行工具的旧模式，自主手写解析各大厂商实况照片协议，底层媒体处理全由 C++ 原生库驱动，实测速度提升近 30 倍，实现多品牌与平台间自由无损互转。"
image: ""
status: "developing"
tags:
  - C++
  - C#
  - WinUI 3
  - Windows App SDK
  - CLI
link:
  - label: "GitHub"
    icon: "fa7-brands:github"
    value: "https://github.com/LengxiQwQ/live-photo-box"
  - label: "官网"
    icon: "material-symbols:link"
    value: "https://livephotobox.lengxiqwq.com"
lang: "zh_CN"
---

## ✦ 项目简介

**Live Photo Box** 是一款专为 Windows 平台打造的现代化实况照片 (Live Photo) 处理与格式互转利器。

在传统方案中，Windows 下的实况照片处理通常依赖调用庞大的外部命令行工具（如 `exiftool` 等子进程）进行元数据注入与封装，不仅容易因进程间通信开销导致吞吐效率低下，还时常出现因环境差异导致的隐性转换缺陷。

为了彻底突破这一瓶颈，**Live Photo Box** 进行了底层深度重构：抛弃外部命令行工具进程依赖，全面纯手写自研解析主流厂商（Apple、OPPO、vivo、Xiaomi 等）的实况照片元数据封装格式与时序协议，底层媒体提取与合成全面由 **C++ 原生库** 驱动，实测吞吐处理速度提升接近 **30 倍**！

---

## ✦ 核心特性

- **高性能原生驱动**：核心数据通路与媒体编码由自研 C++ 模块处理，摆脱外部 CLI 进程调用瓶颈，兼备极速吞吐与低资源占用。
- **现代美观 UI 交互**：基于最新的 **WinUI 3** 与 **Windows App SDK** 开发，完美融入 Windows 11 Fluent Design 与深色模式。
- **跨品牌格式互转**：自主兼容并掌控各大主流手机品牌的实况照片格式标准，实现无损互转与导出。
- **双模态支持**：同时提供图形化桌面客户端（GUI）与自动化命令行工具（CLI），兼顾普通日常用户与极客批处理需求。
