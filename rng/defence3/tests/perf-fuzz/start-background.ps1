# Starts the perf fuzzer detached (no console window, output in a log), so it keeps running while you use the
# machine or close the terminal. Same arguments as `node tests/perf-fuzz.cjs`:
#   powershell -ExecutionPolicy Bypass -File tests/perf-fuzz/start-background.ps1 100000-1000.json --hours=8 --vis=full,team,history
# Stops cleanly with:  New-Item <run folder>\STOP     (the folder is printed here and in the log's first line)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$stamp = Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'
$out = Join-Path $repo "tests\test-runs\perf-fuzz-$stamp"
New-Item -ItemType Directory -Force $out | Out-Null
$argsList = @("tests/perf-fuzz.cjs") + $args
if (-not ($args | Where-Object { $_ -like '--out=*' })) { $argsList += "--out=$out" }
$proc = Start-Process -FilePath node -ArgumentList $argsList -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $out 'console.log') -RedirectStandardError (Join-Path $out 'console.err.log')
$proc.Id | Out-File (Join-Path $out 'pid.txt') -Encoding ascii
Write-Output "perf fuzz running as pid $($proc.Id)"
Write-Output "folder:  $out"
Write-Output "log:     $out\run.log   (tail it: Get-Content -Wait '$out\run.log')"
Write-Output "report:  $out\report.md (rewritten every 10 minutes)"
Write-Output "stop:    New-Item '$out\STOP'   (ends after the current trial and writes the final report)"
