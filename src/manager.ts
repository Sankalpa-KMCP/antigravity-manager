import { DashboardData, ProjectMapping, SwitchSession, TargetId, TargetState } from './types';
import { detectTarget, invalidateTargetCache } from './discovery/detector';
import { getPowershellLaunchCount } from './discovery/process';
import { getNetstatLaunchCount } from './discovery/ports';
import { fetchCascadeTrajectories, fetchUserStatus } from './rpc/endpoints';
import { parseUserStatus } from './usage/parser';
import { evaluateTrajectories } from './trajectories/evaluator';
import { calculateAggregates } from './aggregate/calculator';
import { ProjectStore } from './routing/store';
import { SwitchManager } from './switching/handler';
import { verifyIdleGate } from './switching/gate';
import { AccountPoolData, AccountRegistry, CandidateScore, PoolEventManager, QuotaCache, calculatePoolData, rankCandidatesForModel } from './pool';
import { PREFERRED_MODEL_ORDER } from './models/filter';
import { SessionVault, TransactionalSwitchController, EnrollmentController, UnattendedActivationController } from './vault';
import { PairingController } from './vault/pairing-controller';
import { AutomaticQuotaRouter } from './routing';

export class AntigravityManager {
  private lastData: DashboardData | null = null;
  private isRefreshing: boolean = false;
  private rpcPollCount: number = 0;
  private startTime: number = Date.now();
  private projectStore: ProjectStore;
  private switchManager: SwitchManager;
  private accountRegistry: AccountRegistry;
  private quotaCache: QuotaCache;
  private eventManager: PoolEventManager;
  private sessionVault: SessionVault;
  private switchController: TransactionalSwitchController;
  private enrollmentController: EnrollmentController;
  private pairingController: PairingController;
  private unattendedController: UnattendedActivationController;
  private quotaRouter: AutomaticQuotaRouter;
  private vaultInitialized: boolean = false;

  private cachedCsrfTokens: Record<TargetId, string | null> = {
    ide: null,
    antigravity2: null
  };

  private consecutiveRpcFailures: Record<TargetId, number> = {
    ide: 0,
    antigravity2: 0
  };

  private lastOfflineScanTime: Record<TargetId, number> = {
    ide: 0,
    antigravity2: 0
  };

  constructor() {
    this.projectStore = new ProjectStore();
    this.switchManager = new SwitchManager();
    this.accountRegistry = new AccountRegistry();
    this.quotaCache = new QuotaCache();
    this.eventManager = new PoolEventManager();
    this.sessionVault = new SessionVault();
    this.switchController = new TransactionalSwitchController(this.sessionVault);
    this.enrollmentController = new EnrollmentController(this.sessionVault, this.accountRegistry, this.quotaCache);
    this.pairingController = new PairingController(this.sessionVault, this.accountRegistry, this.quotaCache);
    this.unattendedController = new UnattendedActivationController(this.sessionVault);
    this.quotaRouter = new AutomaticQuotaRouter(this.sessionVault, this.switchController, this.accountRegistry, this.quotaCache);

    // Wire poll trigger during active switch verification
    this.switchManager.setPollTrigger(async () => {
      await this.refreshAll();
    });

    // Wire switch success callback to trigger fresh telemetry update
    this.switchManager.onSwitchSuccess(async (targetId, newEmail) => {
      await this.refreshAll('SwitchVerified');
    });
  }

  getQuotaRouter(): AutomaticQuotaRouter {
    return this.quotaRouter;
  }

  getEnrollmentController(): EnrollmentController {
    return this.enrollmentController;
  }

  getPairingController(): PairingController {
    return this.pairingController;
  }

  getUnattendedController(): UnattendedActivationController {
    return this.unattendedController;
  }

  getSessionVault(): SessionVault {
    return this.sessionVault;
  }

  getSwitchController(): TransactionalSwitchController {
    return this.switchController;
  }

  getCsrfToken(targetId: TargetId): string | null {
    return this.cachedCsrfTokens[targetId];
  }

  getProjectStore(): ProjectStore {
    return this.projectStore;
  }

  getSwitchManager(): SwitchManager {
    return this.switchManager;
  }

