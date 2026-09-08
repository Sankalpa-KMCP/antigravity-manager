import { TargetId } from './types';
import { SessionVault } from './vault';
import { safeLog } from './sanitizer';
import { ProcessContinuitySnapshot } from './process-helper';
import {
  FeasibilityClassification,
  ActivationMode,
  UnattendedState,
  OAuthAuditReport,
  SyncedFeasibilityStatus,
  SafetyPreflightResult,
  UnattendedControllerStatus
} from './unattended-types';

/**
 * Controller and state machine for Phase 4H Unattended Hot Activation Feasibility.
 * Enforces safety gates, evaluates OAuth audit properties, tracks target continuity,
 * and classifies activation feasibility across Antigravity 2.0 and Antigravity IDE.
 */
export class UnattendedActivationController {
  private vault: SessionVault;
  private currentState: UnattendedState = 'IDLE';
  private currentMode: ActivationMode = 'SYNCED';
  private targetAccountId: string | null = null;
  private activeAccountIds: { antigravity2: string | null; ide: string | null } = {
    antigravity2: null,
    ide: null
  };
  private progressMessage: string = 'Ready';
  private lastError: string | null = null;
  private statusUpdatedAt: string = new Date().toISOString();

  // Authoritative read-only audit reports adhering strictly to verified findings
  private static readonly AUDIT_AG2: OAuthAuditReport = {
    target: 'antigravity2',
    installedVersion: '2.12.2',
    nativeFlow: 'External browser launched via osappopen/open.Start to Google OAuth endpoint',
    promptBehavior: 'Interactive system browser consent flow',
    loginHintSupported: false,
    silentAuthAvailable: false,
    classification: 'INTERACTION_REQUIRED',
    reasons: [
      'current installed AG2 does not expose a supported stored-session runtime reload mechanism',
      'LoginWithBrowser is deprecated in the installed version',
      'native OAuth construction exposes no deterministic login_hint targeting',
      'unattended selection of a specific account is therefore not proven or supported'
    ]
  };

  private static readonly AUDIT_IDE: OAuthAuditReport = {
    target: 'ide',
    installedVersion: 'Antigravity IDE 1.x',
    nativeFlow: 'Electron Main AntigravityAuthMainService creates local loopback server and launches external browser',
    promptBehavior: 'Hardcoded prompt="consent" in getLoginUrl()',
    loginHintSupported: false,
    silentAuthAvailable: false,
    classification: 'INTERACTION_REQUIRED',
    reasons: [
      'supported auth path runs through Electron Main',
      'OAuth request hardcodes prompt="consent"',
      'therefore a silent prompt=none authorization flow is unavailable through the existing supported implementation',
      'no login_hint or equivalent deterministic account-targeting parameter is exposed',
      'therefore the Manager cannot reliably select a specific saved Google account unattended through the supported IDE OAuth path',
      'stored IDE session cannot be externally hot-activated without bypassing the supported AuthenticationProvider/USS state machine'
    ]
  };

  constructor(vault: SessionVault) {
    this.vault = vault;
  }

  getAuditReport(target: TargetId): OAuthAuditReport {
    return target === 'antigravity2'
      ? { ...UnattendedActivationController.AUDIT_AG2 }
      : { ...UnattendedActivationController.AUDIT_IDE };
  }

  getSyncedFeasibility(): SyncedFeasibilityStatus {
    return {
      feasible: false,
      verdict: 'NOT AVAILABLE THROUGH CURRENTLY SUPPORTED INTERFACES IN THE INSTALLED VERSIONS',
      reasons: [
        'Neither Antigravity 2.0 nor Antigravity IDE exposes a supported silent or login_hint-targeted unattended OAuth mechanism in the installed versions.',
        'Both targets require user interaction (account chooser or consent screen).',
        'Synchronized unattended hot activation cannot occur without unsupported token injection or unsupported direct database manipulation, both of which violate product safety rules.'
      ]
    };
  }

  /**
   * Safety Gate Preflight.
   * Prohibits live authentication transitions whenever active trajectories exist on either target.
   */
  performSafetyPreflight(ideTrajectories: number = 0, ag2Trajectories: number = 0): SafetyPreflightResult {
    const reasons: string[] = [];
    const ideSafe = ideTrajectories === 0;
    const ag2Safe = ag2Trajectories === 0;

    if (!ideSafe) {
      reasons.push(`Active trajectory detected: Antigravity IDE has ${ideTrajectories} running trajectory(ies). Live authentication transition blocked.`);
    }
    if (!ag2Safe) {
      reasons.push(`Active trajectory detected: Antigravity 2.0 has ${ag2Trajectories} running trajectory(ies). Live authentication transition blocked.`);
    }

    const allowed = ideSafe && ag2Safe;
    return {
      allowed,
      reasons,
      ideTrajectories,
      ag2Trajectories,
      isIdeIdle: ideSafe,
      isAg2Idle: ag2Safe,
      timestamp: new Date().toISOString()
    };
  }

  setMode(mode: ActivationMode): void {
    this.currentMode = mode;
    safeLog(`[UNATTENDED CONTROLLER] Mode set to ${mode}`);
  }

  getMode(): ActivationMode {
    return this.currentMode;
  }

  setActiveAccounts(ag2AccountId: string | null, ideAccountId: string | null): void {
    this.activeAccountIds = {
      antigravity2: ag2AccountId,
      ide: ideAccountId
    };
  }

