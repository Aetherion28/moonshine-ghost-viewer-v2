# Manta Sweep MCP server (stdio). Lets an AI assistant that speaks MCP (LM Studio, Claude Desktop, ...) watch and control
# the sweep. Client config:  command "powershell", args ["-NoProfile","-ExecutionPolicy","Bypass","-File","<this file>"]
# Tools: sweep_status, sweep_start, sweep_pause, best_runs, winners, add_next_search, capture_winners, read_manual.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false); [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$pause = Join-Path $here 'pause.txt'; $stop = Join-Path $here 'stop.txt'; $csv = Join-Path $here 'sweep_results.csv'
$winnersFile = Join-Path $here 'winners.txt'; $claims = Join-Path $here 'sweep_claims.txt'; $queue1 = Join-Path $here 'sweep_queue_first.txt'
$CODE = '800888C8:7C0802A6,800888CC:90010004,800888D0:9421FFF0,800888D4:4BFFD1F1,800888D8:3C808000,800888DC:80A41824,800888E0:80C41828,800888E4:7C053000,800888E8:40800018,800888EC:38C50001,800888F0:90C41824,800888F4:54A6083C,800888F8:38C61830,800888FC:7C64322E,80088900:80010014,80088904:38210010,80088908:7C0803A6,8008890C:4E800020,803211E8:4BD676E1'
function Lines($f) { if (-not (Test-Path $f)) { return @() }
    try { $fs = New-Object IO.FileStream($f, 'Open', 'Read', 'ReadWrite'); $sr = New-Object IO.StreamReader($fs); $t = $sr.ReadToEnd(); $sr.Close(); $fs.Close()
        return @($t -split "`r?`n" | Where-Object { $_ }) } catch { return @() } }
