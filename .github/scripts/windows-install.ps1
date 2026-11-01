param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('baseline', 'candidate')]
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$stage = if ($Version -eq 'baseline') { 'installBaseline' } else { 'installCandidate' }
$code = 'installation_failed'
try {
    if ($env:OS -ne 'Windows_NT' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
        throw 'hosted_windows_required'
    }
    $root = Join-Path $env:RUNNER_TEMP 'simon-windows-qa'
    if ([IO.Path]::GetFullPath($env:SIMON_QA_ROOT) -cne [IO.Path]::GetFullPath($root)) {
        throw 'invalid_qa_directory'
    }
    $selection = Get-Content -LiteralPath (Join-Path $root 'selection.json') -Raw | ConvertFrom-Json
    $identity = $selection.$Version
    if (-not $identity -or $identity.updaterSignature -cne 'verified') { throw 'unverified_installer' }
    $installDirectory = Join-Path $root 'installed'
    $executable = Join-Path $installDirectory 'simon.exe'
    if ($selection.executable -cne $executable -or $selection.installDirectory -cne $installDirectory) {
        throw 'installation_identity_mismatch'
    }
    $installer = Join-Path $root "$Version-setup.exe"
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $identity.sha256) {
        throw 'installer_checksum_mismatch'
    }
    # Shipped Windows releases deliberately have no paid OS code-signing cert.
    # Their mandatory identity is the verified Tauri updater key + asset hash.
    $installerSignature = (Get-AuthenticodeSignature -LiteralPath $installer).Status.ToString()
    if ($installerSignature -cne 'NotSigned') { throw 'authenticode_identity_changed' }
    if ($Version -eq 'baseline') {
        if (Test-Path -LiteralPath $installDirectory) { throw 'baseline_not_fresh' }
    } else {
        if (-not (Test-Path -LiteralPath $executable)) { throw 'upgrade_baseline_missing' }
        $previous = (Get-Item -LiteralPath $executable).VersionInfo
        if ($previous.FileMajorPart -ne 0 -or $previous.FileMinorPart -ne 1 -or $previous.FileBuildPart -ne 9) {
            throw 'upgrade_baseline_version_mismatch'
        }
        # Baseline login closes its own process; this is not an uninstall/reinstall.
        if (Test-Path -LiteralPath (Join-Path $root 'native.json')) { throw 'baseline_process_still_owned' }
    }
    $started = [Diagnostics.Stopwatch]::StartNew()
    # /D must be last and unquoted per NSIS. No custom installer/repacked binary.
    $process = Start-Process -FilePath $installer -ArgumentList "/S /D=$installDirectory" -PassThru
    if (-not $process.WaitForExit(120000)) {
        & taskkill.exe /PID $process.Id /T /F | Out-Null
        throw 'nsis_deadline'
    }
    if ($process.ExitCode -ne 0) { throw 'nsis_nonzero_exit' }
    if (-not (Test-Path -LiteralPath $executable)) { throw 'installed_executable_missing' }
    $info = (Get-Item -LiteralPath $executable).VersionInfo
    $expected = [version]$identity.version
    if ($info.FileMajorPart -ne $expected.Major -or $info.FileMinorPart -ne $expected.Minor -or
        $info.FileBuildPart -ne $expected.Build -or $info.ProductName -cne 'Simón') {
        throw 'installed_version_identity_mismatch'
    }
    $binarySignature = (Get-AuthenticodeSignature -LiteralPath $executable).Status.ToString()
    if ($binarySignature -cne 'NotSigned') { throw 'authenticode_identity_changed' }
    $registrations = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    ) | ForEach-Object { Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue } |
        Where-Object { $_.InstallLocation -and $_.InstallLocation.TrimEnd('\') -ieq $installDirectory.TrimEnd('\') }
    $registrations = @($registrations)
    if ($registrations.Count -ne 1 -or $registrations[0].DisplayVersion -cne $identity.version) {
        throw 'nsis_registration_mismatch'
    }
    $evidencePath = Join-Path $root 'evidence.json'
    $evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json -AsHashtable
    $evidence[$stage] = @{
        state = 'completed'; version = $identity.version; method = 'real-nsis-silent';
        nsisExitCode = $process.ExitCode; durationMs = $started.ElapsedMilliseconds;
        installerSha256 = $identity.sha256;
        installedExecutableSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant();
        authenticode = 'NotSigned'; updaterSignature = 'verified'; registryVersionVerified = $true;
        sameInstallDirectory = $true
    }
    $evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $evidencePath -Encoding utf8
} catch {
    # Never emit exception details, installer output or a process/environment dump.
    $allowed = @('hosted_windows_required', 'invalid_qa_directory', 'unverified_installer',
        'installation_identity_mismatch', 'installer_checksum_mismatch', 'authenticode_identity_changed',
        'baseline_not_fresh', 'upgrade_baseline_missing', 'upgrade_baseline_version_mismatch',
        'baseline_process_still_owned', 'nsis_deadline', 'nsis_nonzero_exit', 'installed_executable_missing',
        'installed_version_identity_mismatch', 'nsis_registration_mismatch')
    if ($allowed -ccontains $_.Exception.Message) { $code = $_.Exception.Message }
    if ($root -and (Test-Path -LiteralPath (Join-Path $root 'evidence.json'))) {
        $evidencePath = Join-Path $root 'evidence.json'
        $evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json -AsHashtable
        $evidence['failure'] = @{ stage = $stage; code = $code }
        $evidence | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $evidencePath -Encoding utf8
    }
    [Console]::Error.WriteLine("Windows QA blocked: $code")
    exit 1
}
