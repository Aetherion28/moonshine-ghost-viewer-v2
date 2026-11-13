@echo off
cd /d "%~dp0"
rem Runs the Manta Storm sync sweep until a winner, then captures the whole TAS with it. Create stop.txt here to stop after the current attempt.
:loop
if exist "%~dp0stop.txt" goto end
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mantasweep.ps1"
if errorlevel 3 goto capture
if errorlevel 2 timeout /t 120 /nobreak >nul
goto loop
:capture
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0capture3.ps1" > "%~dp0capture3_console.txt" 2>&1
:end
echo Sweep finished.
pause
