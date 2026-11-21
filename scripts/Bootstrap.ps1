#Requires -Version 5.1
<#
.SYNOPSIS
    Checks the prerequisites of the AutoDev framework and does first-time setup.

.DESCRIPTION
    Validates this machine and prints a PASS / WARN / FAIL table:

      - PowerShell 5.1 or later to run this script, and PowerShell 6 or later
        (pwsh) because GitHub Copilot CLI itself needs it on Windows
      - Node.js 22.12 or later, npm, git
      - GitHub Copilot CLI (copilot --version). If it is absent the install
        commands are printed; this script does not install it
      - Microsoft Edge (used only when a service needs a browser sign-in)
      - proxy settings (HTTPS_PROXY, NODE_USE_ENV_PROXY) and NODE_EXTRA_CA_CERTS
      - NODE_TLS_REJECT_UNAUTHORIZED must not be 0. If it is, the script stops

    Unless -CheckOnly is given it then:

      - creates <Workspace>\projects and <Workspace>\state
      - runs "npm ci" in the repository ("npm install" if there is no lockfile)
      - runs "autodev doctor" and "autodev discovery verify" and summarises them

    It never downloads a browser, never changes the execution policy, never
    installs software other than this repository's npm packages, and never
    reads or writes a secret.

    Exit code: 0 when every required prerequisite is present and setup worked,
    1 otherwise. Required: PowerShell 5.1, Node.js, npm, git, GitHub Copilot
    CLI and enabled TLS validation. Everything else is a warning.

.PARAMETER Workspace
    Workspace root. Default: the parent of the repository folder, for example
    C:\DevWorkspace when the repository is C:\DevWorkspace\automation.

.PARAMETER CheckOnly
    Validate only. Creates nothing, installs nothing, changes nothing.

.PARAMETER SkipNpmInstall
    Do the setup but skip "npm ci" / "npm install".

.EXAMPLE
    .\scripts\Bootstrap.ps1 -CheckOnly

.EXAMPLE
    .\scripts\Bootstrap.ps1

.EXAMPLE
    .\scripts\Bootstrap.ps1 -Workspace 'D:\Dev Workspace' -SkipNpmInstall

.NOTES
    If scripts are blocked on this machine, run it for this one process only:
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Bootstrap.ps1
    That does not change the execution policy of the machine or the user.
#>
[CmdletBinding()]
param(
    [string]$Workspace = '',
    [switch]$CheckOnly,
    [switch]$SkipNpmInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Defined up front so that reading it can never trip strict mode.
$global:LASTEXITCODE = 0

$minimumNode = New-Object -TypeName System.Version -ArgumentList 22, 12, 0
$repoRoot = Split-Path -Path $PSScriptRoot -Parent
if ([string]::IsNullOrWhiteSpace($Workspace)) {
    $Workspace = Split-Path -Path $repoRoot -Parent
}
if ([string]::IsNullOrWhiteSpace($Workspace)) {
    throw 'The repository is at the root of a drive, so there is no parent folder to use as the workspace. Pass -Workspace.'
}
$Workspace = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Workspace)
if ($Workspace.Length -gt 3) {
    # A trailing backslash would swallow the closing quote when the path is
    # passed to a program by Windows PowerShell 5.1.
    $Workspace = $Workspace.TrimEnd('\')
}
$discoveryProblems = @()
$entryPoint = Join-Path -Path $repoRoot -ChildPath 'scripts\autodev.mjs'

$script:results = New-Object -TypeName System.Collections.ArrayList

function Add-CheckResult {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][ValidateSet('PASS', 'WARN', 'FAIL', 'INFO')][string]$Status,
        [Parameter(Mandatory = $true)][string]$Check,
        [string]$Detail = ''
    )
    $row = New-Object -TypeName PSObject -Property @{ Status = $Status; Check = $Check; Detail = $Detail }
    [void]$script:results.Add($row)
}

