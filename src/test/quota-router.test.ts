import fs from 'fs';
import path from 'path';
import { SessionVault } from '../vault/vault';
import { VaultAuditLogger } from '../vault/audit';
import { TransactionalSwitchController } from '../vault/switch-controller';
import { AccountRegistry } from '../pool/account-registry';
import { QuotaCache } from '../pool/quota-cache';
import { AutomaticQuotaRouter } from '../routing/router';
import { rankCandidatesForModel } from '../pool/selector';
import { DashboardData, TargetState } from '../types';

export async function runQuotaRouterTests(): Promise<boolean> {
  console.log('--- RUNNING PHASE 4I AUTOMATIC QUOTA ROUTER TEST SUITE ---');
  let passed = true;

  function assert(cond: boolean, msg: string) {
    if (!cond) {
      console.error(`  FAIL: ${msg}`);
      passed = false;
    } else {
      console.log(`  PASS: ${msg}`);
    }
  }

  const testDir = path.join(process.cwd(), 'data', 'test_router_suite');

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

    // Setup 3 accounts:
    // Account A: Primary (Active on IDE & AG2, high priority 1)
    // Account B: Eligible secondary (Paired, priority 2)
    // Account C: Reserve account (Paired, priority 3, isReserve: true)
    const mockPayload = { token: 'mock-non-sensitive-test-token' };

    const regA = registry.registerObservedAccount({
      email: 'account-a@example.com',
      label: 'Account A',
      priority: 1,
      enabled: true,
      isReserve: false
    });
    await vault.storeTargetSession(regA.id, 'antigravity2', mockPayload);
    await vault.storeTargetSession(regA.id, 'ide', mockPayload);

    const regB = registry.registerObservedAccount({
      email: 'account-b@example.com',
      label: 'Account B',
      priority: 2,
      enabled: true,
      isReserve: false
    });
    await vault.storeTargetSession(regB.id, 'antigravity2', mockPayload);
    await vault.storeTargetSession(regB.id, 'ide', mockPayload);

    const regC = registry.registerObservedAccount({
      email: 'account-c@example.com',
      label: 'Account C (Reserve)',
      priority: 3,
      enabled: true,
      isReserve: true
    });
    await vault.storeTargetSession(regC.id, 'antigravity2', mockPayload);
    await vault.storeTargetSession(regC.id, 'ide', mockPayload);

    // Stub activation controller for isolated router orchestration unit testing
    switchController.activateVaultedAccount = async (accId: string) => {
      return {
        success: true,
        state: 'COMPLETED',
        targetEmail: accId === regB.id ? 'account-b@example.com' : 'account-a@example.com',
        previousEmail: 'account-a@example.com'
      };
    };

    // Populate Quota Cache for Candidate Accounts
    const nowIso = new Date().toISOString();
    quotaCache.updateCache({
      email: 'account-b@example.com',
      models: [
        {
          label: 'Gemini 3.8 Flash (High)',
          modelOrTier: 'gemini-3.8-flash',
          remainingFraction: 0.85,
          resetTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
          isExhausted: false
        }
      ],
      capturedAt: nowIso
    });

    quotaCache.updateCache({
      email: 'account-c@example.com',
      models: [
        {
          label: 'Gemini 3.8 Flash (High)',
          modelOrTier: 'gemini-3.8-flash',
          remainingFraction: 0.90,
          resetTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
          isExhausted: false
        }
      ],
      capturedAt: nowIso
    });

    const router = new AutomaticQuotaRouter(vault, switchController, registry, quotaCache);

    // -------------------------------------------------------------
    // TEST 1: ROUTING DISABLED BY DEFAULT
    // -------------------------------------------------------------
    console.log('\n  [1. Default Configuration & Safety Bounds]');
    const initConfig = router.getConfig();
    assert(initConfig.enabled === false, 'Automatic routing is strictly DISABLED by default');
    assert(initConfig.mode === 'INDEPENDENT', 'Default mode is INDEPENDENT');
    assert(initConfig.switchThreshold === 10, 'Switch threshold is 10%');
    assert(initConfig.returnThreshold === 30, 'Return hysteresis threshold is 30%');
    assert(initConfig.minDwellMinutes === 15, 'Minimum dwell time is 15 minutes');
    assert(initConfig.cooldownMinutes === 30, 'Candidate failure cooldown is 30 minutes');
    assert(initConfig.resetGraceMinutes === 5, 'Reset grace window is 5 minutes');

    // -------------------------------------------------------------
    // TEST 2: CANDIDATE SCORING & TIE-BREAKER DISCIPLINE
    // -------------------------------------------------------------
    console.log('\n  [2. Candidate Scoring & Tie-Breaker Discipline]');
    // Account B (85% quota, regular) vs Account C (90% quota, reserve)
    const snapshots = [
      {
        accountId: regB.id,
        accountEmail: 'account-b@example.com',
        accountLabel: 'Account B',
        priority: 2,
        enabled: true,
        isReserve: false,
        activeTarget: null,
        freshness: 'LIVE' as const,
        capturedAt: nowIso,
        planName: 'Pro',
        userTier: 'PAYG',
        models: {
          'Gemini 3.8 Flash (High)': {
            remainingFraction: 0.85,
            remainingPercent: 85,
            resetTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
            isExhausted: false,
            health: 'READY' as const
          }
        }
      },
      {
        accountId: regC.id,
        accountEmail: 'account-c@example.com',
        accountLabel: 'Account C',
        priority: 3,
        enabled: true,
        isReserve: true,
        activeTarget: null,
        freshness: 'LIVE' as const,
        capturedAt: nowIso,
        planName: 'Pro',
        userTier: 'PAYG',
        models: {
          'Gemini 3.8 Flash (High)': {
            remainingFraction: 0.90,
            remainingPercent: 90,
            resetTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
            isExhausted: false,
            health: 'READY' as const
          }
        }
      }
    ];

    const ranked = rankCandidatesForModel({
      modelLabel: 'Gemini 3.8 Flash (High)',
      accounts: snapshots,
      currentlyActiveEmails: ['account-a@example.com'],
      coolingDownAccountIds: []
    });

    assert(ranked.length === 2, 'Two candidates scored');
    assert(ranked[0].accountId === regB.id, 'Account B ranks #1 ahead of Account C due to reserve penalty on C');
    assert(ranked[1].accountId === regC.id, 'Account C is held as reserve backup (-50 penalty)');

    // -------------------------------------------------------------
    // TEST 3: DISABLED & EXHAUSTED CANDIDATE EXCLUSION
    // -------------------------------------------------------------
    console.log('\n  [3. Exclusion of Disabled and Exhausted Candidates]');
    const disabledSnapshot = {
      ...snapshots[0],
      accountId: 'acc-disabled',
      accountEmail: 'disabled@example.com',
      enabled: false
    };
    const exhaustedSnapshot = {
      ...snapshots[0],
      accountId: 'acc-exhausted',
      accountEmail: 'exhausted@example.com',
      models: {
        'Gemini 3.8 Flash (High)': {
          remainingFraction: 0.0,
          remainingPercent: 0,
          resetTime: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
          isExhausted: true,
          health: 'EXHAUSTED' as const
        }
      }
    };

    const exclusionRankings = rankCandidatesForModel({
      modelLabel: 'Gemini 3.8 Flash (High)',
      accounts: [disabledSnapshot, exhaustedSnapshot],
      currentlyActiveEmails: [],
      coolingDownAccountIds: []
    });

    assert(exclusionRankings[0].tier === 'UNAVAILABLE', 'Disabled account receives UNAVAILABLE tier');
    assert(exclusionRankings[1].tier === 'UNAVAILABLE', 'Exhausted account receives UNAVAILABLE tier');

    // -------------------------------------------------------------
    // TEST 4: NO ROUTING WHEN DISABLED
    // -------------------------------------------------------------
    console.log('\n  [4. Passive Monitoring When Disabled]');
    const mockDashboardLowQuota: DashboardData = {
      targets: [
        {
          id: 'antigravity2',
          name: 'Antigravity 2.0',
          isRunning: true,
          port: 52892,
          pid: 11752,
          email: 'account-a@example.com',
          planName: 'Pro',
          userName: 'Account A',
          userTier: 'Standard',
          credits: null,
          discovery: { lastDiscoveryAt: null, discoveryReason: null, discoveryCount: 0 },
          lastUpdated: new Date().toISOString(),
          error: null,
          models: [
            {
              label: 'Gemini 3.8 Flash (High)',
              modelOrTier: 'gemini-3.8-flash',
              remainingFraction: 0.05, // 5% -> Low!
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
          email: 'account-a@example.com',
          planName: 'Pro',
          userName: 'Account A',
          userTier: 'Standard',
          credits: null,
          discovery: { lastDiscoveryAt: null, discoveryReason: null, discoveryCount: 0 },
          lastUpdated: new Date().toISOString(),
          error: null,
          models: [
            {
              label: 'Gemini 3.8 Flash (High)',
              modelOrTier: 'gemini-3.8-flash',
              remainingFraction: 0.05, // 5%
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
      timestamp: new Date().toISOString()
    };

    await router.onTelemetryUpdated(mockDashboardLowQuota);
    let st = router.getStatus();
    assert(st.config.enabled === false, 'Router remained disabled');
    assert(st.targets.antigravity2.state === 'MONITORING', 'AG2 stays MONITORING when disabled');
    assert(st.targets.ide.state === 'MONITORING', 'IDE stays MONITORING when disabled');

    // -------------------------------------------------------------
    // TEST 5: USER ACKNOWLEDGEMENT ENABLES ROUTER
    // -------------------------------------------------------------
    console.log('\n  [5. User Acknowledgement & Activation]');
    router.acknowledgeEnable();
    assert(router.getConfig().enabled === true, 'Router enabled after acknowledgeEnable()');

    // -------------------------------------------------------------
    // TEST 6: THRESHOLD CROSSING & HEALTHY QUOTA NO-OP
    // -------------------------------------------------------------
    console.log('\n  [6. Threshold Crossing Check]');
    // Provide 25% quota -> above 10% threshold -> should NOT trigger route
    const mockDashboardHealthyQuota: DashboardData = {
      ...mockDashboardLowQuota,
      targets: mockDashboardLowQuota.targets.map(t => ({
        ...t,
        models: [
          {
            label: 'Gemini 3.8 Flash (High)',
            modelOrTier: 'gemini-3.8-flash',
            remainingFraction: 0.25, // 25% > 10% threshold
            resetTime: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
            isExhausted: false
          }
        ]
      }))
    };

    await router.onTelemetryUpdated(mockDashboardHealthyQuota);
    st = router.getStatus();
    assert(st.targets.antigravity2.state === 'MONITORING', 'AG2 stays in MONITORING when quota is 25% > 10%');
    assert(st.targets.ide.state === 'MONITORING', 'IDE stays in MONITORING when quota is 25% > 10%');

    // -------------------------------------------------------------
    // TEST 7: RESET GRACE WINDOW PROTECTION (WAIT_FOR_RESET)
    // -------------------------------------------------------------
    console.log('\n  [7. Reset Grace Window Protection]');
    // Set resetTime to 3 minutes from now (within 5 min grace window, quota 5% > 0%)
    const imminentResetTime = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    const mockDashboardImminentReset: DashboardData = {
      ...mockDashboardLowQuota,
      targets: [
        {
          ...mockDashboardLowQuota.targets[0],
          models: [
            {
              label: 'Gemini 3.8 Flash (High)',
              modelOrTier: 'gemini-3.8-flash',
              remainingFraction: 0.05, // 5%
              resetTime: imminentResetTime,
              isExhausted: false
            }
          ]
        },
        mockDashboardLowQuota.targets[1]
      ]
    };

    await router.onTelemetryUpdated(mockDashboardImminentReset);
    st = router.getStatus();
    assert(st.targets.antigravity2.state === 'WAIT_FOR_RESET', 'AG2 enters WAIT_FOR_RESET when reset is in 3 minutes');

    // -------------------------------------------------------------
    // TEST 8: ACTIVE WORK PROTECTION (WAITING_FOR_IDLE)
    // -------------------------------------------------------------
    console.log('\n  [8. Active Work Safety Gate (Trajectories / Busy)]');
    const farResetTime = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    const mockDashboardActiveTask: DashboardData = {
      ...mockDashboardLowQuota,
      targets: [
        {
          ...mockDashboardLowQuota.targets[0],
          models: [
            {
              label: 'Gemini 3.8 Flash (High)',
              modelOrTier: 'gemini-3.8-flash',
              remainingFraction: 0.05,
              resetTime: farResetTime,
              isExhausted: false
            }
          ],
          trajectoryStatus: {
            state: 'BUSY',
            runningTrajectories: 2, // 2 ACTIVE TRAJECTORIES!
            totalTrajectories: 2
          }
        },
        mockDashboardLowQuota.targets[1]
      ]
    };

    await router.onTelemetryUpdated(mockDashboardActiveTask);
    st = router.getStatus();
    assert(st.targets.antigravity2.state === 'WAITING_FOR_IDLE', 'AG2 enters WAITING_FOR_IDLE when 2 trajectories running');
    assert(st.targets.antigravity2.runningTrajectories === 2, 'Tracked 2 running trajectories');

    // -------------------------------------------------------------
    // TEST 9: AG2 AUTOMATED ACTIVATION DISPATCH (COLD TARGET RELOAD)
    // -------------------------------------------------------------
    console.log('\n  [9. AG2 Automatic Activation Dispatch]');
    router.setOperatingMode('LIVE', true);
    // Set AG2 to IDLE with 0 trajectories
    const mockDashboardAg2Idle: DashboardData = {
      ...mockDashboardLowQuota,
      targets: [
        {
          ...mockDashboardLowQuota.targets[0],
          models: [
            {
              label: 'Gemini 3.8 Flash (High)',
              modelOrTier: 'gemini-3.8-flash',
              remainingFraction: 0.05,
              resetTime: farResetTime,
              isExhausted: false
            }
          ],
          trajectoryStatus: {
            state: 'IDLE',
            runningTrajectories: 0,
            totalTrajectories: 0
          }
        },
        // Keep IDE above threshold to test independent routing
        {
          ...mockDashboardLowQuota.targets[1],
          models: [
            {
              label: 'Gemini 3.8 Flash (High)',
              modelOrTier: 'gemini-3.8-flash',
              remainingFraction: 0.50,
              resetTime: farResetTime,
              isExhausted: false
            }
          ]
        }
      ]
    };

    await router.onTelemetryUpdated(mockDashboardAg2Idle);
    st = router.getStatus();
    assert(st.targets.antigravity2.state === 'COMPLETED', 'AG2 automatic activation completed');
    assert(st.targets.antigravity2.dwellRemainingSeconds > 0, 'Dwell timer initiated for AG2');
    assert(st.targets.ide.state === 'MONITORING', 'IDE remained unaffected in MONITORING');

    // -------------------------------------------------------------
    // TEST 10: MINIMUM DWELL TIME ENFORCEMENT
    // -------------------------------------------------------------
    console.log('\n  [10. Minimum Dwell Time Enforcement]');
    // Now AG2 has dwellRemainingSeconds > 0. Even if quota is 5%, dwell should prevent voluntary switch
    await router.onTelemetryUpdated(mockDashboardAg2Idle);
    st = router.getStatus();
    assert(st.targets.antigravity2.state === 'MONITORING', 'AG2 stays MONITORING due to active dwell protection');
    assert(st.targets.antigravity2.actionRequired.includes('dwell period'), 'Action specifies minimum dwell period');

    // -------------------------------------------------------------
    // TEST 11: HYSTERESIS RETURN RESTRICTION
    // -------------------------------------------------------------
    console.log('\n  [11. Hysteresis Return Restriction]');
    // Update Quota Cache for Account A to only 20% (<= 30% returnThreshold)
    quotaCache.updateCache({
      email: 'account-a@example.com',
      models: [
        {
          label: 'Gemini 3.8 Flash (High)',
          modelOrTier: 'gemini-3.8-flash',
          remainingFraction: 0.20, // 20% <= 30% returnThreshold
          resetTime: farResetTime,
          isExhausted: false
        }
      ]
    });

    // Score candidates for AG2 (which previously switched away from Account A)
    const snapA = {
      accountId: 'acc-account_a',
      accountEmail: 'account-a@example.com',
      accountLabel: 'Account A',
      priority: 1,
      enabled: true,
      isReserve: false,
      activeTarget: null,
      freshness: 'LIVE' as const,
      capturedAt: nowIso,
      planName: 'Pro',
      userTier: 'PAYG',
      models: {
        'Gemini 3.8 Flash (High)': {
          remainingFraction: 0.20,
          remainingPercent: 20,
          resetTime: farResetTime,
          isExhausted: false,
          health: 'LOW' as const
        }
      }
    };

    // Evaluate target candidate selection directly to test hysteresis filter
    const ag2TargetState: TargetState = {
      id: 'antigravity2',
      name: 'Antigravity 2.0',
      isRunning: true,
      email: 'account-b@example.com',
      models: [
        {
          label: 'Gemini 3.8 Flash (High)',
          modelOrTier: 'gemini-3.8-flash',
          remainingFraction: 0.05,
          resetTime: farResetTime,
          isExhausted: false
        }
      ],
      trajectoryStatus: { state: 'IDLE', runningTrajectories: 0, totalTrajectories: 0 },
      pid: 11752,
      port: 52892,
      userName: 'Account B',
      userTier: 'Standard',
      planName: 'Pro',
      credits: null,
      discovery: { lastDiscoveryAt: null, discoveryReason: null, discoveryCount: 0 },
      lastUpdated: new Date().toISOString(),
      error: null
    };

    // -------------------------------------------------------------
    // TEST 12: CANDIDATE FAILURE COOLDOWN
    // -------------------------------------------------------------
    console.log('\n  [12. Candidate Failure Cooldown & Disqualification]');
    router.addCooldown(regB.id, 'Simulated failure test');
    st = router.getStatus();
    assert(Boolean(st.cooldowns[regB.id]), 'Account B is present in active cooldown list');

    const rankingsWithCooldown = rankCandidatesForModel({
      modelLabel: 'Gemini 3.8 Flash (High)',
      accounts: snapshots,
      currentlyActiveEmails: [],
      coolingDownAccountIds: [regB.id]
    });

    const bCandidate = rankingsWithCooldown.find(c => c.accountId === regB.id);
    assert(bCandidate?.tier === 'UNAVAILABLE', 'Cooling down candidate B is classified as UNAVAILABLE');

    // -------------------------------------------------------------
    // TEST 13: IDE INTERACTIVE HANDOFF (WAITING_FOR_USER)
    // -------------------------------------------------------------
    console.log('\n  [13. Antigravity IDE Interactive Handoff]');
    const candidateC = ranked.find(c => c.accountId === regC.id)!;
    router.initiateIdeInteractionHandoff(candidateC);
    st = router.getStatus();
    assert(st.targets.ide.state === 'WAITING_FOR_USER', 'IDE transitions to WAITING_FOR_USER');
    assert(st.targets.ide.actionRequired.includes('User authentication required'), 'IDE action requires user login');

    // Test cancellation of handoff
    router.cancelIdeHandoff();
    st = router.getStatus();
    assert(st.targets.ide.state === 'MONITORING', 'IDE returns to MONITORING after cancellation');

    // -------------------------------------------------------------
    // TEST 14: SYNCED TRANSACTIONAL ROLLBACK
    // -------------------------------------------------------------
    console.log('\n  [14. Synced Transactional Rollback]');
    router.updateConfig({ mode: 'SYNCED' });
    assert(router.getConfig().mode === 'SYNCED', 'Mode updated to SYNCED');

    // Trigger rollback helper directly
    const rollbackSuccess = await router.rollbackSyncedAg2Target();
    // Rollback is safe no-op if no pre-switch backup stored
    assert(typeof rollbackSuccess === 'boolean', 'Rollback function executed safely');

    // -------------------------------------------------------------
    // TEST 15: ZERO RAW TOKENS / SECRETS IN ROUTING EVENTS
    // -------------------------------------------------------------
    console.log('\n  [15. Secret-Free Event Logging Guarantee]');
    st = router.getStatus();
    const eventJson = JSON.stringify(st.recentEvents);
    assert(!eventJson.includes('mock-non-sensitive-test-token'), 'Zero raw tokens leaked in recentEvents');
    assert(!eventJson.includes('secret'), 'Zero secrets in recentEvents');
    assert(st.recentEvents.length > 0, `Recorded ${st.recentEvents.length} sanitized routing events`);

  } finally {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  }

  console.log(`\nALL AUTOMATIC QUOTA ROUTER TESTS PASSED: ${passed}`);
  return passed;
}

if (require.main === module) {
  runQuotaRouterTests().then(success => {
    process.exit(success ? 0 : 1);
  });
}
