param(
    [double]$Seconds = 60,
    [string]$Scenarios = 'fight-2-teams-*',
    [int]$Jobs = 1,
    [string]$Out = 'tests/balance/reports/adaptive',
    [switch]$Regenerate
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$outputPath = if ([IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $repoRoot $Out }
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$runnerPath = Join-Path $PSScriptRoot 'run-fights.cjs'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$arguments = @($runnerPath, '--seconds', [string]$Seconds, '--scenarios', $Scenarios, '--jobs', [string]$Jobs, '--out', $outputPath, '--resume')
if ($Regenerate) { $arguments += '--regenerate' }
$quotedArguments = $arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }
$process = Start-Process -FilePath $nodePath -ArgumentList $quotedArguments -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $outputPath 'background.log') -RedirectStandardError (Join-Path $outputPath 'background-errors.log') -PassThru
Set-Content -LiteralPath (Join-Path $outputPath 'background.pid') -Value $process.Id
Write-Output "Balance sweep started in background (PID $($process.Id))."
Write-Output "Progress: $(Join-Path $outputPath 'progress.json')"
Write-Output "Report: $(Join-Path $outputPath 'report.html')"
