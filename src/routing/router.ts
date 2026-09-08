import { TargetId, TargetState, DashboardData } from '../types';
import { SessionVault } from '../vault/vault';
import { TransactionalSwitchController } from '../vault/switch-controller';
import { AccountRegistry } from '../pool/account-registry';
import { QuotaCache } from '../pool/quota-cache';
import { rankCandidatesForModel } from '../pool/selector';
import { CandidateScore, AccountModelSnapshot, AccountHealthState } from '../pool/types';
import { safeLog, sanitizeObject } from '../vault/sanitizer';
import { snapshotIdeProcesses, ProcessContinuitySnapshot } from '../vault/process-helper';
import {
  RouterConfig,
  RouterOperatingMode,
  RoutingState,
  TargetRoutingMode,
  RoutingTargetStatus,
  RoutingEvent,
  RoutingEventType,
  RouterStatusResponse,
  ActivationCapability
} from './types';

export class AutomaticQuotaRouter {
  private config: RouterConfig = {
    enabled: false, // Default is STRICTLY OFF
    operatingMode: 'OFF',
    mode: 'INDEPENDENT',
    selectedModel: 'Gemini 3.8 Flash (High)',
    switchThreshold: 10,
    returnThreshold: 30,
    minDwellMinutes: 15,
    cooldownMinutes: 30,
    resetGraceMinutes: 5
  };

  private vault: SessionVault;
  private switchController: TransactionalSwitchController;
  private registry: AccountRegistry;
  private quotaCache: QuotaCache;

  private targetStatuses: Record<TargetId, RoutingTargetStatus> = {
    ide: {
      targetId: 'ide',
      targetName: 'Antigravity IDE',
      state: 'MONITORING',
      currentAccountId: null,
      currentEmail: null,
      currentModelQuotaPercent: null,
      health: 'READY',
      recommendedCandidate: null,
      requiresRefresh: false,
      activationCapability: 'INTERACTION_REQUIRED',
      actionRequired: 'Monitoring quota',
      isIdle: true,
      runningTrajectories: 0,
      lastSwitchAt: null,
      dwellRemainingSeconds: 0,
      shadowPlan: null,
      error: null
    },
    antigravity2: {
      targetId: 'antigravity2',
      targetName: 'Antigravity 2.0',
      state: 'MONITORING',
      currentAccountId: null,
      currentEmail: null,
      currentModelQuotaPercent: null,
      health: 'READY',
      recommendedCandidate: null,
      requiresRefresh: false,
      activationCapability: 'AUTOMATIC_COLD_TARGET_RELOAD',
      actionRequired: 'Monitoring quota',
      isIdle: true,
      runningTrajectories: 0,
      lastSwitchAt: null,
      dwellRemainingSeconds: 0,
      shadowPlan: null,
      error: null
    }
  };

  private cooldowns: Record<string, { accountId: string; expiresAt: string; reason: string }> = {};
  private previousSwitchedAwayEmails: Record<TargetId, string | null> = {
    ide: null,
    antigravity2: null
  };
  private events: RoutingEvent[] = [];
  private isProcessingEvent: boolean = false;
  private syncedPreSwitchBackupEmail: string | null = null;
  private ideWatchTimer: NodeJS.Timeout | null = null;
  private pendingIdeTargetAccountId: string | null = null;
  private lastEvaluationTime: string = new Date().toISOString();

  constructor(
    vault: SessionVault,
    switchController: TransactionalSwitchController,
    registry: AccountRegistry,
    quotaCache: QuotaCache
  ) {
    this.vault = vault;
    this.switchController = switchController;
    this.registry = registry;
    this.quotaCache = quotaCache;
  }

  getConfig(): RouterConfig {
    return { ...this.config };
  }

