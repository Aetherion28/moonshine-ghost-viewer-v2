MANTA STORM SPLIT SWEEP - how to run it without Claude
=======================================================

What it does
  Plays the any% TAS (sms-anypct-tas.dtm) from the savestate at Sirena's start (Dolphin slot 1) once for every
  value 0..32767 of the random number that decides the first Manta split's direction, six Dolphins at once.
  A run ends on Mario's first hit, a death, a freeze, or no Manta victory by field 174824 (TAS ~174224 + 10 s).
  A run where Mario grabs the Sirena Shine is a WINNER.

Control
  Double-click sweep_control.cmd: a coloured dot appears in the taskbar notification area (green running, yellow paused, red stopped); click it for the menu. It shows progress, the rate, the time left and the number of winners.
    Pause  - each Dolphin finishes its current run, then no new runs start (use this when you need the PC).
    Start  - continue. If the workers aren't running (after a reboot, say) or are stuck, Start relaunches them.
  It always picks up where it left off: sweep_results.txt records every finished value.
  Runs that were cut off (reboot, crash) are run again automatically.

After a reboot
  Double-click sweep_control.cmd, press Start.

Where the results are
  winners.txt          one line per Shine grab: time | name (split_<value>) | result | the queue line
  sweep\winners\       the full log of each winner
  sweep_results.txt    every finished run (FAIL hit at field N ... = Mario's first hit; higher N = got further)
  sweep\split_N.txt    each run's own log (Mario's status, position, rand seed every 10 fields)
  An ERROR result means the run didn't start properly; it is retried up to 3 times automatically.

To see the runs that got furthest (PowerShell in this folder):
  Get-Content sweep_results.txt | Select-String '^split_' | Sort-Object { [int]([regex]::Match($_, 'field (\d+)').Groups[1].Value) } | Select-Object -Last 20

Capturing the winners (continuing the TAS capture)
  Pick "Capture winners" in the dot's menu, or double-click capture_winners.cmd. For every winner without a
  finished capture it loads the Sirena savestate, sets that winner's split value and records the rest of the movie
  exactly as capture3 did (speed 1, every tick and frame), up to six at once in the same 3x2 grid, each with its own
  Dolphin copy (Dolphin-x64-c0..c5). The sweep pauses while they run (its current runs finish first) and goes on after.
  Each capture takes about 25 minutes. Output: captures\split_<value>.bin, its _log.txt, and .done when finished.
  A capture shows whether the movie stays in sync after Sirena: its log prints the area every 10 seconds.
  You can run it again any time; finished winners are skipped. To recapture one, delete its .done file.
  Turning a capture into per-level ghosts and traces is done in the repository (web/tools/tascapture/convert.ts and
  mkghost.py, v3 branch); give the .bin to the next Claude session with this file.

Files
  mantasweep.ps1  one run (read by every worker each run, so edits apply to the next run)
  run_worker.cmd  a worker's loop        parallel.ps1 / run_parallel.cmd  start the 6 workers
  sweep_control.ps1 / .cmd  the window   capture_winner.ps1 / capture_winners.ps1 / .cmd  the winners' captures
    pause.txt  exists while paused   stop.txt  ends the workers
  Dolphin-x64, Dolphin-x64-w1..w5  each worker's own portable Dolphin (same settings, own savestates)