  async refreshTarget(targetId: TargetId, targetName: string, forceReason?: string): Promise<TargetState> {
    const now = Date.now();
    if (!forceReason && this.lastData) {
      const prev = this.lastData.targets.find(t => t.id === targetId);
      if (prev && !prev.isRunning && (now - this.lastOfflineScanTime[targetId] < 60000)) {
        return {
          ...prev,
          lastUpdated: new Date().toISOString()
        };
      }
    }

    const discovery = await detectTarget(targetId, forceReason);
    if (!discovery.isRunning) {
      this.lastOfflineScanTime[targetId] = now;
      this.cachedCsrfTokens[targetId] = null;
    } else {
      this.cachedCsrfTokens[targetId] = discovery.csrfToken;
    }

    if (!discovery.isRunning || !discovery.port || !discovery.csrfToken) {
      this.accountRegistry.clearAccountTarget(targetId);
      return {
        id: targetId,
        name: targetName,
        isRunning: false,
        pid: discovery.pid,
        port: discovery.port,
        email: null,
        userName: null,
        userTier: null,
        planName: null,
        credits: null,
        models: [],
        trajectoryStatus: {
          totalTrajectories: 0,
          runningTrajectories: 0,
          state: 'UNKNOWN'
        },
        discovery: discovery.discovery,
        lastUpdated: new Date().toISOString(),
        error: discovery.error
      };
    }

    try {
      this.rpcPollCount++;
      const [rawStatus, rawTrajectories] = await Promise.all([
        fetchUserStatus(discovery.port, discovery.csrfToken),
        fetchCascadeTrajectories(discovery.port, discovery.csrfToken)
      ]);

      this.consecutiveRpcFailures[targetId] = 0;

      const parsedUser = parseUserStatus(rawStatus);
      const trajectoryStatus = evaluateTrajectories(rawTrajectories);

      // Phase 4A Multi-Account Registry & Quota Cache auto-discovery
      if (parsedUser.email) {
        this.accountRegistry.registerObservedAccount({
          email: parsedUser.email,
          targetId,
          userName: parsedUser.userName
        });

        this.quotaCache.updateCache({
          email: parsedUser.email,
          planName: parsedUser.planName,
          userTier: parsedUser.userTier,
          credits: parsedUser.credits,
          models: parsedUser.models
        });
      }

      // Notify switch manager of current email for post-switch verification
      this.switchManager.notifyTargetStatusUpdated(targetId, parsedUser.email);

      return {
        id: targetId,
        name: targetName,
        isRunning: true,
        pid: discovery.pid,
        port: discovery.port,
        email: parsedUser.email,
        userName: parsedUser.userName,
        userTier: parsedUser.userTier,
        planName: parsedUser.planName,
        credits: parsedUser.credits,
        models: parsedUser.models,
        trajectoryStatus,
        discovery: discovery.discovery,
        lastUpdated: new Date().toISOString(),
        error: null
      };
    } catch (err) {
      this.consecutiveRpcFailures[targetId]++;

      if (this.consecutiveRpcFailures[targetId] >= 3) {
        invalidateTargetCache(targetId);
      }

      return {
        id: targetId,
        name: targetName,
        isRunning: true,
        pid: discovery.pid,
        port: discovery.port,
        email: null,
        userName: null,
        userTier: null,
        planName: null,
        credits: null,
        models: [],
        trajectoryStatus: {
          totalTrajectories: 0,
          runningTrajectories: 0,
          state: 'UNKNOWN'
        },
        discovery: discovery.discovery,
        lastUpdated: new Date().toISOString(),
        error: `RPC call failed (${this.consecutiveRpcFailures[targetId]}/3 failures): ${(err as Error).message}`
      };
    }
  }

  getAccountRegistry(): AccountRegistry {
    return this.accountRegistry;
  }

  getQuotaCache(): QuotaCache {
    return this.quotaCache;
  }

  getEventManager(): PoolEventManager {
    return this.eventManager;
  }

