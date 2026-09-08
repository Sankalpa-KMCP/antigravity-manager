import crypto from 'crypto';
import { TargetState, EnrollmentState, EnrollmentControllerStatus } from '../types';
import { SessionVault } from './vault';
import { readWinCred, writeWinCred, WinCredEntry } from './wincred';
import { fetchUserStatus, requestLoginWithBrowser } from '../rpc/endpoints';
import { parseUserStatus } from '../usage/parser';
import { detectTarget, invalidateTargetCache } from '../discovery/detector';
import { safeLog, sanitizeString } from './sanitizer';
import { normalizeEmail, AccountRegistry } from '../pool/account-registry';
import { QuotaCache } from '../pool/quota-cache';
import {
  closeAntigravity2Processes,
  waitForPidExit,
  launchAntigravity2,
  pollForNewTarget
} from './process-helper';

export interface EnrollmentOptions {
  returnToBase?: boolean;
  timeoutMs?: number;
}

export interface EnrollmentExecutionResult {
  success: boolean;
  state: EnrollmentState;
  accountId: string;
  email: string;
  sourceHashMatch: boolean;
  returnedToBase: boolean;
  finalActiveEmail: string;
  error?: string;
  errorCode?: 'DUPLICATE_ACCOUNT' | 'TIMEOUT' | 'CANCELLED' | 'VALIDATION_FAILED' | 'BUSY' | 'SYSTEM_ERROR';
}

/**
 * Production-Grade Multi-Account Enrollment Controller for Antigravity 2.0.
 * Orchestrates safe, reusable enrollment of authorized provider-approved accounts.
 * Implements strict state machine, duplicate protection, zero-exposure capture,
 * cold-launch verification, and return-to-base restoration.
 */
export class EnrollmentController {
  private vault: SessionVault;
  private registry: AccountRegistry;
  private quotaCache: QuotaCache;

  private isLocked: boolean = false;
  private currentState: EnrollmentState = 'IDLE';
  private preservedEmail: string | null = null;
  private preservedAccountId: string | null = null;
  private detectedEmail: string | null = null;
  private returnToBaseConfig: boolean = true;
  private progressMessage: string = 'Ready';
  private lastError: string | null = null;
  private startedAt: string | null = null;
  private statusUpdatedAt: string = new Date().toISOString();

  private cancellationRequested: boolean = false;
  private inMemoryPreservedCred: WinCredEntry | null = null;

  constructor(vault: SessionVault, registry: AccountRegistry, quotaCache: QuotaCache) {
    this.vault = vault;
    this.registry = registry;
    this.quotaCache = quotaCache;
  }

  getEnrollmentStatus(): EnrollmentControllerStatus {
    return {
      state: this.currentState,
      preservedEmail: this.preservedEmail,
      detectedEmail: this.detectedEmail,
      returnToBase: this.returnToBaseConfig,
      progress: this.progressMessage,
      error: this.lastError,
      startedAt: this.startedAt,
      updatedAt: this.statusUpdatedAt
    };
  }

  private updateState(state: EnrollmentState, progress: string, error: string | null = null) {
    this.currentState = state;
    this.progressMessage = progress;
    this.lastError = error;
    this.statusUpdatedAt = new Date().toISOString();
    safeLog(`[ENROLLMENT CONTROLLER] ${state} | ${progress} ${error ? `Error: ${error}` : ''}`.trim());
  }

  cancelEnrollment(): { success: boolean; message: string } {
    if (!this.isLocked || this.currentState === 'IDLE' || this.currentState === 'COMPLETED' || this.currentState === 'FAILED') {
      return { success: false, message: 'No active enrollment operation to cancel.' };
    }

    this.cancellationRequested = true;
    this.updateState('CANCELLING', 'User requested enrollment cancellation. Rolling back...');
    return { success: true, message: 'Enrollment cancellation initiated.' };
  }

