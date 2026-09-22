---
title: "Live Photo Box"
slug: live-photo-box
published: 2026-03-01
draft: false
order: 100
description: "Windows 上的实况照片工具箱，用来合成、拆分、转换、修复和编辑不同品牌与平台的 Live Photo / Motion Photo。处理过程中会尽量保留 HDR、EXIF、拍摄参数和原始媒体内容。"
image: "./images/live-photo-box.webp"
status: "developing"
tags:
  - C#
  - C++
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

## ✦ 这是做什么的？

不同品牌的实况照片看起来都像“一张会动的照片”，底层格式却并不统一。iPhone 常见的是图片 + 视频双文件，Android 各家又有自己的单文件封装和协议。文件换到另一台设备或另一个平台后，就可能出现只能看到静态图、无法播放、方向异常，或者元数据丢失的问题。

**Live Photo Box** 是我做的一个 Windows 实况照片工具箱，专门处理这些麻烦事。它可以把实况照片进行**合成、拆分、格式 / 协议转换、修复和编辑**，也支持批量处理。

转换时会尽量保留照片原本的信息，包括 HDR、EXIF、相机参数、拍摄信息和原始媒体内容，而不是为了“能播放”就把原图重新压一遍。

## ✦ 现在能做什么？

#### 🔗 合成实况照片

把图片 + 视频组合成单文件实况照片，也可以批量扫描文件夹、自动配对后一起处理。

  | 合成协议                   | 支持设备                           | 状态     |
  | -------------------------- | ---------------------------------- | -------- |
  | Google - Micro Video (v1)  | Windows / 小米 (旧版 MIUI) / Pixel | ✅ 可用   |
  | Google - Motion Photo (v2) | Windows / 小米 / Pixel             | ✅ 可用   |
  | OPPO - O-Live Photo        | Windows / 小米 / OPPO              | ✅ 可用   |
  | HUAWEI - Moving Photo      | 华为 / 荣耀                        | ✅ 可用   |
  | Samsung - Motion Photo     | Windows / Samsung                  | ✅ 可用   |
  | vivo - Live Photo          | Windows / vivo（≥ x300）           | 🟡 测试中 |

#### 📸 拆分实况照片

把单文件实况照片拆回图片与视频，或输出成 Apple / vivo 等双文件形式。

  | 拆分协议           | 支持机型       | 状态   |
  | ------------------ | -------------- | ------ |
  | Apple - Live Photo | iPhone / iPad  | ✅ 可用 |
  | vivo - Live Photo  | vivo（≤ x200） | ✅ 可用 |

- **修复 Apple 实况照片**：处理导出后常见的方向、拉伸、缩略图等显示异常。

- **编辑封面帧**：从视频时间轴里重新选择 Live Photo 的 Key Photo，也可以导出单帧、视频或 GIF。

- **批量任务与命名**：支持自动配对、批量队列、命名模板以及完成后的文件整理。

- **GUI + CLI**：除了桌面界面，也提供 `livephotobox` 命令行工具，方便脚本、批处理和自动化调用。

> iPhone / iPad 对 Live Photo 的导入有系统限制。Live Photo Box 可以生成对应的数据，但导入 iOS 设备仍需要借助第三方工具。

## ✦ 底层现在在改什么？

早期版本里，媒体与元数据处理需要调用 ExifTool 等外部工具。现在开发分支正在把这些职责逐步迁移到 **LivePhotoBox.Native**，一个 C++20 原生核心。

GUI、CLI 和应用流程仍主要由 C# 负责；更底层的媒体容器、元数据和实况照片协议处理则逐步下沉到 C++。希望批量处理更稳定、调用链更简单，也方便以后继续扩展新的协议和平台。在最近的实测中发现，媒体文件处理速度比重构前快了30倍！

目前已发布版本与开发分支的底层实现并不完全相同，具体支持情况以项目 README 和最新 Release 为准。
