# Builds installer\dist\VoiceBird-Setup-<version>.exe: stages the app (code, built screen, uv) and runs Inno Setup.
#   powershell -ExecutionPolicy Bypass -File installer\build.ps1 [-Version 1.0.0]
param([string]$Version = '1.0.0')
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$Root = Split-Path -Parent $Here
$Stage = "$Here\build\app"

$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 7\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 7\ISCC.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup is not installed (https://jrsoftware.org/isdl.php).' }
if (-not (Test-Path "$Root\ui\dist\index.html")) { throw 'Build the screen first: cd ui; npm run build' }
if (-not (Test-Path "$Here\art\voicebird.ico")) { throw 'Make the art first: cd ui; node ..\installer\art.mjs' }

if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force $Stage | Out-Null
function Put([string]$from, [string]$to = $from) {
  $dst = Join-Path $Stage $to
  New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null
  Copy-Item -Recurse -Force (Join-Path $Root $from) $dst
}
foreach ($f in 'requirements.txt', 'start.bat', 'launch.ps1', 'VoiceBird.vbs', 'README.md', 'docs\GUIDE.md', 'installer\setup.ps1') { Put $f }
Get-ChildItem "$Root\server\*.py" | ForEach-Object { Put "server\$($_.Name)" }
Put 'engines\base.py'
foreach ($e in 'qwen3', 'chatterbox-nano', 'chatterbox', 'voxcpm', 'sopro') {
  foreach ($f in 'worker.py', 'engine.json', 'requirements.txt') { Put "engines\$e\$f" }
}
Put 'ui\dist'
$uv = (Get-Command uv.exe -ErrorAction SilentlyContinue).Source
if ($uv) { New-Item -ItemType Directory -Force "$Stage\runtime\uv" | Out-Null; Copy-Item $uv "$Stage\runtime\uv\uv.exe" }
Remove-Item "$Stage\x" -ErrorAction SilentlyContinue

& $iscc "/DAppVersion=$Version" "/DSourceDir=$Stage" "$Here\VoiceBird.iss"
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed ($LASTEXITCODE)" }
Get-Item "$Here\dist\VoiceBird-Setup-$Version.exe" | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