  setOperatingMode(mode: RouterOperatingMode, allowLiveInTest: boolean = false): RouterConfig {
    if (mode === 'LIVE' && !allowLiveInTest) {
      safeLog('[ROUTER] LIVE mode request denied: LIVE routing is disabled in Phase 4J.');
      throw new Error('LIVE routing is disabled in Phase 4J. Operating in SHADOW mode.');
    }

    this.config.operatingMode = mode;
    this.config.enabled = (mode !== 'OFF');
    if (mode === 'OFF') {
      this.targetStatuses.ide.shadowPlan = null;
      this.targetStatuses.antigravity2.shadowPlan = null;
    }
    safeLog(`[ROUTER] Operating mode set to ${mode} (enabled=${this.config.enabled})`);
    this.recordEvent('OPERATING_MODE_CHANGED', 'synced', undefined, undefined, `Router operating mode changed to ${mode}.`);
    return this.getConfig();
  }

  updateConfig(partial: Partial<RouterConfig>): RouterConfig {
    if (partial.operatingMode !== undefined) {
      this.setOperatingMode(partial.operatingMode);
      delete partial.operatingMode;
    }
    this.config = {
      ...this.config,
      ...partial
    };
    safeLog(`[ROUTER] Configuration updated: operatingMode=${this.config.operatingMode}, enabled=${this.config.enabled}, mode=${this.config.mode}, model=${this.config.selectedModel}`);
    return this.getConfig();
  }

  acknowledgeEnable(): RouterConfig {
    return this.setOperatingMode('SHADOW');
  }

  disableRouting(): RouterConfig {
    return this.setOperatingMode('OFF');
  }

  getStatus(): RouterStatusResponse {
    this.cleanExpiredCooldowns();

    const isSynchronized =
      Boolean(this.targetStatuses.ide.currentEmail) &&
      this.targetStatuses.ide.currentEmail?.toLowerCase() === this.targetStatuses.antigravity2.currentEmail?.toLowerCase();

    return {
      config: this.getConfig(),
      globalState: this.deriveGlobalState(),
      targets: {
        ide: { ...this.targetStatuses.ide },
        antigravity2: { ...this.targetStatuses.antigravity2 }
      },
      syncStatus: {
        isSynchronized,
        activeAccountEmail: isSynchronized ? this.targetStatuses.ide.currentEmail : null
      },
      cooldowns: { ...this.cooldowns },
      recentEvents: this.events.slice(-25),
      updatedAt: this.lastEvaluationTime
    };
  }

  private deriveGlobalState(): RoutingState {
    const states = [this.targetStatuses.ide.state, this.targetStatuses.antigravity2.state];
    if (states.includes('ACTIVATING')) return 'ACTIVATING';
    if (states.includes('WAITING_FOR_USER')) return 'WAITING_FOR_USER';
    if (states.includes('WAITING_FOR_IDLE')) return 'WAITING_FOR_IDLE';
    if (states.includes('SELECTING')) return 'SELECTING';
    if (states.includes('ROUTE_NEEDED')) return 'ROUTE_NEEDED';
    if (states.includes('WAIT_FOR_RESET')) return 'WAIT_FOR_RESET';
    if (states.includes('COOLDOWN')) return 'COOLDOWN';
    if (states.includes('FAILED')) return 'FAILED';
    return 'MONITORING';
  }

  /**
   * Main evaluation entry point called on each dashboard telemetry cycle.
   */
  async onTelemetryUpdated(data: DashboardData): Promise<void> {
    this.lastEvaluationTime = new Date().toISOString();
    this.cleanExpiredCooldowns();

    const ideTarget = data.targets.find(t => t.id === 'ide');
    const ag2Target = data.targets.find(t => t.id === 'antigravity2');

    // Update target running status & trajectories
    if (ideTarget) this.syncTargetTelemetry('ide', ideTarget);
    if (ag2Target) this.syncTargetTelemetry('antigravity2', ag2Target);

    // If automatic routing is disabled, only update status & candidates without executing switches
    if (!this.config.enabled) {
      if (ideTarget) this.evaluateTargetCandidates('ide', ideTarget);
      if (ag2Target) this.evaluateTargetCandidates('antigravity2', ag2Target);
      return;
    }

    if (this.isProcessingEvent) {
      return; // Do not overlap transitions
    }

    if (this.config.mode === 'SYNCED') {
      await this.evaluateSyncedRouting(ideTarget, ag2Target);
    } else {
      if (ideTarget) await this.evaluateIndependentTarget('ide', ideTarget);
      if (ag2Target) await this.evaluateIndependentTarget('antigravity2', ag2Target);
    }
  }

