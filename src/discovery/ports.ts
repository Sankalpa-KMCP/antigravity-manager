import { execFile } from 'child_process';
import https from 'https';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

let netstatLaunchCount = 0;

export function getNetstatLaunchCount(): number {
  return netstatLaunchCount;
}

export async function getListeningPorts(pid: number): Promise<number[]> {
  netstatLaunchCount++;
  try {
    const { stdout } = await execFileAsync('netstat.exe', ['-ano'], { timeout: 8000 });
    const regex = new RegExp(`TCP\\s+(?:127\\.0\\.0\\.1|\\[::1\\]):(\\d+)\\s+.*?LISTENING\\s+${pid}\\b`, 'gi');
    const ports: number[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(stdout)) !== null) {
      const port = parseInt(match[1], 10);
      if (!ports.includes(port)) {
        ports.push(port);
      }
    }

    return ports;
  } catch (err) {
    throw new Error(`Failed to get listening ports for PID ${pid}: ${(err as Error).message}`);
  }
}

export function probeConnectRpcPort(port: number, csrfToken: string, timeoutMs: number = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
    });

    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrfToken,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: timeoutMs,
      rejectUnauthorized: false
    }, (res) => {
      // Any 200 or 4xx status confirms this is the active Connect-RPC HTTP server
      if (res.statusCode && res.statusCode < 500) {
        resolve(true);
      } else {
        resolve(false);
      }
      res.resume(); // Discard stream data
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}
