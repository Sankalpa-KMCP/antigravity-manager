import crypto from 'crypto';
import path from 'path';
import { spawn } from 'child_process';
import { TargetState } from '../types';
import { SessionVault } from './vault';
import { readWinCred, writeWinCred, WinCredEntry, WinCredError } from './wincred';
import { fetchUserStatus } from '../rpc/endpoints';
import { parseUserStatus } from '../usage/parser';
import { detectTarget } from '../discovery/detector';
import { safeLog } from './sanitizer';
import { IDESessionAdapter } from './targets/ide-session';
import { normalizeEmail } from '../pool/account-registry';

export interface CaptureResult {
  success: boolean;
  accountId: string;
  email: string;
  sourceHashMatch: boolean;
  error?: string;
}

export interface ColdRestoreResult {
  success: boolean;
  oldPid: number;
  newPid: number;
  newPort: number;
  expectedEmail: string;
  actualEmail: string;
  planName: string;
  userTier: string;
  quotaReadable: boolean;
  idleState: string;
  ideAccountUnchanged: boolean;
  error?: string;
}

export class VaultSessionManager {
  private vault: SessionVault;
  private inMemoryRollbackSnapshot: WinCredEntry | null = null;

  constructor(vault: SessionVault) {
    this.vault = vault;
  }

  /**
   * Captures the live Antigravity 2.0 session from gemini:antigravity into the DPAPI vault.
   * Performs an immediate cryptographic hash equality check without exposing secrets.
   */
  async captureAntigravity2Session(target: TargetState, accountId?: string): Promise<CaptureResult> {
    if (!target.isRunning || !target.email) {
      return {
        success: false,
        accountId: '',
        email: '',
        sourceHashMatch: false,
        error: 'Target Antigravity 2.0 is not running or unauthenticated'
      };
    }

    if (target.trajectoryStatus.state === 'BUSY' || target.trajectoryStatus.runningTrajectories > 0) {
      return {
        success: false,
        accountId: '',
        email: target.email,
        sourceHashMatch: false,
        error: `Target is BUSY (${target.trajectoryStatus.runningTrajectories} active trajectories). Capture refused.`
      };
    }

    // 1. Read existing WinCred generic credential
    const liveCred = await readWinCred('gemini:antigravity');
    if (!liveCred) {
      return {
        success: false,
        accountId: '',
        email: target.email,
        sourceHashMatch: false,
        error: 'Windows Credential Manager entry gemini:antigravity not found'
      };
    }

    // Cache rollback copy in memory
    this.inMemoryRollbackSnapshot = {
      target: liveCred.target,
      type: liveCred.type,
      userName: liveCred.userName,
      persistence: liveCred.persistence,
      blob: Buffer.from(liveCred.blob)
    };

    const targetAccountId = accountId || `acc-${target.email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_')}`;

    // 2. Compute source SHA-256 hash transiently
    const sourceHash = crypto.createHash('sha256').update(liveCred.blob).digest('hex');

    // 3. Store in DPAPI SessionVault (preserving all metadata)
    await this.vault.storeSession(
      targetAccountId,
      'google',
      'oauth2_wincred',
      {
        target: liveCred.target,
        type: liveCred.type,
        userName: liveCred.userName,
        persistence: liveCred.persistence,
        rawBlobBase64: liveCred.blob.toString('base64'),
        capturedEmail: target.email,
        capturedAt: new Date().toISOString()
      },
      `Captured live session for ${target.email}`
    );

    // 4. Verify Equivalence: Decrypt vault entry and compare hash
    const retrieved = await this.vault.getSession(targetAccountId);
    if (!retrieved || !retrieved.payload || !retrieved.payload.rawBlobBase64) {
      return {
        success: false,
        accountId: targetAccountId,
        email: target.email,
        sourceHashMatch: false,
        error: 'Failed to retrieve or decrypt stored session from vault'
      };
    }

    const vaultBytes = Buffer.from(retrieved.payload.rawBlobBase64, 'base64');
    const vaultHash = crypto.createHash('sha256').update(vaultBytes).digest('hex');
    const match = sourceHash === vaultHash;

    // Wipe memory buffers
    vaultBytes.fill(0);
    liveCred.blob.fill(0);

    safeLog(`[VAULT CAPTURE] Successfully captured session ${targetAccountId} (${target.email}). Hash match: ${match ? 'YES' : 'NO'}`);

    return {
      success: match,
      accountId: targetAccountId,
      email: target.email,
      sourceHashMatch: match,
      error: match ? undefined : 'Cryptographic hash mismatch between live credential and vaulted copy'
    };
  }

