export type TargetId = 'ide' | 'antigravity2';

export interface ModelQuota {
  label: string;
  modelOrTier: string;
  remainingFraction: number; // 0.0 to 1.0 (DO NOT aggregate across accounts)
  resetTime: string;         // ISO 8601 UTC timestamp
  isExhausted: boolean;
}

export interface CreditStatus {
  availablePromptCredits: number;
  monthlyPromptCredits: number;
  computedUsedPromptCredits: number;
  availableFlowCredits: number;
  monthlyFlowCredits: number;
  computedUsedFlowCredits: number;
}

export interface TrajectoryStatus {
  totalTrajectories: number;
  runningTrajectories: number;
  state: 'BUSY' | 'IDLE' | 'UNKNOWN';
}

export interface DiscoveryTelemetry {
  lastDiscoveryAt: string | null;
  discoveryReason: string | null;
  discoveryCount: number;
}

export interface TargetState {
  id: TargetId;
  name: string;
  isRunning: boolean;
  pid: number | null;
  port: number | null;
  email: string | null;
  userName: string | null;
  userTier: string | null;
  planName: string | null;
  credits: CreditStatus | null;
  models: ModelQuota[];
  trajectoryStatus: TrajectoryStatus;
  discovery: DiscoveryTelemetry;
  lastUpdated: string;
  error: string | null;
}

export interface CreditPool {
  monthly: number;
  available: number;
  computedUsed: number;
}

export interface AggregatedCredits {
  prompt: CreditPool;
  flow: CreditPool;
}

export interface SystemTelemetry {
  powershellLaunches: number;
  netstatLaunches: number;
  rpcPollCount: number;
  uptimeSeconds: number;
}

export interface ProjectMapping {
  name: string;
  path?: string;
  target: TargetId;
  preferredAccountEmail: string;
}

export interface ProjectStatus {
  name: string;
  path?: string;
  target: TargetId;
  targetName: string;
  preferredAccountEmail: string;
  currentAccountEmail: string | null;
  isTargetRunning: boolean;
  isTargetBusy: boolean;
  status: 'READY' | 'SWITCH_REQUIRED' | 'TARGET_OFFLINE';
}

export type SwitchStatusType = 
  | 'IDLE'
  | 'INITIATED'
  | 'WAITING'
  | 'SUCCESS'
  | 'TIMEOUT'
  | 'REFUSED_BUSY'
  | 'CANCELLED';

export interface SwitchSession {
  targetId: TargetId;
  targetName: string;
  status: SwitchStatusType;
  oldEmail: string | null;
  currentDetectedEmail?: string | null;
  newEmail: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  elapsedSeconds?: number;
  timeoutSeconds?: number;
  targetHealth?: string;
  message: string;
}

import type { AccountPoolData } from './pool/types';

export type EnrollmentState =
  | 'IDLE'
  | 'PRECHECK'
  | 'PRESERVE_CURRENT'
  | 'START_OAUTH'
  | 'WAITING_FOR_USER'
  | 'DETECT_ACCOUNT_CHANGE'
  | 'VALIDATING_NEW_ACCOUNT'
  | 'CAPTURING'
  | 'COLD_VERIFYING'
  | 'COMPLETED'
  | 'CANCELLING'
  | 'ROLLING_BACK'
  | 'FAILED';

export interface EnrollmentControllerStatus {
  state: EnrollmentState;
  preservedEmail: string | null;
  detectedEmail: string | null;
  returnToBase: boolean;
  progress: string;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
}

export interface VaultAccountSummary {
  accountId: string;
  email?: string;
  label?: string;
  priority?: number;
  enabled?: boolean;
  isReserve?: boolean;
  provider: string;
  authMethod: string;
  status: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string | null;
  lastQuotaRefreshAt?: string | null;
  freshness?: string;
  isActive?: boolean;
  targets?: {
    antigravity2?: {
      capturedAt: string;
      lastValidatedAt: string | null;
      status: string;
      notes?: string;
    };
    ide?: {
      capturedAt: string;
      lastValidatedAt: string | null;
      status: string;
      notes?: string;
    };
  };
  capabilities?: {
    antigravity2: {
      sessionStored: boolean;
      activationMode: string;
    };
    ide: {
      sessionStored: boolean;
      activationMode: string;
    };
  };
  activeTargets?: TargetId[];
}

export interface VaultDashboardStatus {
  accounts: VaultAccountSummary[];
  controllerState: string;
  activeAccountId: string | null;
  targetEmail: string | null;
  previousEmail: string | null;
  progress: string;
  error: string | null;
  enrollment?: EnrollmentControllerStatus;
}

import type { RouterStatusResponse } from './routing/types';

export interface DashboardData {
  targets: TargetState[];
  aggregate: AggregatedCredits;
  projects: ProjectStatus[];
  activeSwitchSession: SwitchSession | null;
  pool?: AccountPoolData;
  vault?: VaultDashboardStatus;
  router?: RouterStatusResponse;
  systemTelemetry: SystemTelemetry;
  timestamp: string;
}

export interface DiscoveredProcess {
  ProcessId: number;
  Name: string;
  CommandLine: string;
  CreationDate?: string;
}
