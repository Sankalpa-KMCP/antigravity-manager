import { ModelQuota, TargetId } from '../types';

export type FreshnessState = 'LIVE' | 'FRESH' | 'STALE' | 'UNKNOWN';

export type AccountHealthState = 'READY' | 'LOW' | 'CRITICAL' | 'RESERVE' | 'EXHAUSTED';

export type CandidateTier = 'BEST_CANDIDATE' | 'SECONDARY' | 'UNAVAILABLE';

export interface AccountRegistryEntry {
  id: string;
  label: string;
  email: string;
  enabled: boolean;
  priority: number;
  isReserve?: boolean;
  vaultStatus?: string;
  lastSeenAt: string | null;
  lastQuotaRefreshAt: string | null;
  source: 'discovered' | 'manual';
  activeTarget?: TargetId | null;
  notes?: string;
}

export interface AccountQuotaCacheEntry {
  email: string;
  capturedAt: string;
  planName: string;
  userTier: string;
  promptCredits: {
    monthly: number;
    available: number;
    computedUsed: number;
  };
  flowCredits: {
    monthly: number;
    available: number;
    computedUsed: number;
  };
  models: ModelQuota[];
  freshness?: FreshnessState;
}

export interface ModelPoolStats {
  modelLabel: string;
  accountCount: number;
  readyCount: number;
  lowCount: number;
  criticalCount: number;
  reserveCount: number;
  exhaustedCount: number;
  averageRemainingPercent: number;        // Derived/calculated
  equivalentPoolRemainingPercent: number; // Derived/calculated
  totalEquivalentCapacityRemaining: number;
  isEquivalenceEstablished: boolean;
  metricNotice: string;
}

export interface CandidateScore {
  accountId: string;
  accountEmail: string;
  accountLabel: string;
  modelLabel: string;
  score: number;
  tier: CandidateTier;
  health: AccountHealthState;
  freshness: FreshnessState;
  remainingFraction: number;
  remainingPercent: number;
  resetTime: string;
  priority: number;
  reasons: string[];
}

export interface AccountModelSnapshot {
  accountId: string;
  accountEmail: string;
  accountLabel: string;
  priority: number;
  enabled: boolean;
  isReserve: boolean;
  vaultStatus?: string;
  activeTarget: TargetId | null;
  freshness: FreshnessState;
  capturedAt: string | null;
  planName: string;
  userTier: string;
  models: Record<string, {
    remainingFraction: number;
    remainingPercent: number;
    resetTime: string;
    isExhausted: boolean;
    health: AccountHealthState;
  }>;
}

export interface AccountPoolData {
  accounts: AccountModelSnapshot[];
  modelStats: Record<string, ModelPoolStats>;
  bestCandidates: Record<string, CandidateScore | null>;
  candidateRankings: Record<string, CandidateScore[]>;
  events: PoolEvent[];
  poolSummary: {
    totalRegisteredAccounts: number;
    enabledAccounts: number;
    validVaultSessionsCount: number;
    activeTargetsCount: number;
    compatiblePlansCount: number;
    readyCount: number;
    lowCount: number;
    criticalCount: number;
    reserveCount: number;
    exhaustedCount: number;
    staleCount: number;
    promptPool: {
      monthly: number;
      available: number;
      computedUsed: number;
      isUnitCompatible: boolean;
    };
    flowPool: {
      monthly: number;
      available: number;
      computedUsed: number;
      isUnitCompatible: boolean;
    };
  };
}

export type PoolEventType = 
  | 'ACCOUNT_LOW'
  | 'ACCOUNT_CRITICAL'
  | 'ACCOUNT_EXHAUSTED'
  | 'QUOTA_RESET'
  | 'QUOTA_DATA_STALE'
  | 'BEST_CANDIDATE_CHANGED';

export interface PoolEvent {
  id: string;
  type: PoolEventType;
  accountId: string;
  accountEmail: string;
  modelLabel?: string;
  timestamp: string;
  message: string;
  metadata?: Record<string, any>;
}
