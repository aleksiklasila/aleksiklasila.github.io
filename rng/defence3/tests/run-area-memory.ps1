param(
    [ValidateSet('Compare','Exact','Area')][string]$Mode='Compare',
    [int]$Units=4000000,[int]$Map=1024,[int]$Ticks=24,[int]$Warmup=6,
    [string]$Name='',
    [switch]$MemoryInventory,[switch]$DenseJsCache
)
$ErrorActionPreference='Stop'
$benchRoot=Split-Path -Parent $PSScriptRoot
$runRoot=Join-Path $PSScriptRoot 'test-runs/area-sample-20261021'
$nodePath='C:/Users/aleks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
# Preflight before launching any child: unavailable counters must not leave
# an unmonitored multi-gigabyte benchmark running in the background.
Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Out-Null
$modes=if($Mode -eq 'Compare'){@('Exact','Area')}else{@($Mode)}
foreach($variant in $modes){
    $runName=if($Name){$Name}else{$variant.ToLower()+'-4m'}
    if($Mode -eq 'Compare' -and $Name){$runName=$Name+'-'+$variant.ToLower()}
    $runPath=Join-Path $runRoot ($runName+'.json')
    $memoryPath=Join-Path $runRoot ($runName+'-paging.jsonl')
    Set-Content -LiteralPath $memoryPath -Value ''
    $benchArgs=@('--max-old-space-size=12000','tests/checkerboard-tps.bench.cjs',"--units=$Units","--map=$Map","--ticks=$Ticks","--warmup=$Warmup",'--helpers=7','--occupancy','--packed',"--out=$runPath")
    if($variant -eq 'Area'){$benchArgs+='--area-targets'}
    else{$benchArgs+='--exact-targets'}
    if($MemoryInventory){$benchArgs+='--memory-inventory'}
    if($DenseJsCache){$benchArgs+='--dense-js-cache'}
    $benchmark=Start-Process -FilePath $nodePath -ArgumentList $benchArgs -WorkingDirectory $benchRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput ($runPath+'.stdout.log') -RedirectStandardError ($runPath+'.stderr.log')
    do{
        $sample=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
        $benchmark.Refresh()
        [ordered]@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();availableMiB=$sample.AvailableMBytes;pageReadsPerSec=$sample.PageReadsPersec;pageWritesPerSec=$sample.PageWritesPersec;pagesInputPerSec=$sample.PagesInputPersec;pagesOutputPerSec=$sample.PagesOutputPersec;workingSetMiB=$benchmark.WorkingSet64/1MB;privateMiB=$benchmark.PrivateMemorySize64/1MB}|ConvertTo-Json -Compress|Add-Content -LiteralPath $memoryPath
        Start-Sleep -Milliseconds 1000
        $benchmark.Refresh()
    }while(-not $benchmark.HasExited)
    $benchmark.WaitForExit()
    if($benchmark.ExitCode -ne 0 -or -not(Test-Path -LiteralPath $runPath)){throw "Benchmark failed: $runPath.stderr.log"}
    $result=Get-Content -LiteralPath $runPath -Raw|ConvertFrom-Json
    Write-Output "$runName : $($result.tps) TPS, $($result.tickMs.mean) ms/tick, occupancy audit $($result.occupancyAuditResult.ok), final hash $($result.final.hash)"
}
