import { calculateAggregates } from '../aggregate/calculator';
import { TargetState } from '../types';

export function runAggregateTests(): boolean {
  console.log('--- RUNNING AGGREGATE TESTS (V1.1 HARDENED) ---');
  let passed = true;

  function assert(condition: boolean, msg: string) {
    if (!condition) {
      console.error(`  FAIL: ${msg}`);
      passed = false;
    } else {
      console.log(`  PASS: ${msg}`);
    }
  }

  // Test 1: Segregated resource classes across 2 active targets
  const mockTargets: TargetState[] = [
    {
      id: 'ide',
      name: 'Antigravity IDE',
      isRunning: true,
      pid: 1001,
      port: 61088,
      email: 'account-a@test.com',
      userName: 'User A',
      userTier: 'Pro',
      planName: 'Pro',
      credits: {
        monthlyPromptCredits: 50000,
        availablePromptCredits: 500,
        computedUsedPromptCredits: 49500,
        monthlyFlowCredits: 150000,
        availableFlowCredits: 100,
        computedUsedFlowCredits: 149900
      },
      models: [
        { label: 'Gemini 3.8 Flash', modelOrTier: 'flash', remainingFraction: 0.95, resetTime: '', isExhausted: false }
      ],
      trajectoryStatus: { totalTrajectories: 1, runningTrajectories: 0, state: 'IDLE' },
      discovery: { lastDiscoveryAt: '', discoveryReason: 'Initial', discoveryCount: 1 },
      lastUpdated: '',
      error: null
    },
    {
      id: 'antigravity2',
      name: 'Antigravity 2.0',
      isRunning: true,
      pid: 1002,
      port: 52417,
      email: 'account-b@test.com',
      userName: 'User B',
      userTier: 'Pro',
      planName: 'Pro',
      credits: {
        monthlyPromptCredits: 50000,
        availablePromptCredits: 1500,
        computedUsedPromptCredits: 48500,
        monthlyFlowCredits: 150000,
        availableFlowCredits: 200,
        computedUsedFlowCredits: 149800
      },
      models: [
        { label: 'Gemini 3.8 Flash', modelOrTier: 'flash', remainingFraction: 0.80, resetTime: '', isExhausted: false }
      ],
      trajectoryStatus: { totalTrajectories: 2, runningTrajectories: 1, state: 'BUSY' },
      discovery: { lastDiscoveryAt: '', discoveryReason: 'Initial', discoveryCount: 1 },
      lastUpdated: '',
      error: null
    }
  ];

  const agg = calculateAggregates(mockTargets);

  // Prompt Pool assertions
  assert(agg.prompt.monthly === 100000, 'Prompt pool monthly correctly sums 50k + 50k = 100k');
  assert(agg.prompt.available === 2000, 'Prompt pool available correctly sums 500 + 1500 = 2000');
  assert(agg.prompt.computedUsed === 98000, 'Prompt pool computedUsed correctly computes 100k - 2k = 98k');

  // Flow Pool assertions
  assert(agg.flow.monthly === 300000, 'Flow pool monthly correctly sums 150k + 150k = 300k');
  assert(agg.flow.available === 300, 'Flow pool available correctly sums 100 + 200 = 300');
  assert(agg.flow.computedUsed === 299700, 'Flow pool computedUsed correctly computes 300k - 300 = 299700');

  // Strict Segregation assertions: No generic combined balance!
  assert(!('combinedAvailable' in (agg as any)), 'Combined Available Balance is strictly removed');
  assert(!('totalAvailable' in (agg as any)), 'No generic combined totalAvailable balance exists');
  assert(!('totalRemainingFraction' in (agg as any)), 'Aggregated object strictly contains NO model percentage arithmetic');

  // Test 2: Inactive target is excluded
  const targetsWithOneStopped: TargetState[] = [
    mockTargets[0],
    { ...mockTargets[1], isRunning: false, credits: null }
  ];

  const aggStopped = calculateAggregates(targetsWithOneStopped);
  assert(aggStopped.prompt.monthly === 50000, 'Inactive target excluded from prompt monthly');
  assert(aggStopped.prompt.available === 500, 'Inactive target excluded from prompt available');
  assert(aggStopped.prompt.computedUsed === 49500, 'Inactive target excluded from prompt computedUsed');

  return passed;
}