  private syncTargetTelemetry(targetId: TargetId, target: TargetState) {
    const st = this.targetStatuses[targetId];
    st.currentEmail = target.email;
    st.isIdle = target.isRunning && (target.trajectoryStatus?.state === 'IDLE' || target.trajectoryStatus?.runningTrajectories === 0);
    st.runningTrajectories = target.trajectoryStatus?.runningTrajectories || 0;

    if (target.email) {
      const reg = this.registry.getAccount(target.email);
      st.currentAccountId = reg ? reg.id : null;
    } else {
      st.currentAccountId = null;
    }

    // Find selected model quota
    const model = (target.models || []).find(m => m.label === this.config.selectedModel);
    if (model) {
      const pct = Math.round(model.remainingFraction * 100);
      st.currentModelQuotaPercent = pct;
      st.health = this.classifyHealth(pct);
    } else {
      st.currentModelQuotaPercent = null;
      st.health = 'READY';
    }

    // Compute remaining dwell time
    if (st.lastSwitchAt) {
      const dwellElapsedSec = Math.floor((Date.now() - new Date(st.lastSwitchAt).getTime()) / 1000);
      const dwellTotalSec = this.config.minDwellMinutes * 60;
      st.dwellRemainingSeconds = Math.max(0, dwellTotalSec - dwellElapsedSec);
    } else {
      st.dwellRemainingSeconds = 0;
    }
  }

  private classifyHealth(percent: number): AccountHealthState {
    if (percent > 25) return 'READY';
    if (percent > 10) return 'LOW';
    if (percent > 0) return 'CRITICAL';
    return 'EXHAUSTED';
  }

  /**
   * Candidate ranking and selection for a target.
   */
  private evaluateTargetCandidates(targetId: TargetId, target: TargetState): CandidateScore | null {
    const st = this.targetStatuses[targetId];
    const poolSnapshots = this.buildAccountSnapshots();
    const activeEmails = [
      this.targetStatuses.ide.currentEmail,
      this.targetStatuses.antigravity2.currentEmail
    ].filter(Boolean) as string[];

    const coolingDownAccountIds = Object.keys(this.cooldowns);

    const rankings = rankCandidatesForModel({
      modelLabel: this.config.selectedModel,
      accounts: poolSnapshots,
      currentlyActiveEmails: activeEmails,
      coolingDownAccountIds
    });

    // Filter eligible candidates for this target
    const eligible = rankings.filter(c => {
      if (c.tier === 'UNAVAILABLE' || c.score <= 0) return false;
      if (st.currentAccountId && c.accountId === st.currentAccountId) return false;
      if (coolingDownAccountIds.includes(c.accountId)) return false;

      // Vault session check
      const accountMeta = this.vault.getAccount(c.accountId);
      if (!accountMeta) return false;

      if (this.config.mode === 'SYNCED') {
        const hasBoth = Boolean(accountMeta.targets.antigravity2 && accountMeta.targets.ide);
        if (!hasBoth) return false;
      } else {
        const hasTarget = Boolean(accountMeta.targets[targetId]);
        if (!hasTarget) return false;
      }

      // Hysteresis Return Check: If switching back to previous account, must be > returnThreshold
      const prevEmail = this.previousSwitchedAwayEmails[targetId];
      if (prevEmail && c.accountEmail.toLowerCase() === prevEmail.toLowerCase()) {
        if (c.remainingPercent < this.config.returnThreshold) {
          return false; // Quota has not recovered above 30% hysteresis threshold
        }
      }

      return true;
    });

    const best = eligible.length > 0 ? eligible[0] : null;
    st.recommendedCandidate = best;
    st.requiresRefresh = Boolean(best && best.freshness === 'STALE');
    return best;
  }

