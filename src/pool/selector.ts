import { AccountModelSnapshot, CandidateScore, CandidateTier } from './types';

export interface ScoreCandidateOptions {
  modelLabel: string;
  accounts: AccountModelSnapshot[];
  currentlyActiveEmails?: string[];
  coolingDownAccountIds?: string[];
  nowMs?: number;
}

/**
 * Deterministically ranks accounts for a specific model quota based on:
 * Quota Health > Freshness > Account Validity > Reset Timing > Recent Failures > Reserve Status > Manual Priority.
 * Manual priority acts strictly as a tie-breaker when scores are near-equal.
 *
 * Formula:
 * score = quotaScore + freshnessScore + resetAdvantage - failurePenalty - recentUsePenalty - reservePenalty
 */
export function rankCandidatesForModel(options: ScoreCandidateOptions): CandidateScore[] {
  const {
    modelLabel,
    accounts,
    currentlyActiveEmails = [],
    coolingDownAccountIds = [],
    nowMs = Date.now()
  } = options;

  const results: CandidateScore[] = [];

  for (const acc of accounts) {
    const reasons: string[] = [];
    const modelData = acc.models[modelLabel];

    // Check 1: Enabled state (Account Validity)
    if (!acc.enabled) {
      results.push({
        accountId: acc.accountId,
        accountEmail: acc.accountEmail,
        accountLabel: acc.accountLabel,
        modelLabel,
        score: -1000,
        tier: 'UNAVAILABLE',
        health: 'EXHAUSTED',
        freshness: acc.freshness,
        remainingFraction: 0,
        remainingPercent: 0,
        resetTime: '',
        priority: acc.priority,
        reasons: ['Account is disabled by configuration (-1000)']
      });
      continue;
    }

    // Check 2: Known telemetry (Account Validity)
    if (!modelData || acc.freshness === 'UNKNOWN') {
      results.push({
        accountId: acc.accountId,
        accountEmail: acc.accountEmail,
        accountLabel: acc.accountLabel,
        modelLabel,
        score: -500,
        tier: 'UNAVAILABLE',
        health: 'EXHAUSTED',
        freshness: 'UNKNOWN',
        remainingFraction: 0,
        remainingPercent: 0,
        resetTime: '',
        priority: acc.priority,
        reasons: ['No quota telemetry ever recorded (UNKNOWN) (-500)']
      });
      continue;
    }

    const { remainingFraction, remainingPercent, resetTime, isExhausted, health } = modelData;

    // Check 3: Exhaustion (Quota Health)
    if (isExhausted || remainingFraction <= 0.0001) {
      results.push({
        accountId: acc.accountId,
        accountEmail: acc.accountEmail,
        accountLabel: acc.accountLabel,
        modelLabel,
        score: 0,
        tier: 'UNAVAILABLE',
        health: 'EXHAUSTED',
        freshness: acc.freshness,
        remainingFraction: 0,
        remainingPercent: 0,
        resetTime,
        priority: acc.priority,
        reasons: ['Quota is exhausted for this model (0)']
      });
      continue;
    }

    // 1. quotaScore: remainingFraction * 80 + tier bonus/penalty
    let quotaScore = remainingFraction * 80;
    if (remainingPercent > 25) {
      quotaScore += 10; // READY bonus
      reasons.push(`Quota READY: ${remainingPercent}% (+${quotaScore.toFixed(1)})`);
    } else if (remainingPercent > 10) {
      reasons.push(`Quota LOW: ${remainingPercent}% (+${quotaScore.toFixed(1)})`);
    } else if (remainingPercent > 5) {
      quotaScore -= 15;
      reasons.push(`Quota CRITICAL: ${remainingPercent}% (-15) (+${quotaScore.toFixed(1)})`);
    } else {
      quotaScore -= 35;
      reasons.push(`Quota RESERVE: ${remainingPercent}% (-35) (+${quotaScore.toFixed(1)})`);
    }

    // 2. freshnessScore
    let freshnessScore = 0;
    if (acc.freshness === 'LIVE') {
      freshnessScore = 10;
      reasons.push('Data is LIVE (<= 30s) (+10)');
    } else if (acc.freshness === 'FRESH') {
      freshnessScore = 5;
      reasons.push('Data is FRESH (<= 5m) (+5)');
    } else if (acc.freshness === 'STALE') {
      freshnessScore = -25;
      reasons.push('Data is STALE (> 5m) (-25 penalty)');
    } else {
      freshnessScore = -100;
      reasons.push('Data is UNKNOWN (-100 penalty)');
    }

    // 3. resetAdvantage
    let resetAdvantage = 0;
    if (resetTime) {
      const resetMs = new Date(resetTime).getTime();
      const diffMin = (resetMs - nowMs) / (60 * 1000);
      if (diffMin > 0 && diffMin <= 30) {
        resetAdvantage = 5;
        reasons.push(`Reset approaching in ${Math.round(diffMin)}m (+5)`);
      }
    }

    // 4. failurePenalty (Recent failures / cooldown)
    let failurePenalty = 0;
    const isCoolingDown = coolingDownAccountIds.includes(acc.accountId);
    if (isCoolingDown) {
      failurePenalty = 100;
      reasons.push('Account in failure cooldown (-100)');
    }

    // 5. recentUsePenalty (Encourage load distribution across targets)
    let recentUsePenalty = 0;
    if (currentlyActiveEmails.includes(acc.accountEmail)) {
      recentUsePenalty = 10;
      reasons.push('Currently active on running target (-10)');
    }

    // 6. reservePenalty (Hold reserve accounts for failover)
    let reservePenalty = 0;
    if (acc.isReserve) {
      reservePenalty = 50;
      reasons.push('Account marked as RESERVE (-50)');
    }

    // Final mathematical score
    const totalScore = quotaScore + freshnessScore + resetAdvantage - failurePenalty - recentUsePenalty - reservePenalty;
    const finalTier: CandidateTier = isCoolingDown || totalScore <= 0 ? 'UNAVAILABLE' : 'SECONDARY';

    results.push({
      accountId: acc.accountId,
      accountEmail: acc.accountEmail,
      accountLabel: acc.accountLabel,
      modelLabel,
      score: Number(totalScore.toFixed(2)),
      tier: finalTier,
      health,
      freshness: acc.freshness,
      remainingFraction,
      remainingPercent,
      resetTime,
      priority: acc.priority,
      reasons
    });
  }

  // Deterministic sorting with near-equal tie-breaking:
  // 1. If score difference >= 1.0 point, higher score wins
  // 2. If scores are within 1.0 point (near-equal tie):
  //    - Remaining fraction descending
  //    - Priority ascending (Priority #1 beats Priority #2)
  //    - Stable accountId alphabetical
  results.sort((a, b) => {
    const diff = b.score - a.score;
    if (Math.abs(diff) >= 1.0) {
      return diff;
    }
    // Near-equal tie break
    if (b.remainingFraction !== a.remainingFraction) {
      return b.remainingFraction - a.remainingFraction;
    }
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.accountId.localeCompare(b.accountId);
  });

  // Assign tiers: First eligible with score > 0 is BEST_CANDIDATE
  let hasBest = false;
  for (const item of results) {
    if (item.tier === 'UNAVAILABLE') continue;

    if (!hasBest && item.score > 0 && item.health !== 'EXHAUSTED') {
      item.tier = 'BEST_CANDIDATE';
      item.reasons.unshift('Ranked #1 Best Candidate');
      hasBest = true;
    } else {
      item.tier = 'SECONDARY';
    }
  }

  return results;
}
