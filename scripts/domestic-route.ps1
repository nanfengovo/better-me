#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Start', 'Stop', 'Status')]
    [string]$Action,
    [string]$InterfaceName,
    [ValidateRange(1024, 65535)]
    [int]$Port = 17891,
    [string]$DownloadProxy
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This helper requires Windows.'
}

$repositoryRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$helperDirectory = [IO.Path]::GetFullPath((Join-Path $repositoryRoot 'data/domestic-route'))
$configurationPath = Join-Path $helperDirectory 'config.yaml'
$binaryPath = Join-Path $helperDirectory 'mihomo-windows-amd64-compatible.exe'
$archivePath = Join-Path $helperDirectory 'mihomo-windows-amd64-compatible-v1.19.32.zip'
$statePath = Join-Path $helperDirectory 'process.json'
$releaseUrl = 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.32/mihomo-windows-amd64-compatible-v1.19.32.zip'
$releaseSha256 = '974a4d7ad69aed27aa2e8f91d61113573c14dadb14562c63e58effabf59816f0'
$utf8WithoutBom = New-Object Text.UTF8Encoding($false)

function Get-FileSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
}

function Write-AtomicText([string]$Path, [string]$Text) {
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, $Text, $utf8WithoutBom)
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Read-HelperState {
    if (-not (Test-Path -LiteralPath $statePath)) { return $null }
    if ((Get-Item -LiteralPath $statePath).Length -gt 8192) { throw 'Helper process record is too large.' }
    $record = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $record.PSObject.Properties['processId'] -or
        -not $record.PSObject.Properties['port'] -or
        [int]$record.processId -le 0 -or [int]$record.port -lt 1024 -or [int]$record.port -gt 65535) {
        throw 'Helper process record is invalid. No process has been changed.'
    }
    return $record
}

function Get-ProcessRecord([int]$ProcessId) {
    return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
}