  /**
   * Independent target routing evaluation.
   */
  private async evaluateIndependentTarget(targetId: TargetId, target: TargetState): Promise<void> {
    const st = this.targetStatuses[targetId];
    if (!target.isRunning || !target.email) {
      st.state = 'MONITORING';
      st.actionRequired = 'Target is offline or not authenticated';
      return;
    }

    const candidate = this.evaluateTargetCandidates(targetId, target);
    const quotaPercent = st.currentModelQuotaPercent;

    if (quotaPercent === null) {
      st.state = 'MONITORING';
      st.actionRequired = 'Selected model telemetry not found';
      return;
    }

    // Check if quota is above threshold
    if (quotaPercent > this.config.switchThreshold) {
      st.state = 'MONITORING';
      st.actionRequired = `Selected model quota is healthy (${quotaPercent}% > ${this.config.switchThreshold}%)`;
      st.shadowPlan = null;
      return;
    }

    // Threshold crossed: Quota <= switchThreshold (10%)
    // Check 1: Reset Grace Window
    const model = (target.models || []).find(m => m.label === this.config.selectedModel);
    if (model && model.resetTime && quotaPercent > 0) {
      const resetMs = new Date(model.resetTime).getTime();
      const diffMin = (resetMs - Date.now()) / (60 * 1000);
      if (diffMin > 0 && diffMin <= this.config.resetGraceMinutes) {
        st.state = 'WAIT_FOR_RESET';
        st.actionRequired = `Quota low (${quotaPercent}%), but reset is imminent in ${Math.round(diffMin)}m (Grace: ${this.config.resetGraceMinutes}m). Waiting for reset.`;
        st.shadowPlan = null;
        return;
      }
    }

    // Check 2: Minimum Dwell Time (Unless 0% EXHAUSTED)
    if (st.dwellRemainingSeconds > 0 && quotaPercent > 0) {
      st.state = 'MONITORING';
      st.actionRequired = `Quota low (${quotaPercent}%), but target is in minimum dwell period (${Math.ceil(st.dwellRemainingSeconds / 60)}m remaining).`;
      st.shadowPlan = null;
      return;
    }

    // Need to route!
    if (!candidate) {
      st.state = 'ROUTE_NEEDED';
      st.actionRequired = 'Quota critical, but no eligible alternative account available in vault';
      st.shadowPlan = null;
      return;
    }

    st.state = 'ROUTE_NEEDED';
    this.recordEvent('ROUTE_NEEDED', targetId, candidate.accountId, candidate.accountEmail, `Quota crossed threshold (${quotaPercent}% <= ${this.config.switchThreshold}%). Selected candidate: ${candidate.accountEmail}`);

    // Check 3: Active Work Safety Gate (Trajectories / Busy)
    if (!st.isIdle || st.runningTrajectories > 0) {
      st.state = 'WAITING_FOR_IDLE';
      st.actionRequired = `Routing queued: Waiting for ${st.runningTrajectories} active agent task(s) to complete before activation.`;
      this.recordEvent('WAITING_FOR_IDLE', targetId, candidate.accountId, candidate.accountEmail, `Target is BUSY (${st.runningTrajectories} tasks). Deferring switch until IDLE.`);
      if (this.config.operatingMode === 'SHADOW') {
        st.shadowPlan = {
          wouldPerform: targetId === 'antigravity2' ? 'AUTOMATIC_COLD_TARGET_RELOAD' : 'INTERACTION_REQUIRED',
          actionDescription: `Target BUSY (${st.runningTrajectories} tasks). Would activate ${candidate.accountEmail} once IDLE.`,
          candidateAccountId: candidate.accountId,
          candidateEmail: candidate.accountEmail,
          candidateModelQuotaPercent: candidate.remainingPercent,
          executed: false
        };
      }
      return;
    }

    // Target is IDLE!
    if (this.config.operatingMode === 'SHADOW') {
      // SHADOW MODE: Record hypothetical plan, zero mutation performed!
      if (targetId === 'antigravity2') {
        st.state = 'ACTIVATION_PLANNED';
        st.shadowPlan = {
          wouldPerform: 'AUTOMATIC_COLD_TARGET_RELOAD',
          actionDescription: `Would perform safe AG2 LS recycle for ${candidate.accountEmail} (recycles AG2 LS at IDLE boundary, zero IDE mutation)`,
          candidateAccountId: candidate.accountId,
          candidateEmail: candidate.accountEmail,
          candidateModelQuotaPercent: candidate.remainingPercent,
          executed: false
        };
        st.actionRequired = `[SHADOW MODE] Would perform safe AG2 LS recycle to ${candidate.accountEmail} (${candidate.remainingPercent}% quota). Executed: NO.`;
        this.recordEvent('SHADOW_PLAN_RECORDED', targetId, candidate.accountId, candidate.accountEmail, `[SHADOW] Would perform safe AG2 LS recycle to ${candidate.accountEmail}. Executed: NO.`);
      } else {
        st.state = 'WAITING_FOR_USER';
        st.shadowPlan = {
          wouldPerform: 'INTERACTION_REQUIRED',
          actionDescription: `Would request interactive IDE OAuth login for ${candidate.accountEmail} (requires supported user OAuth login)`,
          candidateAccountId: candidate.accountId,
          candidateEmail: candidate.accountEmail,
          candidateModelQuotaPercent: candidate.remainingPercent,
          executed: false
        };
        st.actionRequired = `[SHADOW MODE] Would request interactive IDE OAuth login to ${candidate.accountEmail}. Executed: NO.`;
        this.recordEvent('SHADOW_PLAN_RECORDED', targetId, candidate.accountId, candidate.accountEmail, `[SHADOW] Would request interactive IDE OAuth login for ${candidate.accountEmail}. Executed: NO.`);
      }
      return;
    }

    // Target is IDLE and LIVE mode is active:
    if (this.config.operatingMode === 'LIVE') {
      st.state = 'ACTIVATION_PLANNED';
      if (targetId === 'antigravity2') {
        await this.executeAg2ColdTargetReload(candidate);
      } else {
        this.initiateIdeInteractionHandoff(candidate);
      }
    }
  }