  async refreshAll(forceReason?: string): Promise<DashboardData> {
    if (this.isRefreshing && this.lastData) {
      return this.lastData;
    }

    this.isRefreshing = true;
    try {
      const [ideState, ag2State] = await Promise.all([
        this.refreshTarget('ide', 'Antigravity IDE', forceReason),
        this.refreshTarget('antigravity2', 'Antigravity 2.0', forceReason)
      ]);

      const targets = [ideState, ag2State];
      const aggregate = calculateAggregates(targets);
      const projects = this.projectStore.evaluateStatuses(targets);
      const activeSwitchSession = this.switchManager.getActiveSession();

      // Phase 4A Multi-Account Pool & Quota Engine & Phase 4D Vault Integration
      const activeEmails = targets.filter(t => t.isRunning && t.email).map(t => t.email!);

      let vaultEntries: any[] = [];
      try {
        if (!this.vaultInitialized) {
          await this.sessionVault.init();
          this.vaultInitialized = true;
        }
        vaultEntries = this.sessionVault.listMetadata();
      } catch {
        // Vault might be uninitialized or in-test
      }

      const poolCalculations = calculatePoolData(this.accountRegistry, this.quotaCache, Date.now(), vaultEntries);

      // Compute candidate rankings for each preferred model
      const candidateRankings: Record<string, CandidateScore[]> = {};
      const bestCandidates: Record<string, CandidateScore | null> = {};

      for (const modelLabel of PREFERRED_MODEL_ORDER) {
        const ranked = rankCandidatesForModel({
          modelLabel,
          accounts: poolCalculations.accounts,
          currentlyActiveEmails: activeEmails
        });
        candidateRankings[modelLabel] = ranked;
        bestCandidates[modelLabel] = ranked.find(r => r.tier === 'BEST_CANDIDATE') || null;
      }

      // Evaluate state transition events (deduplicated with cooldown)
      this.eventManager.evaluateTransitions({
        accounts: poolCalculations.accounts,
        bestCandidates
      });

      const poolData: AccountPoolData = {
        accounts: poolCalculations.accounts,
        modelStats: poolCalculations.modelStats,
        bestCandidates,
        candidateRankings,
        events: this.eventManager.getRecentEvents(),
        poolSummary: poolCalculations.poolSummary
      };

      const systemTelemetry = {
        powershellLaunches: getPowershellLaunchCount(),
        netstatLaunches: getNetstatLaunchCount(),
        rpcPollCount: this.rpcPollCount,
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000)
      };

      const ctrl = this.switchController.getControllerStatus();
      const enrollmentStatus = this.enrollmentController.getEnrollmentStatus();

      const sharedAccounts = this.sessionVault.listAccounts();
      const enrichedVaultAccounts = sharedAccounts.length > 0
        ? sharedAccounts.map(acc => {
            const reg = this.accountRegistry.getAccountById(acc.accountId);
            const email = reg ? reg.email : (
              acc.targets.antigravity2?.notes?.split(' ').find((w: string) => w.includes('@')) ||
              acc.targets.ide?.notes?.split(' ').find((w: string) => w.includes('@'))
            );
            const quota = email ? this.quotaCache.getQuota(email) : null;
            const activeTargets = targets.filter(t => t.isRunning && t.email && email && t.email.toLowerCase() === email.toLowerCase()).map(t => t.id);
            const isActive = activeTargets.length > 0;
            const primaryTargetMeta = acc.targets.antigravity2 || acc.targets.ide;

            return {
              accountId: acc.accountId,
              email,
              label: reg?.label || email?.split('@')[0] || acc.accountId,
              priority: reg?.priority || 1,
              enabled: reg?.enabled !== undefined ? reg.enabled : true,
              isReserve: Boolean(reg?.isReserve),
              provider: 'google',
              authMethod: acc.targets.antigravity2 ? 'oauth2_wincred' : 'oauth2_uss',
              status: primaryTargetMeta?.status || 'VALID',
              notes: primaryTargetMeta?.notes,
              createdAt: primaryTargetMeta?.capturedAt || acc.updatedAt,
              updatedAt: acc.updatedAt,
              lastValidatedAt: primaryTargetMeta?.lastValidatedAt || null,
              lastQuotaRefreshAt: reg?.lastQuotaRefreshAt || null,
              freshness: quota?.freshness || 'UNKNOWN',
              isActive,
              targets: acc.targets,
              capabilities: this.sessionVault.getTargetCapabilities(acc.accountId),
              activeTargets
            };
          })
        : vaultEntries.map(e => {
            const reg = this.accountRegistry.getAccountById(e.accountId);
            const email = reg ? reg.email : (e.notes && e.notes.includes('@') ? e.notes.split(' ').find((w: string) => w.includes('@')) : undefined);
            const quota = email ? this.quotaCache.getQuota(email) : null;
            const activeTargets = targets.filter(t => t.isRunning && t.email && email && t.email.toLowerCase() === email.toLowerCase()).map(t => t.id);
            const isActive = activeTargets.length > 0;
            return {
              accountId: e.accountId,
              email,
              label: reg?.label || email?.split('@')[0] || e.accountId,
              priority: reg?.priority || 1,
              enabled: reg?.enabled !== undefined ? reg.enabled : true,
              isReserve: Boolean(reg?.isReserve),
              provider: e.provider,
              authMethod: e.authMethod,
              status: e.status,
              notes: e.notes,
              createdAt: e.createdAt,
              updatedAt: e.updatedAt,
              lastValidatedAt: e.lastValidatedAt,
              lastQuotaRefreshAt: reg?.lastQuotaRefreshAt || null,
              freshness: quota?.freshness || 'UNKNOWN',
              isActive,
              targets: (e.target ? { [e.target]: { target: e.target, status: e.status, capturedAt: e.createdAt, lastValidatedAt: e.lastValidatedAt, notes: e.notes } } : {}) as any,
              activeTargets
            };
          });

      const pairingStatus = this.pairingController.getPairingStatus();
      const totalAccounts = enrichedVaultAccounts.length;
      const fullyPairedAccounts = enrichedVaultAccounts.filter(a => (a as any).targets?.ide && (a as any).targets?.antigravity2).length;
      const targetCoverage = {
        fullyPaired: fullyPairedAccounts,
        totalAccounts,
        ratio: `${fullyPairedAccounts} / ${totalAccounts} complete`
      };

      const vaultStatus = {
        accounts: enrichedVaultAccounts,
        controllerState: ctrl.state,
        activeAccountId: ctrl.activeAccountId,
        targetEmail: ctrl.targetEmail,
        previousEmail: ctrl.previousEmail,
        progress: ctrl.progress,
        error: ctrl.error,
        enrollment: enrollmentStatus,
        pairing: pairingStatus,
        targetCoverage
      };

      const routerTelemetry = this.quotaRouter.getStatus();

      this.lastData = {
        targets,
        aggregate,
        projects,
        activeSwitchSession,
        pool: poolData,
        vault: vaultStatus,
        router: routerTelemetry,
        systemTelemetry,
        timestamp: new Date().toISOString()
      };

      // Notify router asynchronously to drive automatic evaluations
      this.quotaRouter.onTelemetryUpdated(this.lastData).catch(() => {});

      return this.lastData;
    } finally {
      this.isRefreshing = false;
    }
  }

  async initiateTargetSwitch(targetId: TargetId): Promise<{ success: boolean; session?: SwitchSession; error?: string }> {
    if (!this.lastData) {
      await this.refreshAll();
    }

    const target = this.lastData?.targets.find(t => t.id === targetId);
    if (!target) {
      return { success: false, error: `Target "${targetId}" not found.` };
    }
    const csrfToken = this.cachedCsrfTokens[targetId];

    // 1. IDLE GATE CHECK: Must have zero running trajectories
    const gate = await verifyIdleGate(target, csrfToken);
    if (!gate.allowed) {
      return {
        success: false,
        error: gate.reason
      };
    }

    // 2. Initiate Switch via SwitchManager
    const session = await this.switchManager.initiateSwitch(target, csrfToken);

    // Refresh dashboard so active session is immediately broadcast
    await this.refreshAll();

    return {
      success: true,
      session
    };
  }

  cancelSwitch(): { success: boolean; message: string } {
    this.switchManager.cancelSwitch();
    return { success: true, message: 'Active switch session cancelled.' };
  }

  async removeAccount(accountId: string, options: { deleteQuotaCache?: boolean } = {}): Promise<{ success: boolean; error?: string }> {
    const reg = this.accountRegistry.getAccountById(accountId);
    const email = reg ? reg.email : (accountId.startsWith('acc-') ? accountId.replace('acc-', '') : accountId);

    // Safety Check: Reject removal of currently active account
    const lastData = this.getLastData();
    const isCurrentlyActive = lastData?.targets.some(t => t.isRunning && t.email && email && t.email.toLowerCase() === email.toLowerCase());
    if (isCurrentlyActive) {
      return {
        success: false,
        error: `Cannot remove account "${email}" because it is currently active on a running target. Activate another vaulted account first.`
      };
    }

    // Remove from SessionVault
    await this.sessionVault.deleteSession(accountId);

    // Remove from AccountRegistry
    this.accountRegistry.deleteAccount(accountId);

    // Optionally delete from QuotaCache
    if (options.deleteQuotaCache && email) {
      this.quotaCache.deleteQuota(email);
    }

    await this.refreshAll('AccountRemoved');
    return { success: true };
  }

  getLastData(): DashboardData | null {
    return this.lastData;
  }
}
