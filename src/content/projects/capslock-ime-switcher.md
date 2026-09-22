---
title: "CapsLock IME Switcher"
slug: capslock-ime-switcher
published: 2025-11-01
draft: false
order: 80
description: "一个 Windows 输入法切换小工具：短按 CapsLock 切换中英文，长按仍然保留原本的大小写切换。基于 AutoHotkey v2，并提供多个版本适配不同使用环境。"
image: "./images/capslock-ime-switcher.webp"
status: "published"
tags:
  - AutoHotkey
  - Windows
  - Utility
link:
  - label: "GitHub"
    icon: "fa7-brands:github"
    value: "https://github.com/LengxiQwQ/capslock-ime-switcher"
lang: "zh_CN"
---

## ✦ 这是做什么的？

我一直很喜欢用 **CapsLock 直接切换中英文** 这种操作方式，但 Windows 上常见的 `Shift`、`Ctrl + Space`、`Win + Space` 在不同软件里体验并不总是一致，有时还会和 IDE、终端或游戏快捷键冲突。

所以我写了 **CapsLock IME Switcher**：

- **短按 CapsLock**：切换中文 / 英文输入法。
- **长按 CapsLock**：继续保留原本的大小写切换。
- **状态提示**：部分版本会在光标附近显示当前输入状态。
- **多个版本**：针对稳定性、多输入法识别、无提示、原生 `Win + Space` 切换等不同需求分别提供脚本。
- **AHK + EXE**：可以直接运行打包好的 EXE，也可以自己修改 AutoHotkey v2 源码。

这个脚本不复杂，主要是自己想用，然后就写出来了。不过现在发现缺点也有一些，后面可能会做更深入的版本。
