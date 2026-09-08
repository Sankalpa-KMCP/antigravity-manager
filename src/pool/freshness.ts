import { FreshnessState } from './types';

export const FRESHNESS_THRESHOLDS = {
  LIVE_MS: 30 * 1000,       // 30 seconds
  FRESH_MS: 5 * 60 * 1000   // 5 minutes
};

/**
 * Evaluates data freshness based on UTC timestamp.
 * - LIVE:    <= 30 sec
 * - FRESH:   <= 5 min
 * - STALE:   > 5 min
 * - UNKNOWN: never observed / invalid date
 */
export function evaluateFreshness(capturedAt: string | null | undefined, nowMs: number = Date.now()): FreshnessState {
  if (!capturedAt) {
    return 'UNKNOWN';
  }

  const capturedTime = new Date(capturedAt).getTime();
  if (isNaN(capturedTime) || capturedTime <= 0) {
    return 'UNKNOWN';
  }

  const ageMs = nowMs - capturedTime;
  if (ageMs < 0) {
    // In case of slight clock skew, treat as LIVE
    return 'LIVE';
  }

  if (ageMs <= FRESHNESS_THRESHOLDS.LIVE_MS) {
    return 'LIVE';
  }

  if (ageMs <= FRESHNESS_THRESHOLDS.FRESH_MS) {
    return 'FRESH';
  }

  return 'STALE';
}
