@echo off
rem Launcher for Douga.
rem
rem This file is kept ASCII-only on purpose. cmd.exe reads a batch file using
rem the system's OEM code page, not the one set by "chcp", so non-ASCII bytes
rem can shift the parser and make it run part of a comment as a command.
rem Japanese messages live in .\messages\*.txt and are printed with "type",
rem whose content cmd never parses.

chcp 65001 >nul
setlocal
cd /d "%~dp0app"

title Douga

where node >nul 2>nul
if errorlevel 1 (
  type "%~dp0messages\node-missing.txt"
  pause
  exit /b 1
)

rem The in-app updater cannot reinstall packages while it is running,
rem so it leaves this marker behind for us to pick up.
if exist ".deps-stale" (
  type "%~dp0messages\setup-deps.txt"
  call npm install
  if errorlevel 1 (
    type "%~dp0messages\setup-failed.txt"
    pause
    exit /b 1
  )
  del ".deps-stale" >nul 2>nul
)

if not exist "node_modules" (
  type "%~dp0messages\setup-first.txt"
  call npm install
  if errorlevel 1 (
    type "%~dp0messages\setup-failed.txt"
    pause
    exit /b 1
  )
)

rem When npm blocks install scripts, Electron's binary is never downloaded
rem and the app cannot start. Try to fetch it before giving up.
if not exist "node_modules\electron\dist" (
  type "%~dp0messages\electron-prepare.txt"
  call npm rebuild electron
)

if not exist "node_modules\electron\dist" (
  type "%~dp0messages\electron-missing.txt"
  pause
  exit /b 1
)

type "%~dp0messages\starting.txt"

npm start

if errorlevel 1 (
  type "%~dp0messages\start-failed.txt"
  pause
)

endlocal
