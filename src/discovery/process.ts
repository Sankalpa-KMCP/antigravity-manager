import { execFile } from 'child_process';
import { promisify } from 'util';
import { DiscoveredProcess } from '../types';

const execFileAsync = promisify(execFile);

let powershellLaunchCount = 0;

export function getPowershellLaunchCount(): number {
  return powershellLaunchCount;
}

export async function findLanguageServerProcesses(): Promise<DiscoveredProcess[]> {
  powershellLaunchCount++;
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*language_server*' } | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress`;

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
      timeout: 8000
    });

    if (!stdout || !stdout.trim()) {
      return [];
    }

    const parsed = JSON.parse(stdout.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    // Fallback to wmic if powershell query encounters an error
    try {
      const { stdout } = await execFileAsync('wmic', [
        'process',
        'where',
        "name like '%language_server%'",
        'get',
        'ProcessId,CommandLine,Name',
        '/format:csv'
      ], { timeout: 8000 });

      const lines = stdout.split(/\r?\n/).filter(l => l.trim());
      const results: DiscoveredProcess[] = [];

      for (const line of lines) {
        const parts = line.split(',');
        if (parts.length >= 4 && parts[1] && parts[2]) {
          const pid = parseInt(parts[3].trim(), 10);
          if (!isNaN(pid)) {
            results.push({
              ProcessId: pid,
              Name: parts[2].trim(),
              CommandLine: parts[1].trim()
            });
          }
        }
      }
      return results;
    } catch (fallbackErr) {
      throw new Error(`Failed to enumerate processes: ${(err as Error).message}`);
    }
  }
}
