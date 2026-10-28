@echo off
rem Double-click to start ReadAloud. Close this window to stop it.
rem It also runs the PC voice for the phone app, once pc-worker\.env has a key.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing for the first time...
  call npm install
)
if exist pc-worker\.env (
  echo PC voice for the phone: on. Keep this window open while you listen.
) else (
  echo PC voice for the phone: off. See pc-worker\.env.example to switch it on.
)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:5520"
node --use-system-ca server\server.js
pause
