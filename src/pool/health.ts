import { AccountHealthState } from './types';

export const HEALTH_THRESHOLDS = {
  READY_MIN: 0.25,     // > 25%
  LOW_MIN: 0.10,       // <= 25% and > 10%
  CRITICAL_MIN: 0.05,  // <= 10% and > 5%
  RESERVE_MIN: 0.00    // <= 5% and > 0%
  // <= 0% or isExhausted: EXHAUSTED
};

/**
 * Calculates health state for an account model quota.
 * Health is strictly informational and does not trigger automatic switching.
 */
export function evaluateHealthState(remainingFraction: number | null | undefined, isExhausted: boolean = false): AccountHealthState {
  if (isExhausted) {
    return 'EXHAUSTED';
  }

  if (remainingFraction === null || remainingFraction === undefined || isNaN(remainingFraction) || remainingFraction <= 0.0001) {
    return 'EXHAUSTED';
  }

  if (remainingFraction <= HEALTH_THRESHOLDS.CRITICAL_MIN) {
    return remainingFraction <= 0 ? 'EXHAUSTED' : 'RESERVE';
  }

  if (remainingFraction <= HEALTH_THRESHOLDS.LOW_MIN) {
    return 'CRITICAL';
  }

  if (remainingFraction <= HEALTH_THRESHOLDS.READY_MIN) {
    return 'LOW';
  }

  return 'READY';
}

/**
 * Returns a sort weight for health states (READY highest, EXHAUSTED lowest).
 */
export function getHealthPriorityWeight(health: AccountHealthState): number {
  switch (health) {
    case 'READY': return 5;
    case 'LOW': return 4;
    case 'CRITICAL': return 3;
    case 'RESERVE': return 2;
    case 'EXHAUSTED': return 1;
    default: return 0;
  }
}