  /**
   * AG2 Automatic Cold Target Reload at verified IDLE boundary.
   */
  async executeAg2ColdTargetReload(candidate: CandidateScore): Promise<boolean> {
    const st = this.targetStatuses.antigravity2;
    this.isProcessingEvent = true;
    st.state = 'ACTIVATING';
    st.actionRequired = `Automated cold reload: Activating ${candidate.accountEmail} into Antigravity 2.0 language server...`;
    this.recordEvent('ACTIVATION_STARTED', 'antigravity2', candidate.accountId, candidate.accountEmail, `Initiating automated cold target reload for ${candidate.accountEmail}`);

    try {
      const oldEmail = st.currentEmail;
      const res = await this.switchController.activateVaultedAccount(candidate.accountId);

      if (res.success) {
        st.state = 'COMPLETED';
        this.previousSwitchedAwayEmails.antigravity2 = oldEmail;
        st.lastSwitchAt = new Date().toISOString();
        st.dwellRemainingSeconds = this.config.minDwellMinutes * 60;
        st.actionRequired = `Successfully activated ${candidate.accountEmail} on Antigravity 2.0`;
        this.recordEvent('ACTIVATION_VERIFIED', 'antigravity2', candidate.accountId, candidate.accountEmail, `Verified identity switch to ${candidate.accountEmail}`);
        this.isProcessingEvent = false;
        return true;
      } else {
        throw new Error(res.error || 'Activation failed');
      }
    } catch (err) {
      const errorMsg = (err as Error).message;
      st.state = 'FAILED';
      st.error = errorMsg;
      st.actionRequired = `Activation failed: ${errorMsg}`;
      this.recordEvent('ACTIVATION_FAILED', 'antigravity2', candidate.accountId, candidate.accountEmail, `Activation error: ${errorMsg}`);
      this.addCooldown(candidate.accountId, `Activation failure on AG2: ${errorMsg}`);
      this.isProcessingEvent = false;
      return false;
    }
  }

  /**
   * Antigravity IDE Routing Handoff (Interactive path).
   */
  initiateIdeInteractionHandoff(candidate: CandidateScore): void {
    const st = this.targetStatuses.ide;
    st.state = 'WAITING_FOR_USER';
    this.pendingIdeTargetAccountId = candidate.accountId;
    st.actionRequired = `User authentication required: Switch IDE to ${candidate.accountEmail}. Click [ Switch IDE ] or sign in via IDE Account menu.`;
    this.recordEvent('WAITING_FOR_USER', 'ide', candidate.accountId, candidate.accountEmail, `IDE routing handoff created for ${candidate.accountEmail}. Awaiting user login.`);

    // Start background watcher for user completion
    this.startIdeVerificationWatcher(candidate);
  }

