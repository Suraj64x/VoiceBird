<#
  VoiceBird setup engine. Installs, checks and repairs everything the app needs:
  uv, Python 3.11, the app's Python packages, FFmpeg, Whisper, the voice engines and their models.
  It never deletes your voices or projects: on repair, an unreadable settings file is moved to .broken\ and reset.

    setup.ps1 [-Mode install|repair|verify] [-Engines qwen3,chatterbox-nano] [-Gpu auto|cuda|cpu] [-Whisper small] [-NoModels]

  Lines starting with "@@ <percent> <text>" are progress for the installer window. Details go to logs\setup.log.
#>
param(
  [ValidateSet('install', 'repair', 'verify')] [string]$Mode = 'repair',
  [string]$Engines = '',
  [ValidateSet('auto', 'cuda', 'cpu')] [string]$Gpu = 'auto',
  [ValidateSet('base', 'small', 'medium')] [string]$Whisper = 'small',
  [switch]$NoModels
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
$RT = Join-Path $Root 'runtime'
foreach ($d in $RT, "$Root\logs", "$Root\.cache\tmp") { New-Item -ItemType Directory -Force $d | Out-Null }
$LogFile = "$Root\logs\setup.log"
# everything stays inside the app folder
$env:UV_CACHE_DIR = "$RT\uv-cache"; $env:UV_PYTHON_INSTALL_DIR = "$RT\python"; $env:UV_PYTHON_PREFERENCE = 'only-managed'
$env:UV_LINK_MODE = 'hardlink'; $env:UV_NO_PROGRESS = '1'
$env:HF_HOME = "$Root\models\hf"; $env:TORCH_HOME = "$Root\models\torch"
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'; $env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:TEMP = $env:TMP = "$Root\.cache\tmp"; $env:PYTHONUTF8 = '1'

$EngineModule = [ordered]@{ 'qwen3' = 'qwen_tts'; 'chatterbox-nano' = 'chatterbox'; 'chatterbox' = 'chatterbox'; 'voxcpm' = 'voxcpm'; 'sopro' = 'sopro' }
$Fix = $Mode -ne 'verify'
$Problems = New-Object System.Collections.Generic.List[string]

function Log([string]$t) { Add-Content -LiteralPath $LogFile -Value ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $t) -Encoding UTF8 }
$Pretty = -not [Console]::IsOutputRedirected
if ($Pretty) { $Host.UI.RawUI.WindowTitle = 'VoiceBird setup'; Write-Host "`n  VoiceBird  $Mode`n" -ForegroundColor Green }
function Say([double]$pct, [string]$text) {
  if ($Pretty) { Write-Host ('  {0,3}%  ' -f [int]$pct) -NoNewline -ForegroundColor DarkGray; Write-Host $text } else { Write-Output ("@@ {0} {1}" -f [int]$pct, $text) }
  Log $text
}
function Bad([string]$what) {
  $Problems.Add($what); Log "PROBLEM: $what"
  if ($Pretty) { Write-Host "        ! $what" -ForegroundColor Yellow } else { Write-Output "!! $what" }
}
function Done([int]$code) { if ($Pretty) { Write-Host ''; Read-Host '  Press Enter to close' | Out-Null }; exit $code }

# Run a tool; its output goes to the log; a non-zero exit stops setup with a readable message.
function Run([string]$exe, [string[]]$a, [string]$what, [switch]$Soft) {
  Log "> $([IO.Path]::GetFileName($exe)) $($a -join ' ')"
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $out = & $exe @a 2>&1 | ForEach-Object { "  $_" }
  $code = $LASTEXITCODE; $ErrorActionPreference = $old
  if ($out) { Add-Content -LiteralPath $LogFile -Value $out -Encoding UTF8 }
  if ($code -ne 0 -and -not $Soft) { throw "$what failed (code $code). Details: logs\setup.log" }
  return $code
}
# The Python that uv installed, found by its real folder (not uv's version link, which some PCs block).
function ManagedPython {
  Get-ChildItem "$RT\python" -Directory -Filter 'cpython-3.11.*-windows-x86_64-none' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'python.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1
}
# True when a tool starts and exits cleanly (used for health checks).
function Works([string]$exe, [string[]]$a) {
  if (-not (Test-Path -LiteralPath $exe) -and -not (Get-Command $exe -ErrorAction SilentlyContinue)) { return $false }
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  & $exe @a *> $null
  $ok = $LASTEXITCODE -eq 0; $ErrorActionPreference = $old
  return $ok
}
function Fetch([string]$url, [string]$dest) {
  Log "download $url"
  $part = "$dest.part"
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & curl.exe -L --fail --retry 4 --retry-delay 3 -s -S -o $part $url 2>> $LogFile
    $code = $LASTEXITCODE; $ErrorActionPreference = $old
    if ($code -ne 0) { throw "Download failed: $url (check your internet connection)" }
  } else {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $part
  }
  Move-Item -Force $part $dest
}
function Unzip([string]$zip, [string]$to) {
  if (Test-Path $to) { Remove-Item -Recurse -Force $to }
  Expand-Archive -LiteralPath $zip -DestinationPath $to -Force
}

