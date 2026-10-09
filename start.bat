@echo off
rem VoiceBird: double-click to start. Your browser opens http://localhost:7878 by itself.
rem Keep this window open while you use the app. Close it to stop the app.
title VoiceBird
cd /d "%~dp0"

rem Already running? Just open it.
netstat -ano | findstr /r /c:":7878 .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  start "" http://localhost:7878
  exit /b 0
)

if not exist ".venv\Scripts\python.exe" (
  echo The Python environment is missing. See README.md, section "Reinstall".
  pause
  exit /b 1
)

rem Build the screen once, and again only after it was changed (a built screen loads much faster).
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d = Get-Item 'ui\dist\index.html' -ErrorAction SilentlyContinue; $s = Get-ChildItem 'ui\src','ui\index.html' -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if (-not $d -or $s.LastWriteTime -gt $d.LastWriteTime) { exit 1 }"
if errorlevel 1 (
  where node >nul 2>&1
  if errorlevel 1 (
    echo Node.js is needed once to prepare the screen. Get it from https://nodejs.org and run this again.
    pause
    exit /b 1
  )
  echo Preparing the screen, about 20 seconds...
  pushd ui
  if not exist node_modules call npm install --no-audit --no-fund
  call npm run build
  popd
)

rem Open the browser as soon as the app answers.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 240; $i++) { try { (New-Object Net.Sockets.TcpClient('127.0.0.1', 7878)).Close(); Start-Process 'http://localhost:7878'; break } catch { Start-Sleep -Milliseconds 500 } }"

echo.
echo   VoiceBird is running at http://localhost:7878
echo   Close this window to stop it.
echo.
".venv\Scripts\python.exe" -m uvicorn server.app:app --host 127.0.0.1 --port 7878 --log-level warning
pause