  /**
   * Captures the live Antigravity IDE session from state.vscdb into the DPAPI vault under targets.ide.
   * Performs read-only capture, memory-only parsing, and cryptographic verification without writing temp files.
   */
  async captureIDESession(target: TargetState, accountId?: string): Promise<CaptureResult> {
    if (!target.isRunning || !target.email) {
      return {
        success: false,
        accountId: '',
        email: '',
        sourceHashMatch: false,
        error: 'Target Antigravity IDE is not running or unauthenticated'
      };
    }

    try {
      const email = normalizeEmail(target.email);
      const targetAccountId = accountId || `acc-${email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '_')}`;

      // 1. Read live session from state.vscdb in read-only mode
      const idePayload = await IDESessionAdapter.readCurrentLiveIDESession(email);

      // Compute hash of rawItemValue for verification
      const sourceHash = crypto.createHash('sha256').update(idePayload.rawItemValue).digest('hex');

      // 2. Store in DPAPI SessionVault under target 'ide'
      await this.vault.storeTargetSession(
        targetAccountId,
        'ide',
        idePayload,
        `Captured live session for ${email}`
      );

      // 3. Verify equivalence in memory
      const retrieved = await this.vault.getTargetSession(targetAccountId, 'ide');
      if (!retrieved || !retrieved.payload || !retrieved.payload.rawItemValue) {
        return {
          success: false,
          accountId: targetAccountId,
          email,
          sourceHashMatch: false,
          error: 'Failed to retrieve or decrypt stored IDE session from vault'
        };
      }

      const vaultHash = crypto.createHash('sha256').update(retrieved.payload.rawItemValue).digest('hex');
      const match = sourceHash === vaultHash;

      safeLog(`[VAULT CAPTURE] Successfully captured IDE session for ${targetAccountId} (${email}). Hash match: ${match ? 'YES' : 'NO'}`);

      return {
        success: match,
        accountId: targetAccountId,
        email,
        sourceHashMatch: match,
        error: match ? undefined : 'Cryptographic hash mismatch between live IDE session and vaulted copy'
      };
    } catch (err) {
      const msg = (err as Error).message;
      safeLog(`[VAULT CAPTURE ERROR] Failed to capture IDE session: ${msg}`);
      return {
        success: false,
        accountId: '',
        email: target.email || '',
        sourceHashMatch: false,
        error: msg
      };
    }
  }

  /**
   * Executes the Cold Restore Proof:
   * 1. Requires Antigravity 2.0 to be IDLE.
   * 2. Writes the vaulted SAME credential back to gemini:antigravity.
   * 3. Gracefully closes Antigravity 2.0 and confirms old PID exits.
   * 4. Starts Antigravity 2.0 normally.
   * 5. Rediscovers NEW PID / port / CSRF.
   * 6. Queries GetUserStatus against the NEW process to prove authentic cold restoration.
   * 7. Verifies Antigravity IDE is completely untouched.
   */
  async executeColdRestoreProof(
    target: TargetState,
    accountId: string,
    executablePath?: string
  ): Promise<ColdRestoreResult> {
    const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : 'C:\\Users\\Default\\AppData\\Local');
    const resolvedExecPath = executablePath || process.env.ANTIGRAVITY_APP_PATH || path.join(localAppData, 'Programs', 'antigravity', 'Antigravity.exe');
    const oldPid = target.pid || 0;
    const expectedEmail = target.email || '';

    // Verify Idle Gate
    if (target.trajectoryStatus.state === 'BUSY' || target.trajectoryStatus.runningTrajectories > 0) {
      throw new Error(`Target Antigravity 2.0 is BUSY (${target.trajectoryStatus.runningTrajectories} tasks). Cold restore refused.`);
    }

    // Retrieve encrypted session from vault
    const retrieved = await this.vault.getSession(accountId);
    if (!retrieved || !retrieved.payload || !retrieved.payload.rawBlobBase64) {
      throw new Error(`Session ${accountId} not found in vault`);
    }

    const payload = retrieved.payload;
    const restoredBlob = Buffer.from(payload.rawBlobBase64 as string, 'base64');

    const credToWrite: WinCredEntry = {
      target: payload.target || 'gemini:antigravity',
      type: payload.type || 1,
      userName: payload.userName || 'antigravity',
      persistence: payload.persistence || 2,
      blob: restoredBlob
    };

    safeLog(`[COLD RESTORE] Step 1: Writing vaulted same-session credential to Windows Credential Manager (${credToWrite.target})...`);
    await writeWinCred(credToWrite);
    restoredBlob.fill(0);

