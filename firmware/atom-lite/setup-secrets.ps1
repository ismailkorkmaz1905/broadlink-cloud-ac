# Writes secrets.yaml (Wi-Fi from the network this PC is on, random keys) and uploads DEVICE_KEY to the Worker.
# Run from the repo root: powershell -ExecutionPolicy Bypass -File firmware\atom-lite\setup-secrets.ps1
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')

$iface = netsh wlan show interfaces | Out-String
if ($iface -notmatch '(?m)^\s*SSID\s*:\s*(.+?)\s*$') { throw 'Bu bilgisayar Wi-Fi aginda degil.' }
$ssid = $Matches[1]

$pw = $null
$tmp = Join-Path $env:TEMP ('wifi-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  netsh wlan export profile name="$ssid" key=clear folder="$tmp" | Out-Null
  $xml = Get-ChildItem $tmp -Filter *.xml | Select-Object -First 1
  if ($xml) { $pw = ([xml](Get-Content $xml.FullName -Raw -Encoding UTF8)).WLANProfile.MSM.security.sharedKey.keyMaterial }
} catch { } finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
if (-not $pw) { $pw = Read-Host "Wi-Fi sifresi okunamadi, '$ssid' sifresini yaz" }

$url = Read-Host 'Worker adresi (https://....workers.dev)'
$url = ($url -replace '\?.*$', '').Trim().TrimEnd('/')
if ($url -notmatch '^https://') { throw 'Adres https:// ile baslamali.' }

$chars = [char[]](48..57 + 97..122)
$key = -join (1..40 | ForEach-Object { Get-Random -InputObject $chars })
$ota = -join (1..24 | ForEach-Object { Get-Random -InputObject $chars })
$q = { param($v) '"' + ($v -replace '\\', '\\' -replace '"', '\"') + '"' }
$txt = "wifi_ssid: $(& $q $ssid)`nwifi_password: $(& $q $pw)`ndevice_url: $(& $q "$url/api/device")`ndevice_key: $(& $q $key)`nota_password: $(& $q $ota)`n"
[IO.File]::WriteAllText((Join-Path $repo 'firmware\atom-lite\secrets.yaml'), $txt, (New-Object Text.UTF8Encoding $false))
Write-Host "secrets.yaml yazildi (Wi-Fi: $ssid)."

Push-Location (Join-Path $repo 'cloud')
try { $key | npx wrangler secret put DEVICE_KEY } finally { Pop-Location }
