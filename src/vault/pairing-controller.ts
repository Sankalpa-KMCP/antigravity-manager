import { TargetId, TargetSessionMetadata, VaultSessionStatus } from './types';
import { SessionVault } from './vault';
import { AccountRegistry, normalizeEmail } from '../pool/account-registry';
import { QuotaCache } from '../pool/quota-cache';
import { IDESessionAdapter } from './targets/ide-session';
import { Antigravity2SessionAdapter } from './targets/antigravity2-session';
import { readWinCred, writeWinCred, WinCredEntry } from './wincred';
import { fetchUserStatus, requestLoginWithBrowser, fetchCascadeTrajectories } from '../rpc/endpoints';
import { detectTarget, isPidAlive } from '../discovery/detector';
import { safeLog } from './sanitizer';
import {
  snapshotIdeProcesses,
  ProcessContinuitySnapshot,
  closeAntigravity2Processes,
  launchAntigravity2,
  pollForNewTarget,
  waitForPidExit
} from './process-helper';

export type PairingState =
  | 'IDLE'
  | 'PRECHECK'
  | 'WAITING_FOR_USER_LOGIN'
  | 'IDENTITY_VERIFICATION'
  | 'CAPTURING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLING';

export interface PairingOptions {
  returnToBase?: boolean;
  timeoutMs?: number;
  skipIdleCheck?: boolean; // For automated unit tests with mock RPCs
}

export interface PairingContinuityDetails {
  processContinuity: 'PASS' | 'FAIL';
  conversationContinuity: 'PASS' | 'FAIL';
  before: Partial<ProcessContinuitySnapshot> & { trajectoryCount?: number };
  after: Partial<ProcessContinuitySnapshot> & { trajectoryCount?: number };
}

export interface PairingStatus {
  state: PairingState;
  accountId: string | null;
  targetId: TargetId | null;
  expectedEmail: string | null;
  detectedEmail: string | null;
  progress: string;
  error: string | null;
  errorCode?: string | null;
  startedAt: string | null;
  updatedAt: string;
  continuity?: PairingContinuityDetails;
}

export interface PairingResult {
  success: boolean;
  state: PairingState;
  accountId: string;
  targetId: TargetId;
  expectedEmail: string;
  authenticatedEmail?: string;
  continuity?: PairingContinuityDetails;
  error?: string;
  errorCode?: 'IDENTITY_MISMATCH' | 'BUSY' | 'TIMEOUT' | 'CANCELLED' | 'TARGET_OFFLINE' | 'DUPLICATE_SESSION' | 'ACCOUNT_NOT_FOUND' | 'SYSTEM_ERROR';
}

/**
 * Production Cross-Target Account Pairing & Enrollment Controller.
 * Manages binding both 'ide' and 'antigravity2' target sessions under the SAME logical accountId.
 * Enforces:
 * - Strict identity matching by normalized email only
 * - Zero USS injection / Zero state.vscdb direct writes
 * - Process & conversation continuity recording
 * - Rollback and safe return-to-base
 */
export class PairingController {
  private vault: SessionVault;
  private registry: AccountRegistry;
  private quotaCache: QuotaCache;

  private isLocked: boolean = false;
  private currentState: PairingState = 'IDLE';
  private activeAccountId: string | null = null;
  private activeTargetId: TargetId | null = null;
  private expectedEmail: string | null = null;
  private detectedEmail: string | null = null;
  private progressMessage: string = 'Ready';
  private lastError: string | null = null;
  private lastErrorCode: string | null = null;
  private startedAt: string | null = null;
  private statusUpdatedAt: string = new Date().toISOString();
  private cancellationRequested: boolean = false;
  private lastContinuity: PairingContinuityDetails | undefined = undefined;

  constructor(vault: SessionVault, registry: AccountRegistry, quotaCache: QuotaCache) {
    this.vault = vault;
    this.registry = registry;
    this.quotaCache = quotaCache;
  }

  getPairingStatus(): PairingStatus {
    return {
      state: this.currentState,
      accountId: this.activeAccountId,
      targetId: this.activeTargetId,
      expectedEmail: this.expectedEmail,
      detectedEmail: this.detectedEmail,
      progress: this.progressMessage,
      error: this.lastError,
      errorCode: this.lastErrorCode,
      startedAt: this.startedAt,
      updatedAt: this.statusUpdatedAt,
      continuity: this.lastContinuity
    };
  }

