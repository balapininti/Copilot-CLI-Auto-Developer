#Requires -Version 5.1
<#
.SYNOPSIS
    Registers or removes the per-user scheduled task that runs AutoDev monitoring.

.DESCRIPTION
    Creates a Windows Task Scheduler task for the current user that runs one
    monitoring pass every few minutes:

        node.exe "<repo>\scripts\autodev.mjs" monitor run --project <id> --workspace "<workspace>"
        (or --all instead of --project <id>)

    with the repository as the working directory.

    The task
      - runs only as the current user, only while that user is signed in, with
        a limited (non-elevated) token; no password is stored and registering
        it needs no administrator rights
      - never starts a second copy while one is running (IgnoreNew)
      - is stopped after 10 minutes (ExecutionTimeLimit)
      - runs as soon as possible after a missed start (StartWhenAvailable)
      - also runs on battery power (the Task Scheduler default would silently
        skip runs on a laptop that is unplugged)

    The workspace is passed with --workspace. Nothing is written to machine or
    user environment variables.

    -Unregister removes the task. -WhatIf shows what would be done.

.PARAMETER Project
    Id of the onboarded project to monitor.

.PARAMETER All
    Monitor every enabled project in the workspace in one pass.

.PARAMETER EveryMinutes
    Interval between passes. Default 15, minimum 5.

.PARAMETER Workspace
    Workspace root. Default: the parent of the repository folder.

.PARAMETER TaskName
    Task name. Default: "AutoDev Monitoring <project>" or "AutoDev Monitoring all".

.PARAMETER Unregister
    Remove the task instead of registering it.

.EXAMPLE
    .\scripts\Register-MonitoringTask.ps1 -Project billing

.EXAMPLE
    .\scripts\Register-MonitoringTask.ps1 -All -EveryMinutes 30 -WhatIf

.EXAMPLE
    .\scripts\Register-MonitoringTask.ps1 -Project billing -Unregister

.NOTES
    Needs the ScheduledTasks module (Windows 10 / Windows Server 2016 or later).
#>
[CmdletBinding(SupportsShouldProcess = $true, DefaultParameterSetName = 'Project')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Project')]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$')]
    [string]$Project,

    [Parameter(Mandatory = $true, ParameterSetName = 'All')]
    [switch]$All,

    [ValidateRange(5, 1440)]
    [int]$EveryMinutes = 15,

    [string]$Workspace = '',

    [ValidateLength(0, 200)]
    [string]$TaskName = '',

    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# HOW THE WORKER BEHAVES, AND WHY THE TASK IS SHAPED THIS WAY
#
# - "monitor run" is one short, bounded pass: it queries the configured
#   sources for the window since the last checkpoint, updates incidents and
#   exits. It is not a service and keeps nothing in memory between passes.
#   That is why a simple repeating trigger with a 10 minute time limit and
#   "ignore new instances" is enough.
# - Each pass ends by writing a checkpoint under <workspace>\state. If a pass
#   is killed, the machine sleeps or a start is missed, the next pass resumes
#   from the last checkpoint. After failures the worker backs off by itself
#   (the checkpoint records when the next attempt is allowed).
# - Secrets are read from Windows Credential Manager, whose entries belong to
#   one Windows user. The task therefore has to run as the same user who
#   stored them with Set-AutoDevCredential.ps1, in that user's interactive
#   logon session. A task set to "run whether the user is logged on or not"
#   without a stored password cannot read Credential Manager, and a task run
#   as SYSTEM or another account sees different (empty) credentials.
# - The task never needs an open Copilot CLI session. It runs Node directly.
#   What it finds waits in the workspace state until a person or an agent
#   session picks it up.
# - The task gets the user's environment as it was at sign-in. Variables the
#   project needs (the base URL variables named in project.yaml, and proxy or
#   CA variables such as NODE_USE_ENV_PROXY, HTTPS_PROXY, NODE_EXTRA_CA_CERTS)
#   must exist as USER environment variables; variables set only inside one
#   PowerShell window are not visible to it.
# - A console window may flash briefly at each run, because node.exe is a
#   console program started in the user's desktop session.

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Write-Error -Message 'Windows Task Scheduler exists only on Windows.' -ErrorAction Continue
    exit 1
}
if ($null -eq (Get-Command -Name 'Register-ScheduledTask' -ErrorAction SilentlyContinue)) {
    Write-Error -Message 'The ScheduledTasks module is not available (it needs Windows 10 / Windows Server 2016 or later).' -ErrorAction Continue
    exit 1
}

