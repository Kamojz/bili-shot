@echo off
rem Build BiliShot release artifacts into dist\ (no admin rights needed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-release.ps1"
echo.
pause
