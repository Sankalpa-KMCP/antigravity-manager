import fs from 'fs';
import path from 'path';
import { SessionVault } from '../vault/vault';
import { VaultAuditLogger } from '../vault/audit';
import { TransactionalSwitchController } from '../vault/switch-controller';
import { AccountRegistry } from '../pool/account-registry';
import { QuotaCache } from '../pool/quota-cache';
import { AutomaticQuotaRouter } from '../routing/router';
import { DashboardData, TargetState } from '../types';

export async function runShadowRouterTests(): Promise<boolean> {
  console.log('--- RUNNING PHASE 4J SHADOW ROUTER & POOL TEST SUITE ---');
  let passed = true;

  function assert(cond: boolean, msg: string) {
    if (!cond) {
      console.error(`  FAIL: ${msg}`);
      passed = false;
    } else {
      console.log(`  PASS: ${msg}`);
    }
  }

  const testDir = path.join(process.cwd(), 'data', 'test_shadow_router_suite');

  try {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    const auditLogger = new VaultAuditLogger();
    const vault = new SessionVault(testDir, auditLogger);
    await vault.init();

    const accountsPath = path.join(testDir, 'accounts.json');
    const quotaCachePath = path.join(testDir, 'quota-cache.json');

    const registry = new AccountRegistry(accountsPath);
    const quotaCache = new QuotaCache(quotaCachePath);
    const switchController = new TransactionalSwitchController(vault);

    // Track any attempted mutations on the switch controller
    let switchCalled = false;
    switchController.activateVaultedAccount = async () => {
      switchCalled = true;
      return { success: true, state: 'COMPLETED', targetEmail: 'mock@example.com', previousEmail: 'mock@example.com' };
    };

    // Setup 7 accounts in pool to test full pool capacity & tie-breaking
    const mockPayload = { token: 'mock-non-sensitive-test-token' };
    const accounts = [];
    for (let i = 1; i <= 7; i++) {
      const email = `pool-account-${i}@example.com`;
      const reg = registry.registerObservedAccount({
        email,
        label: `Account ${i}`,
        priority: i, // 1 is highest priority, 7 is lowest
        enabled: true,
        isReserve: i === 7 // Account 7 is reserve
      });
      await vault.storeTargetSession(reg.id, 'antigravity2', mockPayload);
      await vault.storeTargetSession(reg.id, 'ide', mockPayload);
      accounts.push(reg);
    }

    // Set model quotas for 'Gemini 3.8 Flash (High)':
    // Account 1: 5% (Critical - active)
    // Account 2: 85% (Healthy, priority 2)
    // Account 3: 85% (Healthy, priority 3 - tie-breaker test)
    // Account 4: 40% (Healthy, priority 4)
    // Account 5: 92% (High, priority 5)
    // Account 6: 15% (Low, priority 6)
    // Account 7: 95% (Reserve, priority 7)
    const testModel = 'Gemini 3.8 Flash (High)';
    const nowIso = new Date().toISOString();

    const quotasToSet = [
      { email: accounts[0].email, fraction: 0.05, exhausted: true },
      { email: accounts[1].email, fraction: 0.85, exhausted: false },
      { email: accounts[2].email, fraction: 0.85, exhausted: false },
      { email: accounts[3].email, fraction: 0.40, exhausted: false },
      { email: accounts[4].email, fraction: 0.92, exhausted: false },
      { email: accounts[5].email, fraction: 0.15, exhausted: false },
      { email: accounts[6].email, fraction: 0.95, exhausted: false }
    ];

    for (const q of quotasToSet) {
      quotaCache.updateCache({
        email: q.email,
        models: [
          {
            label: testModel,
            modelOrTier: 'gemini-3.8-flash',
            remainingFraction: q.fraction,
            resetTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
            isExhausted: q.exhausted
          }
        ],
        capturedAt: nowIso
      });
    }

    const router = new AutomaticQuotaRouter(vault, switchController, registry, quotaCache);

    console.log('\n--- TEST 1: OPERATING MODE CONTROLS & LIVE LOCKOUT ---');
    const initStatus = router.getStatus();
    assert(initStatus.config.enabled === false, 'Initial state: enabled is false');
    assert(initStatus.config.operatingMode === 'OFF', 'Initial operatingMode is OFF');

    // Enable via acknowledgeEnable -> should activate SHADOW mode in Phase 4J
    const enabledConfig = router.acknowledgeEnable();
    assert(enabledConfig.enabled === true, 'acknowledgeEnable sets enabled = true');
    assert(enabledConfig.operatingMode === 'SHADOW', 'acknowledgeEnable sets operatingMode = SHADOW in Phase 4J');

    // Attempting to set LIVE mode must throw error
    let liveLockoutCaught = false;
    try {
      router.setOperatingMode('LIVE');
    } catch (e: any) {
      liveLockoutCaught = true;
      assert(e.message.includes('LIVE routing is disabled in Phase 4J'), 'LIVE mode rejected with Phase 4J lockout message');
    }
    assert(liveLockoutCaught, 'Router prevents setting LIVE operating mode');

    // Toggling back to OFF
    const disabledConfig = router.setOperatingMode('OFF');
    assert(disabledConfig.enabled === false && disabledConfig.operatingMode === 'OFF', 'setOperatingMode(OFF) disables routing');

    // Toggling to SHADOW
    const shadowConfig = router.setOperatingMode('SHADOW');
    assert(shadowConfig.enabled === true && shadowConfig.operatingMode === 'SHADOW', 'setOperatingMode(SHADOW) activates shadow mode');

    console.log('\n--- TEST 2: ZERO MUTATION GUARANTEE IN SHADOW MODE ---');
    // Prepare mock dashboard data where targets are running Account 1 at 5% quota (Critical)
    const mockTelemetry: DashboardData = {
      targets: [
        {
          id: 'antigravity2',
          name: 'Antigravity 2.0',
          isRunning: true,
          port: 52892,
          pid: 11752,
          email: accounts[0].email,
          planName: 'Pro',
          userName: 'Account 1',
          userTier: 'Standard',
          credits: null,
          discovery: { lastDiscoveryAt: null, discoveryReason: null, discoveryCount: 0 },
          lastUpdated: nowIso,
          error: null,
          models: [
            {
              label: testModel,
              modelOrTier: 'gemini-3.8-flash',
              remainingFraction: 0.05, // 5% -> Critical!
              resetTime: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
              isExhausted: false
            }
          ],
          trajectoryStatus: {
            state: 'IDLE',
            runningTrajectories: 0,
            totalTrajectories: 0
          }
        },
        {
          id: 'ide',
          name: 'Antigravity IDE',
          isRunning: true,
          port: 52893,
          pid: 11750,
          email: accounts[0].email,
          planName: 'Pro',
          userName: 'Account 1',
          userTier: 'Standard',
          credits: null,
          discovery: { lastDiscoveryAt: null, discoveryReason: null, discoveryCount: 0 },
          lastUpdated: nowIso,
          error: null,
          models: [
            {
              label: testModel,
              modelOrTier: 'gemini-3.8-flash',
              remainingFraction: 0.05, // 5% -> Critical!
              resetTime: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
              isExhausted: false
            }
          ],
          trajectoryStatus: {
            state: 'IDLE',
            runningTrajectories: 0,
            totalTrajectories: 0
          }
        }
      ],
      aggregate: {
        prompt: { monthly: 0, available: 0, computedUsed: 0 },
        flow: { monthly: 0, available: 0, computedUsed: 0 }
      },
      projects: [],
      activeSwitchSession: null,
      systemTelemetry: {
        powershellLaunches: 0,
        netstatLaunches: 0,
        rpcPollCount: 0,
        uptimeSeconds: 10
      },
      timestamp: nowIso
    };

    switchCalled = false;

    // Evaluate in SHADOW mode
    await router.onTelemetryUpdated(mockTelemetry);

    assert(switchCalled === false, 'activateVaultedAccount was NOT called (Zero Mutation Guarantee)');

    console.log('\n--- TEST 3: HYPOTHETICAL ACTION PLANS (SHADOW PLAN) ---');
    const statusAfterEval = router.getStatus();
    const ag2Status = statusAfterEval.targets.antigravity2;
    const ideStatus = statusAfterEval.targets.ide;

    assert(ag2Status.currentModelQuotaPercent === 5, 'AG2 currentModelQuotaPercent correctly detected as 5%');
    assert(ag2Status.health === 'CRITICAL', 'AG2 health correctly flagged CRITICAL');
    assert(ag2Status.shadowPlan !== null && ag2Status.shadowPlan !== undefined, 'AG2 has shadowPlan populated');
    assert(ag2Status.shadowPlan?.wouldPerform === 'AUTOMATIC_COLD_TARGET_RELOAD', 'AG2 shadowPlan wouldPerform = AUTOMATIC_COLD_TARGET_RELOAD');
    assert(ag2Status.shadowPlan?.executed === false, 'AG2 shadowPlan.executed === false');
    assert(ag2Status.shadowPlan?.actionDescription.includes('Would perform safe AG2 LS recycle') || false, 'AG2 shadowPlan description documents hypothetical reload');

    assert(ideStatus.currentModelQuotaPercent === 5, 'IDE currentModelQuotaPercent correctly detected as 5%');
    assert(ideStatus.health === 'CRITICAL', 'IDE health correctly flagged CRITICAL');
    assert(ideStatus.shadowPlan !== null && ideStatus.shadowPlan !== undefined, 'IDE has shadowPlan populated');
    assert(ideStatus.shadowPlan?.wouldPerform === 'INTERACTION_REQUIRED', 'IDE shadowPlan wouldPerform = INTERACTION_REQUIRED');
    assert(ideStatus.shadowPlan?.executed === false, 'IDE shadowPlan.executed === false');
    assert(ideStatus.shadowPlan?.actionDescription.includes('Would request interactive IDE OAuth login') || false, 'IDE shadowPlan description documents hypothetical OAuth handoff');

    console.log('\n--- TEST 4: CANDIDATE SELECTION ACROSS 7 ACCOUNTS ---');
    // Account 5 has 92% quota (non-reserve).
    // Account 7 has 95% quota but is Reserve, so non-reserve Account 5 beats it.
    assert(ag2Status.recommendedCandidate?.accountEmail === accounts[4].email, `Selected top candidate is Account 5 (${accounts[4].email}) with 92% quota`);
    assert(ag2Status.shadowPlan?.candidateEmail === accounts[4].email, 'Shadow plan candidate matches best candidate (Account 5)');

    console.log('\n--- TEST 5: TIE-BREAKING ON PRIORITY ---');
    // Set Account 2 and Account 3 to identical 90% quota.
    // Account 2 has priority 2, Account 3 has priority 3.
    // Account 2 must win because priority 2 < 3 (lower number = higher priority).
    quotaCache.updateCache({
      email: accounts[1].email,
      models: [{ label: testModel, modelOrTier: 'gemini-3.8-flash', remainingFraction: 0.90, resetTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString(), isExhausted: false }],
      capturedAt: nowIso
    });
    quotaCache.updateCache({
      email: accounts[2].email,
      models: [{ label: testModel, modelOrTier: 'gemini-3.8-flash', remainingFraction: 0.90, resetTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString(), isExhausted: false }],
      capturedAt: nowIso
    });
    quotaCache.updateCache({
      email: accounts[4].email,
      models: [{ label: testModel, modelOrTier: 'gemini-3.8-flash', remainingFraction: 0.50, resetTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString(), isExhausted: false }],
      capturedAt: nowIso
    });

    await router.onTelemetryUpdated(mockTelemetry);
    const tieBreakStatus = router.getStatus();
    const tieBreakCandidate = tieBreakStatus.targets.antigravity2.recommendedCandidate;
    assert(tieBreakCandidate?.accountEmail === accounts[1].email, `Tie-breaker: Account 2 (Priority 2) selected over Account 3 (Priority 3) at identical 90% quota`);

    console.log('\n--- TEST 6: SYNCED SHADOW MODE PLAN ---');
    router.updateConfig({ mode: 'SYNCED' });
    assert(router.getConfig().mode === 'SYNCED', 'Router updated to SYNCED mode');

    switchCalled = false;
    await router.onTelemetryUpdated(mockTelemetry);

    assert(switchCalled === false, 'Synced shadow mode: ZERO mutations executed');
    const syncedStatus = router.getStatus();
    assert(syncedStatus.targets.antigravity2.shadowPlan !== null, 'Synced shadow mode generated coordinated shadow plan for AG2');
    assert(syncedStatus.targets.ide.shadowPlan !== null, 'Synced shadow mode generated coordinated shadow plan for IDE');

    console.log('\n--- TEST 7: SECRET-FREE EVENTS AND AUDIT LOG ---');
    const recentEvents = statusAfterEval.recentEvents || [];
    assert(recentEvents.length > 0, 'Router recorded events');

    let secretsFound = false;
    for (const ev of recentEvents) {
      const jsonStr = JSON.stringify(ev);
      if (
        jsonStr.includes('mock-non-sensitive-test-token') ||
        jsonStr.includes('password') ||
        jsonStr.includes('bearer') ||
        jsonStr.includes('secret')
      ) {
        secretsFound = true;
        console.error('  FAIL: Found sensitive keyword in event:', jsonStr);
      }
    }
    assert(!secretsFound, 'Zero secrets or credential tokens found in any router event');

    // Check that SHADOW_PLAN_RECORDED event was emitted
    const shadowEvents = recentEvents.filter((e: any) => e.type === 'SHADOW_PLAN_RECORDED');
    assert(shadowEvents.length > 0, `SHADOW_PLAN_RECORDED events successfully emitted (${shadowEvents.length} events)`);

  } catch (err: any) {
    console.error('Unexpected test error:', err);
    passed = false;
  } finally {
    if (fs.existsSync(testDir)) {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  if (passed) {
    console.log('\n>>> PHASE 4J SHADOW ROUTER TEST SUITE: ALL TESTS PASSED <<<\n');
  } else {
    console.error('\n>>> PHASE 4J SHADOW ROUTER TEST SUITE: SOME TESTS FAILED <<<\n');
  }

  return passed;
}

if (require.main === module) {
  runShadowRouterTests().then(success => {
    process.exit(success ? 0 : 1);
  });
}