  getControllerStatus(ideTrajectories: number = 0, ag2Trajectories: number = 0): UnattendedControllerStatus {
    const preflight = this.performSafetyPreflight(ideTrajectories, ag2Trajectories);

    return {
      state: this.currentState,
      mode: this.currentMode,
      targetAccountId: this.targetAccountId,
      activeAccountIds: { ...this.activeAccountIds },
      classification: {
        antigravity2: UnattendedActivationController.AUDIT_AG2.classification,
        ide: UnattendedActivationController.AUDIT_IDE.classification,
        synced: this.getSyncedFeasibility().verdict
      },
      safetyGate: {
        trajectoriesActive: !preflight.allowed,
        safeToTransition: preflight.allowed,
        blockReason: preflight.allowed ? undefined : preflight.reasons.join('; ')
      },
      lastAudit: {
        antigravity2: { ...UnattendedActivationController.AUDIT_AG2 },
        ide: { ...UnattendedActivationController.AUDIT_IDE }
      },
      progress: this.progressMessage,
      error: this.lastError,
      updatedAt: this.statusUpdatedAt
    };
  }

  /**
   * Evaluates an activation request against the safety gates and capability model.
   * If trajectories are running, it blocks with TARGET_BUSY.
   * If targets require interaction, it marks state as WAITING_FOR_INTERACTION / INTERACTION_REQUIRED
   * and refuses to attempt silent/unattended activation.
   */
  evaluateActivationRequest(
    targetAccountId: string,
    ideTrajectories: number = 0,
    ag2Trajectories: number = 0
  ): {
    allowed: boolean;
    classification: FeasibilityClassification;
    state: UnattendedState;
    message: string;
  } {
    this.targetAccountId = targetAccountId;
    this.currentState = 'SAFETY_PRECHECK';

    // 1. Safety Gate Check
    const preflight = this.performSafetyPreflight(ideTrajectories, ag2Trajectories);
    if (!preflight.allowed) {
      this.currentState = 'ABORTED';
      this.progressMessage = 'Aborted: Active trajectory detected.';
      this.lastError = preflight.reasons.join('; ');
      this.statusUpdatedAt = new Date().toISOString();
      safeLog(`[UNATTENDED CONTROLLER] Aborted activation of ${targetAccountId}: ${this.lastError}`);
      return {
        allowed: false,
        classification: 'UNSUPPORTED',
        state: 'ABORTED',
        message: this.lastError
      };
    }

    // 2. Account Pairing Check in Vault
    const account = this.vault.getAccount(targetAccountId);
    if (!account) {
      this.currentState = 'FAILED';
      this.progressMessage = `Account ${targetAccountId} not found in shared vault.`;
      this.lastError = this.progressMessage;
      this.statusUpdatedAt = new Date().toISOString();
      return {
        allowed: false,
        classification: 'UNSUPPORTED',
        state: 'FAILED',
        message: this.progressMessage
      };
    }

    if (this.currentMode === 'SYNCED') {
      const hasAg2 = Boolean(account.targets.antigravity2);
      const hasIde = Boolean(account.targets.ide);
      if (!hasAg2 || !hasIde) {
        this.currentState = 'FAILED';
        this.progressMessage = `Cannot perform SYNCED activation: Account ${targetAccountId} is not fully paired (AG2: ${hasAg2}, IDE: ${hasIde}).`;
        this.lastError = this.progressMessage;
        this.statusUpdatedAt = new Date().toISOString();
        return {
          allowed: false,
          classification: 'PARTIAL_HOT',
          state: 'FAILED',
          message: this.progressMessage
        };
      }
    }

    // 3. Unattended Feasibility Check
    // Both targets are classified as INTERACTION_REQUIRED.
    this.currentState = 'WAITING_FOR_INTERACTION';
    this.progressMessage = 'Supported authentication paths require user interaction (silent prompt=none and login_hint unsupported).';
    this.statusUpdatedAt = new Date().toISOString();

    return {
      allowed: true,
      classification: 'INTERACTION_REQUIRED',
      state: 'WAITING_FOR_INTERACTION',
      message: this.progressMessage
    };
  }

  /**
   * Evaluates process continuity between pre- and post-activation snapshots.
   * In a true HOT switch, mainPid, extHostPid, unifiedLsPid, and lspLsPid MUST remain invariant.
   */
  evaluateProcessContinuity(
    preSnapshot: ProcessContinuitySnapshot,
    postSnapshot: ProcessContinuitySnapshot
  ): {
    isContinuous: boolean;
    driftedPids: string[];
  } {
    const drifted: string[] = [];

    if (preSnapshot.mainPid && postSnapshot.mainPid && preSnapshot.mainPid !== postSnapshot.mainPid) {
      drifted.push(`mainPid (${preSnapshot.mainPid} -> ${postSnapshot.mainPid})`);
    }
    if (preSnapshot.extHostPid && postSnapshot.extHostPid && preSnapshot.extHostPid !== postSnapshot.extHostPid) {
      drifted.push(`extHostPid (${preSnapshot.extHostPid} -> ${postSnapshot.extHostPid})`);
    }
    if (preSnapshot.unifiedLsPid && postSnapshot.unifiedLsPid && preSnapshot.unifiedLsPid !== postSnapshot.unifiedLsPid) {
      drifted.push(`unifiedLsPid (${preSnapshot.unifiedLsPid} -> ${postSnapshot.unifiedLsPid})`);
    }
    if (preSnapshot.lspLsPid && postSnapshot.lspLsPid && preSnapshot.lspLsPid !== postSnapshot.lspLsPid) {
      drifted.push(`lspLsPid (${preSnapshot.lspLsPid} -> ${postSnapshot.lspLsPid})`);
    }

    return {
      isContinuous: drifted.length === 0,
      driftedPids: drifted
    };
  }
}
