@echo off
cd /d "%~dp0"
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0dev.ps1"
if errorlevel 1 (
    echo.
    pause
)
