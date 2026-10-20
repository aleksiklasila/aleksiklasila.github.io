param([string]$Name='production',[int]$Helpers=7,[int]$Ticks=24,[string]$Kernel='',[switch]$Capture)
$ErrorActionPreference='Stop'
$benchRoot=Split-Path -Parent $PSScriptRoot
$runRoot=Join-Path $PSScriptRoot 'test-runs/contact-profile-20261020'
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
$runPath=Join-Path $runRoot ($Name+'.json')
$node='C:/Users/aleks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$benchArgs=@('--max-old-space-size=10000','tests/checkerboard-tps.bench.cjs','--units=4000000','--map=1000',"--ticks=$Ticks",'--warmup=3',"--helpers=$Helpers",'--profile','--contact-trace',"--out=$runPath")
if($Kernel){$benchArgs+="--wasm64=$Kernel"}
if($Capture){$benchArgs+='--capture-contacts'}
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
Write-Output "$Name : $($r.tickMs.mean) ms, $($r.tps) TPS"
