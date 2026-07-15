# Creates "Directors Desktop" shortcuts (Desktop + Start Menu) that launch the
# app with the real app icon, console minimized. Run once:
#   powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
$ErrorActionPreference = 'Stop'

$Repo = Split-Path -Parent $PSScriptRoot
$Icon = Join-Path $Repo 'resources\icon.ico'
$Target = Join-Path $Repo 'scripts\launch-app.bat'

if (-not (Test-Path $Icon)) { throw "Icon not found: $Icon" }
if (-not (Test-Path $Target)) { throw "Launcher not found: $Target" }

$Locations = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Directors Desktop.lnk'),
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Directors Desktop.lnk')
)

$Shell = New-Object -ComObject WScript.Shell
foreach ($LnkPath in $Locations) {
    $Lnk = $Shell.CreateShortcut($LnkPath)
    $Lnk.TargetPath = $Target
    $Lnk.WorkingDirectory = $Repo
    $Lnk.IconLocation = "$Icon,0"
    $Lnk.WindowStyle = 7   # start the console window minimized
    $Lnk.Description = 'Launch Directors Desktop'
    $Lnk.Save()
    Write-Host "Created: $LnkPath"
}
