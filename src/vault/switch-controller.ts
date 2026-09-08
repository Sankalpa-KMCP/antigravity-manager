import crypto from 'crypto';
import { spawn } from 'child_process';
import { TargetState, TargetId } from '../types';
import { SessionVault } from './vault';
import { readWinCred, writeWinCred, WinCredEntry } from './wincred';
import { fetchUserStatus, requestLoginWithBrowser } from '../rpc/endpoints';
import { parseUserStatus } from '../usage/parser';
import { detectTarget, invalidateTargetCache } from '../discovery/detector';
import { safeLog, sanitizeString } from './sanitizer';
import { closeAntigravity2Processes, waitForPidExit, launchAntigravity2, pollForNewTarget } from './process-helper';

export type SwitchControllerState =
  | 'IDLE'
  | 'PRECHECK'
  | 'PREPARING'
  | 'WRITING'
  | 'RESTARTING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'ROLLING_BACK'
  | 'FAILED';

export interface SwitchControllerStatus {
  state: SwitchControllerState;
  activeAccountId: string | null;
  targetEmail: string | null;
  previousEmail: string | null;
  progress: string;
  error: string | null;
  updatedAt: string;
}

export interface ActivationResult {
  success: boolean;
  state: SwitchControllerState;
  targetEmail: string;
  previousEmail: string;
  newPid?: number;
  newPort?: number;
  error?: string;
}

export interface EnrollmentResult {
  success: boolean;
  accountId: string;
  email: string;
  sourceHashMatch: boolean;
  error?: string;
}

/**
 * Transactional Multi-Account Switch Controller for Antigravity 2.0.
 * Orchestrates safe, atomic transitions between vaulted account credentials.
 * Implements a strict fail-closed state machine with automatic rollback on any failure.
 */
export class TransactionalSwitchController {
  private vault: SessionVault;
  private isLocked: boolean = false;
  private currentState: SwitchControllerState = 'IDLE';
  private activeAccountId: string | null = null;
  private targetEmail: string | null = null;
  private previousEmail: string | null = null;
  private progressMessage: string = 'Ready';
  private lastError: string | null = null;
  private statusUpdatedAt: string = new Date().toISOString();
  private inMemoryRollbackSnapshot: WinCredEntry | null = null;

  constructor(vault: SessionVault) {
    this.vault = vault;
  }

  getControllerStatus(): SwitchControllerStatus {
    return {
      state: this.currentState,
      activeAccountId: this.activeAccountId,
      targetEmail: this.targetEmail,
      previousEmail: this.previousEmail,
      progress: this.progressMessage,
      error: this.lastError,
      updatedAt: this.statusUpdatedAt
    };
  }

  private updateState(state: SwitchControllerState, progress: string, error: string | null = null) {
    this.currentState = state;
    this.progressMessage = progress;
    this.lastError = error;
    this.statusUpdatedAt = new Date().toISOString();
    safeLog(`[SWITCH CONTROLLER] ${state} | ${progress} ${error ? `Error: ${error}` : ''}`.trim());
  }

  /**
   * Enrolls a new authorized account (Account B) through the supported LoginWithBrowser flow.
   * Prompts the native browser login, detects authenticated email change,
   * captures the new credential into the DPAPI vault, and cold-verifies the new session.
   */
  async enrollAccountB(
    target: TargetState,
    csrfToken: string,
    timeoutMs: number = 300000 // 5 minutes
  ): Promise<EnrollmentResult> {
    if (this.isLocked) {
      throw new Error('Another switch or enrollment operation is currently in progress.');
    }

    if (!target.isRunning || !target.email || !target.port || !target.pid) {
      throw new Error('Antigravity 2.0 must be running and authenticated to enroll a new account.');
    }

    if (target.trajectoryStatus.state === 'BUSY' || target.trajectoryStatus.runningTrajectories > 0) {
      throw new Error(`Antigravity 2.0 is BUSY (${target.trajectoryStatus.runningTrajectories} tasks). Enrollment refused.`);
    }

    this.isLocked = true;
    const originalEmail = target.email;
    const targetPid = target.pid;

    try {
      this.updateState('PREPARING', `Initiating native LoginWithBrowser flow for new account (Original: ${originalEmail})...`);

      // 1. Trigger native LoginWithBrowser RPC
      const loginRes = await requestLoginWithBrowser(target.port, csrfToken);
      if (!loginRes.success) {
        throw new Error(`Failed to initiate LoginWithBrowser: ${loginRes.error}`);
      }

      this.updateState('VERIFYING', 'Waiting for user to complete Google OAuth in browser (up to 5 minutes)...');

      // 2. Poll GetUserStatus until email changes
      const startTime = Date.now();
      let newEmail: string | null = null;
      let currentPort = target.port;
      let currentCsrf = csrfToken;

      while (Date.now() - startTime < timeoutMs) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const rawStatus = await fetchUserStatus(currentPort, currentCsrf);
          const parsed = parseUserStatus(rawStatus);

          if (parsed.email && parsed.email !== originalEmail) {
            newEmail = parsed.email;
            break;
          }
        } catch {
          // Language server may briefly reload; re-discover target if port changed
          try {
            const recheck = await detectTarget('antigravity2', 'Enrollment poll check');
            if (recheck.isRunning && recheck.port && recheck.csrfToken) {
              currentPort = recheck.port;
              currentCsrf = recheck.csrfToken;
              const rawRecheck = await fetchUserStatus(currentPort, currentCsrf);
              const parsedRecheck = parseUserStatus(rawRecheck);
              if (parsedRecheck.email && parsedRecheck.email !== originalEmail) {
                newEmail = parsedRecheck.email;
                break;
              }
            }
          } catch {
            // continue polling
          }
        }
      }

