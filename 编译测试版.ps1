$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exeItem = Get-ChildItem -LiteralPath $root -Filter '*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
$exe = if ($exeItem) { $exeItem.FullName } else { $null }
$solution = Join-Path $root 'project\ProgrammerAssistant.sln'
$msbuild = 'D:\Microsoft Visual Studio\2019\Community\MSBuild\Current\Bin\MSBuild.exe'

$exeFull = [IO.Path]::GetFullPath($exe)
$oldPids = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        if ($_.Path -and ([IO.Path]::GetFullPath($_.Path) -ieq $exeFull)) { $_.Id }
    } catch { }
})
foreach ($processId in $oldPids) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 700

& $msbuild $solution /p:Configuration=Release /p:Platform=x64 /v:minimal
if ($LASTEXITCODE -ne 0) {
    throw "MSBuild failed with exit code $LASTEXITCODE"
}

if (-not $exe) {
    $exeItem = Get-ChildItem -LiteralPath $root -Filter '*.exe' -File | Select-Object -First 1
    if ($exeItem) { $exe = $exeItem.FullName }
}
if (-not $exe) { throw 'Built executable was not found in project root' }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $true
[System.Diagnostics.Process]::Start($psi) | Out-Null
Start-Sleep -Milliseconds 800
$started = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and ([IO.Path]::GetFullPath($_.Path) -ieq [IO.Path]::GetFullPath($exe)) } catch { $false }
}
if (-not $started) {
    throw "Test executable did not start: $exe"
}
Write-Host "Built and started: $exe"
