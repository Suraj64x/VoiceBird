; VoiceBird installer (Inno Setup 7). Build with installer\build.ps1, which stages the app into build\app first.
; The wizard copies the app (a few MB), then setup.ps1 downloads and checks Python, FFmpeg, Whisper and the
; chosen voice engines, with live progress in the wizard. Running the installer again repairs a broken install.

#define AppName "VoiceBird"
#ifndef AppVersion
  #define AppVersion "1.0"
#endif
#ifndef SourceDir
  #define SourceDir "build\app"
#endif

[Setup]
AppId={{8C2F3B6E-6C7A-4E0B-9F3D-5A1B7C2E9D41}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=VoiceBird
AppPublisherURL=https://github.com/Suraj64x/VoiceBird
AppSupportURL=https://github.com/Suraj64x/VoiceBird/issues
AppComments=Clone your voice and make voice-overs, free and on your own PC.
DefaultDirName={localappdata}\Programs\VoiceBird
DefaultGroupName=VoiceBird
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern dark
WizardSizePercent=115
WizardImageFile=art\wizard-164.bmp,art\wizard-192.bmp,art\wizard-246.bmp,art\wizard-273.bmp,art\wizard-328.bmp,art\wizard-355.bmp,art\wizard-410.bmp
WizardSmallImageFile=art\small-55.bmp,art\small-64.bmp,art\small-83.bmp,art\small-92.bmp,art\small-110.bmp,art\small-119.bmp,art\small-138.bmp
SetupIconFile=art\voicebird.ico
UninstallDisplayIcon={app}\voicebird.ico
UninstallDisplayName={#AppName}
OutputDir=dist
OutputBaseFilename=VoiceBird-Setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
SetupLogging=yes
ShowLanguageDialog=no
CloseApplications=no

[Messages]
WelcomeLabel1=Welcome to VoiceBird
WelcomeLabel2=Clone your voice and turn any script into a studio-ready voice-over, free and fully on this PC.%n%nSetup downloads Python, the voice engines you pick and their models. Keep the internet on; it can take a while the first time.
FinishedHeadingLabel=VoiceBird is ready
FinishedLabel=Everything is installed and checked.%n%nIf anything ever breaks, run Repair VoiceBird from the Start menu, or this installer again. Your voices and projects are always kept.

[Types]
Name: "recommended"; Description: "Recommended: Qwen3 and Chatterbox Nano"
Name: "full"; Description: "Everything: all five voice engines"
Name: "custom"; Description: "Custom"; Flags: iscustom

[Components]
Name: "app"; Description: "VoiceBird app"; Types: recommended full custom; Flags: fixed; ExtraDiskSpaceRequired: 700000000
Name: "engines"; Description: "Voice engines"; Types: recommended full custom
Name: "engines\qwen3"; Description: "Qwen3: closest match to your voice"; Types: recommended full custom; ExtraDiskSpaceRequired: 5500000000
Name: "engines\nano"; Description: "Chatterbox Nano: fastest"; Types: recommended full; ExtraDiskSpaceRequired: 1500000000
Name: "engines\chatterbox"; Description: "Chatterbox: real emotion control"; Types: full; ExtraDiskSpaceRequired: 3000000000
Name: "engines\voxcpm"; Description: "VoxCPM: voice timbre and accent"; Types: full; ExtraDiskSpaceRequired: 2500000000
Name: "engines\sopro"; Description: "Sopro: works without a graphics card"; Types: full; ExtraDiskSpaceRequired: 1200000000
Name: "speech"; Description: "Speech recognition (transcripts and subtitles)"; Types: recommended full custom; Flags: fixed
Name: "speech\small"; Description: "Balanced"; Types: recommended custom; Flags: exclusive; ExtraDiskSpaceRequired: 490000000
Name: "speech\medium"; Description: "Most accurate"; Types: full; Flags: exclusive; ExtraDiskSpaceRequired: 1550000000
Name: "speech\base"; Description: "Smallest"; Flags: exclusive; ExtraDiskSpaceRequired: 150000000

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "art\voicebird.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\VoiceBird"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\VoiceBird.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\voicebird.ico"; Comment: "Open VoiceBird"
Name: "{group}\Repair VoiceBird"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\setup.ps1"" -Mode repair"; WorkingDir: "{app}"; IconFilename: "{app}\voicebird.ico"; Comment: "Check and fix VoiceBird"
Name: "{group}\Uninstall VoiceBird"; Filename: "{uninstallexe}"
Name: "{autodesktop}\VoiceBird"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\VoiceBird.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\voicebird.ico"; Tasks: desktopicon

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\VoiceBird.vbs"""; Description: "Open VoiceBird now"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; everything VoiceBird downloaded; your voices, projects and settings are only removed if you say so
Type: filesandordirs; Name: "{app}\.venv"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\models"
Type: filesandordirs; Name: "{app}\engines"
Type: filesandordirs; Name: "{app}\.cache"
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\ui"
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\installer"

[Code]
var
  Problems: String;

function Engines(): String;
begin
  Result := '';
  if WizardIsComponentSelected('engines\qwen3') then Result := Result + 'qwen3,';
  if WizardIsComponentSelected('engines\nano') then Result := Result + 'chatterbox-nano,';
  if WizardIsComponentSelected('engines\chatterbox') then Result := Result + 'chatterbox,';
  if WizardIsComponentSelected('engines\voxcpm') then Result := Result + 'voxcpm,';
  if WizardIsComponentSelected('engines\sopro') then Result := Result + 'sopro,';
  if Result = '' then Result := 'none';
end;

function SpeechModel(): String;
begin
  if WizardIsComponentSelected('speech\medium') then Result := 'medium'
  else if WizardIsComponentSelected('speech\base') then Result := 'base'
  else Result := 'small';
end;

{ Stop a VoiceBird that runs from this install folder (and only that), so its files can be replaced or removed. }
procedure StopVoiceBird();
var
  Code: Integer;
begin
  Exec('powershell.exe',
    '-NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ''' + ExpandConstant('{app}') +
    '\*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopVoiceBird();
  Result := '';
end;

{ setup.ps1 prints "@@ <percent> <text>" for progress and "!! <text>" for problems. }
procedure OnSetupOutput(const S: String; const Error, FirstLine: Boolean);
var
  Rest: String;
  Space, Pct: Integer;
begin
  Log(S);
  if Copy(S, 1, 3) = '@@ ' then
  begin
    Rest := Copy(S, 4, MaxInt);
    Space := Pos(' ', Rest);
    Pct := StrToIntDef(Copy(Rest, 1, Space - 1), -1);
    if Pct >= 0 then
    begin
      WizardForm.ProgressGauge.Position := Pct;
      WizardForm.StatusLabel.Caption := Copy(Rest, Space + 1, MaxInt);
    end;
  end
  else if Copy(S, 1, 3) = '!! ' then
    Problems := Problems + '  - ' + Copy(S, 4, MaxInt) + #13#10;
end;

procedure RunSetup();
var
  Code: Integer;
  Params: String;
begin
  WizardForm.ProgressGauge.Min := 0;
  WizardForm.ProgressGauge.Max := 100;
  WizardForm.ProgressGauge.Position := 0;
  WizardForm.StatusLabel.Caption := 'Getting ready';
  WizardForm.FilenameLabel.Caption := 'Downloading Python, the voice engines and their models. The first install can take a while.';
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\installer\setup.ps1') + '" -Mode install -Engines ' + Engines() + ' -Whisper ' + SpeechModel();
  Problems := '';
  if not ExecAndLogOutput('powershell.exe', Params, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code, @OnSetupOutput) then
    Problems := '  - Setup could not start PowerShell.' + #13#10;
  if (Code <> 0) or (Problems <> '') then
    SuppressibleMsgBox('VoiceBird is installed, but some parts need another try:' + #13#10#13#10 + Problems + #13#10 +
      'Open "Repair VoiceBird" from the Start menu (or run this installer again). It continues where it stopped and keeps everything that already worked.' + #13#10#13#10 +
      'Details: ' + ExpandConstant('{app}\logs\setup.log'), mbInformation, MB_OK, IDOK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then RunSetup();
end;

function InitializeUninstall(): Boolean;
begin
  StopVoiceBird();
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    if SuppressibleMsgBox('Also delete your voices, projects and settings?' + #13#10#13#10 +
      'Choose No to keep them for a later reinstall.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES then
      DelTree(ExpandConstant('{app}'), True, True, True);
end;
