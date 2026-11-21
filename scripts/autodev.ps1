<#
.SYNOPSIS
    Runs the autodev command line from PowerShell.

.DESCRIPTION
    Thin wrapper around scripts\autodev.mjs. Every argument is passed to Node
    unchanged and the exit code of Node is returned unchanged:

        0 success, 1 unexpected, 2 usage/config, 3 blocked on a person
        (approval or sign-in), 4 refused by policy, 5 upstream/transient.

    This script deliberately has no [CmdletBinding()] and no param() block.
    An advanced script would claim arguments such as -h or -v as PowerShell
    parameters and would add the common parameters (-Verbose, -Debug, ...),
    so the arguments would no longer reach autodev exactly as typed.

    Standard input is not forwarded from the PowerShell pipeline. Interactive
    commands (approvals review, onboard-project) read from the console and
    work normally.

.PARAMETER args
    Everything after the script name is handed to autodev unchanged.

.EXAMPLE
    .\scripts\autodev.ps1 help

.EXAMPLE
    .\scripts\autodev.ps1 project validate --project billing

.EXAMPLE
    .\scripts\autodev.ps1 approvals review APR-0001 --project billing
    Run this in a terminal that was NOT started by Start-AutoDev.ps1.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$nodeCommand = Get-Command -Name 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCommand) {
    [Console]::Error.WriteLine('autodev: Node.js was not found on PATH. Install Node.js 22.12 or later, then run scripts\Bootstrap.ps1.')
    exit 1
}

$entryPoint = Join-Path -Path $PSScriptRoot -ChildPath 'autodev.mjs'
& $nodeCommand.Path $entryPoint @args
exit $LASTEXITCODE