  private startIdeVerificationWatcher(candidate: CandidateScore) {
    if (this.ideWatchTimer) clearInterval(this.ideWatchTimer);

    const startedAt = Date.now();
    const timeoutMs = 15 * 60 * 1000; // 15 minutes interaction window

    this.ideWatchTimer = setInterval(async () => {
      const st = this.targetStatuses.ide;
      if (st.state !== 'WAITING_FOR_USER') {
        if (this.ideWatchTimer) clearInterval(this.ideWatchTimer);
        return;
      }

      if (Date.now() - startedAt > timeoutMs) {
        st.state = 'FAILED';
        st.actionRequired = 'Interaction timed out after 15 minutes with no identity change.';
        this.recordEvent('ACTIVATION_FAILED', 'ide', candidate.accountId, candidate.accountEmail, 'User interaction timed out.');
        this.addCooldown(candidate.accountId, 'IDE interaction timed out.');
        if (this.ideWatchTimer) clearInterval(this.ideWatchTimer);
        return;
      }

      // Check current detected email
      if (st.currentEmail && st.currentEmail.toLowerCase() === candidate.accountEmail.toLowerCase()) {
        // Identity verified!
        st.state = 'COMPLETED';
        this.previousSwitchedAwayEmails.ide = st.currentEmail;
        st.lastSwitchAt = new Date().toISOString();
        st.dwellRemainingSeconds = this.config.minDwellMinutes * 60;
        st.actionRequired = `Successfully verified IDE sign in to ${candidate.accountEmail}`;
        this.recordEvent('ACTIVATION_VERIFIED', 'ide', candidate.accountId, candidate.accountEmail, `IDE identity verified as ${candidate.accountEmail}`);
        if (this.ideWatchTimer) clearInterval(this.ideWatchTimer);
      }
    }, 2500);
  }

  cancelIdeHandoff(): void {
    if (this.ideWatchTimer) {
      clearInterval(this.ideWatchTimer);
      this.ideWatchTimer = null;
    }
    const st = this.targetStatuses.ide;
    if (st.state === 'WAITING_FOR_USER') {
      st.state = 'MONITORING';
      st.actionRequired = 'Pending IDE switch was cancelled by user.';
    }
  }

