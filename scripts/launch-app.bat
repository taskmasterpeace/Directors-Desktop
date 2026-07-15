@echo off
rem Launches Directors Desktop (Vite + Electron + Python backend).
rem Double-click the "Directors Desktop" shortcut (created by
rem scripts\create-shortcut.ps1) rather than running this directly —
rem the shortcut starts it minimized with the app icon.
title Directors Desktop
cd /d "%~dp0.."

where pnpm >nul 2>nul
if errorlevel 1 (
    echo pnpm was not found on PATH. Install Node + pnpm, then try again.
    pause
    exit /b 1
)

echo Starting Directors Desktop...
call pnpm dev
if errorlevel 1 (
    echo.
    echo Directors Desktop exited with an error. See the output above.
    pause
)