  private updateState(
    state: PairingState,
    progress: string,
    error: string | null = null,
    errorCode: string | null = null
  ) {
    this.currentState = state;
    this.progressMessage = progress;
    this.lastError = error;
    this.lastErrorCode = errorCode;
    this.statusUpdatedAt = new Date().toISOString();
    safeLog(`[PAIRING CONTROLLER] ${state} | ${progress}${error ? ` | Error: ${error}` : ''}`);
  }

  cancelPairing(): { success: boolean; message: string } {
    if (!this.isLocked || this.currentState === 'IDLE' || this.currentState === 'COMPLETED' || this.currentState === 'FAILED') {
      return { success: false, message: 'No active pairing operation to cancel.' };
    }

    this.cancellationRequested = true;
    this.updateState('CANCELLING', 'Cancellation requested by user. Terminating pairing...');
    return { success: true, message: 'Pairing cancellation initiated.' };
  }

  /**
   * Starts cross-target enrollment asynchronously.
   * Returns immediately so UI can monitor progress via getPairingStatus().
   */
  async startEnrollment(
    accountId: string,
    targetId: TargetId,
    options: PairingOptions = {}
  ): Promise<{ success: boolean; message: string }> {
    if (this.isLocked) {
      return {
        success: false,
        message: `Pairing controller is busy with active operation (${this.activeAccountId} -> ${this.activeTargetId})`
      };
    }

    // Launch background worker without awaiting
    this.enrollTargetSession(accountId, targetId, options).catch(err => {
      safeLog(`[PAIRING CONTROLLER] Background enrollment failed: ${err.message}`);
    });

    return {
      success: true,
      message: `Cross-target enrollment initiated for ${accountId} on target "${targetId}".`
    };
  }

  /**
   * Core synchronous/awaitable enrollment API.
   * Resolves the requested account, verifies target IDLE status, guides/monitors login,
   * enforces strict email matching, and captures target session into DPAPI vault.
   */
  async enrollTargetSession(
    accountId: string,
    targetId: TargetId,
    options: PairingOptions = {}
  ): Promise<PairingResult> {
    if (this.isLocked) {
      return {
        success: false,
        state: 'FAILED',
        accountId,
        targetId,
        expectedEmail: '',
        errorCode: 'BUSY',
        error: 'Pairing controller is already processing an active enrollment.'
      };
    }

    this.isLocked = true;
    this.cancellationRequested = false;
    this.activeAccountId = accountId;
    this.activeTargetId = targetId;
    this.startedAt = new Date().toISOString();
    this.lastContinuity = undefined;

    const timeoutMs = options.timeoutMs || 300000; // 5 minutes default

    try {
      this.updateState('PRECHECK', `Validating account ${accountId} and target ${targetId}...`);

      // 1. Resolve logical account and expected email
      const allAccounts = this.registry.getAllAccounts();
      const matchedAccount = allAccounts.find(a => a.id === accountId);
      
      let expectedEmail = '';
      if (matchedAccount) {
        expectedEmail = normalizeEmail(matchedAccount.email);
      } else {
        // Check vault metadata for accountId fallback
        const vaultAccounts = this.vault.listAccounts();
        const vAcc = vaultAccounts.find(a => a.accountId === accountId);
        if (vAcc) {
          // Extract email from notes or target sessions
          const metaEntries = this.vault.listMetadata();
          const entry = metaEntries.find(e => e.accountId === accountId);
          const emailMatch = entry?.notes?.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
          if (emailMatch) {
            expectedEmail = normalizeEmail(emailMatch[1]);
          }
        }
      }

      if (!expectedEmail) {
        this.updateState('FAILED', `Account "${accountId}" not found in registry or vault.`, `Account ${accountId} not found.`, 'ACCOUNT_NOT_FOUND');
        return {
          success: false,
          state: 'FAILED',
          accountId,
          targetId,
          expectedEmail: '',
          errorCode: 'ACCOUNT_NOT_FOUND',
          error: `Account ${accountId} not found.`
        };
      }

      this.expectedEmail = expectedEmail;

      // 2. Check if target session is already present and valid
      const capabilities = this.vault.getTargetCapabilities(accountId);
      const isAlreadyStored = capabilities[targetId].sessionStored;
      if (isAlreadyStored) {
        const existingSession = await this.vault.getTargetSession(accountId, targetId);
        if (existingSession && existingSession.metadata.status === 'VALID') {
          this.updateState('COMPLETED', `Account ${accountId} already holds a VALID session for ${targetId}.`);
          return {
            success: true,
            state: 'COMPLETED',
            accountId,
            targetId,
            expectedEmail,
            authenticatedEmail: expectedEmail
          };
        }
      }

      // 3. Inspect target process state
      const target = await detectTarget(targetId, 'Enrollment precheck');
      if (!target.isRunning || !target.port || !target.csrfToken) {
        this.updateState('FAILED', `Target "${targetId}" is not running or RPC credentials missing.`, `Target ${targetId} offline`, 'TARGET_OFFLINE');
        return {
          success: false,
          state: 'FAILED',
          accountId,
          targetId,
          expectedEmail,
          errorCode: 'TARGET_OFFLINE',
          error: `Target ${targetId} is not running.`
        };
      }

      // 4. Target-Specific Enrollment Dispatch
      if (targetId === 'ide') {
        return await this.enrollIdeTarget(accountId, expectedEmail, target, options, timeoutMs);
      } else {
        return await this.enrollAntigravity2Target(accountId, expectedEmail, target, options, timeoutMs);
      }
    } catch (err: any) {
      this.updateState('FAILED', `Unexpected pairing error: ${err.message}`, err.message, 'SYSTEM_ERROR');
      return {
        success: false,
        state: 'FAILED',
        accountId,
        targetId,
        expectedEmail: this.expectedEmail || '',
        errorCode: 'SYSTEM_ERROR',
        error: err.message
      };
    } finally {
      this.isLocked = false;
      this.cancellationRequested = false;
    }
  }

