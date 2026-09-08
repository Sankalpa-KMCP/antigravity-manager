import { AggregatedCredits, TargetState } from '../types';

/**
 * Safely aggregate credits across active targets into distinct resource pools.
 *
 * RULES:
 * 1. PROMPT credits and FLOW credits are separate resource classes and MUST NEVER be combined.
 * 2. "Combined Available Balance" is STRICTLY PROHIBITED.
 * 3. Total Computed Used = Total Monthly - Total Available (clamped >= 0).
 * 4. Model remainingFraction percentages are NEVER summed or averaged across accounts.
 */
export function calculateAggregates(targets: TargetState[]): AggregatedCredits {
  let promptMonthly = 0;
  let promptAvailable = 0;
  let flowMonthly = 0;
  let flowAvailable = 0;

  for (const target of targets) {
    if (target.isRunning && target.credits) {
      promptMonthly += target.credits.monthlyPromptCredits;
      promptAvailable += target.credits.availablePromptCredits;
      flowMonthly += target.credits.monthlyFlowCredits;
      flowAvailable += target.credits.availableFlowCredits;
    }
  }

  const promptComputedUsed = Math.max(0, promptMonthly - promptAvailable);
  const flowComputedUsed = Math.max(0, flowMonthly - flowAvailable);

  return {
    prompt: {
      monthly: promptMonthly,
      available: promptAvailable,
      computedUsed: promptComputedUsed
    },
    flow: {
      monthly: flowMonthly,
      available: flowAvailable,
      computedUsed: flowComputedUsed
    }
  };
}
