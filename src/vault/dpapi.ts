import { spawn } from 'child_process';
import { sanitizeString } from './sanitizer';

export class DpapiError extends Error {
  constructor(message: string, public readonly originalError?: string) {
    super(message);
    this.name = 'DpapiError';
  }
}

/**
 * Windows DPAPI adapter utilizing CurrentUser data protection.
 * Communicates directly with Windows System.Security.Cryptography.ProtectedData
 * using pure stdin/stdout piping. Zero plaintext temporary files are created on disk.
 */

const PS_PROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security;
$stdin = [Console]::In.ReadToEnd();
if (-not $stdin) { exit 10 }
$bytes = [Convert]::FromBase64String($stdin.Trim());
$enc = [System.Security.Cryptography.ProtectedData]::Protect(
    $bytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
);
[Console]::Out.Write([Convert]::ToBase64String($enc));
`;

const PS_UNPROTECT_SCRIPT = `
Add-Type -AssemblyName System.Security;
$stdin = [Console]::In.ReadToEnd();
if (-not $stdin) { exit 10 }
$bytes = [Convert]::FromBase64String($stdin.Trim());
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $bytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
);
[Console]::Out.Write([Convert]::ToBase64String($dec));
`;

/**
 * Encrypts a plaintext buffer using Windows DPAPI scoped to CurrentUser.
 * The input buffer is wiped (filled with zeros) after encryption.
 */
export async function encryptDpapi(plaintext: Buffer): Promise<Buffer> {
  if (!plaintext || plaintext.length === 0) {
    throw new DpapiError('Cannot encrypt empty or null payload');
  }

  const base64Input = plaintext.toString('base64');

  try {
    const encryptedBase64 = await runPowerShellDpapi(PS_PROTECT_SCRIPT, base64Input);
    return Buffer.from(encryptedBase64.trim(), 'base64');
  } catch (err) {
    throw new DpapiError(`DPAPI encryption failed: ${(err as Error).message}`);
  } finally {
    // Explicitly zero out the plaintext buffer in memory
    plaintext.fill(0);
  }
}

/**
 * Decrypts a DPAPI-encrypted ciphertext buffer scoped to CurrentUser.
 * Fails closed if the ciphertext is corrupted, tampered with, or accessed by a different Windows user.
 */
export async function decryptDpapi(ciphertext: Buffer): Promise<Buffer> {
  if (!ciphertext || ciphertext.length === 0) {
    throw new DpapiError('Cannot decrypt empty or null ciphertext');
  }

  const base64Input = ciphertext.toString('base64');

  try {
    const decryptedBase64 = await runPowerShellDpapi(PS_UNPROTECT_SCRIPT, base64Input);
    return Buffer.from(decryptedBase64.trim(), 'base64');
  } catch (err) {
    const sanitizedMsg = sanitizeString((err as Error).message);
    throw new DpapiError(`DPAPI decryption failed (corrupted ciphertext, invalid key, or wrong Windows user): ${sanitizedMsg}`);
  }
}

/**
 * Internal helper to run DPAPI script via child_process.spawn with stdin/stdout.
 * Avoids any command-line argument secrets and never touches the filesystem.
 */
function runPowerShellDpapi(script: string, stdinData: string): Promise<string> {
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

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    child.on('error', (err) => {
      reject(new DpapiError(`Failed to spawn PowerShell process for DPAPI: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new DpapiError(`PowerShell DPAPI process exited with code ${code}. Stderr: ${stderrData.trim() || 'none'}`));
      } else {
        resolve(stdoutData);
      }
    });

    // Pipe stdin safely and close stream
    try {
      child.stdin.write(stdinData);
      child.stdin.end();
    } catch (writeErr) {
      reject(new DpapiError(`Failed to pipe data to DPAPI stdin: ${(writeErr as Error).message}`));
    }
  });
}