function ConvertTo-QuotedArgument {
    # Wraps a path in double quotes for a Windows command line. Backslashes
    # directly before the closing quote are doubled so they cannot escape it.
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value.Contains('"')) {
        throw ('A path must not contain a double quote: ' + $Value)
    }
    return ('"' + ($Value -replace '(\\+)$', '$1$1') + '"')
}

$allProjects = ($PSCmdlet.ParameterSetName -eq 'All')
$scopeLabel = 'all'
if (-not $allProjects) {
    $scopeLabel = $Project
}
if ([string]::IsNullOrWhiteSpace($TaskName)) {
    $TaskName = 'AutoDev Monitoring ' + $scopeLabel
}
if ($TaskName.IndexOfAny([char[]]@('\', '/', ':', '*', '?', '"', '<', '>', '|')) -ge 0) {
    Write-Error -Message 'The task name must not contain any of these characters: \ / : * ? " < > |' -ErrorAction Continue
    exit 1
}

# --- Unregister ---------------------------------------------------------------

if ($Unregister) {
    $existing = Get-ScheduledTask -TaskName $TaskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        Write-Host ('Nothing to remove: there is no scheduled task named "' + $TaskName + '".')
        exit 0
    }
    if ($PSCmdlet.ShouldProcess($TaskName, 'Remove scheduled task')) {
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath '\' -Confirm:$false
        Write-Host ('Removed the scheduled task "' + $TaskName + '". Checkpoints and incidents in the workspace are kept.')
    }
    exit 0
}

# --- Resolve paths ------------------------------------------------------------

$repoRoot = Split-Path -Path $PSScriptRoot -Parent
if ([string]::IsNullOrWhiteSpace($Workspace)) {
    $Workspace = Split-Path -Path $repoRoot -Parent
}
if ([string]::IsNullOrWhiteSpace($Workspace)) {
    throw 'The repository is at the root of a drive, so there is no parent folder to use as the workspace. Pass -Workspace.'
}
$Workspace = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Workspace)
if ($Workspace.Length -gt 3) {
    $Workspace = $Workspace.TrimEnd('\')
}
$entryPoint = Join-Path -Path $repoRoot -ChildPath 'scripts\autodev.mjs'

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    Write-Error -Message ('Not found: ' + $entryPoint) -ErrorAction Continue
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path -Path $Workspace -ChildPath 'projects') -PathType Container)) {
    Write-Error -Message ('"' + $Workspace + '" is not an AutoDev workspace (it has no projects folder). Run .\scripts\Bootstrap.ps1, or pass -Workspace.') -ErrorAction Continue
    exit 1
}
if (-not $allProjects) {
    $manifestPath = Join-Path -Path (Join-Path -Path (Join-Path -Path $Workspace -ChildPath 'projects') -ChildPath $Project) -ChildPath 'project.yaml'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        Write-Error -Message ('Project "' + $Project + '" is not onboarded: ' + $manifestPath + ' does not exist.') -ErrorAction Continue
        exit 1
    }
}

# The task stores the full path of node.exe, because the task does not have to
# share this window's PATH. Re-register the task if Node.js is moved.
$nodeCommand = Get-Command -Name 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCommand) {
    Write-Error -Message 'node.exe was not found on PATH. Run .\scripts\Bootstrap.ps1 -CheckOnly to see what is missing.' -ErrorAction Continue
    exit 1
}
$nodePath = $nodeCommand.Path

