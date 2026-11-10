@echo off
rem Starts the PC side of wiiprobe (server.py beside this file). Leave the window open; close it to stop.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py
  goto end
)
where python >nul 2>nul
if %errorlevel%==0 (
  python server.py
  goto end
)
echo Python 3 was not found. Install it from python.org (tick "Add python.exe to PATH") and start this again.
:end
pause
