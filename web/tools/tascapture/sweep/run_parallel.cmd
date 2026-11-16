@echo off
cd /d "%~dp0"
rem Starts the Manta sweep on every physical core (pass a number to choose how many workers). Create stop.txt here to stop them all.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0parallel.ps1" %1
