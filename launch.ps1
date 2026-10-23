# Starts VoiceBird without a console window and opens it in the browser. Used by the desktop/Start menu shortcut.
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Url = 'http://localhost:7878'
Add-Type -AssemblyName PresentationFramework

function Up { try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', 7878); $c.Close(); return $true } catch { return $false } }
function Repair([string]$why) {
  $r = [System.Windows.MessageBox]::Show("$why`n`nRepair VoiceBird now? It fixes missing or broken parts and keeps your voices and projects.",
    'VoiceBird', 'YesNo', 'Warning')
  if ($r -eq 'Yes') {
    Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$Root\installer\setup.ps1`"", '-Mode', 'repair' -Wait
    Start-Process wscript.exe "`"$Root\VoiceBird.vbs`""
  }
  exit 1
}

if (Up) { Start-Process $Url; exit 0 }   # already running

$py = "$Root\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) { Repair 'VoiceBird is missing some of its files.' }

New-Item -ItemType Directory -Force "$Root\logs" | Out-Null
Start-Process -FilePath $py -WorkingDirectory $Root -WindowStyle Hidden `
  -ArgumentList '-m', 'uvicorn', 'server.app:app', '--host', '127.0.0.1', '--port', '7878', '--log-level', 'warning' `
  -RedirectStandardOutput "$Root\logs\server-out.log" -RedirectStandardError "$Root\logs\server.log"

for ($i = 0; $i -lt 120; $i++) {   # up to a minute
  Start-Sleep -Milliseconds 500
  if (Up) { Start-Process $Url; exit 0 }
}
Repair 'VoiceBird did not start. Details are in logs\server.log.'