Log "==== $Mode $(Get-Date -Format s) ===="
Say 1 'Getting ready'

# which engines: asked for, else the ones already installed, else the recommended pair
$sel = @($Engines.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $EngineModule.Contains($_) })
if ($Engines -ne 'none') {
  if (-not $sel.Count) { $sel = @($EngineModule.Keys | Where-Object { Test-Path "$Root\engines\$_\.venv" }) }
  if (-not $sel.Count) { $sel = @('qwen3', 'chatterbox-nano') }
}

$cuda = $false
if ($Gpu -eq 'cuda') { $cuda = $true }
elseif ($Gpu -eq 'auto') {  # ask Windows (works from 32-bit PowerShell too, unlike nvidia-smi)
  $cuda = [bool](Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'NVIDIA' })
}
Log "engines: $($sel -join ', ')  graphics card: $cuda"

try {
  # ---------- 1. uv (fast Python installer) ----------
  Say 3 'Checking the installer tools'
  $uv = "$RT\uv\uv.exe"
  if (-not (Works $uv @('--version'))) {
    if (-not $Fix) { Bad 'uv is missing' } else {
      Say 4 'Downloading uv'
      Fetch 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' "$RT\uv.zip"
      Unzip "$RT\uv.zip" "$RT\uv"; Remove-Item "$RT\uv.zip"
      $found = Get-ChildItem "$RT\uv" -Recurse -Filter uv.exe | Select-Object -First 1
      if ($found.FullName -ne $uv) { Move-Item -Force $found.FullName $uv }
    }
  }

  # ---------- 2. Python ----------
  Say 6 'Checking Python 3.11'
  $pyExe = ManagedPython
  if (-not $pyExe -or -not (Works $pyExe @('-c', 'import sys'))) {
    if (-not $Fix) { Bad 'Python 3.11 is missing' } else {
      Say 7 'Installing Python 3.11'
      # a private copy: nothing goes to the registry or your user folder. uv's version link may be blocked; the install itself is enough
      $null = Run $uv @('python', 'install', '3.11', '--no-bin', '--no-registry') 'Installing Python' -Soft
      $pyExe = ManagedPython
      if (-not $pyExe -or -not (Works $pyExe @('-c', 'import sys'))) { throw 'Installing Python failed. Details: logs\setup.log' }
    }
  }

  # ---------- 3. the app ----------
  Say 12 'Checking the app'
  $appPy = "$Root\.venv\Scripts\python.exe"
  if (-not (Works $appPy @('-c', 'import fastapi, uvicorn, numpy, soundfile, multipart'))) {
    if (-not $Fix) { Bad 'The app''s Python packages are missing or broken' } else {
      Say 13 'Installing the app'
      $null = Run $pyExe @('-m', 'venv', '--without-pip', '--clear', "$Root\.venv") 'Creating the app environment'
      $null = Run $uv @('pip', 'install', '--python', $appPy, '-r', "$Root\requirements.txt") 'Installing the app packages'
    }
  }
  if (-not (Test-Path "$Root\ui\dist\index.html")) { Bad 'The app screen (ui\dist) is missing: reinstall VoiceBird' }

  # ---------- 4. FFmpeg (audio processing) ----------
  Say 20 'Checking FFmpeg'
  $ff = "$RT\ffmpeg\ffmpeg.exe"
  $ffOk = (Works $ff @('-version'))
  if ($ffOk) { $ffOk = [bool](& $ff -hide_banner -filters 2> $null | Select-String -SimpleMatch 'rubberband') }
  if (-not $ffOk) {
    if (-not $Fix) { Bad 'FFmpeg is missing' } else {
      Say 21 'Downloading FFmpeg'
      Fetch 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' "$RT\ffmpeg.zip"
      Unzip "$RT\ffmpeg.zip" "$RT\ffmpeg-x"; Remove-Item "$RT\ffmpeg.zip"
      New-Item -ItemType Directory -Force "$RT\ffmpeg" | Out-Null
      Get-ChildItem "$RT\ffmpeg-x" -Recurse -Include ffmpeg.exe, ffprobe.exe | Move-Item -Destination "$RT\ffmpeg" -Force
      Remove-Item -Recurse -Force "$RT\ffmpeg-x"
      if (-not (Works $ff @('-version'))) { throw 'FFmpeg did not start after installing' }
    }
  }

  # ---------- 5. Whisper (transcripts and subtitles) ----------
  Say 27 'Checking speech recognition'
  $wdir = "$RT\whisper"; $wcli = "$wdir\whisper-cli.exe"
  if (-not (Works $wcli @('--help'))) {
    if (-not $Fix) { Bad 'Whisper is missing' } else {
      Say 28 'Downloading Whisper'
      # the Windows builds sit on the numbered build releases, so take the newest release that has one
      $rels = Invoke-RestMethod -UseBasicParsing 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20'
      $asset = $rels | ForEach-Object { $_.assets } | Where-Object { $_.name -eq 'whisper-bin-x64.zip' } | Select-Object -First 1
      if (-not $asset) { throw 'Could not find the Whisper download' }
      Fetch $asset.browser_download_url "$RT\whisper.zip"
      Unzip "$RT\whisper.zip" "$RT\whisper-x"; Remove-Item "$RT\whisper.zip"
      New-Item -ItemType Directory -Force $wdir | Out-Null
      Get-ChildItem "$RT\whisper-x" -Recurse -Include *.exe, *.dll | Move-Item -Destination $wdir -Force
      Remove-Item -Recurse -Force "$RT\whisper-x"
    }
  }
  $haveModel = Get-ChildItem $wdir -Filter 'ggml-*.en.bin' -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 50MB }
  if (-not $haveModel) {
    if (-not $Fix) { Bad 'The Whisper model is missing' } else {
      Say 32 "Downloading the speech model ($Whisper)"
      Fetch "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Whisper.en.bin" "$wdir\ggml-$Whisper.en.bin"
    }
  }

  # ---------- 6. voice engines ----------
  $span = 55 / [Math]::Max(1, $sel.Count); $i = 0
  foreach ($id in $sel) {
    $base = 40 + $span * $i; $i++
    $name = (Get-Content "$Root\engines\$id\engine.json" -Raw | ConvertFrom-Json).name -replace '\s*\(.*\)$', ''
    $epy = "$Root\engines\$id\.venv\Scripts\python.exe"
    Say $base "Checking $name"
    if (-not (Works $epy @('-c', "import torch, $($EngineModule[$id])"))) {
      if (-not $Fix) { Bad "$name is not installed or broken"; continue }
      $useCuda = $cuda -and $id -ne 'sopro'
      Say ($base + $span * 0.1) "Installing $name$(if ($useCuda) { ' for your graphics card' } else { '' }) (large download)"
      $null = Run $pyExe @('-m', 'venv', '--without-pip', '--clear', "$Root\engines\$id\.venv") "Creating the $name environment"
      $idx = if ($useCuda) { 'https://download.pytorch.org/whl/cu124' } else { 'https://download.pytorch.org/whl/cpu' }
      $null = Run $uv @('pip', 'install', '--python', $epy, 'torch==2.6.0', 'torchaudio==2.6.0', '--index-url', $idx) "Installing PyTorch for $name"
      Say ($base + $span * 0.45) "Installing $name packages"
      $null = Run $uv @('pip', 'install', '--python', $epy, '-r', "$Root\engines\$id\requirements.txt") "Installing $name"
    }
    if ($Fix -and -not $NoModels) {
      Say ($base + $span * 0.6) "Downloading and testing the $name voice model"
      $env:PYTHONPATH = "$Root\engines;$Root\engines\$id"
      $null = Run $epy @('-c', 'import worker; worker.load(); print("model ok")') "Loading the $name model"
      Remove-Item Env:PYTHONPATH
    }
  }

  # ---------- 7. your data and settings ----------
  Say 96 'Checking your voices, projects and settings'
  if (Test-Path $appPy) {
    $check = @'
import json, pathlib, shutil, sys, time  # prints one unreadable file per line
root, fix = pathlib.Path(sys.argv[1]), sys.argv[2] == "fix"
stamp, bad = time.strftime("%Y%m%d-%H%M%S"), []
files = [*root.glob("voices/*/voice.json"), *root.glob("projects/*/project.json"),
         root / "projects/_folders/folders.json", root / "words.json", root / "presets.json"]
for f in files:
    if not f.exists():
        continue
    try:
        json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        bad.append(str(f.relative_to(root)))
        if fix:  # keep the broken file for recovery, give the app a clean one
            dst = root / ".broken" / stamp / f.relative_to(root)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(f), dst)
            if f.name in ("words.json", "presets.json", "folders.json"):
                f.write_text("[]", encoding="utf-8")
