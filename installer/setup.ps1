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
# slow or shaky connections: long timeouts, retries, plain resumable HTTP downloads
$env:UV_HTTP_TIMEOUT = '300'; $env:UV_HTTP_RETRIES = '5'
$env:HF_HUB_DOWNLOAD_TIMEOUT = '120'; $env:HF_HUB_ETAG_TIMEOUT = '60'; $env:HF_HUB_DISABLE_XET = '1'

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
  if ($code -ne 0 -and -not $Soft) {
    $why = @($out | Where-Object { "$_".Trim() } | Select-Object -Last 1) -join ''
    throw "$what failed$(if ($why) { ': ' + $why.Trim() } else { " (code $code)" }). Details: logs\setup.log"
  }
  return $code
}
function Uv([string[]]$a, [string]$what) {
  for ($try = 1; $try -le 3; $try++) {
    if ((Run $uv $a $what -Soft) -eq 0) { return }
    Log "$what failed, try $try of 3"; Start-Sleep -Seconds (10 * $try)
  }
  throw "$what failed after 3 tries. Details: logs\setup.log"
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
# What a tool prints; never stops setup (its error text goes to the log).
function Ask([string]$exe, [string[]]$a) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $all = & $exe @a 2>&1
  $ErrorActionPreference = $old
  foreach ($l in $all) { if ($l -is [Management.Automation.ErrorRecord]) { Log "  $l" } else { $l } }
}
# Stop with a clear message before a big download that would not fit (a full disk breaks installs halfway).
function Room([double]$gb, [string]$what) {
  try { $d = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($Root)); $free = $d.AvailableFreeSpace / 1GB } catch { return }
  if ($free -lt $gb) {
    throw ('Not enough free space on {0} for {1}: about {2} GB is needed, {3:N1} GB is free. Free some space, then run Repair VoiceBird.' -f $d.Name.TrimEnd('\'), $what, $gb, $free)
  }
}
# Size of a file on the server (follows redirects), or 0 when unknown.
function RemoteSize([string]$url) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $h = & curl.exe -sIL --connect-timeout 30 $url 2>$null
  $ErrorActionPreference = $old
  $len = $h | Select-String -Pattern '^content-length:\s*(\d+)' | Select-Object -Last 1
  if ($len) { return [int64]$len.Matches[0].Groups[1].Value } else { return [int64]0 }
}
# Download with resume (a stopped download continues), retries, stall detection and a size check.
function Fetch([string]$url, [string]$dest) {
  $part = "$dest.part"
  $want = RemoteSize $url
  for ($try = 1; $try -le 5; $try++) {
    Log "download $url (try $try)"
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $err = & curl.exe -L --fail --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 30 `
      --speed-limit 4096 --speed-time 60 -C - -s -S -o $part $url 2>&1 | Out-String
    $code = $LASTEXITCODE; $ErrorActionPreference = $old
    if ($err.Trim()) { Add-Content -LiteralPath $LogFile -Value "  $($err.Trim())" -Encoding UTF8 }
    $have = if (Test-Path $part) { (Get-Item $part).Length } else { 0 }
    if ($code -eq 0 -and ($want -eq 0 -or $have -eq $want)) { Move-Item -Force $part $dest; return }
    if ($code -in 22, 33, 36 -or ($want -gt 0 -and $have -gt $want)) { Remove-Item $part -ErrorAction SilentlyContinue }  # can't resume: start over
    Start-Sleep -Seconds (5 * $try)
  }
  throw "Download did not finish after 5 tries: $url"
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
      Uv @('pip', 'install', '--python', $appPy, '-r', "$Root\requirements.txt") 'Installing the app packages'
    }
  }
  if (-not (Test-Path "$Root\ui\dist\index.html")) { Bad 'The app screen (ui\dist) is missing: reinstall VoiceBird' }

  # ---------- 4. FFmpeg (audio processing) ----------
  Say 20 'Checking FFmpeg'
  $ff = "$RT\ffmpeg\ffmpeg.exe"
  $ffOk = (Works $ff @('-version'))
  if ($ffOk) { $ffOk = [bool](Ask $ff @('-hide_banner', '-filters') | Select-String -SimpleMatch 'rubberband') }
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
  $model = Get-ChildItem $wdir -Filter 'ggml-*.en.bin' -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 1
  if (-not $Fix) { if (-not $model -or $model.Length -lt 50MB) { Bad 'The Whisper model is missing' } }
  else {
    $name = if ($model) { $model.Name } else { "ggml-$Whisper.en.bin" }
    $url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$name"
    $want = RemoteSize $url
    if (-not $model -or ($want -gt 0 -and $model.Length -ne $want)) {
      Room 2 'the speech model'
      Say 32 "Downloading the speech model ($($name -replace 'ggml-|\.en\.bin',''))"
      if ($model) { Move-Item -Force $model.FullName "$wdir\$name.part" }  # finish a cut-off copy instead of starting over
      Fetch $url "$wdir\$name"
    }
  }

  # ---------- 6. voice engines ----------
  $span = 55 / [Math]::Max(1, $sel.Count); $i = 0
  foreach ($id in $sel) {
    $base = 40 + $span * $i; $i++
    $name = (Get-Content "$Root\engines\$id\engine.json" -Raw | ConvertFrom-Json).name -replace '\s*\(.*\)$', ''
    $epy = "$Root\engines\$id\.venv\Scripts\python.exe"
    Say $base "Checking $name"
    try {
      $useCuda = $cuda -and $id -ne 'sopro'
      if (-not (Works $epy @('-c', "import torch, $($EngineModule[$id])"))) {
        if (-not $Fix) { Bad "$name is not installed or broken"; continue }
        Say ($base + $span * 0.05) "Installing $name$(if ($useCuda) { ' for your graphics card' } else { '' }) (large download)"
        $null = Run $pyExe @('-m', 'venv', '--without-pip', '--clear', "$Root\engines\$id\.venv") "Creating the $name environment"
      }
      if (-not $Fix) { continue }
      # the right PyTorch (graphics card or processor) and every package: quick when all is already fine
      $have = Ask $epy @('-c', "import torch; print('cuda' if torch.version.cuda else 'cpu')") | Select-Object -Last 1
      $want = if ($useCuda) { 'cuda' } else { 'cpu' }
      if ($have -ne $want) {
        # PyTorch is big the first time; later engines reuse the copy that is already downloaded
        $tag = if ($useCuda) { 'cu124' } else { 'cpu' }
        $reuse = Test-Path "$Root\engines\*\.venv\Lib\site-packages\torch-2.6.0+$tag.dist-info"
        Room $(if ($reuse) { 1 } elseif ($useCuda) { 5 } else { 1.5 }) "PyTorch for $name"
        Say ($base + $span * 0.1) "Installing PyTorch for $name (large download)"
        $idx = if ($useCuda) { 'https://download.pytorch.org/whl/cu124' } else { 'https://download.pytorch.org/whl/cpu' }
        Uv @('pip', 'install', '--python', $epy, 'torch==2.6.0', 'torchaudio==2.6.0', '--index-url', $idx, '--reinstall-package', 'torch', '--reinstall-package', 'torchaudio') "Installing PyTorch for $name"
      }
      Say ($base + $span * 0.4) "Checking $name packages"
      Room 1 $name
      Uv @('pip', 'install', '--no-deps', '--python', $epy, '-r', "$Root\engines\$id\requirements.txt") "Installing $name"
      if ($NoModels) { continue }
      Say ($base + $span * 0.5) "Downloading the $name voice model (continues if it was cut off)"
      $env:PYTHONPATH = "$Root\engines;$Root\engines\$id"; $env:VOICEBIRD_REFRESH = '1'
      try { $null = Run $epy @('-c', 'import worker; print(worker.fetch())') "Downloading the $name model" }
      finally { $env:VOICEBIRD_REFRESH = '0' }
      Say ($base + $span * 0.85) "Starting $name once to test it"
      if ((Run $epy @('-c', "import worker; worker.load(); print('model ok')") "Starting $name" -Soft) -ne 0) {
        # downloaded fine but did not start here (for example, not enough graphics memory right now): not fatal
        $why = (Get-Content $LogFile -Encoding UTF8 | Where-Object { $_ -match 'Error|error:' } | Select-Object -Last 1)
        Log "WARNING: $name is installed but did not start in setup: $why"
        Write-Output "@@ $([int]($base + $span * 0.95)) $name is installed (it will start when you use it)"
      }
    }
    catch { Bad "$name`: $($_.Exception.Message)" }
    finally { Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue }
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
    $out = Ask $appPy @($script, $Root, $(if ($Fix) { 'fix' } else { 'check' }))
    $broken = @($out | Where-Object { $_ -and $_.Trim() })
    foreach ($b in $broken) { if ($Fix) { Log "moved aside: $b"; Say 97 "Moved an unreadable file aside: $b (kept in .broken\)" } else { Bad "Unreadable file: $b" } }
    Remove-Item $script -ErrorAction SilentlyContinue
  }

  if ($Problems.Count) {
    Say 100 $(if ($Fix) { "Done, but $($Problems.Count) part(s) need another try: run Repair VoiceBird" } else { "Found $($Problems.Count) problem(s). Run Repair VoiceBird to fix them." })
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
