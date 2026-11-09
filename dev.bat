@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: 通过重定向 <nul，使 cmd.exe 在接收到 Ctrl+C 时自动获取 EOF 并干净退出，
:: 彻底根除 "终止批处理操作 (Y/N)?" / "Terminate batch job (Y/N)?" 弹窗询问！
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0dev.ps1" <nul
set "EXIT_CODE=%errorlevel%"

:: 仅当启动或同步异常失败时（且非用户主动 Ctrl+C 退出），才暂停以供排查错误
if %EXIT_CODE% neq 0 (
    if %EXIT_CODE% neq 130 (
        echo.
        echo [dev.bat] 进程异常退出 (退出码: %EXIT_CODE%^)
        pause
    )
)
exit /b %EXIT_CODE%
