@echo off
echo Starting TD Maker dev...

start "Astro Dev Server" cmd /k "cd /d C:\harel\TD\app && npm run dev"

timeout /t 4 /nobreak >nul

cd /d C:\harel\TD
npm run dev
