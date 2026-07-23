# package-python.ps1
# Packages the prepared python-embed runtime into the downloadable release
# archives the app expects (electron/python-setup.ts):
#
#   python-embed-win32.manifest.json   { totalSize, parts: [{ name, size }] }
#   python-embed-win32.tar.gz.part0    raw byte split of the tar.gz
#   python-embed-win32.tar.gz.part1    ...
#
# The app downloads the manifest, fetches each part, concatenates them back
# into one tar.gz, and extracts it (the archive's top-level dir MUST be
# "python-embed"). Parts stay under GitHub's 2 GB per-asset limit.
#
# Usage:  pwsh scripts/package-python.ps1 [-PartSizeMB 1800] [-OutDir release/python-dist]

param(
    [int]$PartSizeMB = 1800,
    [string]$OutDir = "release/python-dist"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

if (-not (Test-Path "python-embed")) {
    Write-Host "ERROR: python-embed not found. Run scripts/prepare-python.ps1 first." -ForegroundColor Red
    exit 1
}

$OutPath = Join-Path $ProjectDir $OutDir
New-Item -ItemType Directory -Force -Path $OutPath | Out-Null

$TarPath = Join-Path $OutPath "python-embed-win32.tar.gz"

Write-Host "[1/3] Creating tar.gz from python-embed (this takes a few minutes)..." -ForegroundColor Yellow
if (Test-Path $TarPath) { Remove-Item $TarPath -Force }
# bsdtar ships with Windows 10+. -C keeps "python-embed" as the top-level entry,
# which is what the extractor looks for.
tar -czf $TarPath -C $ProjectDir python-embed
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: tar failed." -ForegroundColor Red
    exit 1
}

$TarSize = (Get-Item $TarPath).Length
Write-Host ("      archive: {0:N2} GB" -f ($TarSize / 1GB)) -ForegroundColor Green

Write-Host "[2/3] Splitting into parts (<= $PartSizeMB MB each)..." -ForegroundColor Yellow
$PartSize = $PartSizeMB * 1MB
$Parts = @()
$Buffer = New-Object byte[] (8MB)

$Reader = [System.IO.File]::OpenRead($TarPath)
try {
    $index = 0
    while ($Reader.Position -lt $Reader.Length) {
        $PartName = "python-embed-win32.tar.gz.part$index"
        $PartPath = Join-Path $OutPath $PartName
        $Writer = [System.IO.File]::Create($PartPath)
        try {
            $written = 0
            while ($written -lt $PartSize -and $Reader.Position -lt $Reader.Length) {
                $toRead = [Math]::Min($Buffer.Length, $PartSize - $written)
                $read = $Reader.Read($Buffer, 0, $toRead)
                if ($read -le 0) { break }
                $Writer.Write($Buffer, 0, $read)
                $written += $read
            }
        } finally {
            $Writer.Dispose()
        }
        $Parts += [PSCustomObject]@{ name = $PartName; size = (Get-Item $PartPath).Length }
        Write-Host ("      {0}  {1:N2} GB" -f $PartName, ((Get-Item $PartPath).Length / 1GB))
        $index++
    }
} finally {
    $Reader.Dispose()
}

Write-Host "[3/3] Writing manifest..." -ForegroundColor Yellow
$Manifest = [PSCustomObject]@{
    totalSize = $TarSize
    parts     = $Parts
}
$ManifestPath = Join-Path $OutPath "python-embed-win32.manifest.json"
$Manifest | ConvertTo-Json -Depth 5 | Out-File -FilePath $ManifestPath -Encoding utf8

# The single joined archive is no longer needed once split.
Remove-Item $TarPath -Force

$Version = (Get-Content (Join-Path $ProjectDir "package.json") -Raw | ConvertFrom-Json).version
Write-Host ""
Write-Host "Done. Upload these to the GitHub release tagged v$Version" -ForegroundColor Green
Write-Host "(repo: taskmasterpeace/Directors-Desktop — must match electron/python-setup.ts):" -ForegroundColor Green
Get-ChildItem $OutPath | ForEach-Object { Write-Host ("  {0,-42} {1:N2} GB" -f $_.Name, ($_.Length / 1GB)) }
Write-Host ""
Write-Host "The app fetches <release>/python-embed-win32.manifest.json, then each part." -ForegroundColor DarkGray