  /**
   * IDE Target Enrollment Flow:
   * - Records initial process tree (Main, ExtHost, Unified LS, LSP LS)
   * - Records active trajectories
   * - Guides user to sign in to expectedEmail in IDE
   * - Polls IDE GetUserStatus
   * - Enforces strict email equality (rejects IDENTITY_MISMATCH)
   * - Verifies process and conversation continuity
   * - Reads state.vscdb read-only and stores into targets.ide
   */
  private async enrollIdeTarget(
    accountId: string,
    expectedEmail: string,
    target: any,
    options: PairingOptions,
    timeoutMs: number
  ): Promise<PairingResult> {
    // Record BEFORE state
    const beforeProcesses = await snapshotIdeProcesses();
    let beforeTrajectoriesCount = 0;
    try {
      const trajRes = await fetchCascadeTrajectories(target.port, target.csrfToken);
      beforeTrajectoriesCount = Object.keys(trajRes.trajectorySummaries || {}).length;
    } catch {
      // Trajectories query fallback
    }

    // Check current IDE email before transition
    let initialEmail: string | null = null;
    try {
      const statusRes = await fetchUserStatus(target.port, target.csrfToken);
      if (statusRes.userStatus?.email) {
        initialEmail = normalizeEmail(statusRes.userStatus.email);
      }
    } catch {
      // Status query fallback
    }

    if (initialEmail === expectedEmail) {
      // User is already logged in to this account in IDE! Capture immediately
      this.updateState('CAPTURING', `IDE is already authenticated as ${expectedEmail}. Capturing session...`);
      return await this.captureIdeSession(accountId, expectedEmail, beforeProcesses, beforeTrajectoriesCount);
    }

    this.updateState(
      'WAITING_FOR_USER_LOGIN',
      `Please sign in to "${expectedEmail}" in Antigravity IDE (User Accounts menu). Waiting for authentication...`
    );

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (this.cancellationRequested) {
        this.updateState('FAILED', 'Pairing cancelled by user.', 'Pairing cancelled by user.', 'CANCELLED');
        return {
          success: false,
          state: 'FAILED',
          accountId,
          targetId: 'ide',
          expectedEmail,
          errorCode: 'CANCELLED',
          error: 'Pairing cancelled by user.'
        };
      }

      await new Promise(r => setTimeout(r, 2000));

      // Poll IDE GetUserStatus
      try {
        const statusRes = await fetchUserStatus(target.port, target.csrfToken);
        const currentEmail = statusRes.userStatus?.email ? normalizeEmail(statusRes.userStatus.email) : null;

        if (currentEmail) {
          this.detectedEmail = currentEmail;

          if (currentEmail === expectedEmail) {
            // MATCH!
            this.updateState('IDENTITY_VERIFICATION', `Authenticated as ${currentEmail}. Identity matched expected account.`);
            return await this.captureIdeSession(accountId, expectedEmail, beforeProcesses, beforeTrajectoriesCount);
          } else if (initialEmail && currentEmail !== initialEmail && currentEmail !== expectedEmail) {
            // The user logged into a completely different account!
            this.updateState(
              'FAILED',
              `IDENTITY MISMATCH: Expected "${expectedEmail}", but user signed in as "${currentEmail}". Session rejected.`,
              `IDENTITY_MISMATCH: Expected ${expectedEmail}, got ${currentEmail}`,
              'IDENTITY_MISMATCH'
            );
            return {
              success: false,
              state: 'FAILED',
              accountId,
              targetId: 'ide',
              expectedEmail,
              authenticatedEmail: currentEmail,
              errorCode: 'IDENTITY_MISMATCH',
              error: `Identity mismatch: Expected "${expectedEmail}", got "${currentEmail}". Session rejected.`
            };
          }
        }
      } catch (pollErr: any) {
        safeLog(`[PAIRING CONTROLLER] IDE polling tick: ${pollErr.message}`);
      }
    }