function Resolve-NativeCommand {
    # Full path of an executable on PATH, or $null. Prefers real Windows
    # launchers (.exe/.cmd) over extensionless shell scripts of the same name,
    # and never returns a .ps1 shim, which the execution policy might block.
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Name)
    $found = @(Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue)
    if ($found.Count -eq 0) {
        return $null
    }
    foreach ($candidate in $found) {
        $extension = [System.IO.Path]::GetExtension($candidate.Path)
        if (@('.exe', '.cmd', '.bat', '.com') -contains $extension.ToLowerInvariant()) {
            return $candidate.Path
        }
    }
    return $found[0].Path
}

function Invoke-Native {
    # Runs an executable, returns its exit code and its stdout lines.
    # stderr is left alone (it goes to the console). The error preference is
    # relaxed for the call because Windows PowerShell 5.1 can turn stderr text
    # of a native command into a terminating error when it is 'Stop'.
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$ArgumentList = @()
    )
    $ErrorActionPreference = 'Continue'
    $lines = @()
    $code = -1
    try {
        $lines = @(& $FilePath @ArgumentList)
        $code = $LASTEXITCODE
    }
    catch {
        $lines = @()
        $code = -1
    }
    return (New-Object -TypeName PSObject -Property @{ ExitCode = $code; Output = $lines })
}

function Get-FirstLine {
    [CmdletBinding()]
    param([object[]]$Lines = @())
    foreach ($line in $Lines) {
        if ($null -ne $line -and ([string]$line).Trim().Length -gt 0) {
            return ([string]$line).Trim()
        }
    }
    return ''
}

