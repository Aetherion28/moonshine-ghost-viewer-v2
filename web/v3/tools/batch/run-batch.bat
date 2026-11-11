@echo off
rem Replays every recording with the game's own code on all of this PC's cores (v3 of the ghost viewer).
rem Put v3batch.mjs beside this file (built from web/v3/tests/batch.ts), set the two paths below, and double-click.
rem Leave the window open until it says how many recordings replayed. The results go to the folder "results" here:
rem results\survey.tsv has a line a recording, results\reports the whole report of each, results\summary.txt the totals.
set "DISC=C:\path\to\JP 1.0 (GMSJ01).iso"
set "TRACES=C:\path\to\the folder with the .msgt recordings"
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.org and start this again.
  goto end
)
node v3batch.mjs "%DISC%" "%TRACES%" results %*
:end
pause
