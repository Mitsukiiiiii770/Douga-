@echo off
rem Douga をダブルクリックで起動するためのランチャー。
rem 初回だけ依存パッケージの取得が走るので数分かかる。

chcp 65001 >nul
setlocal
cd /d "%~dp0app"

title Douga

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js が見つかりませんでした。
  echo   https://nodejs.org から LTS 版をインストールしてから、
  echo   もう一度このファイルを開いてください。
  echo.
  pause
  exit /b 1
)

rem 自動更新で依存パッケージが変わると、アプリ自身は入れ直せないので
rem 印だけ残してある。ここで拾って入れ直す。
if exist ".deps-stale" (
  echo.
  echo   更新された部品を準備しています。数分かかります...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   準備に失敗しました。上のメッセージを確認してください。
    echo.
    pause
    exit /b 1
  )
  del ".deps-stale" >nul 2>nul
)

if not exist "node_modules" (
  echo.
  echo   初回の準備をしています。数分かかります...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   準備に失敗しました。上のメッセージを確認してください。
    echo.
    pause
    exit /b 1
  )
)

rem npm がインストールスクリプトをブロックすると Electron 本体が落ちてこない。
rem その状態では起動できないので、先に取得を試みる。
if not exist "node_modules\electron\dist" (
  echo.
  echo   Electron の本体を準備しています...
  echo.
  call npm rebuild electron
)

if not exist "node_modules\electron\dist" (
  echo.
  echo   Electron の本体が取得できていません。
  echo   このフォルダでコマンドプロンプトを開き、次を実行してから
  echo   もう一度このファイルを開いてください。
  echo.
  echo       cd app
  echo       npm approve-scripts --allow-scripts-pending
  echo       npm rebuild electron
  echo.
  pause
  exit /b 1
)

echo.
echo   Douga を起動しています。このウィンドウは閉じないでください。
echo.

npm start

if errorlevel 1 (
  echo.
  echo   起動に失敗しました。上のメッセージを確認してください。
  echo.
  pause
)

endlocal
