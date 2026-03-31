param(
    [Parameter(Mandatory = $true)]
    [string]$BridgePassword,

    [Parameter(Mandatory = $true)]
    [string]$EdgePassword,

    [string]$BridgeUser = 'drainage-cloud',
    [string]$EdgeUser = 'drainage-edge',
    [string]$BrokerHost = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$configDir = Join-Path $repoRoot 'infrastructure\mosquitto\config'
$certDir = Join-Path $repoRoot 'infrastructure\mosquitto\certs'
$dataDir = Join-Path $repoRoot 'infrastructure\mosquitto\data'
$logDir = Join-Path $repoRoot 'infrastructure\mosquitto\log'
$passwordFile = Join-Path $configDir 'passwordfile'

foreach ($path in @($configDir, $certDir, $dataDir, $logDir)) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path | Out-Null
    }
}

$docker = Get-Command docker -ErrorAction SilentlyContinue
$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $openssl -and -not $docker) {
    throw 'Either OpenSSL or Docker Desktop is required to generate the MQTT TLS certificates.'
}

function Invoke-OpenSsl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandLine
    )

    if ($script:openssl) {
        & $script:openssl.Source @($CommandLine -split ' ') | Out-Null
        return
    }

    & $script:docker.Source run --rm -v "${certDir}:/work" alpine:3.20 sh -lc "apk add --no-cache openssl >/dev/null && cd /work && openssl $CommandLine" | Out-Null
}

$caKey = Join-Path $certDir 'ca.key'
$caCert = Join-Path $certDir 'ca.crt'
$serverKey = Join-Path $certDir 'server.key'
$serverCsr = Join-Path $certDir 'server.csr'
$serverCert = Join-Path $certDir 'server.crt'
$serverExt = Join-Path $certDir 'server.ext'
$caSerial = Join-Path $certDir 'ca.srl'

Push-Location $certDir
try {
    if (-not (Test-Path $caCert)) {
        Invoke-OpenSsl 'genrsa -out ca.key 4096'
        Invoke-OpenSsl "req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.crt -subj /C=ZA/ST=WesternCape/L=CapeTown/O=SmartDrainage/OU=IoT/CN=smart-drainage-ca"
    }

    if (-not (Test-Path $serverCert)) {
        Invoke-OpenSsl 'genrsa -out server.key 2048'
        Invoke-OpenSsl "req -new -key server.key -out server.csr -subj /C=ZA/ST=WesternCape/L=CapeTown/O=SmartDrainage/OU=IoT/CN=localhost"
        @(
            'authorityKeyIdentifier=keyid,issuer',
            'basicConstraints=CA:FALSE',
            'keyUsage=digitalSignature,keyEncipherment',
            'extendedKeyUsage=serverAuth',
            'subjectAltName=DNS:localhost,IP:127.0.0.1'
        ) | Set-Content -Path $serverExt
        Invoke-OpenSsl 'x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 825 -sha256 -extfile server.ext'
    }
}
finally {
    Pop-Location
}

if (Test-Path $passwordFile) {
    Remove-Item $passwordFile -Force
}

$mosquittoPasswd = Get-Command mosquitto_passwd -ErrorAction SilentlyContinue
if ($mosquittoPasswd) {
    & $mosquittoPasswd.Source -b -c $passwordFile $BridgeUser $BridgePassword | Out-Null
    & $mosquittoPasswd.Source -b $passwordFile $EdgeUser $EdgePassword | Out-Null
}
else {
    if (-not $docker) {
        throw 'Either `mosquitto_passwd` or Docker Desktop must be installed to generate the MQTT password file.'
    }

    & $docker.Source run --rm -v "${configDir}:/work" eclipse-mosquitto mosquitto_passwd -b -c /work/passwordfile $BridgeUser $BridgePassword | Out-Null
    & $docker.Source run --rm -v "${configDir}:/work" eclipse-mosquitto mosquitto_passwd -b /work/passwordfile $EdgeUser $EdgePassword | Out-Null
}

Write-Host ''
Write-Host 'Optional local Mosquitto bootstrap complete.' -ForegroundColor Green
Write-Host "Broker host: $BrokerHost" -ForegroundColor Cyan
Write-Host 'If you want to use this local broker, copy `Demo/.env.example` to `Demo/.env` and set:' -ForegroundColor Yellow
Write-Host "  MQTT_HOST=$BrokerHost"
Write-Host '  MQTT_PORT=8883'
Write-Host "  MQTT_BRIDGE_USERNAME=$BridgeUser"
Write-Host '  MQTT_BRIDGE_PASSWORD=<your bridge password>'
Write-Host "  MQTT_EDGE_USERNAME=$EdgeUser"
Write-Host '  MQTT_EDGE_PASSWORD=<your edge password>'
Write-Host '  MQTT_CA_CERT=./infrastructure/mosquitto/certs/ca.crt'
Write-Host '  ENABLE_DEMO_SIMULATOR=false'
Write-Host ''
Write-Host 'This local broker path is optional. You can also use any existing managed MQTT broker with TLS on port 8883.' -ForegroundColor Yellow
