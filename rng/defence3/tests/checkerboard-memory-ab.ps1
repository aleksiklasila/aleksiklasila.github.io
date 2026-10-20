param([string]$Node='C:/Users/aleks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe',[int]$Ticks=20,[int]$Warmup=3,[int]$ContactBudget=8,[string]$RunName='',[switch]$HardwareCounters,[switch]$Reverse)
$ErrorActionPreference='Stop'
$benchRoot=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $benchRoot
$runRoot=Join-Path $PSScriptRoot 'test-runs/collision-tps-20261020'
$layouts=if($Reverse){@('removed','cached')}else{@('cached','removed')}
foreach($layout in $layouts) {
    $runPath=Join-Path $runRoot ($layout+$RunName+'-monitored.json')
    $benchArgs=@('--max-old-space-size=12000','tests/checkerboard-tps.bench.cjs','--units=4000000','--map=1000',"--ticks=$Ticks","--warmup=$Warmup",'--profile',"--contact-budget=$ContactBudget","--out=$runPath")
    if($layout -eq 'cached') {$benchArgs+='--cached-layout';$benchArgs+='--shared-stats=0'}
    if($HardwareCounters) {$benchArgs+='--wpr'}
    $proc=Start-Process -FilePath $Node -ArgumentList $benchArgs -WorkingDirectory $benchRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput ($runPath+'.stdout.log') -RedirectStandardError ($runPath+'.stderr.log')
    $paging=Join-Path $runRoot ($layout+$RunName+'-paging.jsonl')
    Set-Content -LiteralPath $paging -Value ''
    do {
        $m=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
        [ordered]@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();pageReadsPerSec=$m.PageReadsPersec;pageWritesPerSec=$m.PageWritesPersec;pagesInputPerSec=$m.PagesInputPersec;pagesOutputPerSec=$m.PagesOutputPersec;availableMiB=$m.AvailableMBytes}|ConvertTo-Json -Compress|Add-Content -LiteralPath $paging
        Start-Sleep -Milliseconds 500
        $proc.Refresh()
    }while(-not $proc.HasExited)
    if(-not (Test-Path -LiteralPath $runPath)){throw "Benchmark failed: $runPath.stderr.log"}
    $r=Get-Content -Raw -LiteralPath $runPath|ConvertFrom-Json
    Write-Output "$layout : $($r.tickMs.mean) ms, $($r.tps) TPS"
}