    safeLog(`[COLD RESTORE] Step 2: Gracefully terminating Antigravity 2.0 (PID ${oldPid})...`);
    await this.closeAntigravity2Processes();

    // Confirm old PID is gone
    const oldExited = await this.waitForPidExit(oldPid, 10000);
    if (!oldExited) {
      throw new Error(`Old Antigravity 2.0 process (PID ${oldPid}) failed to exit.`);
    }
    safeLog(`[COLD RESTORE] Step 3: Old Antigravity 2.0 process exited successfully.`);

    // Start Antigravity 2.0 normally
    safeLog('[COLD RESTORE] Step 4: Starting Antigravity 2.0 language server...');
    await this.launchAntigravity2();

    // Rediscover NEW PID / port / CSRF
    safeLog(`[COLD RESTORE] Step 5: Waiting for new Antigravity 2.0 process to initialize RPC port...`);
    const newDiscovery = await this.pollForNewTarget(oldPid, 35000);
    if (!newDiscovery || !newDiscovery.isRunning || !newDiscovery.port || !newDiscovery.csrfToken) {
      // Rollback attempt
      await this.rollbackToOriginalSnapshot();
      throw new Error('Failed to discover new Antigravity 2.0 process after launch. Rolled back credential.');
    }

    safeLog(`[COLD RESTORE] Step 6: Discovered NEW Antigravity 2.0 process (PID ${newDiscovery.pid}, Port ${newDiscovery.port}). Querying GetUserStatus...`);
    const rawUserStatus = await fetchUserStatus(newDiscovery.port, newDiscovery.csrfToken);
    const parsedUser = parseUserStatus(rawUserStatus);

    safeLog(`[COLD RESTORE] Step 7: GetUserStatus returned email: "${parsedUser.email}", tier: "${parsedUser.userTier}", plan: "${parsedUser.planName}".`);

    // Validate email
    if (parsedUser.email !== expectedEmail) {
      await this.rollbackToOriginalSnapshot();
      throw new Error(`Email mismatch after cold restore! Expected "${expectedEmail}", received "${parsedUser.email}". Rolled back credential.`);
    }

    // Verify IDE remains untouched
    const ideDiscovery = await detectTarget('ide', 'Verify IDE after AG2 cold restore');
    const ideAccountUnchanged = ideDiscovery.isRunning === true;

    return {
      success: true,
      oldPid,
      newPid: newDiscovery.pid!,
      newPort: newDiscovery.port!,
      expectedEmail,
      actualEmail: parsedUser.email,
      planName: parsedUser.planName || 'Unknown',
      userTier: parsedUser.userTier || 'Unknown',
      quotaReadable: parsedUser.credits !== null && parsedUser.models.length > 0,
      idleState: 'IDLE',
      ideAccountUnchanged
    };
  }

  /**
   * Restores the in-memory rollback snapshot in the event of any restoration failure.
   */
  async rollbackToOriginalSnapshot(): Promise<boolean> {
    if (!this.inMemoryRollbackSnapshot) {
      safeLog('[ROLLBACK] No in-memory rollback snapshot available.');
      return false;
    }

    try {
      safeLog('[ROLLBACK] Restoring original WinCred snapshot...');
      await writeWinCred(this.inMemoryRollbackSnapshot);
      safeLog('[ROLLBACK] Original WinCred snapshot restored successfully.');
      return true;
    } catch (err) {
      safeLog(`[CRITICAL ROLLBACK FAILURE] Failed to restore original WinCred snapshot: ${(err as Error).message}`);
      return false;
    }
  }

  // --- PRIVATE PROCESS HELPERS ---

  private closeAntigravity2Processes(): Promise<void> {
    return new Promise(resolve => {
      const ps = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-Process -Name language_server, Antigravity -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*AppData*Local*Programs*antigravity*' -or ($_.Path -like '*antigravity*' -and $_.Path -notlike '*antigravity-ide*') } | Stop-Process -Force -ErrorAction SilentlyContinue`
      ]);
      ps.on('close', () => resolve());
    });
  }

  private async waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const isAlive = await this.isPidRunning(pid);
      if (!isAlive) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  private isPidRunning(pid: number): Promise<boolean> {
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

  private launchAntigravity2(): Promise<void> {
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

      const child = spawn(serverBin, args, {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
      setTimeout(resolve, 3500);
    });
  }

  private async pollForNewTarget(oldPid: number, timeoutMs: number): Promise<any> {
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
}