if fix:
    for t in (root / ".cache" / "tmp").glob("*.wav"):
        try:
            t.unlink()
        except OSError:
            pass
print(chr(10).join(bad))
'@
    $script = "$Root\.cache\tmp\check_data.py"
    Set-Content -LiteralPath $script -Value $check -Encoding ASCII
    $out = & $appPy $script $Root $(if ($Fix) { 'fix' } else { 'check' }) 2>> $LogFile
    $broken = @($out | Where-Object { $_ -and $_.Trim() })
    foreach ($b in $broken) { if ($Fix) { Log "moved aside: $b"; Say 97 "Moved an unreadable file aside: $b (kept in .broken\)" } else { Bad "Unreadable file: $b" } }
    Remove-Item $script -ErrorAction SilentlyContinue
  }

  if ($Problems.Count) {
    Say 100 "Found $($Problems.Count) problem(s). Run Repair VoiceBird to fix them."
    Done 1
  }
  Say 100 $(if ($Mode -eq 'verify') { 'Everything is healthy' } else { 'VoiceBird is ready' })
  Done 0
}
catch {
  Log "FAILED: $($_.Exception.Message)"
  if ($Pretty) { Write-Host "`n  Setup stopped: $($_.Exception.Message)" -ForegroundColor Red } else { Write-Output "!! $($_.Exception.Message)" }
  Done 2
}
