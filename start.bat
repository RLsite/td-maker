@echo off
cd /d "%~dp0app"
start /B cmd /c "npm run dev"
echo Waiting for dev server...
:wait
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://localhost:4321/' -UseBasicParsing -TimeoutSec 1).StatusCode | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto wait
)
start "" "http://localhost:4321"
echo TD Maker running at http://localhost:4321
pause
