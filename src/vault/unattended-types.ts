import { TargetId, VaultSessionStatus } from './types';

export type FeasibilityClassification =
  | 'FULL_UNATTENDED_HOT'
  | 'INTERACTION_REQUIRED'
  | 'PARTIAL_HOT'
  | 'UNSUPPORTED';

export type ActivationMode = 'INDEPENDENT' | 'SYNCED';

export type UnattendedState =
  | 'IDLE'
  | 'SAFETY_PRECHECK'
  | 'PREPARING'
  | 'EVALUATING_FEASIBILITY'
  | 'WAITING_FOR_INTERACTION'
  | 'VERIFYING_CONTINUITY'
  | 'COMPLETED'
  | 'ROLLING_BACK'
  | 'ABORTED'
  | 'FAILED';

export interface OAuthAuditReport {
  target: TargetId;
  installedVersion?: string;
  nativeFlow: string;
  promptBehavior: string;
  loginHintSupported: boolean;
  silentAuthAvailable: boolean;
  classification: FeasibilityClassification;
  reasons: string[];
}

export interface SyncedFeasibilityStatus {
  feasible: false;
  verdict: 'NOT AVAILABLE THROUGH CURRENTLY SUPPORTED INTERFACES IN THE INSTALLED VERSIONS';
  reasons: string[];
}

export interface SafetyPreflightResult {
  allowed: boolean;
  reasons: string[];
  ideTrajectories: number;
  ag2Trajectories: number;
  isIdeIdle: boolean;
  isAg2Idle: boolean;
  timestamp: string;
}

export interface UnattendedControllerStatus {
  state: UnattendedState;
  mode: ActivationMode;
  targetAccountId: string | null;
  activeAccountIds: {
    antigravity2: string | null;
    ide: string | null;
  };
  classification: {
    antigravity2: FeasibilityClassification;
    ide: FeasibilityClassification;
    synced: string;
  };
  safetyGate: {
    trajectoriesActive: boolean;
    safeToTransition: boolean;
    blockReason?: string;
  };
  lastAudit: {
    antigravity2: OAuthAuditReport;
    ide: OAuthAuditReport;
  };
  progress: string;
  error: string | null;
  updatedAt: string;
}
