param([string]$Name='one-plane',[int]$Planes=1,[int]$Units=4000000,[int]$Ticks=16,[switch]$Reference)
$ErrorActionPreference='Stop'
$benchRoot=Split-Path -Parent $PSScriptRoot
$runRoot=Join-Path $PSScriptRoot 'test-runs/occupancy-20261021'
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
$runPath=Join-Path $runRoot ($Name+'.json')
$node='C:/Users/aleks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$benchArgs=@('--max-old-space-size=10000','tests/checkerboard-tps.bench.cjs',"--units=$Units",'--map=1024',"--ticks=$Ticks",'--warmup=3','--helpers=7','--profile','--packed',"--occ-planes=$Planes","--out=$runPath")
if(-not $Reference){$benchArgs+='--occupancy'}
$proc=Start-Process -FilePath $node -ArgumentList $benchArgs -WorkingDirectory $benchRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput ($runPath+'.stdout.log') -RedirectStandardError ($runPath+'.stderr.log')
$paging=Join-Path $runRoot ($Name+'-paging.jsonl')
Set-Content -LiteralPath $paging -Value ''
do {
    $m=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    [ordered]@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();pageReadsPerSec=$m.PageReadsPersec;pageWritesPerSec=$m.PageWritesPersec;pagesInputPerSec=$m.PagesInputPersec;pagesOutputPerSec=$m.PagesOutputPersec;availableMiB=$m.AvailableMBytes}|ConvertTo-Json -Compress|Add-Content -LiteralPath $paging
    Start-Sleep -Milliseconds 500
    $proc.Refresh()
}while(-not $proc.HasExited)
if(-not (Test-Path -LiteralPath $runPath)){throw "Benchmark failed: $runPath.stderr.log"}
$r=Get-Content -Raw -LiteralPath $runPath|ConvertFrom-Json
Write-Output "$Name : $($r.tickMs.mean) ms, $($r.tps) TPS, $($r.final.units) survivors"
