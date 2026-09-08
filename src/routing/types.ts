import { TargetId } from '../types';
import { CandidateScore, FreshnessState, AccountHealthState } from '../pool/types';

export type RoutingState =
  | 'MONITORING'
  | 'ROUTE_NEEDED'
  | 'SELECTING'
  | 'WAITING_FOR_IDLE'
  | 'WAIT_FOR_RESET'
  | 'ACTIVATION_PLANNED'
  | 'ACTIVATING'
  | 'WAITING_FOR_USER'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'ROLLING_BACK'
  | 'FAILED'
  | 'COOLDOWN';

export type TargetRoutingMode = 'INDEPENDENT' | 'SYNCED';

export type ActivationCapability =
  | 'AUTOMATIC_COLD_TARGET_RELOAD'
  | 'INTERACTION_REQUIRED'
  | 'UNAVAILABLE';

export type RouterOperatingMode = 'OFF' | 'SHADOW' | 'LIVE';

export interface ShadowActionPlan {
  wouldPerform: ActivationCapability;
  actionDescription: string;
  candidateAccountId: string;
  candidateEmail: string;
  candidateModelQuotaPercent: number;
  executed: false;
}

export interface RouterConfig {
  enabled: boolean;
  operatingMode: RouterOperatingMode; // 'OFF' | 'SHADOW' | 'LIVE'
  mode: TargetRoutingMode;
  selectedModel: string;
  switchThreshold: number;      // default: 10 (%)
  returnThreshold: number;      // default: 30 (%)
  minDwellMinutes: number;      // default: 15 (min)
  cooldownMinutes: number;      // default: 30 (min)
  resetGraceMinutes: number;    // default: 5 (min)
}

export interface RoutingTargetStatus {
  targetId: TargetId;
  targetName: string;
  state: RoutingState;
  currentAccountId: string | null;
  currentEmail: string | null;
  currentModelQuotaPercent: number | null;
  health: AccountHealthState;
  recommendedCandidate: CandidateScore | null;
  requiresRefresh: boolean;
  activationCapability: ActivationCapability;
  actionRequired: string;
  isIdle: boolean;
  runningTrajectories: number;
  lastSwitchAt: string | null;
  dwellRemainingSeconds: number;
  shadowPlan?: ShadowActionPlan | null;
  error: string | null;
}

export type RoutingEventType =
  | 'ROUTE_NEEDED'
  | 'WAITING_FOR_IDLE'
  | 'CANDIDATE_SELECTED'
  | 'WAITING_FOR_USER'
  | 'ACTIVATION_STARTED'
  | 'ACTIVATION_VERIFIED'
  | 'ACTIVATION_FAILED'
  | 'ROLLBACK_STARTED'
  | 'ROLLBACK_VERIFIED'
  | 'SHADOW_PLAN_RECORDED'
  | 'OPERATING_MODE_CHANGED'
  | 'ACCOUNT_COOLDOWN'
  | 'RESET_DETECTED';

export interface RoutingEvent {
  id: string;
  type: RoutingEventType;
  targetId: TargetId | 'synced';
  accountId?: string;
  accountEmail?: string;
  modelLabel?: string;
  message: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface RouterStatusResponse {
  config: RouterConfig;
  globalState: RoutingState;
  targets: Record<TargetId, RoutingTargetStatus>;
  syncStatus: {
    isSynchronized: boolean;
    activeAccountEmail: string | null;
    pendingTarget?: TargetId;
  };
  cooldowns: Record<string, { accountId: string; expiresAt: string; reason: string }>;
  recentEvents: RoutingEvent[];
  updatedAt: string;
}
