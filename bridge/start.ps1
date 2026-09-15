param([string]$Config = "config.json")
$ErrorActionPreference = "Stop"
Push-Location $PSScriptRoot
try {
    & node dist/index.js --config $Config
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
