import { spawn } from 'child_process';
import { sanitizeString } from './sanitizer';

export interface WinCredEntry {
  target: string;
  type: number; // 1 = Generic
  userName: string;
  persistence: number; // 2 = Local Machine, 3 = Enterprise
  blob: Buffer;
  lastWritten?: string;
}

export class WinCredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WinCredError';
  }
}

/**
 * P/Invoke script for reading Windows Credentials via advapi32.dll.
 * Streams data strictly over stdin and stdout.
 */
const PS_READ_WINCRED_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WinCredNativeReader {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "CredReadW", CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credPtr);

    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr cred);

    public static string ReadToB64(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1 /* Generic */, 0, out ptr)) {
            int err = Marshal.GetLastWin32Error();
            if (err == 1168 /* ERROR_NOT_FOUND */) {
                return "{\\"exists\\":false}";
            }
            throw new Exception("CredRead failed with Win32 error code: " + err);
        }
        try {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            byte[] bytes = new byte[c.CredentialBlobSize];
            if (c.CredentialBlobSize > 0 && c.CredentialBlob != IntPtr.Zero) {
                Marshal.Copy(c.CredentialBlob, bytes, 0, c.CredentialBlobSize);
            }
            string b64 = Convert.ToBase64String(bytes);
            string user = Marshal.PtrToStringUni(c.UserName) ?? "";
            string tgt = Marshal.PtrToStringUni(c.TargetName) ?? target;
            return string.Format(
                "{{\\"exists\\":true,\\"target\\":\\"{0}\\",\\"type\\":{1},\\"userName\\":\\"{2}\\",\\"persistence\\":{3},\\"blobBase64\\":\\"{4}\\"}}",
                tgt.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\""),
                c.Type,
                user.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\""),
                c.Persist,
                b64
            );
        } finally {
            CredFree(ptr);
        }
    }
}
"@

$stdin = [Console]::In.ReadToEnd().Trim();
if (-not $stdin) { exit 10; }
$result = [WinCredNativeReader]::ReadToB64($stdin);
[Console]::Out.Write($result);
`;

/**
 * P/Invoke script for writing Windows Credentials via advapi32.dll.
 * Receives complete credential structure and secret payload strictly over stdin.
 */
const PS_WRITE_WINCRED_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WinCredNativeWriter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags;
        public int Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "CredWriteW", CharSet = CharSet.Unicode)]
    public static extern bool CredWrite(ref CREDENTIAL credential, int flags);

    public static void Write(string target, string userName, int type, int persist, byte[] blob) {
        CREDENTIAL cred = new CREDENTIAL();
        cred.Flags = 0;
        cred.Type = type;
        cred.TargetName = Marshal.StringToHGlobalUni(target);
        cred.UserName = Marshal.StringToHGlobalUni(userName);
        cred.Comment = IntPtr.Zero;
        cred.Persist = persist;
        cred.AttributeCount = 0;
        cred.Attributes = IntPtr.Zero;
        cred.TargetAlias = IntPtr.Zero;
        cred.CredentialBlobSize = blob.Length;
        cred.CredentialBlob = Marshal.AllocHGlobal(blob.Length);

        try {
            Marshal.Copy(blob, 0, cred.CredentialBlob, blob.Length);
            bool success = CredWrite(ref cred, 0);
            if (!success) {
                int err = Marshal.GetLastWin32Error();
                throw new Exception("CredWrite failed with Win32 error code: " + err);
            }
        } finally {
            if (cred.TargetName != IntPtr.Zero) Marshal.FreeHGlobal(cred.TargetName);
            if (cred.UserName != IntPtr.Zero) Marshal.FreeHGlobal(cred.UserName);
            if (cred.CredentialBlob != IntPtr.Zero) {
                // Zero memory before freeing
                for (int i = 0; i < blob.Length; i++) {
                    Marshal.WriteByte(cred.CredentialBlob, i, 0);
                }
                Marshal.FreeHGlobal(cred.CredentialBlob);
            }
        }
    }
}
"@

$stdin = [Console]::In.ReadToEnd().Trim();
if (-not $stdin) { exit 10; }
$data = $stdin | ConvertFrom-Json;
$blobBytes = [Convert]::FromBase64String($data.blobBase64);

[WinCredNativeWriter]::Write(
    $data.target,
    $data.userName,
    [int]$data.type,
    [int]$data.persistence,
    $blobBytes
);

# Clear byte array in memory
[Array]::Clear($blobBytes, 0, $blobBytes.Length);
[Console]::Out.Write("SUCCESS");
`;

