<#
.SYNOPSIS
    Stores, removes or lists AutoDev secrets in Windows Credential Manager.

.DESCRIPTION
    For a person, at a terminal. The framework looks a secret NAME up first in
    the environment variable NAME and then in the Windows Credential Manager
    generic credential "autodev/NAME". This script manages that second place.

    Store (default): prompts for the value with Read-Host -AsSecureString. The
    value is never accepted as a parameter, never echoed and never written to
    a file, the pipeline or the PowerShell history. It is handed to
    advapi32!CredWriteW from unmanaged memory that is zeroed and freed straight
    afterwards. The credential is written with CRED_PERSIST_LOCAL_MACHINE (2):
    it stays on this computer, for this Windows user, and does not roam.

    -Remove deletes the credential (CredDeleteW).
    -List shows the autodev/* entries (CredEnumerateW) without their values.

    Windows protects these entries with the signed-in user's logon credentials.
    Any program running as the same user can read them, which is exactly how
    the framework and the scheduled monitoring task get them.

    Works in Windows PowerShell 5.1 and PowerShell 7. It needs Add-Type, so it
    does not work where PowerShell is restricted to Constrained Language Mode.

.PARAMETER Name
    Secret name without the "autodev/" prefix, for example AGILITY_TOKEN,
    BITBUCKET_TOKEN, SPLUNK_TOKEN, DYNATRACE_TOKEN or DB2_CONN_BILLING.

.PARAMETER Remove
    Delete the credential instead of storing it.

.PARAMETER List
    List the names of all autodev/* credentials and when each was last written.

.EXAMPLE
    .\scripts\Set-AutoDevCredential.ps1 -Name AGILITY_TOKEN
    Prompts for the token (input is hidden) and stores autodev/AGILITY_TOKEN.

.EXAMPLE
    .\scripts\Set-AutoDevCredential.ps1 -Name AGILITY_TOKEN -Remove

.EXAMPLE
    .\scripts\Set-AutoDevCredential.ps1 -List
#>
[CmdletBinding(DefaultParameterSetName = 'Store')]
param(
    [Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Store')]
    [Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'Remove')]
    [ValidatePattern('^[A-Za-z_][A-Za-z0-9_.-]{0,99}$')]
    [string]$Name,

    [Parameter(Mandatory = $true, ParameterSetName = 'Remove')]
    [switch]$Remove,

    [Parameter(Mandatory = $true, ParameterSetName = 'List')]
    [switch]$List
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$prefix = 'autodev/'
# CRED_MAX_CREDENTIAL_BLOB_SIZE is 5 * 512 bytes; the value is stored as UTF-16.
$maxSecretCharacters = 1280

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Write-Error -Message 'Windows Credential Manager exists only on Windows. On macOS use the login keychain; on Linux use secret-tool (see docs/secrets.md).' -ErrorAction Continue
    exit 1
}

if ($null -eq ('AutoDev.CredentialManager' -as [type])) {
    # C# 5 syntax only: Windows PowerShell 5.1 compiles this with the
    # .NET Framework compiler.
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace AutoDev
{
    public sealed class CredentialEntry
    {
        public string Target;
        public DateTime LastWrittenUtc;
    }

    public static class CredentialManager
    {
        private const uint CRED_TYPE_GENERIC = 1;
        private const uint CRED_PERSIST_LOCAL_MACHINE = 2;
        private const int ERROR_NOT_FOUND = 1168;

        [StructLayout(LayoutKind.Sequential)]
        private struct FILETIME
        {
            public uint dwLowDateTime;
            public uint dwHighDateTime;
        }

        // Matches CREDENTIALW in wincred.h. Every pointer is an IntPtr that
        // this class allocates and frees itself, so nothing is marshalled
        // (and therefore copied) behind its back.
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

        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredDelete(string target, uint type, uint flags);

        [DllImport("advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CredEnumerate(string filter, uint flags, out uint count, out IntPtr credentials);

        [DllImport("advapi32.dll", EntryPoint = "CredFree")]
        private static extern void CredFree(IntPtr buffer);

        // secretPointer addresses secretBytes bytes of UTF-16LE text owned by
        // the caller, who zeroes and frees it. No managed copy is made here.
        public static void Write(string target, string userName, string comment, IntPtr secretPointer, int secretBytes)
        {
            if (secretPointer == IntPtr.Zero || secretBytes <= 0)
            {
                throw new ArgumentException("The secret is empty.");
            }
            CREDENTIAL credential = new CREDENTIAL();
            credential.Flags = 0;
            credential.Type = CRED_TYPE_GENERIC;
            credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
            credential.CredentialBlobSize = (uint)secretBytes;
            credential.CredentialBlob = secretPointer;
            credential.AttributeCount = 0;
            credential.Attributes = IntPtr.Zero;
            credential.TargetAlias = IntPtr.Zero;
            credential.TargetName = IntPtr.Zero;
            credential.Comment = IntPtr.Zero;
            credential.UserName = IntPtr.Zero;
            try
            {
                credential.TargetName = Marshal.StringToCoTaskMemUni(target);
                credential.Comment = Marshal.StringToCoTaskMemUni(comment);
                credential.UserName = Marshal.StringToCoTaskMemUni(userName);
                if (!CredWrite(ref credential, 0))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
            }
            finally
            {
                if (credential.TargetName != IntPtr.Zero) { Marshal.FreeCoTaskMem(credential.TargetName); }
                if (credential.Comment != IntPtr.Zero) { Marshal.FreeCoTaskMem(credential.Comment); }
                if (credential.UserName != IntPtr.Zero) { Marshal.FreeCoTaskMem(credential.UserName); }
            }
        }

        // Returns false when there was nothing to delete.
        public static bool Delete(string target)
        {
            if (CredDelete(target, CRED_TYPE_GENERIC, 0))
            {
                return true;
            }
            int error = Marshal.GetLastWin32Error();
            if (error == ERROR_NOT_FOUND)
            {
                return false;
            }
            throw new Win32Exception(error);
        }

        // Names and dates only. Secret values are never copied out of the
        // buffer the system returns.
        public static CredentialEntry[] List(string filter)
        {
            List<CredentialEntry> entries = new List<CredentialEntry>();
            uint count = 0;
            IntPtr array = IntPtr.Zero;
            if (!CredEnumerate(filter, 0, out count, out array))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_NOT_FOUND)
                {
                    return entries.ToArray();
                }
                throw new Win32Exception(error);
            }
            try
            {
                for (int index = 0; index < (int)count; index++)
                {
                    IntPtr item = Marshal.ReadIntPtr(array, index * IntPtr.Size);
                    if (item == IntPtr.Zero)
                    {
                        continue;
                    }
                    CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(item, typeof(CREDENTIAL));
                    if (credential.Type != CRED_TYPE_GENERIC || credential.TargetName == IntPtr.Zero)
                    {
                        continue;
                    }
                    CredentialEntry entry = new CredentialEntry();
                    entry.Target = Marshal.PtrToStringUni(credential.TargetName);
                    long fileTime = ((long)credential.LastWritten.dwHighDateTime << 32) | (long)credential.LastWritten.dwLowDateTime;
                    entry.LastWrittenUtc = fileTime > 0 ? DateTime.FromFileTimeUtc(fileTime) : DateTime.MinValue;
                    entries.Add(entry);
                }
            }
            finally
            {
                CredFree(array);
            }
            return entries.ToArray();
        }
    }
}
'@
}

if ($PSCmdlet.ParameterSetName -eq 'List') {
    $entries = @([AutoDev.CredentialManager]::List($prefix + '*'))
    if ($entries.Count -eq 0) {
        Write-Host 'No autodev/* credentials are stored for this user.'
        exit 0
    }
    foreach ($entry in ($entries | Sort-Object -Property Target)) {
        $lastWritten = ''
        if ($entry.LastWrittenUtc -gt [DateTime]::MinValue) {
            $lastWritten = $entry.LastWrittenUtc.ToLocalTime().ToString('yyyy-MM-dd HH:mm')
        }
        [pscustomobject]@{
            Name        = $entry.Target.Substring($prefix.Length)
            Target      = $entry.Target
            LastWritten = $lastWritten
        }
    }
    exit 0
}

$target = $prefix + $Name

if ($PSCmdlet.ParameterSetName -eq 'Remove') {
    if ([AutoDev.CredentialManager]::Delete($target)) {
        Write-Host ('Removed ' + $target + ' from Windows Credential Manager.')
    }
    else {
        Write-Host ('Nothing to remove: ' + $target + ' is not stored for this user.')
    }
    exit 0
}

# Store.
$secure = Read-Host -Prompt ('Value for ' + $Name + ' (input is hidden)') -AsSecureString
if ($null -eq $secure -or $secure.Length -eq 0) {
    Write-Error -Message 'Nothing was entered. No credential was written.' -ErrorAction Continue
    exit 1
}
if ($secure.Length -gt $maxSecretCharacters) {
    $secure.Dispose()
    Write-Error -Message ('The value is longer than ' + $maxSecretCharacters + ' characters, the most Windows Credential Manager can hold. No credential was written.') -ErrorAction Continue
    exit 1
}

$length = $secure.Length
$pointer = [IntPtr]::Zero
try {
    # UTF-16LE in unmanaged memory; the value never becomes a .NET string.
    $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($secure)
    [AutoDev.CredentialManager]::Write($target, [System.Environment]::UserName, 'AutoDev secret. Managed with scripts\Set-AutoDevCredential.ps1.', $pointer, $length * 2)
}
finally {
    if ($pointer -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($pointer)
    }
    $secure.Dispose()
}

Write-Host ('Stored ' + $target + ' (' + $length + ' characters) in Windows Credential Manager for ' + [System.Environment]::UserName + ' on this computer.')
Write-Host 'Check it without revealing the value:  node scripts\autodev.mjs auth status --project <id>'
exit 0
