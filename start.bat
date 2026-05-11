@echo off
setlocal

cd /d "%~dp0"

:: index.html のキャッシュを避けるためクエリ付き（古い JS が残ると起動直後から対局になる）
set "URL=http://127.0.0.1:8765/index.html?v=2"

where py >nul 2>nul
if %errorlevel%==0 (
  start "" "%URL%"
  py serve.py
  goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
  start "" "%URL%"
  python serve.py
  goto :eof
)

echo Python が見つかりませんでした。
echo Python をインストール後、もう一度実行してください。
pause
