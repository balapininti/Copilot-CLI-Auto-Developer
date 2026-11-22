#Requires -Version 5.1
<#
.SYNOPSIS
    Starts GitHub Copilot CLI as an AutoDev session bound to one project.

.DESCRIPTION
    The workspace launcher. It:

      1. refuses to start when NODE_TLS_REJECT_UNAUTHORIZED=0
      2. sets, for this process and its children only:
           AUTODEV_WORKSPACE   the workspace root
           AUTODEV_HOME        this repository
           AUTODEV_SESSION_ID  a new id for this session
           AUTODEV_PROJECT     only when -Project is given
      3. with -Project, validates the project first
         (autodev project validate --project <id>)
      4. with -InstallUserLevel, runs "autodev discovery install"
      5. runs "autodev discovery verify" and stops, listing the problems, if
         the agents and skills are not valid
      6. starts "copilot --agent <Agent>" with the repository as the working
         directory, which is what makes .github\agents and .github\skills
         discoverable

    When Copilot CLI exits, the environment variables and the current folder
    of the calling PowerShell session are put back exactly as they were.

    Copilot CLI is started with its normal permission prompts. This launcher
    never passes --allow-all-tools or --yolo.

.PARAMETER Project
    Id of an onboarded project (the folder name under <Workspace>\projects).
    When omitted, the agent selects the project once, from the board and
    story, with "autodev session select"; it cannot change it afterwards.

.PARAMETER Agent
    Custom agent to start. Default: auto-developer. Others shipped with the
    framework: incident-investigator, and project-onboarder (start it without
    -Project to onboard a new project from what already exists on the machine).

.PARAMETER Workspace
    Workspace root. Default: the parent of the repository folder.

.PARAMETER Model
    Model for this session, passed to Copilot CLI as --model. Default: whatever
    Copilot CLI is set to. Use the name Copilot CLI shows under /model.

.PARAMETER InstallUserLevel
    Also copy the agents and skills into the user-level Copilot folders
    (autodev discovery install) before starting.

.EXAMPLE
    .\scripts\Start-AutoDev.ps1 -Project billing

.EXAMPLE
    .\scripts\Start-AutoDev.ps1 -Project billing -Agent incident-investigator

.EXAMPLE
    .\scripts\Start-AutoDev.ps1
    Starts without a project; the agent binds the session to one project.

.NOTES
    Copilot CLI needs PowerShell 6 or later (pwsh) on Windows. This launcher
    itself also runs in Windows PowerShell 5.1.