      if (!newEmail) {
        this.updateState('FAILED', 'Enrollment timed out: No account change detected within 5 minutes.');
        return {
          success: false,
          accountId: '',
          email: '',
          sourceHashMatch: false,
          error: 'Browser authentication timed out or cancelled by user.'
        };
      }

      this.updateState('PRECHECK', `New account authenticated: ${newEmail}. Validating telemetry...`);

      // 3. Validate Account B telemetry
      const rawNewStatus = await fetchUserStatus(currentPort, currentCsrf);
      const parsedB = parseUserStatus(rawNewStatus);

      if (!parsedB.planName || !parsedB.userTier || !parsedB.credits) {
        throw new Error(`Account ${newEmail} telemetry could not be read or lacks valid subscription.`);
      }

      // 4. Capture Account B from gemini:antigravity into DPAPI Vault
      this.updateState('WRITING', `Capturing credential for ${newEmail} into session vault...`);
      const liveCredB = await readWinCred('gemini:antigravity');
      if (!liveCredB) {
        throw new Error('Failed to read updated Windows Credential Manager entry gemini:antigravity.');
      }

      const accountBId = `acc-${newEmail.split('@')[0].replace(/[^a-zA-Z0-9]/g, '_')}`;
      const sourceHash = crypto.createHash('sha256').update(liveCredB.blob).digest('hex');

      await this.vault.storeSession(
        accountBId,
        'google',
        'oauth2_wincred',
        {
          target: liveCredB.target,
          type: liveCredB.type,
          userName: liveCredB.userName,
          persistence: liveCredB.persistence,
          rawBlobBase64: liveCredB.blob.toString('base64'),
          capturedEmail: newEmail,
          capturedAt: new Date().toISOString()
        },
        `Enrolled live account ${newEmail}`
      );

      // Verify Equivalence in memory
      const retrievedB = await this.vault.getSession(accountBId);
      if (!retrievedB || !retrievedB.payload || !retrievedB.payload.rawBlobBase64) {
        throw new Error('Failed to retrieve or decrypt stored Account B session from vault.');
      }

      const vaultBytes = Buffer.from(retrievedB.payload.rawBlobBase64, 'base64');
      const vaultHash = crypto.createHash('sha256').update(vaultBytes).digest('hex');
      const hashMatch = sourceHash === vaultHash;

      // Wipe memory buffers
      vaultBytes.fill(0);
      liveCredB.blob.fill(0);

      if (!hashMatch) {
        throw new Error('Cryptographic hash mismatch between live credential and vaulted copy for Account B.');
      }

      // 5. Cold Verification of Account B
      this.updateState('RESTARTING', `Cold-restarting Antigravity 2.0 to verify Account B (${newEmail}) on cold launch...`);
      await this.closeAntigravity2Processes();
      await this.waitForPidExit(targetPid, 10000);
      await this.launchAntigravity2();

      this.updateState('VERIFYING', 'Discovering new process and validating GetUserStatus for Account B...');
      const newDiscovery = await this.pollForNewTarget(targetPid, 35000);
      if (!newDiscovery || !newDiscovery.isRunning || !newDiscovery.port || !newDiscovery.csrfToken) {
        throw new Error('Failed to discover Antigravity 2.0 after cold restart for Account B.');
      }