  /**
   * Synced Mode Orchestration (Transactional Multi-Target Switch).
   */
  private async evaluateSyncedRouting(ideTarget?: TargetState, ag2Target?: TargetState): Promise<void> {
    const ideSt = this.targetStatuses.ide;
    const ag2St = this.targetStatuses.antigravity2;

    const ideQuota = ideSt.currentModelQuotaPercent;
    const ag2Quota = ag2St.currentModelQuotaPercent;

    const isIdeLow = ideQuota !== null && ideQuota <= this.config.switchThreshold;
    const isAg2Low = ag2Quota !== null && ag2Quota <= this.config.switchThreshold;

    if (!isIdeLow && !isAg2Low) {
      ideSt.state = 'MONITORING';
      ag2St.state = 'MONITORING';
      return;
    }

    // Determine common eligible candidate holding both target sessions
    const poolSnapshots = this.buildAccountSnapshots();
    const activeEmails = [ideSt.currentEmail, ag2St.currentEmail].filter(Boolean) as string[];
    const coolingDownAccountIds = Object.keys(this.cooldowns);

    const rankings = rankCandidatesForModel({
      modelLabel: this.config.selectedModel,
      accounts: poolSnapshots,
      currentlyActiveEmails: activeEmails,
      coolingDownAccountIds
    });

    const eligible = rankings.filter(c => {
      if (c.tier === 'UNAVAILABLE' || c.score <= 0) return false;
      if (c.accountId === ideSt.currentAccountId || c.accountId === ag2St.currentAccountId) return false;
      const accountMeta = this.vault.getAccount(c.accountId);
      return Boolean(accountMeta?.targets.antigravity2 && accountMeta?.targets.ide);
    });

    const candidate = eligible.length > 0 ? eligible[0] : null;
    ideSt.recommendedCandidate = candidate;
    ag2St.recommendedCandidate = candidate;

    if (!candidate) {
      ideSt.state = 'ROUTE_NEEDED';
      ag2St.state = 'ROUTE_NEEDED';
      ideSt.actionRequired = 'Synced route needed, but no fully paired candidate available';
      ag2St.actionRequired = 'Synced route needed, but no fully paired candidate available';
      return;
    }

    // Verify BOTH targets are IDLE before starting coordinated switch
    const bothIdle = ideSt.isIdle && ideSt.runningTrajectories === 0 && ag2St.isIdle && ag2St.runningTrajectories === 0;

    if (!bothIdle) {
      ideSt.state = 'WAITING_FOR_IDLE';
      ag2St.state = 'WAITING_FOR_IDLE';
      const msg = `Synced switch waiting for idle boundary (IDE tasks: ${ideSt.runningTrajectories}, AG2 tasks: ${ag2St.runningTrajectories})`;
      ideSt.actionRequired = msg;
      ag2St.actionRequired = msg;
      if (this.config.operatingMode === 'SHADOW') {
        ag2St.shadowPlan = {
          wouldPerform: 'AUTOMATIC_COLD_TARGET_RELOAD',
          actionDescription: `[SHADOW SYNCED] Waiting for idle. Would perform AG2 cold reload to ${candidate.accountEmail}.`,
          candidateAccountId: candidate.accountId,
          candidateEmail: candidate.accountEmail,
          candidateModelQuotaPercent: candidate.remainingPercent,
          executed: false
        };
        ideSt.shadowPlan = {
          wouldPerform: 'INTERACTION_REQUIRED',
          actionDescription: `[SHADOW SYNCED] Waiting for idle. Would enter IDE interaction for ${candidate.accountEmail}.`,
          candidateAccountId: candidate.accountId,
          candidateEmail: candidate.accountEmail,
          candidateModelQuotaPercent: candidate.remainingPercent,
          executed: false
        };
      }
      return;
    }

    if (this.config.operatingMode === 'SHADOW') {
      // SHADOW SYNCED: Record both plans with rollback plan, zero mutation!
      ag2St.state = 'ACTIVATION_PLANNED';
      ag2St.shadowPlan = {
        wouldPerform: 'AUTOMATIC_COLD_TARGET_RELOAD',
        actionDescription: `[SHADOW SYNCED] Phase 1: Would perform AUTOMATIC_COLD_TARGET_RELOAD to ${candidate.accountEmail}. Rollback plan: restore AG2 to ${ag2St.currentEmail} if IDE interaction fails.`,
        candidateAccountId: candidate.accountId,
        candidateEmail: candidate.accountEmail,
        candidateModelQuotaPercent: candidate.remainingPercent,
        executed: false
      };
      ag2St.actionRequired = `[SHADOW MODE] Synced switch evaluated: Would activate ${candidate.accountEmail} on AG2. Executed: NO.`;

      ideSt.state = 'WAITING_FOR_USER';
      ideSt.shadowPlan = {
        wouldPerform: 'INTERACTION_REQUIRED',
        actionDescription: `[SHADOW SYNCED] Phase 2: Would prompt user interaction for IDE to ${candidate.accountEmail}. Rollback plan: restore AG2 if user cancels.`,
        candidateAccountId: candidate.accountId,
        candidateEmail: candidate.accountEmail,
        candidateModelQuotaPercent: candidate.remainingPercent,
        executed: false
      };
      ideSt.actionRequired = `[SHADOW MODE] Synced switch evaluated: Would prompt user login for IDE to ${candidate.accountEmail}. Executed: NO.`;

      this.recordEvent('SHADOW_PLAN_RECORDED', 'synced', candidate.accountId, candidate.accountEmail,
        `[SHADOW SYNCED] Coordinated switch evaluated for ${candidate.accountEmail}. Zero mutation executed.`);
      return;
    }

    if (this.config.operatingMode === 'LIVE') {
      // Execute Phase 1: AG2 Cold Target Reload
      this.isProcessingEvent = true;
      this.syncedPreSwitchBackupEmail = ag2St.currentEmail;

      const ag2Success = await this.executeAg2ColdTargetReload(candidate);
      if (!ag2Success) {
        this.isProcessingEvent = false;
        return;
      }

      // Execute Phase 2: IDE User Interaction Prompt
      this.initiateIdeInteractionHandoff(candidate);
      this.isProcessingEvent = false;
    }
  }

