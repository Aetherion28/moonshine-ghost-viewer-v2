@echo off
cd /d "%~dp0"
rem One sweep worker (run_parallel.cmd starts them). Worker 0 uses Dolphin-x64, worker N Dolphin-x64-wN.
rem pause.txt: no new attempt starts until it is gone (sweep_control.cmd has the buttons). stop.txt ends the worker.
:loop
if exist "%~dp0stop.txt" goto end
if exist "%~dp0pause.txt" ( timeout /t 5 /nobreak >nul & goto loop )
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mantasweep.ps1" -Worker %1
if errorlevel 2 timeout /t 60 /nobreak >nul
goto loop
:end
echo Worker %1 finished.
