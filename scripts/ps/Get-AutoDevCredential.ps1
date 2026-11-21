<#
.SYNOPSIS
    Prints one AutoDev secret from Windows Credential Manager to standard output.

.DESCRIPTION
    Reads a GENERIC credential (CRED_TYPE_GENERIC) with advapi32!CredReadW and
    writes only the secret, followed by one newline, to standard output. The
    secret is the credential blob decoded as UTF-16LE, which is how
    Set-AutoDevCredential.ps1 and "cmdkey /generic" store it. Output bytes are
    UTF-8 without a byte order mark, written straight to the stdout stream so
    that the console code page cannot alter them.

    Only targets of the form autodev/<NAME> are accepted, so this helper cannot
    be used to print credentials that belong to other programs.

    Exit codes:
        0  found; the secret is on stdout
        1  not found; nothing is written
        2  could not be read (bad target, not Windows, Add-Type blocked by
           policy, or an API error); nothing is written to stdout and the
           message on stderr never contains the secret

    This script is called by src\core\secrets.js as:
        powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass
            -File <this script> -Target autodev/<NAME>
    It works in Windows PowerShell 5.1 and PowerShell 7, never prompts and
    never writes the secret to a file, a log or the error stream.

.PARAMETER Target
    Credential target name, for example autodev/AGILITY_TOKEN.

.EXAMPLE
    powershell.exe -NoProfile -NonInteractive -File .\scripts\ps\Get-AutoDevCredential.ps1 -Target autodev/AGILITY_TOKEN
    Prints the secret. Do not run this on a shared screen.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Target
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$exitCode = 2
try {
    if ($Target -cnotmatch '^autodev/[A-Za-z_][A-Za-z0-9_.-]{0,99}$') {
        throw 'The target must look like autodev/NAME (letters, digits, dot, dash, underscore).'
    }

    if ($null -eq ('AutoDev.CredentialReader' -as [type])) {
        # C# 5 syntax only: Windows PowerShell 5.1 compiles this with the
        # .NET Framework compiler.
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace AutoDev
{
    public static class CredentialReader
    {
        private const uint CRED_TYPE_GENERIC = 1;
        private const int ERROR_NOT_FOUND = 1168;

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            public uint dwLowDateTime;
            public uint dwHighDateTime;
        }

        // Matches CREDENTIALW in wincred.h. Strings are kept as IntPtr so the
        // marshaller never copies or frees memory owned by the system.
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct CREDENTIAL
        {
            public uint Flags;
            public uint Type;
            public IntPtr TargetName;
            public IntPtr Comment;
            public FILETIME LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist;
            public uint AttributeCount;
            public IntPtr Attributes;
            public IntPtr TargetAlias;
            public IntPtr UserName;
        }

        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredRead(string target, uint type, uint reservedFlag, out IntPtr credential);

        [DllImport("advapi32.dll", EntryPoint = "CredFree")]
        private static extern void CredFree(IntPtr buffer);

        // Returns the secret, or null when no such generic credential exists.
        public static string Read(string target)
        {
            IntPtr pointer = IntPtr.Zero;
            if (!CredRead(target, CRED_TYPE_GENERIC, 0, out pointer))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_NOT_FOUND)
                {
                    return null;
                }
                throw new Win32Exception(error);
            }
            try
            {
                CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
                if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize < 2)
                {
                    return string.Empty;
                }
                return Marshal.PtrToStringUni(credential.CredentialBlob, (int)(credential.CredentialBlobSize / 2));
            }
            finally
            {
                CredFree(pointer);
            }
        }
    }
}
'@
    }

    $secret = [AutoDev.CredentialReader]::Read($Target)
    if ($null -eq $secret) {
        $exitCode = 1
    }
    else {
        $encoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
        $bytes = $encoding.GetBytes($secret + "`n")
        $stream = [Console]::OpenStandardOutput()
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()
        }
        finally {
            [Array]::Clear($bytes, 0, $bytes.Length)
        }
        $secret = $null
        $exitCode = 0
    }
}
catch {
    # The message comes from parameter checks, Add-Type or a Win32 error code.
    # None of those can contain the secret.
    $exitCode = 2
    [Console]::Error.WriteLine('Get-AutoDevCredential: ' + $_.Exception.Message)
}

exit $exitCode
