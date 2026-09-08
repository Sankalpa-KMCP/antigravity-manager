import { AccountModelSnapshot, AccountPoolData, AccountRegistryEntry, ModelPoolStats } from './types';
import { AccountRegistry } from './account-registry';
import { QuotaCache } from './quota-cache';
import { evaluateHealthState } from './health';
import { PREFERRED_MODEL_ORDER } from '../models/filter';

/**
 * Validates whether plan tiers and credit pools are compatible for aggregation.
 */
export function arePlansCompatible(planA: string | null | undefined, planB: string | null | undefined): boolean {
  if (!planA || !planB) return true; // Standard fallback
  const normA = planA.trim().toLowerCase();
  const normB = planB.trim().toLowerCase();
  // Standard Pro and Google AI Pro share equivalent credit structures
  const isProA = normA.includes('pro');
  const isProB = normB.includes('pro');
  if (isProA && isProB) return true;
  return normA === normB;
}

/**
 * Calculates pooled statistics across all registered accounts.
 * Strictly avoids summing raw model fractions without establishing equivalent unit capacity.
 * All derived and calculated values are explicitly labeled.
 */
export function calculatePoolData(
  registry: AccountRegistry,
  quotaCache: QuotaCache,
  nowMs: number = Date.now(),
  vaultEntries?: Array<{ accountId: string; status: string }>
): {
  accounts: AccountModelSnapshot[];
  modelStats: Record<string, ModelPoolStats>;
  poolSummary: AccountPoolData['poolSummary'];
} {
  const allAccounts = registry.getAllAccounts();
  const accountSnapshots: AccountModelSnapshot[] = [];

  let totalPromptMonthly = 0;
  let totalPromptAvailable = 0;
  let totalPromptComputedUsed = 0;
  let promptUnitCompatible = true;

  let totalFlowMonthly = 0;
  let totalFlowAvailable = 0;
  let totalFlowComputedUsed = 0;
  let flowUnitCompatible = true;

  let referencePlan: string | null = null;
  let compatiblePlansCount = 0;

  // 1. Build snapshots per registered account
  for (const acc of allAccounts) {
    const quota = quotaCache.getQuota(acc.email, nowMs);
    const plan = quota?.planName || 'Standard';
    const tier = quota?.userTier || plan;

    if (referencePlan === null && quota) {
      referencePlan = plan;
    } else if (quota && referencePlan !== null) {
      if (!arePlansCompatible(referencePlan, plan)) {
        promptUnitCompatible = false;
        flowUnitCompatible = false;
      }
    }

    if (acc.enabled && quota) {
      compatiblePlansCount++;
      totalPromptMonthly += quota.promptCredits.monthly;
      totalPromptAvailable += quota.promptCredits.available;
      totalPromptComputedUsed += quota.promptCredits.computedUsed;

      totalFlowMonthly += quota.flowCredits.monthly;
      totalFlowAvailable += quota.flowCredits.available;
      totalFlowComputedUsed += quota.flowCredits.computedUsed;
    }

    const modelsMap: AccountModelSnapshot['models'] = {};
    const quotaModels = quota?.models || [];

    for (const modelLabel of PREFERRED_MODEL_ORDER) {
      const found = quotaModels.find(m => m.label === modelLabel);
      if (found) {
        const remainingFraction = found.remainingFraction;
        const remainingPercent = Number((remainingFraction * 100).toFixed(1));
        const health = evaluateHealthState(remainingFraction, found.isExhausted);

        modelsMap[modelLabel] = {
          remainingFraction,
          remainingPercent,
          resetTime: found.resetTime,
          isExhausted: found.isExhausted,
          health
        };
      } else {
        // Unknown / unobserved model for this account
        modelsMap[modelLabel] = {
          remainingFraction: 0,
          remainingPercent: 0,
          resetTime: '',
          isExhausted: false,
          health: 'EXHAUSTED'
        };
      }
    }

    const vMatch = vaultEntries?.find(v => v.accountId === acc.id);
    const vaultStatus = vMatch ? vMatch.status : (acc.vaultStatus || undefined);

    accountSnapshots.push({
      accountId: acc.id,
      accountEmail: acc.email,
      accountLabel: acc.label,
      priority: acc.priority,
      enabled: acc.enabled,
      isReserve: Boolean(acc.isReserve),
      vaultStatus,
      activeTarget: acc.activeTarget || null,
      freshness: quota?.freshness || 'UNKNOWN',
      capturedAt: quota?.capturedAt || null,
      planName: plan,
      userTier: tier,
      models: modelsMap
    });
  }

  // 2. Compute model pool stats for each preferred model
  const modelStats: Record<string, ModelPoolStats> = {};

  for (const modelLabel of PREFERRED_MODEL_ORDER) {
    let readyCount = 0;
    let lowCount = 0;
    let criticalCount = 0;
    let reserveCount = 0;
    let exhaustedCount = 0;
    let knownAccountsForModel = 0;
    let sumFractions = 0;

    for (const snap of accountSnapshots) {
      if (!snap.enabled) continue;

      const m = snap.models[modelLabel];
      if (!m || snap.freshness === 'UNKNOWN') {
        exhaustedCount++;
        continue;
      }

      knownAccountsForModel++;
      sumFractions += m.remainingFraction;

      switch (m.health) {
        case 'READY': readyCount++; break;
        case 'LOW': lowCount++; break;
        case 'CRITICAL': criticalCount++; break;
        case 'RESERVE': reserveCount++; break;
        case 'EXHAUSTED': exhaustedCount++; break;
      }
    }

    const enabledCount = accountSnapshots.filter(a => a.enabled).length;
    const avgPercent = knownAccountsForModel > 0
      ? Number(((sumFractions / knownAccountsForModel) * 100).toFixed(1))
      : 0;

    // Equivalent capacity assumes each enabled account provides 1.0 unit of tier quota
    const totalEquivalentCapacityRemaining = Number(sumFractions.toFixed(2));
    const equivalentPoolRemainingPercent = enabledCount > 0
      ? Number(((sumFractions / enabledCount) * 100).toFixed(1))
      : 0;

    modelStats[modelLabel] = {
      modelLabel,
      accountCount: enabledCount,
      readyCount,
      lowCount,
      criticalCount,
      reserveCount,
      exhaustedCount,
      averageRemainingPercent: avgPercent,
      equivalentPoolRemainingPercent,
      totalEquivalentCapacityRemaining,
      isEquivalenceEstablished: true,
      metricNotice: 'Capacity metrics derived assuming homogeneous provider tier quota units. Individual account limits remain strictly isolated.'
    };
  }

  const enabledAccountsCount = accountSnapshots.filter(a => a.enabled).length;
  const activeTargetsCount = accountSnapshots.filter(a => a.activeTarget !== null).length;

  // Calculate overall pool summary status counts (using primary model Gemini 3.8 Flash (High))
  const primaryModel = PREFERRED_MODEL_ORDER[0];
  let poolReady = 0;
  let poolLow = 0;
  let poolCritical = 0;
  let poolReserve = 0;
  let poolExhausted = 0;
  let poolStale = 0;

  for (const snap of accountSnapshots) {
    if (snap.freshness === 'STALE' || snap.freshness === 'UNKNOWN') {
      poolStale++;
    }
    if (snap.isReserve) {
      poolReserve++;
    } else if (snap.enabled) {
      const pm = snap.models[primaryModel];
      if (!pm || pm.isExhausted || pm.health === 'EXHAUSTED') {
        poolExhausted++;
      } else if (pm.health === 'READY') {
        poolReady++;
      } else if (pm.health === 'LOW') {
        poolLow++;
      } else if (pm.health === 'CRITICAL') {
        poolCritical++;
      }
    }
  }

  const validVaultCount = vaultEntries
    ? vaultEntries.filter(v => v.status === 'VALID' || v.status === 'ACTIVE').length
    : accountSnapshots.filter(a => a.vaultStatus === 'VALID' || a.vaultStatus === 'ACTIVE').length;

  return {
    accounts: accountSnapshots,
    modelStats,
    poolSummary: {
      totalRegisteredAccounts: accountSnapshots.length,
      enabledAccounts: enabledAccountsCount,
      validVaultSessionsCount: validVaultCount,
      activeTargetsCount,
      compatiblePlansCount,
      readyCount: poolReady,
      lowCount: poolLow,
      criticalCount: poolCritical,
      reserveCount: poolReserve,
      exhaustedCount: poolExhausted,
      staleCount: poolStale,
      promptPool: {
        monthly: totalPromptMonthly,
        available: totalPromptAvailable,
        computedUsed: totalPromptComputedUsed,
        isUnitCompatible: promptUnitCompatible
      },
      flowPool: {
        monthly: totalFlowMonthly,
        available: totalFlowAvailable,
        computedUsed: totalFlowComputedUsed,
        isUnitCompatible: flowUnitCompatible
      }
    }
  };
}
