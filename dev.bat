@echo off
chcp 65001 >nul
title LengxiQwQ 个人站点 - 本地开发服务

echo =======================================================
echo   正在启动 LengxiQwQ 个人站点本地开发服务...
echo =======================================================
echo.

cd /d "%~dp0"

echo [1/2] 同步私有内容仓 (lengxiqwq-site-content)...
call pnpm content:sync
if errorlevel 1 (
    echo [警告] 内容同步遇到问题，将尝试直接启动开发服务...
)

echo.
echo [2/2] 正在启动 Astro 本地服务并自动打开浏览器...
echo 本地访问地址: http://localhost:4321/
echo 如需关闭服务，直接关闭本窗口或按 Ctrl + C 即可。
echo.

call pnpm dev --open

if errorlevel 1 (
    echo.
    echo 服务异常退出，请检查上方错误提示。
    pause
)
