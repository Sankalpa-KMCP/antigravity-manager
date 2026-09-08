import crypto from 'crypto';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { detectTarget } from '../discovery/detector';

const execFileAsync = promisify(execFile);

/**
 * Shared Antigravity 2.0 process lifecycle management helpers.
 * Strictly operates on Antigravity 2.0 (language_server.exe / Antigravity.exe in AppData\Local\Programs\antigravity).
 * NEVER touches Antigravity IDE!
 */

export function closeAntigravity2Processes(): Promise<void> {
  return new Promise(resolve => {
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-Process -Name language_server, Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*AppData*Local*Programs*antigravity*' } | Stop-Process -Force -ErrorAction SilentlyContinue`
    ]);
    ps.on('close', () => resolve());
  });
}

export function isPidRunning(pid: number): Promise<boolean> {
  return new Promise(resolve => {
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-Process -Id ${pid} -ErrorAction SilentlyContinue`
    ]);
    ps.on('close', code => resolve(code === 0));
  });
}

export async function waitForPidExit(pid: number, timeoutMs: number = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const isAlive = await isPidRunning(pid);
    if (!isAlive) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export function launchAntigravity2(): Promise<void> {
  return new Promise(resolve => {
    const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : 'C:\\Users\\Default\\AppData\\Local');
    const serverBin = process.env.ANTIGRAVITY_LANGUAGE_SERVER_BIN || path.join(localAppData, 'Programs', 'antigravity', 'resources', 'bin', 'language_server.exe');
    const csrfToken = crypto.randomUUID();
    const args = [
      '--standalone',
      '--override_ide_name', 'antigravity',
      '--subclient_type', 'hub',
      '--override_ide_version', '2.12.2',
      '--override_user_agent_name', 'antigravity',
      '--https_server_port', '0',
      '--csrf_token', csrfToken,
      '--app_data_dir', 'antigravity',
      '--api_server_url', 'https://generativelanguage.googleapis.com',
      '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com'
    ];

    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -FilePath '${serverBin}' -ArgumentList ${args.map(a => `'${a}'`).join(', ')} -WindowStyle Hidden`
    ]);
    ps.on('close', () => {
      setTimeout(resolve, 3500);
    });
  });
}

export async function pollForNewTarget(oldPid: number, timeoutMs: number = 35000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const d = await detectTarget('antigravity2', 'Cold restore discovery poll');
      if (d.isRunning && d.pid && d.pid !== oldPid && d.port && d.csrfToken) {
        return d;
      }
    } catch {
      // Continue polling
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return null;
}

export interface ProcessContinuitySnapshot {
  mainPid: number | null;
  extHostPid: number | null;
  unifiedLsPid: number | null;
  lspLsPid: number | null;
  timestamp: string;
}

/**
 * Snapshots the key Antigravity IDE processes for continuity verification:
 * - Electron Main PID (Antigravity.exe without --type=)
 * - Extension Host PID (--type=extensionHost)
 * - Unified Language Server PID (language_server_windows_x64.exe without --enable_lsp)
 * - LSP Language Server PID (language_server_windows_x64.exe with --enable_lsp)
 */
export async function snapshotIdeProcesses(): Promise<ProcessContinuitySnapshot> {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*antigravity*' -or $_.CommandLine -like '*antigravity*' } | Select-Object ProcessId, ParentProcessId, Name, CommandLine | ConvertTo-Json -Compress`;
  let processes: Array<{ ProcessId: number; ParentProcessId?: number; Name: string; CommandLine?: string }> = [];

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: 10000
    });
    if (stdout && stdout.trim()) {
      const parsed = JSON.parse(stdout.trim());
      processes = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch {
    // Return empty on failure
  }

  let mainPid: number | null = null;
  let extHostPid: number | null = null;
  let unifiedLsPid: number | null = null;
  let lspLsPid: number | null = null;

  for (const p of processes) {
    const name = (p.Name || '').toLowerCase();
    const cmd = p.CommandLine || '';

    const isIdeProcess = cmd.toLowerCase().includes('antigravity ide') || cmd.toLowerCase().includes('antigravity-ide') || name.includes('antigravity ide');

    if ((name === 'antigravity.exe' || name === 'antigravity ide.exe') && !cmd.includes('--type=') && isIdeProcess) {
      mainPid = p.ProcessId;
    } else if ((cmd.includes('--type=extensionHost') || (cmd.includes('node.mojom.NodeService') && cmd.includes('--inspect-port='))) && isIdeProcess) {
      extHostPid = p.ProcessId;
    } else if (name.includes('language_server') && cmd.includes('--app_data_dir antigravity-ide') && !cmd.includes('--enable_lsp')) {
      unifiedLsPid = p.ProcessId;
      if (!mainPid && p.ParentProcessId) {
        mainPid = p.ParentProcessId;
      }
    } else if (name.includes('language_server') && cmd.includes('--enable_lsp')) {
      lspLsPid = p.ProcessId;
    }
  }

  return {
    mainPid,
    extHostPid,
    unifiedLsPid,
    lspLsPid,
    timestamp: new Date().toISOString()
  };
}
