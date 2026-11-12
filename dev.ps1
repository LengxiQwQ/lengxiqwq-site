#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Start the dev server (LAN-accessible, auto-open localhost) with automatic content cleanup on exit.
.DESCRIPTION
    Equivalent to pnpm dev --open, exposing the dev server to the local network (--host),
    automatically opening http://localhost:4321/ in the default browser, and running
    content:reset when the dev server is stopped (Ctrl+C or closing the terminal).
.EXAMPLE
    .\dev.ps1
#>

$ErrorActionPreference = 'Continue'

Push-Location $PSScriptRoot

function Test-LocalTcpPort {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetHost,
        [Parameter(Mandatory = $true)]
        [int]$Port,
        [int]$TimeoutMs = 250
    )

    $client = $null
    try {
        $ip = [System.Net.IPAddress]::Parse($TargetHost)
        $client = New-Object System.Net.Sockets.TcpClient($ip.AddressFamily)
        $async = $client.BeginConnect($ip, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
            return $false
        }
        $client.EndConnect($async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($null -ne $client) {
            $client.Dispose()
        }
    }
}

function Get-RunningDevPort {
    $candidates = @(
        (Join-Path $PSScriptRoot ".dev.lock"),
        (Join-Path $PSScriptRoot ".astro\dev.json")
    )

    foreach ($lockFile in $candidates) {
        if (Test-Path $lockFile) {
            try {
                $data = Get-Content -Path $lockFile -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($null -ne $data.port) {
                    $parsedPort = [int]$data.port
                    if ($parsedPort -ge 1 -and $parsedPort -le 65535) {
                        return $parsedPort
                    }
                }
            }
            catch {
                # Ignore malformed lock files and fall back
            }
        }
    }

    return 4321
}

$serverStarted = $false
try {
    Write-Host ""
    Write-Host "  [dev] " -ForegroundColor Cyan -NoNewline
    Write-Host "Syncing content from content repo..."
    & pnpm exec tsx scripts/sync-content.ts --for-dev
    if ($LASTEXITCODE -ne 0) {
        $runningPort = Get-RunningDevPort
        $isListening = (Test-LocalTcpPort -TargetHost "127.0.0.1" -Port $runningPort) -or (Test-LocalTcpPort -TargetHost "::1" -Port $runningPort)
        if ($isListening) {
            $localUrl = "http://localhost:$runningPort/"
            Write-Host "  [dev] " -ForegroundColor Green -NoNewline
            Write-Host "Dev server is already running at $localUrl"
            if ($args -notcontains "--no-open") {
                Write-Host "  [dev] " -ForegroundColor Cyan -NoNewline
                Write-Host "Opening $localUrl in default browser..."
                Start-Process $localUrl
            }
            Start-Sleep -Seconds 2
            exit 0
        }

        Write-Host "  [dev] Content sync was aborted or failed." -ForegroundColor Yellow
        exit 1
    }

    Write-Host ""
    Write-Host "  [dev] " -ForegroundColor Cyan -NoNewline
    Write-Host "Starting dev server (LAN enabled, auto-opening localhost)..."
    Write-Host "  [dev] " -ForegroundColor DarkGray -NoNewline
    Write-Host "Press Ctrl+C or close the terminal to stop. Content will be auto-reset." -ForegroundColor DarkGray
    Write-Host ""

    $astroArgs = @("--host")
    if ($args -notcontains "--no-open") {
        $astroArgs += "--open"
    }

    $serverStarted = $true
    & pnpm exec astro dev @astroArgs @args
}
finally {
    if ($serverStarted) {
        Write-Host ""
        Write-Host "  [dev] " -ForegroundColor Yellow -NoNewline
        Write-Host "Cleaning up, resetting to clean template state..."

        # 短暂休眠以确保 Node.js / Astro 进程完全释放端口与 Windows 文件锁
        Start-Sleep -Milliseconds 300

        # 带上 --force，防止 reset-content 误判端口残留而跳过重置
        & pnpm exec tsx scripts/reset-content.ts --force
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [dev] Done. Repo restored to clean template preset." -ForegroundColor Green
        }
        else {
            Write-Host "  [dev] Auto-reset skipped or failed." -ForegroundColor Yellow
        }

        Pop-Location
        # 显式正常退出，避免外层 bat 误判非零中断码而挂起 pause
        exit 0
    }
    Pop-Location
}