function Get-JsonProperty {
    # Strict-mode-safe property read: $null when the object or property is absent.
    [CmdletBinding()]
    param([object]$InputObject, [Parameter(Mandatory = $true)][string]$Name)
    if ($null -eq $InputObject) {
        return $null
    }
    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function ConvertFrom-AutoDevOutput {
    # autodev prints one JSON document on stdout: { ok, data | error, meta }.
    [CmdletBinding()]
    param([object[]]$Lines = @())
    $text = ($Lines | ForEach-Object { [string]$_ }) -join "`n"
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }
    try {
        return ($text | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

function Write-ResultTable {
    [CmdletBinding()]
    param()
    $colours = @{ PASS = 'Green'; WARN = 'Yellow'; FAIL = 'Red'; INFO = 'Gray' }
    $width = 5
    foreach ($row in $script:results) {
        if ($row.Check.Length -gt $width) { $width = $row.Check.Length }
    }
    Write-Host ''
    Write-Host ('{0,-6} {1} {2}' -f 'STATUS', 'CHECK'.PadRight($width), 'DETAIL')
    Write-Host ('{0,-6} {1} {2}' -f '------', ('-' * $width), '------')
    foreach ($row in $script:results) {
        Write-Host ('{0,-6} ' -f $row.Status) -ForegroundColor $colours[$row.Status] -NoNewline
        Write-Host ('{0} {1}' -f $row.Check.PadRight($width), $row.Detail)
    }
    Write-Host ''
}

function Get-StatusCount {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Status)
    return @($script:results | Where-Object { $_.Status -eq $Status }).Count
}

Write-Host ('AutoDev bootstrap. Repository: ' + $repoRoot)
Write-Host ('Workspace: ' + $Workspace)
if ($CheckOnly) {
    Write-Host 'Mode: check only (nothing will be created or installed).'
}

# --- Operating system and PowerShell -----------------------------------------

$isWindowsHost = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
if (-not $isWindowsHost) {
    Add-CheckResult -Status WARN -Check 'Windows' -Detail 'Not Windows. The framework is Windows-first; Windows-only checks will report as missing.'
}

$psVersion = $PSVersionTable.PSVersion
$psText = $psVersion.ToString()
if (($psVersion.Major -gt 5) -or ($psVersion.Major -eq 5 -and $psVersion.Minor -ge 1)) {
    Add-CheckResult -Status PASS -Check 'PowerShell (this script)' -Detail $psText
}
else {
    Add-CheckResult -Status FAIL -Check 'PowerShell (this script)' -Detail ($psText + ' found; 5.1 or later is needed.')
}

$pwshHint = 'Copilot CLI needs PowerShell 6 or later (pwsh) on Windows. Install it, for example: winget install Microsoft.PowerShell'
if ($psVersion.Major -ge 6) {
    Add-CheckResult -Status PASS -Check 'PowerShell 6+ (pwsh)' -Detail ('running in ' + $psText)
}
else {
    $pwshPath = Resolve-NativeCommand -Name 'pwsh'
    if ($null -eq $pwshPath) {
        Add-CheckResult -Status WARN -Check 'PowerShell 6+ (pwsh)' -Detail ('Not found. ' + $pwshHint)
    }
    else {
        $pwshRun = Invoke-Native -FilePath $pwshPath -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()')
        if ($pwshRun.ExitCode -eq 0) {
            Add-CheckResult -Status PASS -Check 'PowerShell 6+ (pwsh)' -Detail ((Get-FirstLine -Lines $pwshRun.Output) + ' at ' + $pwshPath)
        }
        else {
            Add-CheckResult -Status WARN -Check 'PowerShell 6+ (pwsh)' -Detail ('pwsh was found but did not run. ' + $pwshHint)
        }
    }
}

# --- Node.js, npm, git --------------------------------------------------------

$nodePath = Resolve-NativeCommand -Name 'node'
$nodeOk = $false
if ($null -eq $nodePath) {
    Add-CheckResult -Status FAIL -Check 'Node.js' -Detail 'Not found on PATH. Install Node.js 22.12 or later (an LTS release).'
}
else {
    $nodeRun = Invoke-Native -FilePath $nodePath -ArgumentList @('--version')
    $nodeText = Get-FirstLine -Lines $nodeRun.Output
    $match = [regex]::Match($nodeText, '^v?(\d+)\.(\d+)\.(\d+)')
    if ($nodeRun.ExitCode -ne 0 -or -not $match.Success) {
        Add-CheckResult -Status FAIL -Check 'Node.js' -Detail ('"node --version" failed (exit code ' + $nodeRun.ExitCode + ').')
    }
    else {
        $nodeVersion = New-Object -TypeName System.Version -ArgumentList ([int]$match.Groups[1].Value), ([int]$match.Groups[2].Value), ([int]$match.Groups[3].Value)
        if ($nodeVersion -ge $minimumNode) {
            $nodeOk = $true
            Add-CheckResult -Status PASS -Check 'Node.js' -Detail ($nodeText + ' at ' + $nodePath)
        }
        else {
            Add-CheckResult -Status FAIL -Check 'Node.js' -Detail ($nodeText + ' found; 22.12 or later is needed.')
        }
    }
}

$npmPath = Resolve-NativeCommand -Name 'npm'
$npmOk = $false
if ($null -eq $npmPath) {
    Add-CheckResult -Status FAIL -Check 'npm' -Detail 'Not found on PATH. It is installed together with Node.js.'
}
else {
    $npmRun = Invoke-Native -FilePath $npmPath -ArgumentList @('--version')
    if ($npmRun.ExitCode -eq 0) {
        $npmOk = $true
        Add-CheckResult -Status PASS -Check 'npm' -Detail (Get-FirstLine -Lines $npmRun.Output)
    }
    else {
        Add-CheckResult -Status FAIL -Check 'npm' -Detail ('"npm --version" failed (exit code ' + $npmRun.ExitCode + ').')
    }
}

$gitPath = Resolve-NativeCommand -Name 'git'
if ($null -eq $gitPath) {
    Add-CheckResult -Status FAIL -Check 'git' -Detail 'Not found on PATH. Install Git for Windows.'
}
else {
    $gitRun = Invoke-Native -FilePath $gitPath -ArgumentList @('--version')
    if ($gitRun.ExitCode -eq 0) {
        Add-CheckResult -Status PASS -Check 'git' -Detail (Get-FirstLine -Lines $gitRun.Output)
    }
    else {
        Add-CheckResult -Status FAIL -Check 'git' -Detail ('"git --version" failed (exit code ' + $gitRun.ExitCode + ').')
    }
}

# --- GitHub Copilot CLI (reported, never installed) ---------------------------

$copilotMissing = $false
$copilotPath = Resolve-NativeCommand -Name 'copilot'
if ($null -eq $copilotPath) {
    $copilotMissing = $true
    Add-CheckResult -Status FAIL -Check 'GitHub Copilot CLI' -Detail 'Not found on PATH. Install commands are printed below the table.'
}
else {
    $copilotRun = Invoke-Native -FilePath $copilotPath -ArgumentList @('--version')
    if ($copilotRun.ExitCode -eq 0) {
        Add-CheckResult -Status PASS -Check 'GitHub Copilot CLI' -Detail ((Get-FirstLine -Lines $copilotRun.Output) + ' at ' + $copilotPath)
    }
    else {
        $copilotMissing = $true
        Add-CheckResult -Status FAIL -Check 'GitHub Copilot CLI' -Detail ('"copilot --version" failed (exit code ' + $copilotRun.ExitCode + ').')
    }
}

# --- Microsoft Edge -----------------------------------------------------------

$edgeFound = $null
$edgeRoots = @(
    [System.Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),
    [System.Environment]::GetEnvironmentVariable('ProgramFiles'),
    [System.Environment]::GetEnvironmentVariable('LOCALAPPDATA')
)
foreach ($root in $edgeRoots) {
    if ([string]::IsNullOrWhiteSpace($root)) { continue }
    $candidate = Join-Path -Path $root -ChildPath 'Microsoft\Edge\Application\msedge.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $edgeFound = $candidate
        break
    }
}
if ($null -ne $edgeFound) {
    Add-CheckResult -Status PASS -Check 'Microsoft Edge' -Detail $edgeFound
}
else {
    Add-CheckResult -Status WARN -Check 'Microsoft Edge' -Detail 'Not found. It is needed only when a service has no API token and falls back to browser sign-in. No browser is downloaded.'
}

# --- Proxy and certificate settings (reported; values are not printed) --------

$httpsProxy = $env:HTTPS_PROXY
if ([string]::IsNullOrWhiteSpace($httpsProxy)) { $httpsProxy = $env:https_proxy }
$useEnvProxy = ($env:NODE_USE_ENV_PROXY -eq '1')
if ([string]::IsNullOrWhiteSpace($httpsProxy)) {
    if ($useEnvProxy) {
        Add-CheckResult -Status WARN -Check 'Proxy' -Detail 'NODE_USE_ENV_PROXY=1 but HTTPS_PROXY is not set, so Node connects directly.'
    }
    else {
        Add-CheckResult -Status INFO -Check 'Proxy' -Detail 'HTTPS_PROXY not set; Node connects directly. See docs\corporate-network.md if a proxy is required.'
    }
}
else {
    if ($useEnvProxy) {
        Add-CheckResult -Status PASS -Check 'Proxy' -Detail 'HTTPS_PROXY is set and NODE_USE_ENV_PROXY=1, so Node uses the proxy.'
    }
    else {
        Add-CheckResult -Status WARN -Check 'Proxy' -Detail 'HTTPS_PROXY is set but NODE_USE_ENV_PROXY is not 1, so Node ignores the proxy. Set NODE_USE_ENV_PROXY=1.'
    }
}

$extraCa = $env:NODE_EXTRA_CA_CERTS
if ([string]::IsNullOrWhiteSpace($extraCa)) {
    Add-CheckResult -Status INFO -Check 'NODE_EXTRA_CA_CERTS' -Detail 'Not set. Set it to your corporate CA bundle (PEM) if Node reports certificate errors.'
}
elseif (Test-Path -LiteralPath $extraCa -PathType Leaf) {
    Add-CheckResult -Status PASS -Check 'NODE_EXTRA_CA_CERTS' -Detail ('Set; file exists: ' + $extraCa)
}
else {
    Add-CheckResult -Status WARN -Check 'NODE_EXTRA_CA_CERTS' -Detail ('Set, but the file does not exist: ' + $extraCa + '. Node ignores a missing file without failing.')
}

$tlsDisabled = ($env:NODE_TLS_REJECT_UNAUTHORIZED -eq '0')
if ($tlsDisabled) {
    Add-CheckResult -Status FAIL -Check 'TLS validation' -Detail 'NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate validation. Remove it and trust your corporate CA instead.'
}
else {
    Add-CheckResult -Status PASS -Check 'TLS validation' -Detail 'Enabled (NODE_TLS_REJECT_UNAUTHORIZED is not 0).'
}

# --- Check-only mode stops here ----------------------------------------------

$modulesDir = Join-Path -Path $repoRoot -ChildPath 'node_modules'
$setupBlocked = $tlsDisabled -or (-not $nodeOk) -or (-not $npmOk -and -not $SkipNpmInstall)

if ($CheckOnly) {
    foreach ($folder in @('projects', 'state')) {
        $path = Join-Path -Path $Workspace -ChildPath $folder
        if (Test-Path -LiteralPath $path -PathType Container) {
            Add-CheckResult -Status PASS -Check ('Workspace\' + $folder) -Detail $path
        }
        else {
            Add-CheckResult -Status WARN -Check ('Workspace\' + $folder) -Detail ($path + ' does not exist yet. Run Bootstrap.ps1 without -CheckOnly.')
        }
    }
    if (Test-Path -LiteralPath $modulesDir -PathType Container) {
        Add-CheckResult -Status PASS -Check 'npm packages' -Detail 'node_modules is present.'
    }
    else {
        Add-CheckResult -Status WARN -Check 'npm packages' -Detail 'Not installed yet. Run Bootstrap.ps1 without -CheckOnly.'
    }
}
elseif ($setupBlocked) {
    Add-CheckResult -Status FAIL -Check 'Setup' -Detail 'Not started: fix the FAIL rows above first. Nothing was created or installed.'
}
else {
    # --- Workspace folders ----------------------------------------------------
    foreach ($folder in @('projects', 'state')) {
        $path = Join-Path -Path $Workspace -ChildPath $folder
        try {
            if (Test-Path -LiteralPath $path -PathType Container) {
                Add-CheckResult -Status PASS -Check ('Workspace\' + $folder) -Detail ($path + ' (already there)')
            }
            else {
                [void](New-Item -ItemType Directory -Path $path -Force)
                Add-CheckResult -Status PASS -Check ('Workspace\' + $folder) -Detail ($path + ' (created)')
            }
        }
        catch {
            Add-CheckResult -Status FAIL -Check ('Workspace\' + $folder) -Detail ('Could not create ' + $path + ': ' + $_.Exception.Message)
        }
    }

    # --- npm packages ---------------------------------------------------------
    $packagesOk = $true
    if ($SkipNpmInstall) {
        if (Test-Path -LiteralPath $modulesDir -PathType Container) {
            Add-CheckResult -Status INFO -Check 'npm packages' -Detail 'Skipped (-SkipNpmInstall); node_modules is present.'
        }
        else {
            Add-CheckResult -Status WARN -Check 'npm packages' -Detail 'Skipped (-SkipNpmInstall) and node_modules is missing; the checks below will probably fail.'
        }
    }
    else {
        $npmVerb = 'install'
        if (Test-Path -LiteralPath (Join-Path -Path $repoRoot -ChildPath 'package-lock.json') -PathType Leaf) {
            $npmVerb = 'ci'
        }
        Write-Host ''
        Write-Host ('Running "npm ' + $npmVerb + '" in ' + $repoRoot + ' ...')
        # The framework drives the Edge that is already installed. This makes
        # sure no package install script downloads a browser, whatever happens.
        $previousSkip = $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD
        $npmCode = -1
        Push-Location -LiteralPath $repoRoot
        try {
            $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
            $ErrorActionPreference = 'Continue'
            # Out-Host keeps npm's progress on the screen and out of this
            # script's own output.
            & $npmPath $npmVerb '--no-audit' '--no-fund' | Out-Host
            $npmCode = $LASTEXITCODE
        }
        catch {
            $npmCode = -1
        }
        finally {
            $ErrorActionPreference = 'Stop'
            if ($null -eq $previousSkip) {
                Remove-Item -LiteralPath 'Env:\PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD' -ErrorAction SilentlyContinue
            }
            else {
                $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = $previousSkip
            }
            Pop-Location
        }
        if ($npmCode -eq 0) {
            Add-CheckResult -Status PASS -Check 'npm packages' -Detail ('"npm ' + $npmVerb + '" succeeded.')
        }
        else {
            $packagesOk = $false
            Add-CheckResult -Status FAIL -Check 'npm packages' -Detail ('"npm ' + $npmVerb + '" failed (exit code ' + $npmCode + '). Behind a proxy or registry mirror, see docs\corporate-network.md.')
        }
    }

    # --- autodev doctor and discovery verify -----------------------------------
    if (-not $packagesOk) {
        Add-CheckResult -Status FAIL -Check 'autodev doctor' -Detail 'Not run because the npm packages are not installed.'
    }
    else {
        $doctorRun = Invoke-Native -FilePath $nodePath -ArgumentList @($entryPoint, 'doctor', '--workspace', $Workspace)
        $doctor = ConvertFrom-AutoDevOutput -Lines $doctorRun.Output
        $doctorData = Get-JsonProperty -InputObject $doctor -Name 'data'
        if ($doctorRun.ExitCode -ne 0 -or $null -eq $doctorData) {
            $message = 'no readable output'
            $errorObject = Get-JsonProperty -InputObject $doctor -Name 'error'
            if ($null -ne $errorObject) {
                $message = [string](Get-JsonProperty -InputObject $errorObject -Name 'code') + ': ' + [string](Get-JsonProperty -InputObject $errorObject -Name 'message')
            }
            Add-CheckResult -Status FAIL -Check 'autodev doctor' -Detail ('Failed (exit code ' + $doctorRun.ExitCode + '): ' + $message)
        }
        else {
            $notOk = @()
            foreach ($check in @(Get-JsonProperty -InputObject $doctorData -Name 'checks')) {
                if ($null -eq $check) { continue }
                if ((Get-JsonProperty -InputObject $check -Name 'ok') -ne $true) {
                    $notOk += [string](Get-JsonProperty -InputObject $check -Name 'name')
                }
            }
            $projects = @(@(Get-JsonProperty -InputObject $doctorData -Name 'projects') | Where-Object { $null -ne $_ })
            $summary = 'workspace ' + [string](Get-JsonProperty -InputObject $doctorData -Name 'workspace') + '; onboarded projects: ' + $projects.Count
            if ((Get-JsonProperty -InputObject $doctorData -Name 'ok') -ne $true) {
                Add-CheckResult -Status FAIL -Check 'autodev doctor' -Detail ('Required checks failed: ' + ($notOk -join ', ') + '; ' + $summary)
            }
            elseif ($notOk.Count -gt 0) {
                Add-CheckResult -Status WARN -Check 'autodev doctor' -Detail ('Optional checks not met: ' + ($notOk -join ', ') + '; ' + $summary)
            }
            else {
                Add-CheckResult -Status PASS -Check 'autodev doctor' -Detail $summary
            }
        }

        # "discovery verify" exits 0 even when it finds problems; the verdict is
        # data.ok in its JSON output.
        $verifyRun = Invoke-Native -FilePath $nodePath -ArgumentList @($entryPoint, 'discovery', 'verify', '--workspace', $Workspace)
        $verify = ConvertFrom-AutoDevOutput -Lines $verifyRun.Output
        $verifyData = Get-JsonProperty -InputObject $verify -Name 'data'
        if ($verifyRun.ExitCode -ne 0 -or $null -eq $verifyData) {
            Add-CheckResult -Status FAIL -Check 'autodev discovery verify' -Detail ('Failed (exit code ' + $verifyRun.ExitCode + ').')
        }
        else {
            $problems = @(@(Get-JsonProperty -InputObject $verifyData -Name 'problems') | Where-Object { $null -ne $_ })
            $agents = @(@(Get-JsonProperty -InputObject $verifyData -Name 'agents') | Where-Object { $null -ne $_ })
            $skills = @(@(Get-JsonProperty -InputObject $verifyData -Name 'skills') | Where-Object { $null -ne $_ })
            $counts = '' + $agents.Count + ' agents, ' + $skills.Count + ' skills'
            if ((Get-JsonProperty -InputObject $verifyData -Name 'ok') -ne $true) {
                $discoveryProblems = $problems
                Add-CheckResult -Status FAIL -Check 'autodev discovery verify' -Detail ('' + $problems.Count + ' problem(s), listed below the table; ' + $counts)
            }
            elseif ((Get-JsonProperty -InputObject $verifyData -Name 'confirmedWithCli') -ne $true) {
                Add-CheckResult -Status WARN -Check 'autodev discovery verify' -Detail ($counts + ' valid on disk, but not confirmed with Copilot CLI itself. Check inside a session with /agent and /skills list.')
            }
            else {
                Add-CheckResult -Status PASS -Check 'autodev discovery verify' -Detail ($counts + ', all seen by Copilot CLI.')
            }
        }
    }
}

# --- Report -------------------------------------------------------------------

Write-ResultTable

if (@($discoveryProblems).Count -gt 0) {
    Write-Host 'Discovery problems:'
    foreach ($problem in @($discoveryProblems)) {
        Write-Host ('  - ' + [string]$problem)
    }
    Write-Host ''
}

if ($copilotMissing) {
    Write-Host 'GitHub Copilot CLI is not installed. Install it yourself with one of:'
    Write-Host '    npm install -g @github/copilot'
    Write-Host '    winget install GitHub.Copilot'
    Write-Host 'Then run this script again. (This script does not install it.)'
    Write-Host ''
}

if ($tlsDisabled) {
    Write-Host 'Stopped: NODE_TLS_REJECT_UNAUTHORIZED=0 is set. The framework refuses to run without'
    Write-Host 'certificate validation. Remove the variable (also from your user environment variables)'
    Write-Host 'and follow docs\corporate-network.md to trust your corporate certificate authority.'
    Write-Host ''
}

$failCount = Get-StatusCount -Status 'FAIL'
$warnCount = Get-StatusCount -Status 'WARN'
Write-Host ('Summary: ' + (Get-StatusCount -Status 'PASS') + ' passed, ' + $warnCount + ' warning(s), ' + $failCount + ' failed.')

if ($failCount -gt 0) {
    Write-Host 'Result: NOT READY. Fix the FAIL rows and run this script again.'
    exit 1
}

if ($CheckOnly) {
    Write-Host 'Result: prerequisites are present. Run this script without -CheckOnly to finish setup.'
}
else {
    Write-Host 'Result: READY.'
    Write-Host 'Next steps:'
    Write-Host '    .\scripts\autodev.ps1 onboard-project            (once per project)'
    Write-Host '    .\scripts\Set-AutoDevCredential.ps1 -Name AGILITY_TOKEN   (see docs\secrets.md)'
    Write-Host '    .\scripts\Start-AutoDev.ps1 -Project <id>'
}
exit 0