  /**
   * Transactional Rollback for Synced Mode if IDE interaction fails or is cancelled.
   */
  async rollbackSyncedAg2Target(): Promise<boolean> {
    if (!this.syncedPreSwitchBackupEmail) return false;

    safeLog(`[ROUTER] Performing transactional rollback of Antigravity 2.0 to ${this.syncedPreSwitchBackupEmail}...`);
    this.recordEvent('ROLLBACK_STARTED', 'synced', undefined, this.syncedPreSwitchBackupEmail, 'Rolling back AG2 to original account after IDE cancellation');

    const prevAccount = this.registry.getAccount(this.syncedPreSwitchBackupEmail);
    if (!prevAccount) return false;

    const res = await this.switchController.activateVaultedAccount(prevAccount.id);
    if (res.success) {
      this.recordEvent('ROLLBACK_VERIFIED', 'synced', prevAccount.id, this.syncedPreSwitchBackupEmail, 'Rollback verified. AG2 restored to previous account.');
      this.syncedPreSwitchBackupEmail = null;
      return true;
    }
    return false;
  }

  addCooldown(accountId: string, reason: string): void {
    const expiresAt = new Date(Date.now() + this.config.cooldownMinutes * 60 * 1000).toISOString();
    this.cooldowns[accountId] = {
      accountId,
      expiresAt,
      reason
    };
    safeLog(`[ROUTER] Account ${accountId} placed in failure cooldown until ${expiresAt} (${reason})`);
    this.recordEvent('ACCOUNT_COOLDOWN', 'synced', accountId, undefined, `Account cooling down: ${reason}`);
  }

  private cleanExpiredCooldowns(): void {
    const now = Date.now();
    for (const [id, c] of Object.entries(this.cooldowns)) {
      if (new Date(c.expiresAt).getTime() <= now) {
        delete this.cooldowns[id];
        safeLog(`[ROUTER] Cooldown expired for account ${id}`);
      }
    }
  }

  private buildAccountSnapshots(): AccountModelSnapshot[] {
    const accounts = this.registry.getAllAccounts();
    const snapshots: AccountModelSnapshot[] = [];

    for (const acc of accounts) {
      const quota = this.quotaCache.getQuota(acc.email);
      const freshness = quota ? quota.freshness : 'UNKNOWN';

      const modelsMap: Record<string, any> = {};
      if (quota && quota.models) {
        for (const m of quota.models) {
          const pct = Math.round(m.remainingFraction * 100);
          modelsMap[m.label] = {
            remainingFraction: m.remainingFraction,
            remainingPercent: pct,
            resetTime: m.resetTime,
            isExhausted: m.isExhausted,
            health: this.classifyHealth(pct)
          };
        }
      }

      snapshots.push({
        accountId: acc.id,
        accountEmail: acc.email,
        accountLabel: acc.label,
        priority: acc.priority,
        enabled: acc.enabled,
        isReserve: Boolean(acc.isReserve),
        vaultStatus: acc.vaultStatus,
        activeTarget: acc.activeTarget || null,
        freshness,
        capturedAt: quota?.capturedAt || null,
        planName: quota?.planName || 'Pro',
        userTier: quota?.userTier || 'PAYG',
        models: modelsMap
      });
    }

    return snapshots;
  }

  private recordEvent(
    type: RoutingEventType,
    targetId: TargetId | 'synced',
    accountId?: string,
    accountEmail?: string,
    message: string = '',
    metadata?: Record<string, any>
  ): void {
    const event: RoutingEvent = {
      id: `route-evt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      targetId,
      accountId,
      accountEmail,
      modelLabel: this.config.selectedModel,
      message,
      timestamp: new Date().toISOString(),
      metadata: metadata ? sanitizeObject(metadata) : undefined
    };

    this.events.push(event);
    if (this.events.length > 50) {
      this.events.shift();
    }
    safeLog(`[ROUTER EVENT] ${type} on [${targetId}]: ${message}`);
  }
}