function Test-HelperIdentity($Process) {
    if (-not $Process -or -not $Process.ExecutablePath -or -not $Process.CommandLine) { return $false }
    if (-not [string]::Equals([IO.Path]::GetFullPath($Process.ExecutablePath), $binaryPath, [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    # Parse actual Windows arguments; a substring match can accept a different config or extra flags.
    if (-not ('BetterMeDomesticRoute.NativeArguments' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace BetterMeDomesticRoute {
    public static class NativeArguments {
        [DllImport("shell32.dll", SetLastError = true)]
        private static extern IntPtr CommandLineToArgvW(
            [MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int count);
        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);
        public static string[] Parse(string commandLine) {
            int count;
            IntPtr memory = CommandLineToArgvW(commandLine, out count);
            if (memory == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            try {
                string[] result = new string[count];
                for (int i = 0; i < count; i++)
                    result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
                return result;
            } finally { LocalFree(memory); }
        }
    }
}
'@
    }
    $arguments = [BetterMeDomesticRoute.NativeArguments]::Parse($Process.CommandLine)
    return $arguments.Length -eq 5 -and $arguments[1] -eq '-d' -and $arguments[3] -eq '-f' -and
        [string]::Equals([IO.Path]::GetFullPath($arguments[0]), $binaryPath, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([IO.Path]::GetFullPath($arguments[2]), $helperDirectory, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([IO.Path]::GetFullPath($arguments[4]), $configurationPath, [StringComparison]::OrdinalIgnoreCase)
}

function Get-PortOwners([int]$LocalPort) {
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $LocalPort)
    return @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
}

function Get-HelperStatus([int]$LocalPort, $Record) {
    $owners = @(Get-PortOwners $LocalPort)
    if ($owners.Count -gt 0) {
        foreach ($owner in $owners) {
            $process = Get-ProcessRecord ([int]$owner)
            if (-not (Test-HelperIdentity $process)) {
                return [PSCustomObject]@{ state = 'port-conflict'; port = $LocalPort; processId = [int]$owner; message = 'Port belongs to another process. It will not be stopped or replaced.' }
            }
        }
        if ($owners.Count -ne 1) { throw 'Port has multiple owners; no process has been changed.' }
        return [PSCustomObject]@{ state = 'running'; port = $LocalPort; processId = [int]$owners[0]; proxyUrl = "http://127.0.0.1:$LocalPort"; configuration = $configurationPath }
    }
    if ($Record) {
        $process = Get-ProcessRecord ([int]$Record.processId)
        if ($process) {
            if (-not (Test-HelperIdentity $process)) {
                return [PSCustomObject]@{ state = 'identity-mismatch'; port = $LocalPort; processId = [int]$Record.processId; message = 'Recorded PID belongs to a different process. It will not be stopped.' }
            }
            return [PSCustomObject]@{ state = 'not-listening'; port = [int]$Record.port; processId = [int]$Record.processId; message = 'Owned helper exists but is not listening on the expected port.' }
        }
    }
    return [PSCustomObject]@{ state = 'stopped'; port = $LocalPort; installed = (Test-Path -LiteralPath $binaryPath) }
}

function Select-PhysicalInterface([string]$RequestedName) {
    $adapters = @(Get-NetAdapter -Physical -ErrorAction Stop | Where-Object Status -eq 'Up')
    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop)
    $interfaces = @(Get-NetIPInterface -AddressFamily IPv4 -ErrorAction Stop)
    $candidates = @(
        foreach ($adapter in $adapters) {
            if ($RequestedName -and $adapter.Name -ne $RequestedName) { continue }
            $route = @($routes | Where-Object InterfaceIndex -eq $adapter.ifIndex | Sort-Object RouteMetric | Select-Object -First 1)
            $ipInterface = @($interfaces | Where-Object InterfaceIndex -eq $adapter.ifIndex | Select-Object -First 1)
            if ($route.Count -and $ipInterface.Count) {
                [PSCustomObject]@{ name = $adapter.Name; interfaceIndex = [int]$adapter.ifIndex; effectiveMetric = [int]$ipInterface[0].InterfaceMetric + [int]$route[0].RouteMetric }
            }
        }
    )
    if (-not $candidates.Count) { throw 'No matching Up physical adapter with an IPv4 default route. Specify -InterfaceName explicitly after checking your connection.' }
    $selected = $candidates | Sort-Object effectiveMetric, interfaceIndex | Select-Object -First 1
    if ($selected.name -match '[\r\n&#]') { throw 'The interface name contains characters unsupported by this DNS binding configuration.' }
    return $selected
}

function Ensure-VerifiedBinary {
    if (-not (Test-Path -LiteralPath $archivePath)) {
        $temporaryArchive = "$archivePath.$([Guid]::NewGuid().ToString('N')).download"
        try {
            $request = @{ Uri = $releaseUrl; OutFile = $temporaryArchive; UseBasicParsing = $true; TimeoutSec = 120; MaximumRedirection = 5 }
            if ($DownloadProxy) {
                $proxyUri = $null
                if (-not [Uri]::TryCreate($DownloadProxy, [UriKind]::Absolute, [ref]$proxyUri) -or
                    $proxyUri.Scheme -notin @('http', 'https') -or $proxyUri.UserInfo -or
                    $proxyUri.Query -or $proxyUri.Fragment -or $proxyUri.AbsolutePath -ne '/') {
                    throw '-DownloadProxy must be an HTTP/HTTPS host and port without credentials or a path.'
                }
                $request.Proxy = $proxyUri.AbsoluteUri
            }
            Invoke-WebRequest @request
            if ((Get-FileSha256 $temporaryArchive) -ne $releaseSha256) {
                throw 'Downloaded archive SHA-256 does not match the pinned official release.'
            }
            Move-Item -LiteralPath $temporaryArchive -Destination $archivePath
        } finally {
            if (Test-Path -LiteralPath $temporaryArchive) { Remove-Item -LiteralPath $temporaryArchive -Force }
        }
    }
    if ((Get-FileSha256 $archivePath) -ne $releaseSha256) {
        throw 'Cached archive SHA-256 is invalid. It will not be executed or silently replaced.'
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $entries = @($archive.Entries | Where-Object FullName -eq 'mihomo-windows-amd64-compatible.exe')
        if ($entries.Count -ne 1 -or $entries[0].Length -le 0) { throw 'The pinned archive has an unexpected executable entry.' }
        $entryStream = $entries[0].Open()
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $expectedBinaryHash = [BitConverter]::ToString($hasher.ComputeHash($entryStream)).Replace('-', '') }
        finally { $hasher.Dispose(); $entryStream.Dispose() }
        if (-not (Test-Path -LiteralPath $binaryPath)) {
            $temporaryBinary = "$binaryPath.$([Guid]::NewGuid().ToString('N')).tmp"
            try {
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $temporaryBinary)
                if ((Get-FileSha256 $temporaryBinary) -ne $expectedBinaryHash) { throw 'Extracted executable integrity check failed.' }
                Move-Item -LiteralPath $temporaryBinary -Destination $binaryPath
            } finally { if (Test-Path -LiteralPath $temporaryBinary) { Remove-Item -LiteralPath $temporaryBinary -Force } }
        }
        if ((Get-FileSha256 $binaryPath) -ne $expectedBinaryHash) {
            throw 'Existing executable does not match the verified archive. It will not be executed or silently replaced.'
        }
    } finally { $archive.Dispose() }
}

function Quote-Argument([string]$Value) {
    # These are canonical file paths ending in a file/directory name, never a trailing slash.
    if ($Value.Contains('"') -or $Value.EndsWith('\')) { throw 'Unexpected path characters in native process arguments.' }
    return '"' + $Value + '"'
}

function Write-Configuration([string]$AdapterName, [int]$LocalPort) {
    $yamlName = $AdapterName.Replace("'", "''")
    $dnsInterface = [Uri]::EscapeDataString($AdapterName)
    $text = @"
mixed-port: $LocalPort
bind-address: 127.0.0.1
allow-lan: false
mode: rule
log-level: info
ipv6: false
interface-name: '$yamlName'
external-controller: ''
geo-auto-update: false
profile:
  store-selected: false
  store-fake-ip: false
tun:
  enable: false
dns:
  enable: true
  ipv6: false
  use-system-hosts: false
  enhanced-mode: redir-host
  respect-rules: false
  default-nameserver:
    - '223.5.5.5#$dnsInterface'
    - '119.29.29.29#$dnsInterface'
  nameserver:
    - 'https://dns.alidns.com/dns-query#$dnsInterface'
  direct-nameserver:
    - 'https://dns.alidns.com/dns-query#$dnsInterface'
rules:
  - DOMAIN-SUFFIX,51job.com,DIRECT
  - DOMAIN-SUFFIX,zhipin.com,DIRECT
  - DOMAIN-SUFFIX,liepin.com,DIRECT
  - AND,((DOMAIN,js.51jobcdn.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,img01.51jobcdn.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,img04.51jobcdn.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,img.alicdn.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,o.alicdn.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,g.alicdn.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,x.alicdn.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open.aliyuncs.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,93bc86fc5f88a01515ccdf7ea6192e9f.captcha-pro-open-b.aliyuncs.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open.aliyuncs.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,93bc86fc5f88a01515ccdf7ea6192e9f-verify.captcha-pro-open-b.aliyuncs.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,upload.captcha-pro-open.aliyuncs.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,upload.captcha-pro-open-b.aliyuncs.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,device.captcha-open.aliyuncs.com),(DST-PORT,443)),DIRECT
  - DOMAIN,img.bosszhipin.com,DIRECT
  - AND,((DOMAIN,api.geetest.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,api.geevisit.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,static.geetest.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,monitor.geetest.com),(DST-PORT,443)),DIRECT
  - AND,((DOMAIN,static.geevisit.com),(DST-PORT,443)),DIRECT
  - DOMAIN,concat.lietou-static.com,DIRECT
  - DOMAIN,image0.lietou-static.com,DIRECT
  - DOMAIN,turing.captcha.qcloud.com,DIRECT
  - DOMAIN,turing.captcha.gtimg.com,DIRECT
  - MATCH,REJECT
"@
    Write-AtomicText $configurationPath ($text + "`n")
}

function Invoke-HelperAction {
    $record = Read-HelperState
    $localPort = $Port
    if ($Action -ne 'Start' -and -not $portWasExplicit -and $record) { $localPort = [int]$record.port }
    $status = Get-HelperStatus $localPort $record
    if ($Action -eq 'Status') { return $status }
    if ($status.state -in @('port-conflict', 'identity-mismatch')) { throw $status.message }
    if ($Action -eq 'Stop') {
        if ($status.state -eq 'stopped') {
            if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
            return $status
        }
        $process = Get-ProcessRecord ([int]$status.processId)
        if (-not (Test-HelperIdentity $process)) { throw 'Helper identity changed before stop. Nothing has been stopped.' }
        Stop-Process -Id ([int]$process.ProcessId) -ErrorAction Stop
        if (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
        return [PSCustomObject]@{ state = 'stopped'; port = $localPort; stoppedProcessId = [int]$process.ProcessId }
    }
    if ($status.state -eq 'running') {
        if ($InterfaceName -and $record -and $record.PSObject.Properties['interfaceName'] -and $record.interfaceName -ne $InterfaceName) {
            throw 'Helper is already running with another interface. Stop this helper explicitly before changing it.'
        }
        return $status
    }
    if ($status.state -eq 'not-listening') { throw 'An owned helper process already exists. Inspect or stop it before starting another.' }
    $selected = Select-PhysicalInterface $InterfaceName
    New-Item -ItemType Directory -Path $helperDirectory -Force | Out-Null
    Ensure-VerifiedBinary
    Write-Configuration $selected.name $localPort
    $nativeArguments = '-d ' + (Quote-Argument $helperDirectory) + ' -f ' + (Quote-Argument $configurationPath)
    $validation = Start-Process -FilePath $binaryPath -ArgumentList ($nativeArguments + ' -t') -WorkingDirectory $helperDirectory -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $helperDirectory 'validation.stdout.log') -RedirectStandardError (Join-Path $helperDirectory 'validation.stderr.log')
    if ($validation.ExitCode -ne 0) { throw "Independent helper configuration validation failed. Check logs in $helperDirectory." }
    $child = $null
    $ready = $false
    try {
        # Recheck after download/config validation: another application may have taken the port.
        if (@(Get-PortOwners $localPort).Count) { throw 'Port became occupied before startup. No existing process was stopped.' }
        $child = Start-Process -FilePath $binaryPath -ArgumentList $nativeArguments -WorkingDirectory $helperDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $helperDirectory 'stdout.log') -RedirectStandardError (Join-Path $helperDirectory 'stderr.log')
        $startupWatch = [Diagnostics.Stopwatch]::StartNew()
        while ($startupWatch.Elapsed.TotalSeconds -lt 8) {
            $child.Refresh()
            if ($child.HasExited) { throw "Independent helper exited during startup. Check logs in $helperDirectory." }
            $owners = @(Get-PortOwners $localPort)
            if ($owners.Count -eq 1 -and [int]$owners[0] -eq $child.Id -and (Test-HelperIdentity (Get-ProcessRecord $child.Id))) { $ready = $true; break }
            if ($owners.Count) { throw 'Port was taken by another process during startup.' }
            Start-Sleep -Milliseconds 200
        }
        if (-not $ready) { throw 'Independent helper did not listen within 8 seconds.' }
        $newRecord = [ordered]@{ processId = $child.Id; port = $localPort; interfaceName = $selected.name; interfaceIndex = $selected.interfaceIndex; startedAt = [DateTimeOffset]::UtcNow.ToString('o') }
        Write-AtomicText $statePath (($newRecord | ConvertTo-Json) + "`n")
        return [PSCustomObject]@{ state = 'running'; processId = $child.Id; port = $localPort; proxyUrl = "http://127.0.0.1:$localPort"; interfaceName = $selected.name; interfaceIndex = $selected.interfaceIndex; configuration = $configurationPath }
    } catch {
        # Roll back only the child started above, never an arbitrary port owner.
        if ($child -and (Test-HelperIdentity (Get-ProcessRecord $child.Id))) { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue }
        throw
    }
}

$portWasExplicit = $PSBoundParameters.ContainsKey('Port')
if ($Action -eq 'Status') {
    # Status performs no download, directory creation, configuration writes or process changes.
    $record = Read-HelperState
    $statusPort = if (-not $portWasExplicit -and $record) { [int]$record.port } else { $Port }
    Get-HelperStatus $statusPort $record | ConvertTo-Json -Depth 5
} else {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $lockId = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($helperDirectory.ToLowerInvariant()))).Replace('-', '') }
    finally { $hasher.Dispose() }
    $mutex = New-Object Threading.Mutex($false, "Local\BetterMeDomesticRoute-$lockId")
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(30000) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'Another helper operation is active. Try again after it finishes.' }
        Invoke-HelperAction | ConvertTo-Json -Depth 5
    } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