if ($env:NODE_TLS_REJECT_UNAUTHORIZED -eq '0') {
    Write-Warning -Message 'NODE_TLS_REJECT_UNAUTHORIZED=0 is set in this window. If it is also a user or machine variable, every scheduled pass will refuse to run (TLS_POLICY_VIOLATION). Remove it.'
}

# --- Build the task -----------------------------------------------------------

$scopeArguments = '--all'
if (-not $allProjects) {
    # The id matches ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$, so it needs no quoting.
    $scopeArguments = '--project ' + $Project
}
$arguments = (ConvertTo-QuotedArgument -Value $entryPoint) + ' monitor run ' + $scopeArguments + ' --workspace ' + (ConvertTo-QuotedArgument -Value $Workspace)

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$userName = $identity.Name
# The SID is used for the task principal because account names of Microsoft
# Entra ID (AzureAD\...) users do not always resolve in Task Scheduler.
$userId = $identity.User.Value
$firstRun = (Get-Date).AddMinutes(1)

# -WorkingDirectory takes the bare path; Task Scheduler does not accept quotes there.
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $repoRoot
# No -RepetitionDuration: on Windows 10 / Server 2016 and later that means
# "repeat indefinitely".
$trigger = New-ScheduledTaskTrigger -Once -At $firstRun -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# Interactive = only while this user is signed in, with no stored password.
# Limited = the normal, non-elevated token.
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$description = 'AutoDev: one monitoring pass (' + $scopeLabel + ') every ' + $EveryMinutes + ' minutes. Registered by scripts\Register-MonitoringTask.ps1.'

Write-Host ('Task:       ' + $TaskName)
Write-Host ('Runs as:    ' + $userName + ' (only while signed in, not elevated)')
Write-Host ('Every:      ' + $EveryMinutes + ' minutes, first run at ' + $firstRun.ToString('HH:mm'))
Write-Host ('Program:    ' + $nodePath)
Write-Host ('Arguments:  ' + $arguments)
Write-Host ('Start in:   ' + $repoRoot)

if (-not $PSCmdlet.ShouldProcess($TaskName, 'Register scheduled task')) {
    exit 0
}

# -Force replaces a task of the same name, so running this again updates it.
[void](Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force)

$statusScope = '--project <id>'
if (-not $allProjects) {
    $statusScope = '--project ' + $Project
}

Write-Host ''
Write-Host 'Registered. To look at the task and its last result:'
Write-Host ('    Get-ScheduledTask -TaskName ''' + $TaskName + ''' | Get-ScheduledTaskInfo')
Write-Host '        LastRunTime, NextRunTime and LastTaskResult. LastTaskResult is the exit code of autodev:'
Write-Host '        0 success, 2 configuration, 3 waiting for a person (sign-in), 4 refused by policy,'
Write-Host '        5 upstream or network. 267011 means the task has not run yet; 267009 means it is running.'
Write-Host ('    Start-ScheduledTask -TaskName ''' + $TaskName + '''        (run one pass now)')
Write-Host ('    .\scripts\autodev.ps1 monitor status ' + $statusScope + '   (checkpoint, last error, incident counts)')
Write-Host '    taskschd.msc                                  (Task Scheduler window: Task Scheduler Library)'
Write-Host ('    .\scripts\Register-MonitoringTask.ps1 ' + $(if ($allProjects) { '-All' } else { '-Project ' + $Project }) + ' -Unregister   (remove the task)')
Write-Host ''
Write-Host 'The task sees USER environment variables only. The base URL variables named in project.yaml,'
Write-Host 'and NODE_USE_ENV_PROXY / HTTPS_PROXY / NODE_EXTRA_CA_CERTS if you need them, must be set there.'
exit 0
