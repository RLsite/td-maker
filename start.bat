@echo off
cd /d "%~dp0app"
start "" "http://localhost:4321"
npm run dev
pause
