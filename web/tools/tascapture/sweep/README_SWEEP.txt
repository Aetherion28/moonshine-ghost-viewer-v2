MANTA STORM SPLIT SWEEP - how to run it without Claude
=======================================================

What it does
  Plays the any% TAS (sms-anypct-tas.dtm) from the savestate at Sirena's start (Dolphin slot 1) once for every
  value 0..32767 of the random number that decides the first Manta split's direction, six Dolphins at once.
  A run ends on Mario's first hit, a death, a freeze, or no Manta victory by field 174824 (TAS ~174224 + 10 s).
  A run where Mario grabs the Sirena Shine is a WINNER.

Control
  Double-click sweep_control.cmd. The window shows progress, the rate, the time left and the number of winners.
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

When it's finished (or when you have a winner)
  The value is the number in split_<value>. Its queue line (in sweep_queue.txt / winners.txt) holds the pokes that
  force that split. Making a ghost and trace from it needs capture3.ps1 taught to load slot 1 and apply those pokes;
  give that to the next Claude session with this file and the repository notes (v3 branch CLAUDE.md, "The any% TAS").

Files
  mantasweep.ps1  one run (read by every worker each run, so edits apply to the next run)
  run_worker.cmd  a worker's loop        parallel.ps1 / run_parallel.cmd  start the 6 workers
  sweep_control.ps1 / .cmd  the window   pause.txt  exists while paused   stop.txt  ends the workers
  Dolphin-x64, Dolphin-x64-w1..w5  each worker's own portable Dolphin (same settings, own savestates)