  /**
   * Reusable multi-account enrollment workflow.
   * State Machine:
   * PRECHECK -> PRESERVE_CURRENT -> START_OAUTH -> WAITING_FOR_USER
   * -> DETECT_ACCOUNT_CHANGE -> VALIDATING_NEW_ACCOUNT -> CAPTURING
   * -> COLD_VERIFYING -> (RETURN_TO_BASE) -> COMPLETED
   *
   * Failure states: CANCELLING -> ROLLING_BACK -> FAILED
   */
  async beginEnrollment(
    target: TargetState,
    csrfToken: string,
    options: EnrollmentOptions = {}
  ): Promise<EnrollmentExecutionResult> {
    if (this.isLocked) {
      return {
        success: false,
        state: this.currentState,
        accountId: '',
        email: '',
        sourceHashMatch: false,
        returnedToBase: false,
        finalActiveEmail: '',
        error: 'Another switch or enrollment operation is currently in progress.',
        errorCode: 'BUSY'
      };
    }

    this.isLocked = true;
    this.cancellationRequested = false;
    this.returnToBaseConfig = options.returnToBase !== undefined ? options.returnToBase : true;
    const timeoutMs = options.timeoutMs || 300000; // 5 minutes default
    this.startedAt = new Date().toISOString();

    let targetPid = target.pid;
    let currentPort = target.port;
    let currentCsrf = csrfToken;
    let newAccountId = '';
    let newEmail = '';

    try {
      // 1. PRECHECK: Idle Gate Verification
      this.updateState('PRECHECK', 'Validating target readiness and IDLE gate...');

      if (!target.isRunning || !target.email || !target.port || !target.pid) {
        throw new Error('Antigravity 2.0 must be running and authenticated before starting enrollment.');
      }

      if (target.trajectoryStatus.state === 'BUSY' || target.trajectoryStatus.runningTrajectories > 0) {
        const err = `Antigravity 2.0 is BUSY with ${target.trajectoryStatus.runningTrajectories} active tasks. Enrollment refused.`;
        this.updateState('FAILED', err, err);
        return {
          success: false,
          state: 'FAILED',
          accountId: '',
          email: '',
          sourceHashMatch: false,
          returnedToBase: false,
          finalActiveEmail: target.email,
          error: err,
          errorCode: 'BUSY'
        };
      }

      const initialEmail = normalizeEmail(target.email);
      this.preservedEmail = initialEmail;

      // 2. PRESERVE_CURRENT: Snapshot live credential in memory
      this.updateState('PRESERVE_CURRENT', `Preserving current session (${initialEmail}) in memory before OAuth...`);
      const livePreservedCred = await readWinCred('gemini:antigravity');
      if (!livePreservedCred) {
        throw new Error('Could not read existing Windows Credential Manager entry "gemini:antigravity" for preservation.');
      }

      this.inMemoryPreservedCred = {
        target: livePreservedCred.target,
        type: livePreservedCred.type,
        userName: livePreservedCred.userName,
        persistence: livePreservedCred.persistence,
        blob: Buffer.from(livePreservedCred.blob)
      };
      livePreservedCred.blob.fill(0);

      // Record preserved account ID if known in registry/vault
      const existingPreservedAcc = this.registry.getAccount(initialEmail);
      this.preservedAccountId = existingPreservedAcc ? existingPreservedAcc.id : `acc-${initialEmail.split('@')[0]}`;

      // 3. START_OAUTH: Request supported browser sign-in
      this.updateState('START_OAUTH', 'Initiating supported browser login flow...');
      try {
        await requestLoginWithBrowser(target.port, csrfToken);
      } catch {
        // In 2.12.2, language server may return deprecated 500. This is expected.
        // The user logs in via normal Google authentication in browser or app.
      }

      // 4. WAITING_FOR_USER: Poll GetUserStatus until email changes or timeout/cancelled
      this.updateState('WAITING_FOR_USER', `Waiting for Google OAuth completion in browser (Original: ${initialEmail})...`);
      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        if (this.cancellationRequested) {
          throw new Error('Enrollment cancelled by user.');
        }

        await new Promise(r => setTimeout(r, 2000));

        try {
          const rawStatus = await fetchUserStatus(currentPort!, currentCsrf);
          const parsed = parseUserStatus(rawStatus);

          if (parsed.email && normalizeEmail(parsed.email) !== initialEmail) {
            newEmail = normalizeEmail(parsed.email);
            this.detectedEmail = newEmail;
            break;
          }
        } catch {
          // Process may restart or reload; check if port changed
          try {
            const recheck = await detectTarget('antigravity2', 'Enrollment waiting poll');
            if (recheck.isRunning && recheck.port && recheck.csrfToken) {
              currentPort = recheck.port;
              currentCsrf = recheck.csrfToken;
              targetPid = recheck.pid;
              const rawRecheck = await fetchUserStatus(currentPort, currentCsrf);
              const parsedRecheck = parseUserStatus(rawRecheck);
              if (parsedRecheck.email && normalizeEmail(parsedRecheck.email) !== initialEmail) {
                newEmail = normalizeEmail(parsedRecheck.email);
                this.detectedEmail = newEmail;
                break;
              }
            }
          } catch {
            // Keep polling
          }
        }
      }

      if (!newEmail) {
        throw new Error(`Enrollment timed out: No account change detected within ${Math.round(timeoutMs / 1000)} seconds.`);
      }

      // 5. DETECT_ACCOUNT_CHANGE: Email change detected
      this.updateState('DETECT_ACCOUNT_CHANGE', `Detected account change to: ${newEmail}. Checking duplicate status...`);

      // 6. VALIDATING_NEW_ACCOUNT: Duplicate Protection & Telemetry
      this.updateState('VALIDATING_NEW_ACCOUNT', `Validating account ${newEmail}...`);

      // A. DUPLICATE ACCOUNT PROTECTION
      const existingInVault = this.vault.listMetadata().find(e => {
        const vAcc = this.registry.getAccountById(e.accountId);
        return (vAcc && normalizeEmail(vAcc.email) === newEmail);
      });

      if (existingInVault) {
        const dupError = `DUPLICATE_ACCOUNT: Account "${newEmail}" is already registered in the vault (${existingInVault.accountId}). Duplicate enrollment rejected.`;
        safeLog(`[ENROLLMENT DUPLICATE] ${dupError}`);
        // Execute rollback to restore preserved session
        await this.rollbackToPreserved('Duplicate account detected');
        this.updateState('FAILED', dupError, dupError);
        return {
          success: false,
          state: 'FAILED',
          accountId: existingInVault.accountId,
          email: newEmail,
          sourceHashMatch: false,
          returnedToBase: true,
          finalActiveEmail: initialEmail,
          error: dupError,
          errorCode: 'DUPLICATE_ACCOUNT'
        };
      }

      // B. TELEMETRY & IDLE VALIDATION
      const rawNewStatus = await fetchUserStatus(currentPort!, currentCsrf);
      const parsedB = parseUserStatus(rawNewStatus);

      if (!parsedB.planName || !parsedB.userTier || !parsedB.credits) {
        throw new Error(`Account "${newEmail}" telemetry is invalid or missing required subscription data.`);
      }

      // 7. CAPTURING: Memory-only read -> DPAPI encrypt -> zero buffers
      this.updateState('CAPTURING', `Securely capturing credential for ${newEmail} into DPAPI vault...`);
      const liveCredB = await readWinCred('gemini:antigravity');
      if (!liveCredB) {
        throw new Error('Failed to read updated Windows Credential Manager entry "gemini:antigravity".');
      }

      newAccountId = `acc-${newEmail.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const sourceHash = crypto.createHash('sha256').update(liveCredB.blob).digest('hex');

      await this.vault.storeSession(
        newAccountId,
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
        `Enrolled authorized account ${newEmail}`
      );

      // Verify source <-> vault equality in memory
      const retrieved = await this.vault.getSession(newAccountId);
      if (!retrieved || !retrieved.payload || !retrieved.payload.rawBlobBase64) {
        throw new Error('Failed to retrieve or decrypt stored account session from vault.');
      }

      const decryptedBytes = Buffer.from(retrieved.payload.rawBlobBase64, 'base64');
      const decryptedHash = crypto.createHash('sha256').update(decryptedBytes).digest('hex');
      const match = sourceHash === decryptedHash;

      // Immediately zero memory buffers
      decryptedBytes.fill(0);
      liveCredB.blob.fill(0);

      if (!match) {
        throw new Error('Cryptographic hash mismatch between live credential and decrypted vault session.');
      }

      // Register account in registry and populate quota cache
      this.registry.registerObservedAccount({
        email: newEmail,
        targetId: 'antigravity2',
        userName: parsedB.userName,
        source: 'manual'
      });

      this.quotaCache.updateCache({
        email: newEmail,
        planName: parsedB.planName,
        userTier: parsedB.userTier,
        credits: parsedB.credits,
        models: parsedB.models
      });

      // 8. COLD_VERIFYING: Cold restart Antigravity 2.0 to verify new session on fresh process
      this.updateState('COLD_VERIFYING', `Cold-restarting Antigravity 2.0 to verify new account (${newEmail}) on clean launch...`);
      await closeAntigravity2Processes();
      if (targetPid) {
        await waitForPidExit(targetPid, 10000);
      }
      await launchAntigravity2();

      const coldDiscovery = await pollForNewTarget(targetPid || 0, 35000);
      if (!coldDiscovery || !coldDiscovery.isRunning || !coldDiscovery.port || !coldDiscovery.csrfToken) {
        throw new Error(`Failed to discover Antigravity 2.0 after cold restart for account ${newEmail}.`);
      }

      const coldStatus = await fetchUserStatus(coldDiscovery.port, coldDiscovery.csrfToken);
      const coldParsed = parseUserStatus(coldStatus);

      if (normalizeEmail(coldParsed.email || '') !== newEmail) {
        throw new Error(`Cold restore verification failed: Expected ${newEmail}, but got ${coldParsed.email}.`);
      }

      // Mark account as VALID in vault
      await this.vault.markValidated(newAccountId);
      invalidateTargetCache('antigravity2');

      // 9. RETURN-TO-BASE: If configured (ON by default), reactivate previous account
      let finalActiveEmail = newEmail;
      if (this.returnToBaseConfig && this.inMemoryPreservedCred) {
        this.updateState('PRESERVE_CURRENT', `Return-to-base: Restoring working account (${initialEmail})...`);
        await this.restoreAccountCred(this.inMemoryPreservedCred, initialEmail);
        finalActiveEmail = initialEmail;
      }

      this.updateState('COMPLETED', `Account ${newEmail} successfully enrolled and vaulted! (Active: ${finalActiveEmail})`);

      return {
        success: true,
        state: 'COMPLETED',
        accountId: newAccountId,
        email: newEmail,
        sourceHashMatch: true,
        returnedToBase: this.returnToBaseConfig,
        finalActiveEmail
      };

    } catch (err) {
      const errMsg = sanitizeString((err as Error).message);
      safeLog(`[ENROLLMENT ERROR] ${errMsg}. Initiating automatic rollback to preserved account...`);

      const isCancelled = this.cancellationRequested || errMsg.includes('cancelled');
      const isTimeout = errMsg.includes('timed out');
      const errorCode = isCancelled ? 'CANCELLED' : (isTimeout ? 'TIMEOUT' : 'SYSTEM_ERROR');

      // Execute rollback to restore preserved session
      if (this.inMemoryPreservedCred && this.preservedEmail) {
        this.updateState('ROLLING_BACK', `Rolling back to preserved account (${this.preservedEmail})...`);
        try {
          await this.rollbackToPreserved(errMsg);
          this.updateState('FAILED', `Enrollment failed: ${errMsg}. Working account successfully restored.`, errMsg);
        } catch (rollbackErr) {
          const rMsg = sanitizeString((rollbackErr as Error).message);
          safeLog(`[CRITICAL ROLLBACK FAILURE] ${rMsg}`);
          this.updateState('FAILED', `CRITICAL ROLLBACK FAILURE: ${rMsg}`, rMsg);
        }
      } else {
        this.updateState('FAILED', `Enrollment failed: ${errMsg}`, errMsg);
      }

      return {
        success: false,
        state: this.currentState,
        accountId: newAccountId,
        email: newEmail,
        sourceHashMatch: false,
        returnedToBase: false,
        finalActiveEmail: this.preservedEmail || '',
        error: errMsg,
        errorCode
      };
    } finally {
      if (this.inMemoryPreservedCred) {
        this.inMemoryPreservedCred.blob.fill(0);
        this.inMemoryPreservedCred = null;
      }
      this.isLocked = false;
    }
  }

  /**
   * Safe rollback helper: writes preserved credential back, restarts Antigravity 2.0,
   * and verifies the preserved email returns on cold process.
   */
  private async rollbackToPreserved(reason: string): Promise<void> {
    if (!this.inMemoryPreservedCred || !this.preservedEmail) {
      return;
    }

    safeLog(`[ROLLBACK] Restoring WinCred for ${this.preservedEmail} due to: ${reason}`);
    const writeOk = await writeWinCred(this.inMemoryPreservedCred);
    if (!writeOk) {
      throw new Error('CRITICAL ROLLBACK FAILURE: Failed to write preserved credential to Windows Credential Manager.');
    }

    await closeAntigravity2Processes();
    await launchAntigravity2();

    const restoredTarget = await pollForNewTarget(0, 35000);
    if (!restoredTarget || !restoredTarget.isRunning || !restoredTarget.port || !restoredTarget.csrfToken) {
      throw new Error('CRITICAL ROLLBACK FAILURE: Antigravity 2.0 did not restart after rollback.');
    }

    const restoredStatus = await fetchUserStatus(restoredTarget.port, restoredTarget.csrfToken);
    const parsedRestored = parseUserStatus(restoredStatus);

    if (normalizeEmail(parsedRestored.email || '') !== normalizeEmail(this.preservedEmail)) {
      throw new Error(`CRITICAL ROLLBACK FAILURE: Restored process email (${parsedRestored.email}) does not match preserved email (${this.preservedEmail}).`);
    }

    invalidateTargetCache('antigravity2');
    safeLog(`[ROLLBACK SUCCESS] Preserved account ${this.preservedEmail} confirmed active on PID ${restoredTarget.pid}.`);
  }

  /**
   * Helper to reactivate a credential and cold-verify.
   */
  private async restoreAccountCred(cred: WinCredEntry, expectedEmail: string): Promise<void> {
    const writeOk = await writeWinCred(cred);
    if (!writeOk) {
      throw new Error(`Failed to restore credential for ${expectedEmail}.`);
    }

    await closeAntigravity2Processes();
    await launchAntigravity2();

    const target = await pollForNewTarget(0, 35000);
    if (!target || !target.isRunning || !target.port || !target.csrfToken) {
      throw new Error(`Failed to discover Antigravity 2.0 after restoring account ${expectedEmail}.`);
    }

    const status = await fetchUserStatus(target.port, target.csrfToken);
    const parsed = parseUserStatus(status);

    if (normalizeEmail(parsed.email || '') !== normalizeEmail(expectedEmail)) {
      throw new Error(`Return-to-base mismatch: Expected ${expectedEmail}, got ${parsed.email}.`);
    }

    invalidateTargetCache('antigravity2');
  }
}