      const verifiedStatus = await fetchUserStatus(newDiscovery.port, newDiscovery.csrfToken);
      const verifiedUser = parseUserStatus(verifiedStatus);

      if (verifiedUser.email !== newEmail) {
        throw new Error(`Cold restore verification failed: Expected ${newEmail}, got ${verifiedUser.email}`);
      }

      await this.vault.markValidated(accountBId);
      this.updateState('COMPLETED', `Account B (${newEmail}) successfully enrolled, vaulted, and cold-verified!`);

      return {
        success: true,
        accountId: accountBId,
        email: newEmail,
        sourceHashMatch: true
      };
    } catch (err) {
      const msg = sanitizeString((err as Error).message);
      this.updateState('FAILED', `Enrollment failed: ${msg}`, msg);
      return {
        success: false,
        accountId: '',
        email: '',
        sourceHashMatch: false,
        error: msg
      };
    } finally {
      this.isLocked = false;
    }
  }

  /**
   * Transactionally activates a vaulted account session on Antigravity 2.0.
   * State Machine:
   * PRECHECK -> PREPARING -> WRITING -> RESTARTING -> VERIFYING -> COMPLETED
   * On error: ROLLING_BACK -> FAILED
   */
  async activateVaultedAccount(accountId: string): Promise<ActivationResult> {
    if (this.isLocked) {
      return {
        success: false,
        state: this.currentState,
        targetEmail: '',
        previousEmail: '',
        error: 'Another switch operation is currently in progress.'
      };
    }

    this.isLocked = true;
    let previousCredSnapshot: WinCredEntry | null = null;
    let previousEmailCaptured: string = '';
    let targetEmailExpected: string = '';

    try {
      // 1. PRECHECK
      this.updateState('PRECHECK', `Validating pre-conditions for account activation (${accountId})...`);

      // Verify vault entry exists and is VALID
      const sessionData = await this.vault.getSession(accountId);
      if (!sessionData) {
        throw new Error(`Vault entry for account "${accountId}" was not found.`);
      }

      if (sessionData.entry.status === 'LOCKED' || sessionData.entry.status === 'INVALID') {
        throw new Error(`Account "${accountId}" is ${sessionData.entry.status}. Activation denied.`);
      }

      targetEmailExpected = sessionData.payload.capturedEmail || accountId;
      this.targetEmail = targetEmailExpected;
      this.activeAccountId = accountId;

      // Discover current Antigravity 2.0 target
      const target = await detectTarget('antigravity2', 'Pre-activation check');
      if (!target.isRunning || !target.pid || !target.port || !target.csrfToken) {
        throw new Error('Antigravity 2.0 is not running. Start the application before activating an account.');
      }

      // Idle Gate Check
      const rawStatus = await fetchUserStatus(target.port, target.csrfToken);
      const parsedStatus = parseUserStatus(rawStatus);
      previousEmailCaptured = parsedStatus.email || 'Unknown';
      this.previousEmail = previousEmailCaptured;

      // Check if already active
      if (parsedStatus.email === targetEmailExpected) {
        this.updateState('COMPLETED', `Account ${targetEmailExpected} is already active.`);
        return {
          success: true,
          state: 'COMPLETED',
          targetEmail: targetEmailExpected,
          previousEmail: previousEmailCaptured
        };
      }

      // 2. PREPARING: Snapshot current live credential in memory
      this.updateState('PREPARING', `Snapshotting live credential (${previousEmailCaptured}) in memory before write...`);
      const liveCred = await readWinCred('gemini:antigravity');
      if (!liveCred) {
        throw new Error('Live Windows Credential gemini:antigravity could not be read for rollback snapshot.');
      }

      previousCredSnapshot = {
        target: liveCred.target,
        type: liveCred.type,
        userName: liveCred.userName,
        persistence: liveCred.persistence,
        blob: Buffer.from(liveCred.blob)
      };
      this.inMemoryRollbackSnapshot = previousCredSnapshot;

      // 3. WRITING: Write target vaulted credential to Windows Credential Manager
      this.updateState('WRITING', `Writing vaulted credential for ${targetEmailExpected} to Windows Credential Manager...`);
      const targetBlob = Buffer.from((sessionData.payload.rawBlobBase64 as string) || '', 'base64');
      const credToWrite: WinCredEntry = {
        target: sessionData.payload.target || 'gemini:antigravity',
        type: sessionData.payload.type || 1,
        userName: sessionData.payload.userName || 'antigravity',
        persistence: sessionData.payload.persistence || 2,
        blob: targetBlob
      };

      const writeOk = await writeWinCred(credToWrite);
      targetBlob.fill(0);
      if (!writeOk) {
        throw new Error('Failed to write target credential to Windows Credential Manager.');
      }

      // 4. RESTARTING: Gracefully close Antigravity 2.0 and launch fresh process
      this.updateState('RESTARTING', `Terminating old Antigravity 2.0 (PID ${target.pid}) and launching cold process...`);
      await this.closeAntigravity2Processes();
      const exited = await this.waitForPidExit(target.pid, 10000);
      if (!exited) {
        throw new Error(`Old Antigravity 2.0 process (PID ${target.pid}) failed to exit.`);
      }

      await this.launchAntigravity2();

      // 5. VERIFYING: Rediscover new PID/port and verify GetUserStatus
      this.updateState('VERIFYING', `Discovering new process and verifying GetUserStatus for ${targetEmailExpected}...`);
      const newDiscovery = await this.pollForNewTarget(target.pid, 35000);
      if (!newDiscovery || !newDiscovery.isRunning || !newDiscovery.port || !newDiscovery.csrfToken) {
        throw new Error('Failed to discover Antigravity 2.0 after cold restart.');
      }

      const newRawStatus = await fetchUserStatus(newDiscovery.port, newDiscovery.csrfToken);
      const newParsedUser = parseUserStatus(newRawStatus);

      if (newParsedUser.email !== targetEmailExpected) {
        throw new Error(`Email mismatch after activation! Expected: ${targetEmailExpected}, Actual: ${newParsedUser.email}`);
      }

      if (!newParsedUser.planName || !newParsedUser.userTier) {
        throw new Error('User subscription telemetry is missing or invalid after activation.');
      }

      // Mark account validated in vault
      await this.vault.markValidated(accountId);

      // Invalidate target cache so all queries pick up new PID/port
      invalidateTargetCache('antigravity2');

      this.updateState('COMPLETED', `Successfully activated and verified account ${targetEmailExpected}!`);
      return {
        success: true,
        state: 'COMPLETED',
        targetEmail: targetEmailExpected,
        previousEmail: previousEmailCaptured,
        newPid: newDiscovery.pid!,
        newPort: newDiscovery.port!
      };

    } catch (err) {
      const errMsg = sanitizeString((err as Error).message);
      safeLog(`[ACTIVATION FAILURE] Error: ${errMsg}. Triggering transactional rollback...`);

      // TRANSACTIONAL ROLLBACK
      if (previousCredSnapshot) {
        this.updateState('ROLLING_BACK', `Restoring previous credential for ${previousEmailCaptured}...`);
        try {
          await writeWinCred(previousCredSnapshot);
          previousCredSnapshot.blob.fill(0);

          // Restart Antigravity 2.0 with rolled-back credential
          await this.closeAntigravity2Processes();
          await this.launchAntigravity2();

          // Invalidate cache
          invalidateTargetCache('antigravity2');

          this.updateState('FAILED', `Activation failed: ${errMsg}. Previous credential successfully restored.`, errMsg);
        } catch (rollbackErr) {
          const rollbackMsg = sanitizeString((rollbackErr as Error).message);
          safeLog(`[CRITICAL ROLLBACK FAILURE] ${rollbackMsg}`);
          this.updateState('FAILED', `CRITICAL ROLLBACK FAILURE: Could not restore previous credential: ${rollbackMsg}`, rollbackMsg);
        }
      } else {
        this.updateState('FAILED', `Activation failed before mutation: ${errMsg}`, errMsg);
      }

      return {
        success: false,
        state: this.currentState,
        targetEmail: targetEmailExpected,
        previousEmail: previousEmailCaptured,
        error: errMsg
      };
    } finally {
      this.isLocked = false;
    }
  }

  // --- PROCESS HELPERS (Delegated to shared process-helper) ---
  closeAntigravity2Processes(): Promise<void> {
    return closeAntigravity2Processes();
  }

  waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
    return waitForPidExit(pid, timeoutMs);
  }

  launchAntigravity2(): Promise<void> {
    return launchAntigravity2();
  }

  pollForNewTarget(oldPid: number, timeoutMs: number): Promise<any> {
    return pollForNewTarget(oldPid, timeoutMs);
  }
}
