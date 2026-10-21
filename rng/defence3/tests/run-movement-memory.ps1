param([string]$Name='final-timing',[int]$Ticks=32,[int]$Warmup=6)
$ErrorActionPreference='Stop'
$benchRoot=Split-Path -Parent $PSScriptRoot
$runRoot=Join-Path $PSScriptRoot 'test-runs/movement-profile-20261021'
$runPath=Join-Path $runRoot ($Name+'.json')
$nodePath='C:/Users/aleks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$benchArgs=@('--max-old-space-size=12000','tests/checkerboard-tps.bench.cjs','--units=4000000','--map=1024',"--ticks=$Ticks","--warmup=$Warmup",'--helpers=7','--occupancy','--packed',"--out=$runPath")
$benchmark=Start-Process -FilePath $nodePath -ArgumentList $benchArgs -WorkingDirectory $benchRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput ($runPath+'.stdout.log') -RedirectStandardError ($runPath+'.stderr.log')
$memoryPath=Join-Path $runRoot ($Name+'-paging.jsonl')
Set-Content -LiteralPath $memoryPath -Value ''
do {
    $sample=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    [ordered]@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();availableMiB=$sample.AvailableMBytes;pageReadsPerSec=$sample.PageReadsPersec;pageWritesPerSec=$sample.PageWritesPersec;pagesInputPerSec=$sample.PagesInputPersec;pagesOutputPerSec=$sample.PagesOutputPersec}|ConvertTo-Json -Compress|Add-Content -LiteralPath $memoryPath
    Start-Sleep -Milliseconds 500
    $benchmark.Refresh()
}while(-not $benchmark.HasExited)
if(-not(Test-Path -LiteralPath $runPath)){throw "Benchmark failed: $runPath.stderr.log"}
$result=Get-Content -LiteralPath $runPath -Raw|ConvertFrom-Json
Write-Output "$Name : $($result.tickMs.mean) ms/tick, movement $($result.phases.simMoveRun) ms, bitmap audit $($result.occupancyAuditResult.ok)"
