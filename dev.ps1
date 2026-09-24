#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Start the dev server with automatic content cleanup on exit.
.DESCRIPTION
    Equivalent to pnpm dev, but automatically runs content:reset
    when the dev server is stopped (Ctrl+C or closing the terminal).
.EXAMPLE
    .\dev.ps1
#>

$ErrorActionPreference = 'Continue'

Push-Location $PSScriptRoot

try {
    Write-Host ""
    Write-Host "  [dev] " -ForegroundColor Cyan -NoNewline
    Write-Host "Syncing content from content repo..."
    & pnpm exec tsx scripts/sync-content.ts
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [dev] Content sync failed, check errors above." -ForegroundColor Red
        Pop-Location
        exit 1
    }

    Write-Host ""
    Write-Host "  [dev] " -ForegroundColor Cyan -NoNewline
    Write-Host "Starting dev server..."
    Write-Host "  [dev] " -ForegroundColor DarkGray -NoNewline
    Write-Host "Press Ctrl+C or close the terminal to stop. Content will be auto-reset." -ForegroundColor DarkGray
    Write-Host ""

    & pnpm exec astro dev
}
finally {
    Write-Host ""
    Write-Host "  [dev] " -ForegroundColor Yellow -NoNewline
    Write-Host "Cleaning up, resetting to clean template state..."

    & pnpm exec astro dev stop 2>$null

    & pnpm exec tsx scripts/reset-content.ts
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [dev] Done. Repo restored to clean template preset." -ForegroundColor Green
    }
    else {
        Write-Host "  [dev] Auto-reset failed. Run manually: pnpm content:reset" -ForegroundColor Red
    }

    Pop-Location
}
