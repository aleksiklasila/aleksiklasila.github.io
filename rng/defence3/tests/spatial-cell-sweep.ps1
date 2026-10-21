param([string]$Sizes='1,2,4,8',[int]$Ticks=16,[string]$Suffix='',[switch]$Small)
$ErrorActionPreference='Stop'
$benchRoot=Split-Path -Parent $PSScriptRoot
$runRoot=Join-Path $PSScriptRoot 'test-runs/spatial-cells-20261021'
New-Item -ItemType Directory -Force -Path $runRoot | Out-Null
$node='C:/Users/aleks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
foreach($size in $Sizes.Split(',')){
    $runPath=Join-Path $runRoot ("cell-$size$Suffix.json")
    $units=if($Small){4000}else{4000000}
    $map=if($Small){100}else{1000}
    $benchArgs=@('--max-old-space-size=10000','tests/checkerboard-tps.bench.cjs',"--units=$units","--map=$map","--ticks=$Ticks",'--warmup=3','--helpers=7','--profile','--contact-trace',"--chunk-size=$size","--out=$runPath")
    $proc=Start-Process -FilePath $node -ArgumentList $benchArgs -WorkingDirectory $benchRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput ($runPath+'.stdout.log') -RedirectStandardError ($runPath+'.stderr.log')
    $paging=Join-Path $runRoot ("cell-$size$Suffix-paging.jsonl")
    Set-Content -LiteralPath $paging -Value ''
    do {
        $m=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
        [ordered]@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();pageReadsPerSec=$m.PageReadsPersec;pageWritesPerSec=$m.PageWritesPersec;pagesInputPerSec=$m.PagesInputPersec;pagesOutputPerSec=$m.PagesOutputPersec;availableMiB=$m.AvailableMBytes}|ConvertTo-Json -Compress|Add-Content -LiteralPath $paging
        Start-Sleep -Milliseconds 500
        $proc.Refresh()
    }while(-not $proc.HasExited)
    if(-not (Test-Path -LiteralPath $runPath)){throw "Benchmark failed: $runPath.stderr.log"}
    $r=Get-Content -Raw -LiteralPath $runPath|ConvertFrom-Json
    Write-Output "cell $size : $($r.tickMs.mean) ms, $($r.tps) TPS, $($r.final.units) survivors"
}
