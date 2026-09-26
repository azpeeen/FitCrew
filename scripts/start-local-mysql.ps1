# Inicia o MySQL local portátil usado por `npm run dev` / `npm run dev:watch`.
# Não é um serviço do Windows (a instalação via winget precisa de admin, que
# não estava disponível) — então precisa rodar isso manualmente a cada sessão
# de desenvolvimento, antes de subir o servidor Node.
#
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\start-local-mysql.ps1

$mysqlDir = "$env:USERPROFILE\mysql-portable"
$iniFile  = Join-Path $mysqlDir "my.ini"
$mysqld   = Join-Path $mysqlDir "mysql-8.4.9-winx64\bin\mysqld.exe"

if (-not (Test-Path $mysqld)) {
    Write-Error "MySQL portátil não encontrado em $mysqld"
    exit 1
}

$existing = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output "MySQL já está rodando na porta 3306."
    exit 0
}

Write-Output "Iniciando MySQL local (porta 3306)..."
Start-Process -FilePath $mysqld -ArgumentList "--defaults-file=`"$iniFile`"" -WindowStyle Hidden

Start-Sleep -Seconds 3
$listening = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Output "MySQL local pronto em 127.0.0.1:3306 (banco: gymbros_dev)."
} else {
    Write-Warning "MySQL nao respondeu na porta 3306 -- confira os logs em $mysqlDir\mysqld.log"
}
