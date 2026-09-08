import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { 
  AccountRegistry, 
  QuotaCache, 
  evaluateFreshness, 
  evaluateHealthState, 
  calculatePoolData, 
  rankCandidatesForModel, 
  PoolEventManager,
  arePlansCompatible,
  normalizeEmail
} from '../pool';

export async function runPoolEngineTests(): Promise<void> {
  console.log('\n--- RUNNING MULTI-ACCOUNT POOL & ENGINE TESTS (PHASE 4A) ---');

  const testDir = path.join(__dirname, '..', '..', 'data', 'test-pool');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  const accountsTestFile = path.join(testDir, 'accounts.test.json');
  const quotaTestFile = path.join(testDir, 'quota-cache.test.json');

  if (fs.existsSync(accountsTestFile)) fs.unlinkSync(accountsTestFile);
  if (fs.existsSync(quotaTestFile)) fs.unlinkSync(quotaTestFile);

  // =========================================================================
  // 1. Account Discovery, Email Normalization, and 7+ Accounts
  // =========================================================================
  const registry = new AccountRegistry(accountsTestFile);

  // Test 1a: Duplicate email normalization
  const acc1 = registry.registerObservedAccount({
    email: '  Test.User1@Example.com  ',
    targetId: 'ide',
    userName: 'User One',
    priority: 1
  });
  assert.strictEqual(acc1.email, 'test.user1@example.com', 'Email must be normalized to lowercase and trimmed');
  console.log('  PASS: Email address normalized to lowercase and trimmed');

  // Upserting with different case / whitespace must update, not duplicate
  const acc1Updated = registry.registerObservedAccount({
    email: 'TEST.USER1@EXAMPLE.COM',
    userName: 'User One Updated'
  });
  assert.strictEqual(registry.size(), 1, 'Registry size must remain 1 on normalized email match');
  assert.strictEqual(acc1Updated.priority, 1, 'Configured priority must be strictly preserved');
  console.log('  PASS: Existing user priority preserved on re-discovery');

  // Test 1b: Support 7+ registered provider-approved accounts
  const sampleEmails = [
    'account.alpha@gmail.com',
    'account.beta@gmail.com',
    'account.gamma@gmail.com',
    'account.delta@gmail.com',
    'account.epsilon@gmail.com',
    'account.zeta@gmail.com',
    'account.eta@gmail.com',
    'account.theta@gmail.com'
  ];

  sampleEmails.forEach((email, idx) => {
    registry.upsertAccount({
      email,
      label: `Account ${idx + 2}`,
      priority: idx + 2,
      enabled: idx !== 6 // Account Eta (index 6) disabled for testing
    });
  });

  assert.strictEqual(registry.size(), 9, 'Registry must support 7+ accounts (9 registered)');
  console.log('  PASS: 7+ registered accounts supported in registry (9 accounts stored)');

  // Test 1c: Fixed ordering (priority ascending, then ID)
  const allAccounts = registry.getAllAccounts();
  for (let i = 0; i < allAccounts.length - 1; i++) {
    assert.ok(allAccounts[i].priority <= allAccounts[i + 1].priority, 'Accounts must sort by priority ascending');
  }
  console.log('  PASS: Registry returns accounts in fixed priority sequence');

  // Test 1d: Zero credentials stored
  registry.flush();
  const rawAccountsJson = fs.readFileSync(accountsTestFile, 'utf8');
  assert.strictEqual(rawAccountsJson.includes('token'), false, 'Registry JSON must contain zero token fields');
  assert.strictEqual(rawAccountsJson.includes('password'), false, 'Registry JSON must contain zero password fields');
  assert.strictEqual(rawAccountsJson.includes('secret'), false, 'Registry JSON must contain zero secret fields');
  console.log('  PASS: Zero credential/secret fields in accounts.json');

  // =========================================================================
  // 2. Quota Cache Persistence & Freshness States
  // =========================================================================
  const quotaCache = new QuotaCache(quotaTestFile);

  const mockModels = [
    { label: 'Gemini 3.8 Flash (High)', modelOrTier: '', remainingFraction: 0.82, resetTime: '2026-09-08T15:00:00Z', isExhausted: false },
    { label: 'Gemini 3.8 Flash (Low)', modelOrTier: '', remainingFraction: 0.82, resetTime: '2026-09-08T15:00:00Z', isExhausted: false }, // Should be filtered out
    { label: 'Gemini 3.1 Pro (High)', modelOrTier: '', remainingFraction: 0.65, resetTime: '2026-09-08T15:00:00Z', isExhausted: false },
    { label: 'Gemini 3.7 Flash (High)', modelOrTier: '', remainingFraction: 0.45, resetTime: '2026-09-08T15:00:00Z', isExhausted: false },
    { label: 'Gemini 3.6 Flash (High)', modelOrTier: '', remainingFraction: 0.15, resetTime: '2026-09-08T15:00:00Z', isExhausted: false },
    { label: 'Claude Sonnet 4.6 (Thinking)', modelOrTier: '', remainingFraction: 0.08, resetTime: '2026-09-08T15:00:00Z', isExhausted: false },
    { label: 'Claude Opus 4.6 (Thinking)', modelOrTier: '', remainingFraction: 0.00, resetTime: '2026-09-08T15:00:00Z', isExhausted: true }
  ];

  const nowMs = Date.now();
  quotaCache.updateCache({
    email: 'test.user1@example.com',
    planName: 'Google AI Pro',
    userTier: 'Pro',
    credits: {
      monthlyPromptCredits: 50000,
      availablePromptCredits: 500,
      computedUsedPromptCredits: 49500,
      monthlyFlowCredits: 150000,
      availableFlowCredits: 100,
      computedUsedFlowCredits: 149900
    },
    models: mockModels,
    capturedAt: new Date(nowMs - 10 * 1000).toISOString() // 10s ago -> LIVE
  });

  const cachedAcc1 = quotaCache.getQuota('test.user1@example.com', nowMs);
  assert.ok(cachedAcc1, 'Cached quota entry must be retrievable');
  assert.strictEqual(cachedAcc1.models.length, 6, 'Only 6 filtered High/Thinking models must be cached (Low ignored)');
  assert.strictEqual(cachedAcc1.freshness, 'LIVE', 'Captured <= 30s ago must be evaluated as LIVE');
  console.log('  PASS: Filtered model cache persisted with LIVE freshness');

  // Test Freshness Transitions
  assert.strictEqual(evaluateFreshness(new Date(nowMs - 20 * 1000).toISOString(), nowMs), 'LIVE', '<= 30s is LIVE');
  assert.strictEqual(evaluateFreshness(new Date(nowMs - 120 * 1000).toISOString(), nowMs), 'FRESH', '<= 5m is FRESH');
  assert.strictEqual(evaluateFreshness(new Date(nowMs - 360 * 1000).toISOString(), nowMs), 'STALE', '> 5m is STALE');
  assert.strictEqual(evaluateFreshness(null, nowMs), 'UNKNOWN', 'Null timestamp is UNKNOWN');
  console.log('  PASS: LIVE, FRESH, STALE, and UNKNOWN freshness states verified');

  // Verify Zero credentials in quota-cache.json
  quotaCache.flush();
  const rawQuotaJson = fs.readFileSync(quotaTestFile, 'utf8');
  assert.strictEqual(rawQuotaJson.includes('token'), false, 'Quota cache JSON must contain zero token fields');
  assert.strictEqual(rawQuotaJson.includes('password'), false, 'Quota cache JSON must contain zero password fields');
  console.log('  PASS: Zero credential/secret fields in quota-cache.json');

  // Populate quotas for other accounts
  quotaCache.updateCache({
    email: 'account.alpha@gmail.com',
    planName: 'Google AI Pro',
    userTier: 'Pro',
    credits: {
      monthlyPromptCredits: 50000,
      availablePromptCredits: 1200,
      computedUsedPromptCredits: 48800,
      monthlyFlowCredits: 150000,
      availableFlowCredits: 250,
      computedUsedFlowCredits: 149750
    },
    models: [
      { label: 'Gemini 3.8 Flash (High)', modelOrTier: '', remainingFraction: 0.95, resetTime: '2026-09-08T16:00:00Z', isExhausted: false },
      { label: 'Claude Sonnet 4.6 (Thinking)', modelOrTier: '', remainingFraction: 0.90, resetTime: '2026-09-08T16:00:00Z', isExhausted: false }
    ],
    capturedAt: new Date(nowMs - 60 * 1000).toISOString() // 1m ago -> FRESH
  });

  // =========================================================================
  // 3. Health State Thresholds
  // =========================================================================
  assert.strictEqual(evaluateHealthState(0.85, false), 'READY', '> 25% is READY');
  assert.strictEqual(evaluateHealthState(0.25, false), 'LOW', '<= 25% and > 10% is LOW');
  assert.strictEqual(evaluateHealthState(0.10, false), 'CRITICAL', '<= 10% and > 5% is CRITICAL');
  assert.strictEqual(evaluateHealthState(0.04, false), 'RESERVE', '<= 5% and > 0% is RESERVE');
  assert.strictEqual(evaluateHealthState(0.00, false), 'EXHAUSTED', '<= 0% is EXHAUSTED');
  assert.strictEqual(evaluateHealthState(0.85, true), 'EXHAUSTED', 'isExhausted=true is EXHAUSTED regardless of fraction');
  console.log('  PASS: READY, LOW, CRITICAL, RESERVE, and EXHAUSTED health thresholds verified');

  // =========================================================================
  // 4. Compatible Credit Aggregation & Pool Engine Calculations
  // =========================================================================
  assert.strictEqual(arePlansCompatible('Google AI Pro', 'Pro'), true, 'Google AI Pro and Pro must be compatible');
  assert.strictEqual(arePlansCompatible('Custom Enterprise', 'Standard Free'), false, 'Incompatible plans must be detected');
  console.log('  PASS: Plan unit compatibility evaluated correctly');

  const poolCalc = calculatePoolData(registry, quotaCache, nowMs);
  assert.strictEqual(poolCalc.accounts.length, 9, 'All 9 registered accounts must be present in snapshot');
  assert.strictEqual(poolCalc.poolSummary.promptPool.isUnitCompatible, true, 'Prompt pool marked compatible');
  assert.strictEqual(poolCalc.poolSummary.promptPool.monthly, 100000, 'Sum of compatible monthly prompt credits: 50k + 50k = 100k');
  assert.strictEqual(poolCalc.poolSummary.promptPool.available, 1700, 'Sum of compatible available prompt credits: 500 + 1200 = 1700');
  console.log('  PASS: Compatible prompt and flow credit pools correctly aggregated');

  // Model statistics
  const g38Stats = poolCalc.modelStats['Gemini 3.8 Flash (High)'];
  assert.ok(g38Stats, 'Model stats for Gemini 3.8 Flash (High) must exist');
  assert.ok(g38Stats.isEquivalenceEstablished, 'Capacity equivalence flag set');
  assert.strictEqual(typeof g38Stats.averageRemainingPercent, 'number', 'Derived average remaining percent is numeric');
  assert.strictEqual(typeof g38Stats.totalEquivalentCapacityRemaining, 'number', 'Total equivalent capacity is numeric');
  console.log('  PASS: Model pool statistics computed with explicit derived metric notices');

  // =========================================================================
  // 5. Deterministic Candidate Scoring & Tier Selection
  // =========================================================================
  const rankings = rankCandidatesForModel({
    modelLabel: 'Gemini 3.8 Flash (High)',
    accounts: poolCalc.accounts,
    currentlyActiveEmails: ['test.user1@example.com'], // active target penalty
    nowMs
  });

  assert.ok(rankings.length > 0, 'Rankings must return evaluated candidates');

  // Top candidate should be account.alpha (0.95 fraction, not active on target)
  const bestCandidate = rankings[0];
  assert.strictEqual(bestCandidate.tier, 'BEST_CANDIDATE', 'Top candidate assigned BEST_CANDIDATE tier');
  assert.strictEqual(bestCandidate.accountEmail, 'account.alpha@gmail.com', 'account.alpha with 95% quota ranked best');
  console.log('  PASS: Deterministic scoring selected #1 Best Candidate (account.alpha: 95%)');

  // Disabled account exclusion (account.eta was registered with enabled: false)
  const disabledCandidate = rankings.find(r => r.accountEmail === 'account.eta@gmail.com');
  assert.ok(disabledCandidate, 'Disabled candidate evaluated in rankings');
  assert.strictEqual(disabledCandidate.tier, 'UNAVAILABLE', 'Disabled account must be assigned UNAVAILABLE tier');
  console.log('  PASS: Disabled accounts strictly assigned UNAVAILABLE tier');

  // Exhausted model tier check
  const opusRankings = rankCandidatesForModel({
    modelLabel: 'Claude Opus 4.6 (Thinking)',
    accounts: poolCalc.accounts,
    nowMs
  });
  const exhaustedCandidate = opusRankings.find(r => r.accountEmail === 'test.user1@example.com');
  assert.strictEqual(exhaustedCandidate?.tier, 'UNAVAILABLE', 'Exhausted model account assigned UNAVAILABLE');
  console.log('  PASS: Exhausted accounts strictly assigned UNAVAILABLE tier');

  // Stale data penalty
  quotaCache.updateCache({
    email: 'account.beta@gmail.com',
    planName: 'Google AI Pro',
    models: [{ label: 'Gemini 3.8 Flash (High)', modelOrTier: '', remainingFraction: 0.95, resetTime: '', isExhausted: false }],
    capturedAt: new Date(nowMs - 400 * 1000).toISOString() // > 5m -> STALE
  });
  const updatedCalc = calculatePoolData(registry, quotaCache, nowMs);
  const updatedRankings = rankCandidatesForModel({
    modelLabel: 'Gemini 3.8 Flash (High)',
    accounts: updatedCalc.accounts,
    nowMs
  });
  const freshCandidate = updatedRankings.find(r => r.accountEmail === 'account.alpha@gmail.com')!;
  const staleCandidate = updatedRankings.find(r => r.accountEmail === 'account.beta@gmail.com')!;
  assert.ok(freshCandidate.score > staleCandidate.score, 'FRESH account must score higher than STALE account with identical quota');
  console.log('  PASS: Stale data receives score penalty compared to fresh data');

  // =========================================================================
  // 6. Event Generation & Deduplication
  // =========================================================================
  const eventManager = new PoolEventManager();

  // Trigger initial evaluation (first observation sets baseline)
  eventManager.evaluateTransitions({
    accounts: updatedCalc.accounts,
    bestCandidates: { 'Gemini 3.8 Flash (High)': bestCandidate },
    nowMs
  });

  // Simulate health drop to LOW (e.g. 20%)
  const dropSnapshots = updatedCalc.accounts.map(acc => {
    if (acc.accountEmail === 'account.alpha@gmail.com') {
      return {
        ...acc,
        models: {
          ...acc.models,
          'Gemini 3.8 Flash (High)': {
            remainingFraction: 0.20,
            remainingPercent: 20,
            health: 'LOW' as const
          }
        }
      };
    }
    return acc;
  });

  const emittedEvents = eventManager.evaluateTransitions({
    accounts: dropSnapshots,
    bestCandidates: { 'Gemini 3.8 Flash (High)': bestCandidate },
    nowMs: nowMs + 1000
  });

  assert.ok(emittedEvents.some(e => e.type === 'ACCOUNT_LOW'), 'ACCOUNT_LOW event must be emitted on READY -> LOW transition');
  console.log('  PASS: ACCOUNT_LOW event emitted on state transition');

  // Deduplication check: repeated evaluation during cooldown should NOT emit duplicate
  const repeatEvents = eventManager.evaluateTransitions({
    accounts: dropSnapshots,
    bestCandidates: { 'Gemini 3.8 Flash (High)': bestCandidate },
    nowMs: nowMs + 2000
  });
  assert.strictEqual(repeatEvents.filter(e => e.type === 'ACCOUNT_LOW').length, 0, 'Duplicate ACCOUNT_LOW event must be suppressed by cooldown');
  console.log('  PASS: Duplicate events suppressed during cooldown period');

  // Cleanup test files
  registry.flush();
  quotaCache.flush();
  try {
    if (fs.existsSync(accountsTestFile)) fs.unlinkSync(accountsTestFile);
    if (fs.existsSync(quotaTestFile)) fs.unlinkSync(quotaTestFile);
    fs.rmdirSync(testDir);
  } catch (_) {}

  console.log('--- ALL MULTI-ACCOUNT POOL & ENGINE UNIT TESTS PASSED ---\n');
}
