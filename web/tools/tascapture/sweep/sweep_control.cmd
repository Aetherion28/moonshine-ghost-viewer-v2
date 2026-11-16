@echo off
rem The sweep control icon in the taskbar notification area (sweep_window.ps1 is the old window).
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0sweep_tray.ps1"