/**
 * P/Invoke script for deleting Windows Credentials via advapi32.dll.
 */
const PS_DELETE_WINCRED_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class WinCredNativeDeleter {
    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode)]
    public static extern bool CredDelete(string target, int type, int flags);

    public static void Delete(string target, int type) {
        bool success = CredDelete(target, type, 0);
        if (!success) {
            int err = Marshal.GetLastWin32Error();
            if (err != 1168 /* ERROR_NOT_FOUND */) {
                throw new Exception("CredDelete failed with Win32 error code: " + err);
            }
        }
    }
}
"@

$stdin = [Console]::In.ReadToEnd().Trim();
if (-not $stdin) { exit 10; }
[WinCredNativeDeleter]::Delete($stdin, 1);
[Console]::Out.Write("SUCCESS");
`;

/**
 * Reads a generic Windows Credential safely using pure stdin/stdout binary streaming.
 * Secrets never touch process arguments or disk.
 */
export async function readWinCred(target: string): Promise<WinCredEntry | null> {
  if (!target || typeof target !== 'string') {
    throw new WinCredError('Target name is required to read Windows Credential');
  }

  const rawJson = await runPowerShellWithStdin(PS_READ_WINCRED_SCRIPT, target);
  try {
    const parsed = JSON.parse(rawJson.trim());
    if (!parsed.exists) {
      return null;
    }

    const blob = Buffer.from(parsed.blobBase64, 'base64');
    return {
      target: parsed.target,
      type: parsed.type,
      userName: parsed.userName,
      persistence: parsed.persistence,
      blob
    };
  } catch (err) {
    throw new WinCredError(`Failed to parse WinCred response: ${sanitizeString((err as Error).message)}`);
  }
}

/**
 * Writes a generic Windows Credential safely using pure stdin binary streaming.
 * Secrets never touch process arguments or disk.
 */
export async function writeWinCred(entry: WinCredEntry): Promise<boolean> {
  if (!entry || !entry.target || !entry.blob) {
    throw new WinCredError('Target and credential blob are required to write Windows Credential');
  }

  const inputPayload = JSON.stringify({
    target: entry.target,
    userName: entry.userName || '',
    type: entry.type || 1, // Generic
    persistence: entry.persistence || 2, // Local Machine
    blobBase64: entry.blob.toString('base64')
  });

  try {
    const result = await runPowerShellWithStdin(PS_WRITE_WINCRED_SCRIPT, inputPayload);
    return result.trim() === 'SUCCESS';
  } catch (err) {
    throw new WinCredError(`Failed to write WinCred: ${sanitizeString((err as Error).message)}`);
  }
}

/**
 * Deletes a generic Windows Credential safely.
 */
export async function deleteWinCred(target: string): Promise<boolean> {
  if (!target || typeof target !== 'string') {
    throw new WinCredError('Target name is required to delete Windows Credential');
  }

  try {
    const result = await runPowerShellWithStdin(PS_DELETE_WINCRED_SCRIPT, target);
    return result.trim() === 'SUCCESS';
  } catch (err) {
    throw new WinCredError(`Failed to delete WinCred: ${sanitizeString((err as Error).message)}`);
  }
}

/**
 * Internal helper to run a PowerShell script with stdin/stdout streaming.
 */
function runPowerShellWithStdin(script: string, stdinData: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', chunk => {
      stdoutData += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderrData += chunk.toString();
    });

    child.on('error', err => {
      reject(new WinCredError(`Failed to spawn PowerShell: ${err.message}`));
    });

    child.on('close', code => {
      if (code !== 0) {
        reject(new WinCredError(`Process exited with code ${code}. Stderr: ${stderrData.trim() || 'none'}`));
      } else {
        resolve(stdoutData);
      }
    });

    try {
      child.stdin.write(stdinData);
      child.stdin.end();
    } catch (writeErr) {
      reject(new WinCredError(`Failed to write to stdin: ${(writeErr as Error).message}`));
    }
  });
}
