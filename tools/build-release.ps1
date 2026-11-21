# Build release artifacts (ASCII-only on purpose: Windows PowerShell 5.1 reads
# BOM-less scripts as ANSI, so keep this file free of non-ASCII characters).
#
# Usage:
#   tools\build-release.cmd          (double-click / cmd)
#   powershell -ExecutionPolicy Bypass -File tools\build-release.ps1
#
# Output:
#   dist\bilishot-extension-v<version>.zip   -> extract, then "Load unpacked"
#   dist\bili-shot.user.js                   -> drag into Tampermonkey
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'extension\manifest.json'
$userScript = Join-Path $root 'userscript\bili-shot.user.js'

$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
$usText = Get-Content $userScript -Raw -Encoding UTF8
$usVersion = [regex]::Match($usText, '^//\s*@version\s+(\S+)', 'Multiline').Groups[1].Value

if ($usVersion -ne $version) {
  throw "Version mismatch: extension/manifest.json=$version, userscript @version=$usVersion"
}
Write-Host "Version: v$version"

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

$zip = Join-Path $dist "bilishot-extension-v$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Copy-Item $userScript (Join-Path $dist 'bili-shot.user.js') -Force

# Build the zip by hand: PS 5.1's Compress-Archive and .NET Framework's
# ZipFile both write backslash separators on Windows, which breaks extraction
# on Linux / 7-Zip, so write forward slashes explicitly.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$source = Join-Path $root 'extension'
$sourceRoot = (Resolve-Path $source).Path.TrimEnd('\')
$zipStream = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
$archiveOut = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in (Get-ChildItem -Path $source -Recurse -File)) {
    $relative = $file.FullName.Substring($sourceRoot.Length + 1).Replace('\', '/')
    $entry = $archiveOut.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
    $entryStream = $entry.Open()
    $fileStream = [System.IO.File]::OpenRead($file.FullName)
    try { $fileStream.CopyTo($entryStream) } finally { $fileStream.Dispose(); $entryStream.Dispose() }
  }
} finally {
  $archiveOut.Dispose()
  $zipStream.Dispose()
}

# Verify the archive layout: manifest.json must sit at the zip root,
# otherwise "Load unpacked" fails.
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
$entries = $archive.Entries | ForEach-Object { $_.FullName }
$archive.Dispose()

if ($entries -notcontains 'manifest.json') { throw 'manifest.json is not at zip root' }
if ($entries -notcontains 'background.js') { throw 'background.js missing from zip' }
if ($entries -notcontains 'content.js') { throw 'content.js missing from zip' }
$badEntry = $entries | Where-Object { $_ -like '*\*' } | Select-Object -First 1
if ($badEntry) { throw "zip entry uses backslash separator: $badEntry" }

Write-Host ''
Get-ChildItem $dist | ForEach-Object {
  $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.Substring(0, 16)
  '{0,-34} {1,8:N1} KB   sha256:{2}' -f $_.Name, ($_.Length / 1KB), $hash
}
Write-Host ''
Write-Host ("OK: {0} files in zip, manifest.json at root" -f $entries.Count)
