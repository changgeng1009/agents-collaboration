param([string]$DotnetRoot,[string]$OutputDirectory)
$ErrorActionPreference='Stop'
$sourceRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if(-not $IsWindows){throw '构建仅支持Windows本机。'}
if(-not $DotnetRoot){$DotnetRoot=Split-Path (Get-Command dotnet.exe -ErrorAction Stop).Source -Parent}
$DotnetRoot=(Resolve-Path -LiteralPath $DotnetRoot).Path
$dotnet=Join-Path $DotnetRoot 'dotnet.exe'
$sdk=Get-ChildItem -LiteralPath (Join-Path $DotnetRoot 'sdk') -Directory | Where-Object {$_.Name -match '^\d+\.\d+\.\d+$'} | Sort-Object {[version]$_.Name} -Descending | Select-Object -First 1
$pack=Get-ChildItem -LiteralPath (Join-Path $DotnetRoot 'packs\Microsoft.NETCore.App.Ref') -Directory | Where-Object {$_.Name -match '^8\.0\.\d+$'} | Sort-Object {[version]$_.Name} -Descending | Select-Object -First 1
if(-not $sdk -or -not $pack){throw '需要本地Roslyn编译器及.NET8引用包；不会自动下载或恢复。'}
$compiler=Join-Path $sdk.FullName 'Roslyn\bincore\csc.dll'
$references=Join-Path $pack.FullName 'ref\net8.0'
if(-not $OutputDirectory){$OutputDirectory=Join-Path $sourceRoot ('bridge\runtime\windows-file-worker\build-'+[guid]::NewGuid().ToString('N'))}
$OutputDirectory=[IO.Path]::GetFullPath($OutputDirectory)
$relative=[IO.Path]::GetRelativePath((Join-Path $sourceRoot 'bridge\runtime'),$OutputDirectory)
if($relative -eq '..' -or $relative.StartsWith('..\') -or [IO.Path]::IsPathRooted($relative) -or (Test-Path -LiteralPath $OutputDirectory)){throw '输出必须为本项目runtime中全新目录，不覆盖历史产物。'}
$ancestor=Split-Path $OutputDirectory -Parent
while(-not (Test-Path -LiteralPath $ancestor)){$ancestor=Split-Path $ancestor -Parent}
if((Get-Item -LiteralPath $ancestor).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '输出目录祖先不能是重解析点。'}
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$utf8=[Text.UTF8Encoding]::new($false)
$native=Join-Path $sourceRoot 'bridge\native\WindowsFileWorker'
$response=Join-Path $OutputDirectory 'compile.rsp'
$arguments=@('/nologo','/target:exe','/nullable:enable','/langversion:latest','/nostdlib+','/deterministic+',('/pathmap:"'+$sourceRoot+'=/_/"'),('/out:"'+(Join-Path $OutputDirectory 'WindowsFileWorker.dll')+'"'))
$arguments+=Get-ChildItem -LiteralPath $references -Filter '*.dll' -File | Sort-Object Name | ForEach-Object {'/reference:"'+$_.FullName+'"'}
$arguments+=@(('"'+(Join-Path $native 'Native.cs')+'"'),('"'+(Join-Path $native 'Program.cs')+'"'))
[IO.File]::WriteAllLines($response,$arguments,$utf8)
# 直接运行已有编译器；不调用SDK命令、NuGet、工作负载或开发证书流程。
& $dotnet $compiler ('@'+$response) *> (Join-Path $OutputDirectory 'compiler.txt')
if($LASTEXITCODE -ne 0){throw '本地原生worker编译失败，保留输出目录。'}
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'WindowsFileWorker.runtimeconfig.json'),('{"runtimeOptions":{"tfm":"net8.0","framework":{"name":"Microsoft.NETCore.App","version":"'+$pack.Name+'"},"configProperties":{"System.Globalization.Invariant":true}}}'),$utf8)
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'WindowsFileWorker.deps.json'),'{"runtimeTarget":{"name":".NETCoreApp,Version=v8.0","signature":""},"compilationOptions":{},"targets":{},"libraries":{}}',$utf8)
$hashes=@{dotnet=(Get-FileHash -LiteralPath $dotnet -Algorithm SHA256).Hash.ToLowerInvariant()}
foreach($name in @('WindowsFileWorker.dll','WindowsFileWorker.deps.json','WindowsFileWorker.runtimeconfig.json')){$hashes[$name]=(Get-FileHash -LiteralPath (Join-Path $OutputDirectory $name) -Algorithm SHA256).Hash.ToLowerInvariant()}
$result=@{status='compiled';dotnetExecutable=$dotnet;buildDirectory=$OutputDirectory;binaryHashes=$hashes;packageRestorePerformed=$false;profileCreated=$false;aclChanged=$false}
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'build-receipt.json'),($result | ConvertTo-Json -Depth 8),$utf8)
$result | ConvertTo-Json -Depth 8