#>
[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')]
    [string]$Project,

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')]
    [string]$Agent = 'auto-developer',

    [string]$Workspace = '',

    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$')]
    [string]$Model = '',

    [switch]$InstallUserLevel
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Defined up front so that reading it can never trip strict mode.
$global:LASTEXITCODE = 0

# ONE SESSION = ONE PROJECT.
# AUTODEV_SESSION_ID identifies this Copilot CLI session to every autodev
# command the agent runs. The session is bound to a single project: by
# AUTODEV_PROJECT when -Project is given, otherwise by the first
# "autodev session select". From then on every command that names another
# project is refused (PROJECT_SCOPE_VIOLATION). To work on another project,
# exit Copilot CLI and run this launcher again.
#
# APPROVALS ARE DECIDED BY A PERSON, IN A DIFFERENT TERMINAL.
# "autodev approvals review" refuses to run wherever AUTODEV_SESSION_ID or
# AUTODEV_PROJECT is set, which is every process started from this launcher,
# so the agent cannot approve its own requests. Open a separate terminal that
# was not started by this launcher and run, for example:
#     .\scripts\autodev.ps1 approvals review <approval-id> --project <id>
# That is also why the finally block below restores the environment: after
# Copilot CLI exits, this terminal is an ordinary terminal again.

$managedVariables = @('AUTODEV_WORKSPACE', 'AUTODEV_HOME', 'AUTODEV_SESSION_ID', 'AUTODEV_PROJECT')

function Resolve-NativeCommand {
    # Full path of an executable on PATH, or $null. Prefers real Windows
    # launchers (.exe/.cmd) and never returns a .ps1 shim.
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
    # Runs an executable, returns its exit code and its stdout lines; stderr
    # goes to the console. The error preference is relaxed for the call because
    # Windows PowerShell 5.1 can turn stderr text into a terminating error.
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

function Get-AutoDevFailureText {
    # "CODE: message" from a failed autodev call, or a generic sentence.
    [CmdletBinding()]
    param([object]$Run)
    $document = ConvertFrom-AutoDevOutput -Lines $Run.Output
    $errorObject = Get-JsonProperty -InputObject $document -Name 'error'
    if ($null -eq $errorObject) {
        return ('exit code ' + $Run.ExitCode + ', no readable output')
    }
    return ([string](Get-JsonProperty -InputObject $errorObject -Name 'code') + ': ' + [string](Get-JsonProperty -InputObject $errorObject -Name 'message'))
}

function Set-ProcessVariable {
    # Sets or (for $null) removes an environment variable of this process only.
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Name, [AllowNull()][AllowEmptyString()][string]$Value)
    if ([string]::IsNullOrEmpty($Value)) {
        Remove-Item -LiteralPath ('Env:\' + $Name) -ErrorAction SilentlyContinue
    }
    else {
        Set-Item -LiteralPath ('Env:\' + $Name) -Value $Value
    }
}

function Write-Problem {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host $Message -ForegroundColor Red
}

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
$entryPoint = Join-Path -Path $repoRoot -ChildPath 'scripts\autodev.mjs'

# --- Checks that need no environment changes ----------------------------------

if ($env:NODE_TLS_REJECT_UNAUTHORIZED -eq '0') {
    Write-Problem -Message 'Refusing to start: NODE_TLS_REJECT_UNAUTHORIZED=0 disables certificate validation.'
    Write-Host 'Remove the variable and trust your corporate certificate authority instead (docs\corporate-network.md).'
    exit 1
}

if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    Write-Problem -Message ('The workspace folder does not exist: ' + $Workspace)
    Write-Host 'Run .\scripts\Bootstrap.ps1 first, or pass -Workspace.'
    exit 1
}

$nodePath = Resolve-NativeCommand -Name 'node'
if ($null -eq $nodePath) {
    Write-Problem -Message 'Node.js was not found on PATH. Run .\scripts\Bootstrap.ps1 -CheckOnly to see what is missing.'
    exit 1
}

$copilotPath = Resolve-NativeCommand -Name 'copilot'
if ($null -eq $copilotPath) {
    Write-Problem -Message 'GitHub Copilot CLI was not found on PATH. Install it with one of:'
    Write-Host '    npm install -g @github/copilot'
    Write-Host '    winget install GitHub.Copilot'
    exit 1
}

# --- Remember the caller's environment, then build the session's --------------

$savedVariables = @{}
foreach ($name in $managedVariables) {
    # $null when the variable does not exist.
    $savedVariables[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')
}

$exitCode = 1
$locationPushed = $false
try {
    # A single-pass loop: "break" leaves it on the first failure and the
    # finally block still restores the environment.
    do {
        if ($null -ne $savedVariables['AUTODEV_SESSION_ID'] -or $null -ne $savedVariables['AUTODEV_PROJECT']) {
            Write-Warning -Message 'AUTODEV_SESSION_ID or AUTODEV_PROJECT was already set in this terminal. It is ignored for the new session and put back afterwards.'
        }
        # The checks below must run outside any session, otherwise autodev
        # would apply the old session's project binding to them.
        Set-ProcessVariable -Name 'AUTODEV_SESSION_ID' -Value $null
        Set-ProcessVariable -Name 'AUTODEV_PROJECT' -Value $null
        Set-ProcessVariable -Name 'AUTODEV_WORKSPACE' -Value $Workspace
        Set-ProcessVariable -Name 'AUTODEV_HOME' -Value $repoRoot

        if (-not [string]::IsNullOrEmpty($Project)) {
            $validation = Invoke-Native -FilePath $nodePath -ArgumentList @($entryPoint, 'project', 'validate', '--project', $Project, '--workspace', $Workspace)
            if ($validation.ExitCode -ne 0) {
                Write-Problem -Message ('Project "' + $Project + '" is not usable: ' + (Get-AutoDevFailureText -Run $validation))
                Write-Host 'List the onboarded projects with:  .\scripts\autodev.ps1 project list'
                $exitCode = 1
                break
            }
            $validationData = Get-JsonProperty -InputObject (ConvertFrom-AutoDevOutput -Lines $validation.Output) -Name 'data'
            $missing = @(@(Get-JsonProperty -InputObject $validationData -Name 'missing') | Where-Object { $null -ne $_ })
            if ($missing.Count -gt 0) {
                Write-Warning -Message ('Project "' + $Project + '" is valid but onboarding is incomplete (' + $missing.Count + ' item(s) missing). Details:  .\scripts\autodev.ps1 project validate --project ' + $Project)
            }
        }

        if ($InstallUserLevel) {
            $install = Invoke-Native -FilePath $nodePath -ArgumentList @($entryPoint, 'discovery', 'install', '--workspace', $Workspace)
            if ($install.ExitCode -ne 0) {
                Write-Problem -Message ('"autodev discovery install" failed: ' + (Get-AutoDevFailureText -Run $install))
                $exitCode = 1
                break
            }
            Write-Host 'Agents and skills were copied to the user-level Copilot folders.'
        }

        # "discovery verify" exits 0 even when it finds problems; the verdict is
        # data.ok in its JSON output.
        $verify = Invoke-Native -FilePath $nodePath -ArgumentList @($entryPoint, 'discovery', 'verify', '--workspace', $Workspace)
        $verifyData = Get-JsonProperty -InputObject (ConvertFrom-AutoDevOutput -Lines $verify.Output) -Name 'data'
        if ($verify.ExitCode -ne 0 -or $null -eq $verifyData) {
            Write-Problem -Message ('"autodev discovery verify" failed: ' + (Get-AutoDevFailureText -Run $verify))
            $exitCode = 1
            break
        }
        if ((Get-JsonProperty -InputObject $verifyData -Name 'ok') -ne $true) {
            Write-Problem -Message 'Not starting: the agents and skills are not valid or not discoverable.'
            foreach ($problem in @(Get-JsonProperty -InputObject $verifyData -Name 'problems')) {
                if ($null -ne $problem) {
                    Write-Host ('  - ' + [string]$problem)
                }
            }
            $exitCode = 1
            break
        }
        $agentIds = @()
        foreach ($entry in @(Get-JsonProperty -InputObject $verifyData -Name 'agents')) {
            if ($null -ne $entry) {
                $agentIds += [string](Get-JsonProperty -InputObject $entry -Name 'id')
            }
        }
        if ($agentIds -notcontains $Agent) {
            Write-Problem -Message ('There is no agent "' + $Agent + '" in .github\agents. Available: ' + ($agentIds -join ', '))
            $exitCode = 1
            break
        }

        # The session starts here.
        $sessionId = 'ps-' + [System.Guid]::NewGuid().ToString('N')
        Set-ProcessVariable -Name 'AUTODEV_SESSION_ID' -Value $sessionId
        if (-not [string]::IsNullOrEmpty($Project)) {
            Set-ProcessVariable -Name 'AUTODEV_PROJECT' -Value $Project
        }

        Write-Host ''
        Write-Host ('AutoDev session ' + $sessionId)
        Write-Host ('  Workspace: ' + $Workspace)
        if ([string]::IsNullOrEmpty($Project)) {
            Write-Host '  Project:   not selected yet (the agent binds the session to one project)'
        }
        else {
            Write-Host ('  Project:   ' + $Project)
        }
        Write-Host ('  Agent:     ' + $Agent)
        Write-Host '  Approvals: decide them in a SEPARATE terminal that was not started by this launcher:'
        Write-Host '             .\scripts\autodev.ps1 approvals review <approval-id> --project <id>'
        Write-Host ''

        # The working directory must be the repository: Copilot CLI discovers
        # .github\agents and .github\skills relative to where it is started.
        Push-Location -LiteralPath $repoRoot
        $locationPushed = $true

        # Normal permission prompts stay on: no --allow-all-tools, no --yolo.
        # --add-dir lets the session read and edit the project clones, which live
        # outside the repository folder (confirmed present in Copilot CLI 1.0.114).
        $projectsDir = Join-Path -Path $Workspace -ChildPath 'projects'
        $copilotArguments = @('--agent', $Agent)
        if (Test-Path -LiteralPath $projectsDir) {
            $copilotArguments += @('--add-dir', $projectsDir)
        }
        if ($Model -ne '') {
            # --model is Copilot CLI's documented way to choose the session model.
            $copilotArguments += @('--model', $Model)
        }
        & $copilotPath @copilotArguments
        $exitCode = $LASTEXITCODE
    } while ($false)
}
finally {
    if ($locationPushed) {
        Pop-Location
    }
    foreach ($name in $managedVariables) {
        Set-ProcessVariable -Name $name -Value $savedVariables[$name]
    }
}

exit $exitCode