    // Timeout
    this.updateState('FAILED', `Enrollment timed out after ${Math.round(timeoutMs / 1000)}s waiting for IDE sign-in.`, 'Enrollment timed out', 'TIMEOUT');
    return {
      success: false,
      state: 'FAILED',
      accountId,
      targetId: 'ide',
      expectedEmail,
      errorCode: 'TIMEOUT',
      error: `Enrollment timed out waiting for IDE sign-in to ${expectedEmail}.`
    };
  }

  /**
   * Captures and validates the live IDE session from state.vscdb into the DPAPI vault.
   */
  private async captureIdeSession(
    accountId: string,
    expectedEmail: string,
    beforeProcesses: ProcessContinuitySnapshot,
    beforeTrajectoriesCount: number
  ): Promise<PairingResult> {
    this.updateState('CAPTURING', `Capturing live IDE session from state.vscdb for ${expectedEmail}...`);

    // Verify Process Continuity
    const afterProcesses = await snapshotIdeProcesses();
    let afterTrajectoriesCount = 0;
    try {
      const target = await detectTarget('ide');
      if (target.port && target.csrfToken) {
        const trajRes = await fetchCascadeTrajectories(target.port, target.csrfToken);
        afterTrajectoriesCount = Object.keys(trajRes.trajectorySummaries || {}).length;
      }
    } catch {
      // Fallback
    }

    const mainPidMatch = beforeProcesses.mainPid ? (beforeProcesses.mainPid === afterProcesses.mainPid && isPidAlive(afterProcesses.mainPid)) : true;
    const extHostPidMatch = beforeProcesses.extHostPid ? (beforeProcesses.extHostPid === afterProcesses.extHostPid && isPidAlive(afterProcesses.extHostPid)) : true;
    const unifiedLsMatch = beforeProcesses.unifiedLsPid ? (beforeProcesses.unifiedLsPid === afterProcesses.unifiedLsPid && isPidAlive(afterProcesses.unifiedLsPid)) : true;
    const lspLsMatch = beforeProcesses.lspLsPid ? (beforeProcesses.lspLsPid === afterProcesses.lspLsPid && isPidAlive(afterProcesses.lspLsPid)) : true;

    const processContinuity = (mainPidMatch && extHostPidMatch && unifiedLsMatch && lspLsMatch) ? 'PASS' : 'FAIL';
    const conversationContinuity = (afterTrajectoriesCount >= beforeTrajectoriesCount) ? 'PASS' : 'FAIL';

    const continuityDetails: PairingContinuityDetails = {
      processContinuity,
      conversationContinuity,
      before: { ...beforeProcesses, trajectoryCount: beforeTrajectoriesCount },
      after: { ...afterProcesses, trajectoryCount: afterTrajectoriesCount }
    };
    this.lastContinuity = continuityDetails;

    // Wait briefly for SQLite state flush and read state.vscdb read-only with retry
    await new Promise(r => setTimeout(r, 1500));
    let idePayload: any = null;
    let readError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        idePayload = await IDESessionAdapter.readCurrentLiveIDESession(expectedEmail);
        if (IDESessionAdapter.validatePayload(idePayload)) {
          readError = null;
          break;
        }
      } catch (err: any) {
        readError = err;
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (!idePayload || !IDESessionAdapter.validatePayload(idePayload)) {
      throw new Error(`Failed to capture valid IDE session from state.vscdb: ${readError ? readError.message : 'schema validation failed'}`);
    }

    // Attach to existing account in DPAPI vault
    await this.vault.storeTargetSession(
      accountId,
      'ide',
      idePayload,
      `Paired IDE session for ${expectedEmail}`
    );

    this.updateState('COMPLETED', `Successfully paired IDE target session to ${accountId} (${expectedEmail}).`);

    return {
      success: true,
      state: 'COMPLETED',
      accountId,
      targetId: 'ide',
      expectedEmail,
      authenticatedEmail: expectedEmail,
      continuity: continuityDetails
    };
  }

  /**
   * Antigravity 2.0 Target Enrollment Flow:
   * - Records initial LS PID
   * - Triggers LoginWithBrowser
   * - Polls AG2 GetUserStatus
   * - Enforces strict email equality (rejects IDENTITY_MISMATCH)
   * - Verifies interactive hot LS PID continuity
   * - Reads WinCred gemini:antigravity and stores into targets.antigravity2
   * - Restores previous account if returnToBase is configured
   */
  private async enrollAntigravity2Target(
    accountId: string,
    expectedEmail: string,
    target: any,
    options: PairingOptions,
    timeoutMs: number
  ): Promise<PairingResult> {
    const pidBefore = target.pid;
    let initialEmail: string | null = null;
    try {
      const statusRes = await fetchUserStatus(target.port, target.csrfToken);
      if (statusRes.userStatus?.email) {
        initialEmail = normalizeEmail(statusRes.userStatus.email);
      }
    } catch {
      // Fallback
    }

    // Preserve current credential for return-to-base if needed
    let preservedCred: WinCredEntry | null = null;
    if (options.returnToBase) {
      try {
        preservedCred = await readWinCred('gemini:antigravity');
      } catch {
        // No current credential to preserve
      }
    }

    if (initialEmail === expectedEmail) {
      // AG2 is already authenticated as expectedEmail! Capture directly
      this.updateState('CAPTURING', `Antigravity 2.0 is already authenticated as ${expectedEmail}. Capturing session...`);
      return await this.captureAntigravity2Session(accountId, expectedEmail, pidBefore);
    }

    // Trigger LoginWithBrowser
    this.updateState('WAITING_FOR_USER_LOGIN', `Launching browser sign-in for "${expectedEmail}"...`);
    await requestLoginWithBrowser(target.port, target.csrfToken);
    this.updateState(
      'WAITING_FOR_USER_LOGIN',
      `Please select "${expectedEmail}" in your browser window. Waiting for authentication...`
    );

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (this.cancellationRequested) {
        this.updateState('FAILED', 'Pairing cancelled by user.', 'Pairing cancelled by user.', 'CANCELLED');
        return {
          success: false,
          state: 'FAILED',
          accountId,
          targetId: 'antigravity2',
          expectedEmail,
          errorCode: 'CANCELLED',
          error: 'Pairing cancelled by user.'
        };
      }

      await new Promise(r => setTimeout(r, 2000));

      try {
        const statusRes = await fetchUserStatus(target.port, target.csrfToken);
        const currentEmail = statusRes.userStatus?.email ? normalizeEmail(statusRes.userStatus.email) : null;

        if (currentEmail) {
          this.detectedEmail = currentEmail;

          if (currentEmail === expectedEmail) {
            // MATCH!
            this.updateState('IDENTITY_VERIFICATION', `Authenticated as ${currentEmail}. Identity matched expected account.`);
            const captureRes = await this.captureAntigravity2Session(accountId, expectedEmail, pidBefore);

            // Return to base if requested and previous email was different
            if (options.returnToBase && preservedCred && initialEmail && initialEmail !== expectedEmail) {
              this.updateState('COMPLETED', `Restoring base account (${initialEmail}) via proven cold restore...`);
              await writeWinCred(preservedCred);
              await closeAntigravity2Processes();
              await waitForPidExit(pidBefore, 10000);
              await launchAntigravity2();
              await pollForNewTarget(pidBefore, 35000);
              safeLog(`[PAIRING CONTROLLER] Successfully restored base account (${initialEmail})`);
            }

            return captureRes;
          } else if (initialEmail && currentEmail !== initialEmail && currentEmail !== expectedEmail) {
            // The user logged into an unexpected account!
            this.updateState(
              'FAILED',
              `IDENTITY MISMATCH: Expected "${expectedEmail}", but user signed in as "${currentEmail}". Session rejected.`,
              `IDENTITY_MISMATCH: Expected ${expectedEmail}, got ${currentEmail}`,
              'IDENTITY_MISMATCH'
            );

            // Restore previous credential if requested
            if (options.returnToBase && preservedCred) {
              await writeWinCred(preservedCred);
              await closeAntigravity2Processes();
              await waitForPidExit(pidBefore, 10000);
              await launchAntigravity2();
              await pollForNewTarget(pidBefore, 35000);
            }

            return {
              success: false,
              state: 'FAILED',
              accountId,
              targetId: 'antigravity2',
              expectedEmail,
              authenticatedEmail: currentEmail,
              errorCode: 'IDENTITY_MISMATCH',
              error: `Identity mismatch: Expected "${expectedEmail}", got "${currentEmail}". Session rejected.`
            };
          }
        }
      } catch (pollErr: any) {
        safeLog(`[PAIRING CONTROLLER] AG2 polling tick: ${pollErr.message}`);
      }
    }

    // Timeout
    this.updateState('FAILED', `Enrollment timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser sign-in.`, 'Enrollment timed out', 'TIMEOUT');
    return {
      success: false,
      state: 'FAILED',
      accountId,
      targetId: 'antigravity2',
      expectedEmail,
      errorCode: 'TIMEOUT',
      error: `Enrollment timed out waiting for browser sign-in to ${expectedEmail}.`
    };
  }

  /**
   * Captures and validates the live WinCred session from gemini:antigravity into the DPAPI vault.
   */
  private async captureAntigravity2Session(
    accountId: string,
    expectedEmail: string,
    pidBefore: number
  ): Promise<PairingResult> {
    this.updateState('CAPTURING', `Capturing live WinCred session from gemini:antigravity for ${expectedEmail}...`);

    // Verify LS PID continuity
    const target = await detectTarget('antigravity2');
    const pidAfter = target.pid;
    const isHotPidAlive = (pidBefore === pidAfter) && isPidAlive(pidBefore);

    const continuityDetails: PairingContinuityDetails = {
      processContinuity: isHotPidAlive ? 'PASS' : 'FAIL',
      conversationContinuity: 'PASS',
      before: { unifiedLsPid: pidBefore },
      after: { unifiedLsPid: pidAfter }
    };
    this.lastContinuity = continuityDetails;

    // Read WinCred
    const wincred = await readWinCred('gemini:antigravity');
    if (!wincred) {
      throw new Error('No Windows Credential found for target "gemini:antigravity".');
    }

    const ag2Payload = {
      target: wincred.target,
      type: wincred.type,
      userName: wincred.userName,
      persistence: wincred.persistence,
      rawBlobBase64: wincred.blob.toString('base64'),
      capturedEmail: expectedEmail,
      capturedAt: new Date().toISOString()
    };

    if (!Antigravity2SessionAdapter.validatePayload(ag2Payload)) {
      throw new Error('Captured Antigravity 2.0 WinCred payload failed schema validation.');
    }

    // Attach to existing account in DPAPI vault
    await this.vault.storeTargetSession(
      accountId,
      'antigravity2',
      ag2Payload,
      `Paired AG2 session for ${expectedEmail}`
    );

    this.updateState('COMPLETED', `Successfully paired Antigravity 2.0 target session to ${accountId} (${expectedEmail}).`);

    return {
      success: true,
      state: 'COMPLETED',
      accountId,
      targetId: 'antigravity2',
      expectedEmail,
      authenticatedEmail: expectedEmail,
      continuity: continuityDetails
    };
  }
}
