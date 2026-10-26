# Persistent OS-level sampler for the perf fuzzer (tests/perf-fuzz.cjs). One
# JSON request per line on stdin, one JSON answer per line on stdout:
#   {"tag":"<fragment of the browser's --user-data-dir>","gpu":true|false}
# The browser's process tree is found by the tag (the main process's command
# line holds it); its private bytes, working set, CPU time (cores busy since
# the last request), handles, GPU memory, and the machine's free memory and
# CPU load are reported. Starting powershell costs ~0.5 s: it is kept running.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::Out.AutoFlush = $true
$cpuCounter = $null
try { $cpuCounter = New-Object System.Diagnostics.PerformanceCounter('Processor', '% Processor Time', '_Total'); [void]$cpuCounter.NextValue() } catch { }
$availCounter = $null
try { $availCounter = New-Object System.Diagnostics.PerformanceCounter('Memory', 'Available MBytes'); [void]$availCounter.NextValue() } catch { }
$prevCpu = @{}
$prevAt = $null
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }
    try {
        $req = $line | ConvertFrom-Json
        $now = [DateTime]::UtcNow
        $os = Get-CimInstance Win32_OperatingSystem
        $all = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'")
        $rootProc = $all | Where-Object { $_.CommandLine -like ('*' + $req.tag + '*') -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1
        $out = [ordered]@{
            freeMB = [int]($os.FreePhysicalMemory / 1024); totalMB = [int]($os.TotalVisibleMemorySize / 1024)
            freeVirtMB = [int]($os.FreeVirtualMemory / 1024); totalVirtMB = [int]($os.TotalVirtualMemorySize / 1024)
            availMB = $(if ($availCounter) { [int]$availCounter.NextValue() } else { $null })   # free plus standby cache: what a program can really still get
            sysCpu = $(if ($cpuCounter) { [math]::Round($cpuCounter.NextValue(), 1) } else { $null })
        }
        if ($rootProc) {
            $ids = New-Object 'System.Collections.Generic.HashSet[int]'
            [void]$ids.Add([int]$rootProc.ProcessId)
            do {
                $added = $false
                foreach ($p in $all) { if (-not $ids.Contains([int]$p.ProcessId) -and $ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId); $added = $true } }
            } while ($added)
            $kind = @{}
            foreach ($p in $all) {
                if (-not $ids.Contains([int]$p.ProcessId)) { continue }
                $t = 'browser'
                if ($p.CommandLine -match '--type=([a-z-]+)') { $t = $Matches[1] }
                if ($t -eq 'utility' -and $p.CommandLine -match '--utility-sub-type=([A-Za-z0-9_.]+)') { $t = 'utility:' + ($Matches[1] -replace '^.*\.', '') }
                $kind[[int]$p.ProcessId] = $t
            }
            $procs = @(Get-Process -Id @($ids) -ErrorAction SilentlyContinue)
            $rows = @(); $priv = 0.0; $ws = 0.0; $handles = 0; $cpuSum = 0.0; $cpuNow = @{}
            foreach ($p in $procs) {
                $pm = $p.PrivateMemorySize64 / 1MB; $wm = $p.WorkingSet64 / 1MB; $cs = $p.TotalProcessorTime.TotalSeconds
                $priv += $pm; $ws += $wm; $handles += $p.HandleCount; $cpuSum += $cs; $cpuNow[[int]$p.Id] = $cs
                $rows += [ordered]@{ pid = [int]$p.Id; type = $kind[[int]$p.Id]; privMB = [math]::Round($pm, 1); wsMB = [math]::Round($wm, 1); cpuSec = [math]::Round($cs, 2); threads = $p.Threads.Count }
            }
            $cores = $null
            if ($prevAt) {
                $dt = ($now - $prevAt).TotalSeconds
                $dc = 0.0
                foreach ($k in $cpuNow.Keys) { if ($prevCpu.ContainsKey($k)) { $dc += $cpuNow[$k] - $prevCpu[$k] } }
                if ($dt -gt 0.05) { $cores = [math]::Round($dc / $dt, 2) }
            }
            $prevCpu = $cpuNow; $prevAt = $now
            $top = @($rows | Sort-Object { $_.privMB } -Descending | Select-Object -First 8)
            $byType = [ordered]@{}
            foreach ($r in $rows) { $k = ($r.type -replace ':.*', ''); if (-not $byType.Contains($k)) { $byType[$k] = 0.0 }; $byType[$k] = [math]::Round($byType[$k] + $r.privMB, 1) }
            $out.edge = [ordered]@{ n = $procs.Count; privMB = [math]::Round($priv, 1); wsMB = [math]::Round($ws, 1); handles = $handles; cores = $cores; cpuSec = [math]::Round($cpuSum, 2); byType = $byType; top = $top }
            if ($req.gpu) {
                $g = Get-Counter -Counter '\GPU Process Memory(*)\Dedicated Usage', '\GPU Process Memory(*)\Shared Usage' -ErrorAction SilentlyContinue
                if ($g) {
                    $ded = 0.0; $sh = 0.0
                    foreach ($s in $g.CounterSamples) {
                        if ($s.InstanceName -match '^pid_(\d+)_') { if ($ids.Contains([int]$Matches[1])) { if ($s.Path -like '*dedicated usage') { $ded += $s.CookedValue } else { $sh += $s.CookedValue } } }
                    }
                    $out.edge.gpuDedicatedMB = [math]::Round($ded / 1MB, 1); $out.edge.gpuSharedMB = [math]::Round($sh / 1MB, 1)
                }
            }
        } else { $out.edge = $null }
        Write-Output ($out | ConvertTo-Json -Compress -Depth 6)
    } catch {
        Write-Output ((@{ error = $_.Exception.Message }) | ConvertTo-Json -Compress)
    }
}
