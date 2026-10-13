param([int]$PreferredPort = 18761, [string]$NodeExecutable, [switch]$InspectExistingOnly)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
if ($env:COLLAB_PROJECT_ROOT -and -not [IO.Path]::IsPathFullyQualified($env:COLLAB_PROJECT_ROOT)) { throw '启动配置的授权根必须是绝对路径。' }
$projectRoot = if ($env:COLLAB_PROJECT_ROOT) { (Resolve-Path -LiteralPath $env:COLLAB_PROJECT_ROOT).Path } else { $sourceRoot }
if (-not [IO.Path]::IsPathFullyQualified($projectRoot)) { throw '授权根必须是绝对目录。' }
$scriptPath = Join-Path $sourceRoot 'bridge\src\doubao-http-probe.mjs'
$logRoot = Join-Path $projectRoot 'logs\http-probe'
$serviceFile = Join-Path $logRoot 'desktop_probe-service.json'
$stdoutFile = Join-Path $logRoot 'desktop-probe-stdout.log'
$stderrFile = Join-Path $logRoot 'desktop-probe-stderr.log'
if (-not $scriptPath.StartsWith($sourceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '服务脚本超出源码范围。' }
$probeCandidates = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' AND CommandLine LIKE '%doubao-http-probe.mjs%'" -ErrorAction Stop)
$sameSourceProbes = @($probeCandidates | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($scriptPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine -match '(?:^|\s)--instance\s+(?:"desktop_probe"|desktop_probe)(?=\s|$)'
})
if ($InspectExistingOnly) {
    [pscustomobject]@{ExistingSameSourceProbeCount=$sameSourceProbes.Count;ExistingPids=@($sameSourceProbes | ForEach-Object ProcessId);StartupBlocked=($sameSourceProbes.Count -gt 0);AnyProcessStarted=$false;CommandLinesPrinted=$false} | ConvertTo-Json -Depth 3
    return
}
if ($sameSourceProbes.Count -gt 0) { throw '同源码 desktop_probe 实例仍在运行，禁止因日志布局变化重复部署。' }
if (-not $NodeExecutable) { $NodeExecutable = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source }
$NodeExecutable = (Resolve-Path -LiteralPath $NodeExecutable).Path
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
if (Test-Path -LiteralPath $serviceFile) {
    $previous = Get-Content -LiteralPath $serviceFile -Raw -Encoding utf8 | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($previous.pid)" -ErrorAction SilentlyContinue
    if ($existing -and $existing.CommandLine -like '*doubao-http-probe.mjs*' -and $existing.CommandLine -like '*desktop_probe*') {
        throw '已有已登记探针进程；请先核对现有服务，禁止重复启动。'
    }
    throw '已有历史部署记录；请先由 manager 核查，禁止静默替换身份或挑战码。'
}
$selectedPort = $null
$portChecks = @()
foreach ($candidatePort in $PreferredPort..($PreferredPort + 9)) {
    $listener = @(Get-NetTCPConnection -LocalPort $candidatePort -State Listen -ErrorAction SilentlyContinue)
    $portChecks += [pscustomobject]@{Port=$candidatePort;Occupied=($listener.Count -gt 0)}
    if ($listener.Count -eq 0) { $selectedPort=$candidatePort; break }
}
if ($null -eq $selectedPort) { throw '候选本机端口均占用，未启动服务。' }
$arguments = @('"' + $scriptPath + '"', '--instance', 'desktop_probe', '--port', $selectedPort.ToString())
$helper = Start-Process -FilePath $NodeExecutable -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
[pscustomobject]@{StartedAt=[DateTimeOffset]::Now.ToString('o');Pid=$helper.Id;Executable=$NodeExecutable;Arguments=$arguments;WindowStyle='Hidden';PortChecks=$portChecks;HeaderValueLogged=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $logRoot 'hidden-helper-launch.json') -Encoding utf8
$service = $null
for ($probeAttempt=0; $probeAttempt -lt 40; $probeAttempt++) {
    if (Test-Path -LiteralPath $serviceFile) { $service = Get-Content -LiteralPath $serviceFile -Raw -Encoding utf8 | ConvertFrom-Json; break }
    if ($helper.HasExited) { throw '探针进程启动失败，请查看 desktop-probe-stderr.log，不自动重启。' }
    Start-Sleep -Milliseconds 250
}
if ($null -eq $service) { throw '探针启动状态不确定；保留 PID 与日志，不自动重启。' }
$localKeyPath = [IO.Path]::GetFullPath($service.privateKeyFile)
$allowedKeyRoot = Join-Path $projectRoot 'artifacts\t1\doubao-probe'
if (-not $localKeyPath.StartsWith($allowedKeyRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '本地身份文件超出授权目录。' }
$localProbeKey = Get-Content -LiteralPath $localKeyPath -Raw -Encoding utf8
$health = Invoke-RestMethod -Uri $service.healthUrl -Headers @{Authorization=('Bearer ' + $localProbeKey)} -TimeoutSec 10
$listener = @(Get-NetTCPConnection -LocalPort $selectedPort -State Listen -ErrorAction Stop | Where-Object OwningProcess -eq $helper.Id)
if ($health.deploymentId -ne $service.deploymentId -or $listener.Count -ne 1 -or $listener[0].LocalAddress -ne '127.0.0.1') { throw '服务健康或监听身份不一致，未认定部署就绪。' }
[pscustomobject]@{CheckedAt=[DateTimeOffset]::Now.ToString('o');Health=$health;Pid=$helper.Id;LocalAddress=$listener[0].LocalAddress;Port=$selectedPort;Endpoint=$service.endpoint;PrivateKeyFile=$service.privateKeyFile;HeaderValueLogged=$false;RealDoubaoVerified=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $logRoot 'hidden-helper-health.json') -Encoding utf8
[pscustomobject]@{Endpoint=$service.endpoint;ServerName='AI协作站-豆包只读探针';HeaderName='Authorization';HeaderValuePrefix='Bearer ';PrivateKeyFile=$service.privateKeyFile;Pid=$helper.Id;DeploymentId=$service.deploymentId} | ConvertTo-Json -Depth 4
