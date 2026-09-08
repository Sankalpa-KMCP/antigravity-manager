import { DiscoveryTelemetry, TargetId } from '../types';
import { findLanguageServerProcesses } from './process';
import { getListeningPorts, probeConnectRpcPort } from './ports';

export interface DiscoveredTarget {
  targetId: TargetId;
  isRunning: boolean;
  pid: number | null;
  port: number | null;
  csrfToken: string | null;
  discovery: DiscoveryTelemetry;
  error: string | null;
}

interface CachedSession {
  pid: number;
  port: number;
  csrfToken: string;
  discovery: DiscoveryTelemetry;
}

const targetCache: Record<TargetId, CachedSession | null> = {
  ide: null,
  antigravity2: null
};

const discoveryCounters: Record<TargetId, number> = {
  ide: 0,
  antigravity2: 0
};

/**
 * Check if a process ID is still alive without spawning any subprocess.
 * Uses native Win32 OpenProcess via process.kill(pid, 0).
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code !== 'ESRCH';
  }
}

/**
 * Invalidate cached credentials forcing a re-discovery on next query.
 */
export function invalidateTargetCache(targetId: TargetId) {
  targetCache[targetId] = null;
}

/**
 * Discover or return cached session for a target.
 * Normal 5-second polling uses the cached session directly after verifying PID liveness.
 * Shell subprocesses (powershell/netstat) are ONLY spawned when:
 * 1. Initial startup
 * 2. Cached PID has died
 * 3. Force re-discovery requested (e.g. repeated RPC failures)
 * 4. Periodic slow health check for offline targets (60s)
 */
export async function detectTarget(targetId: TargetId, forceReason?: string): Promise<DiscoveredTarget> {
  const cached = targetCache[targetId];

  // Fast-path: Reuse cached session if valid and PID is still alive
  if (!forceReason && cached) {
    if (isPidAlive(cached.pid)) {
      return {
        targetId,
        isRunning: true,
        pid: cached.pid,
        port: cached.port,
        csrfToken: cached.csrfToken,
        discovery: { ...cached.discovery },
        error: null
      };
    } else {
      // Process has died; invalidate and rediscover
      targetCache[targetId] = null;
      forceReason = 'Cached PID terminated';
    }
  }

  // Slow-path: Discover process and port using OS inspection
  const reason = forceReason || (cached ? 'Cached session expired' : 'Initial startup');
  discoveryCounters[targetId]++;

  const telemetry: DiscoveryTelemetry = {
    lastDiscoveryAt: new Date().toISOString(),
    discoveryReason: reason,
    discoveryCount: discoveryCounters[targetId]
  };

  try {
    const processes = await findLanguageServerProcesses();
    let targetProc = null;

    if (targetId === 'ide') {
      targetProc = processes.find(p => {
        const cmd = p.CommandLine || '';
        return (
          p.Name.toLowerCase().includes('language_server_windows_x64') &&
          cmd.includes('--app_data_dir antigravity-ide') &&
          !cmd.includes('--enable_lsp')
        );
      });
      if (!targetProc) {
        targetProc = processes.find(p => {
          const cmd = p.CommandLine || '';
          return p.Name.toLowerCase().includes('language_server_windows_x64') && /--csrf_token\s+([A-Za-z0-9_-]+)/i.test(cmd);
        });
      }
    } else if (targetId === 'antigravity2') {
      targetProc = processes.find(p => {
        const cmd = p.CommandLine || '';
        return (
          cmd.includes('--standalone') ||
          (cmd.includes('--override_ide_name antigravity') && cmd.includes('--subclient_type hub')) ||
          cmd.toLowerCase().includes('programs\\antigravity\\resources\\bin\\language_server.exe')
        );
      });
    }

    if (!targetProc) {
      targetCache[targetId] = null;
      return {
        targetId,
        isRunning: false,
        pid: null,
        port: null,
        csrfToken: null,
        discovery: telemetry,
        error: null
      };
    }

    const cmd = targetProc.CommandLine || '';
    const csrfMatch = cmd.match(/--csrf_token\s+([A-Za-z0-9_-]+)/i);
    const csrfToken = csrfMatch ? csrfMatch[1] : null;

    if (!csrfToken) {
      targetCache[targetId] = null;
      return {
        targetId,
        isRunning: true,
        pid: targetProc.ProcessId,
        port: null,
        csrfToken: null,
        discovery: telemetry,
        error: 'Target process running but CSRF token could not be parsed from command line'
      };
    }

    const candidatePorts = await getListeningPorts(targetProc.ProcessId);
    let workingPort: number | null = null;

    for (const port of candidatePorts) {
      const isWorking = await probeConnectRpcPort(port, csrfToken);
      if (isWorking) {
        workingPort = port;
        break;
      }
    }

    if (!workingPort) {
      targetCache[targetId] = null;
      return {
        targetId,
        isRunning: true,
        pid: targetProc.ProcessId,
        port: null,
        csrfToken,
        discovery: telemetry,
        error: `Process listening on [${candidatePorts.join(', ')}] but none responded to Connect-RPC probe`
      };
    }

    // Cache the working session
    targetCache[targetId] = {
      pid: targetProc.ProcessId,
      port: workingPort,
      csrfToken,
      discovery: telemetry
    };

    return {
      targetId,
      isRunning: true,
      pid: targetProc.ProcessId,
      port: workingPort,
      csrfToken,
      discovery: telemetry,
      error: null
    };
  } catch (err) {
    targetCache[targetId] = null;
    return {
      targetId,
      isRunning: false,
      pid: null,
      port: null,
      csrfToken: null,
      discovery: telemetry,
      error: (err as Error).message
    };
  }
}
