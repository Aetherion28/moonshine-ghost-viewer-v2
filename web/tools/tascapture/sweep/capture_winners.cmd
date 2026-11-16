@echo off
rem Captures every split-sweep winner not captured yet (see README_SWEEP.txt).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0capture_winners.ps1"