function Workers { @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*run_worker.cmd*' }).Count }
function Runs { $ok = New-Object 'System.Collections.Generic.List[string[]]'
    foreach ($l in @(Lines $csv | Select-Object -Skip 1)) { $p = $l.Split(',', 8); if ($p.Count -lt 8 -or $p[2] -like 'error*') { continue }; $ok.Add($p) }
    return , $ok }
function BestRuns($runs, $count) { $list = New-Object System.Collections.ArrayList
    foreach ($p in $runs) { $f = 0; [void][int]::TryParse($p[3], [ref]$f); if ($p[2] -eq 'WINNER') { $f += 10000000 }; if ($f -gt 0) { [void]$list.Add([pscustomobject]@{ Key = $f; Row = $p }) } }
    $seen = @{}; $out = @()
    foreach ($o in @($list | Sort-Object Key -Descending)) { $v = $o.Row[1]; if ($seen.ContainsKey($v)) { continue }; $seen[$v] = 1; $out += , $o.Row; if ($out.Count -ge $count) { break } }
    return , $out }
function PokeFor($vals) { $v = @($vals); $n = $v.Count; if ($v.Count % 2) { $v += 0 }
    $s = '80001824:00000000,80001828:' + $n.ToString('X8')
    for ($i = 0; $i -lt $v.Count; $i += 2) { $s += ',8000' + (0x1830 + 2 * $i).ToString('X4') + ':' + ((([int]$v[$i]) -shl 16) -bor ([int]$v[$i + 1])).ToString('X8') }
    return $s + ',' + $CODE }
function AddNextSearch($k, $m) { $have = @{}; foreach ($l in @(Lines $queue1)) { $have[(($l.TrimStart('#', 'X', ' ')) -split ';')[0].Trim()] = 1 }
    $new = New-Object System.Collections.ArrayList
    foreach ($row in (BestRuns (Runs) $k)) { $prefix = @($row[1] -split '\+' | ForEach-Object { [int]$_ }); if ($prefix.Count -ge 4) { continue }
        for ($i = 0; $i -lt $m; $i++) { $v = [int][math]::Floor($i * 32768 / $m); $vals = @($prefix) + $v; $name = 'split' + $vals.Count + '_' + ($vals -join '_')
            if ($have.ContainsKey($name)) { continue }; $have[$name] = 1
            [void]$new.Add("$name; sram=stereo; backend=D3D; loadstate=1; poke=" + (PokeFor $vals)) } }
    if ($new.Count -gt 0) { Add-Content -Path $queue1 -Value $new }
    return $new.Count }
function Status { $runs = Runs; $main = 0; $pri = 0; foreach ($p in $runs) { if ($p[0].StartsWith('P')) { $pri++ } else { $main++ } }
    $cut = (Get-Date).AddHours(-1); $hour = 0
    foreach ($c in @(Lines $claims)) { $p = $c -split '\|'; if ($p.Count -ge 3 -and $p[0].StartsWith('split')) { try { if ([datetime]::ParseExact($p[2].Trim(), 'yyyy-MM-dd HH:mm:ss', $null) -gt $cut) { $hour++ } } catch { } } }
    $w = Workers; $paused = Test-Path $pause; $priTotal = @(Lines $queue1 | Where-Object { -not $_.TrimStart().StartsWith('#') }).Count
    $state = if ($paused) { 'paused' } elseif ($w -eq 0) { 'stopped' } else { 'running' }
    $left = (32768 - $main) + [math]::Max(0, $priTotal - $pri)
    "state: $state`ngames running: $w`nfirst-split directions tried: $main of 32768`nnext-search runs done: $pri of $priTotal`nruns in the last hour: $hour`nhours left for everything queued: " + $(if ($hour -gt 0) { [math]::Round($left / $hour, 1) } else { 'unknown' }) + "`nwinners (Shine grabs): " + @(Lines $winnersFile).Count }
function Tool($name, $desc, $props) { @{ name = $name; description = $desc; inputSchema = @{ type = 'object'; properties = $props; required = @() } } }
$tools = @(
    (Tool 'sweep_status' 'Is the Manta sweep running, how far along it is, how fast, how long is left, and how many winners there are.' @{}),
    (Tool 'sweep_start' 'Start the sweep, or continue it after a pause or a PC restart.' @{}),
    (Tool 'sweep_pause' 'Pause the sweep: the six games finish their current runs (about 2 minutes), then nothing new starts.' @{}),
    (Tool 'best_runs' 'The runs that got furthest (latest first hit on Mario; winners first).' @{ count = @{ type = 'integer'; description = 'how many to list (default 15)' } }),
    (Tool 'winners' 'The runs where Mario grabbed the Shine, with their attempt numbers and split values.' @{}),
    (Tool 'add_next_search' 'Widen the search: for each of the best runs, also choose the direction of the next Manta split. Adds best x directions runs, done before the rest of the normal sweep.' @{ best = @{ type = 'integer'; description = 'how many of the best runs to build on (default 20)' }; directions = @{ type = 'integer'; description = 'directions to try for the next split, each (default 64)' } }),
    (Tool 'capture_winners' 'Record every winner from the start of Manta Storm to the end of the TAS (needed for ghosts and traces). Pauses the sweep while it runs.' @{}),
    (Tool 'read_manual' 'The full manual of the Manta sweep: what it is, every file, every button, and what to do when something goes wrong.' @{})
)
function Call($name, $a) {
    switch ($name) {
        'sweep_status' { return Status }
        'sweep_start' { Remove-Item -ErrorAction SilentlyContinue $pause, $stop
            if ((Workers) -eq 0) { Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $here 'parallel.ps1')`"" -WorkingDirectory $here -WindowStyle Hidden; return 'Started the six games. They take about 20 seconds to appear.' }
            return 'The sweep continues (the pause was removed).' }
        'sweep_pause' { Set-Content -Path $pause -Value 'paused through MCP'; return 'Paused. The games finish their current runs (about 2 minutes); nothing new starts until sweep_start.' }
        'best_runs' { $n = 15; if ($a -and $a.count) { $n = [int]$a.count }; $t = "attempt | split value(s) | outcome | field of first hit`n"
            foreach ($p in (BestRuns (Runs) $n)) { $t += "#$($p[0]) | $($p[1]) | $($p[2]) | $($p[3])`n" }; return $t + '(The TAS wins the fight at about field 174224; a later field means the run followed it longer.)' }
        'winners' { $l = @(Lines $winnersFile); if ($l.Count -eq 0) { return 'No winners yet.' }; return ($l | ForEach-Object { ($_ -split '\|' | Select-Object -First 4) -join '|' }) -join "`n" }
        'add_next_search' { $k = 20; $m = 64; if ($a -and $a.best) { $k = [int]$a.best }; if ($a -and $a.directions) { $m = [int]$a.directions }
            $n = AddNextSearch $k $m; return "Added $n runs. They are done before the rest of the normal sweep." }
        'capture_winners' { if (@(Lines $winnersFile).Count -eq 0) { return 'There are no winners yet, so nothing to capture.' }
            Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $here 'capture_winners.ps1')`" -Quiet" -WorkingDirectory $here -WindowStyle Hidden
            return 'Capturing the winners in the background (about 25 minutes each, six at a time). The sweep pauses meanwhile and continues afterwards. Output: the captures folder.' }
        'read_manual' { return [IO.File]::ReadAllText((Join-Path $here 'MANUAL.txt')) }
        default { throw "unknown tool $name" }
    }
}
function Send($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Depth 12 -Compress)); [Console]::Out.Flush() }
while ($true) {
    $line = [Console]::In.ReadLine(); if ($line -eq $null) { break }; if (-not $line.Trim()) { continue }
    try { $msg = $line | ConvertFrom-Json } catch { continue }
    if ($msg.id -eq $null) { continue }   # a notification: no answer
    try {
        switch ($msg.method) {
            'initialize' { $v = '2024-11-05'; if ($msg.params -and $msg.params.protocolVersion) { $v = $msg.params.protocolVersion }
                Send @{ jsonrpc = '2.0'; id = $msg.id; result = @{ protocolVersion = $v; capabilities = @{ tools = @{ listChanged = $false } }; serverInfo = @{ name = 'manta-sweep'; version = '1.0' }; instructions = 'Controls the Manta Storm split sweep. Call read_manual first if unsure.' } } }
            'ping' { Send @{ jsonrpc = '2.0'; id = $msg.id; result = @{} } }
            'tools/list' { Send @{ jsonrpc = '2.0'; id = $msg.id; result = @{ tools = $tools } } }
            'tools/call' { $text = ''; $err = $false; try { $text = [string](Call $msg.params.name $msg.params.arguments) } catch { $text = 'Error: ' + $_.Exception.Message; $err = $true }
                Send @{ jsonrpc = '2.0'; id = $msg.id; result = @{ content = @(@{ type = 'text'; text = $text }); isError = $err } } }
            default { Send @{ jsonrpc = '2.0'; id = $msg.id; error = @{ code = -32601; message = 'Method not found' } } }
        }
    } catch { Send @{ jsonrpc = '2.0'; id = $msg.id; error = @{ code = -32603; message = $_.Exception.Message } } }
}
