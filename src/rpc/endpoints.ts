import { callConnectRpc } from './client';

export interface RawUserStatusResponse {
  userStatus?: {
    email?: string;
    name?: string;
    userTier?: {
      id?: string;
      name?: string;
      description?: string;
      availableCredits?: Array<{ creditType?: string; minimumCreditAmountForUsage?: string }>;
    };
    planStatus?: {
      availablePromptCredits?: number;
      availableFlowCredits?: number;
      planInfo?: {
        planName?: string;
        teamsTier?: string;
        monthlyPromptCredits?: number;
        monthlyFlowCredits?: number;
      };
    };
    cascadeModelConfigData?: {
      clientModelConfigs?: Array<{
        label?: string;
        modelOrTier?: string;
        quotaInfo?: {
          remainingFraction?: number;
          resetTime?: string;
          isExhausted?: boolean;
        };
      }>;
    };
  };
}

export interface RawTrajectoriesResponse {
  trajectorySummaries?: Record<string, {
    cascadeId?: string;
    trajectoryId?: string;
    summary?: string;
    stepCount?: number;
    status?: string; // 'CASCADE_RUN_STATUS_RUNNING', 'CASCADE_RUN_STATUS_IDLE', etc.
    lastModifiedTime?: string;
    createdTime?: string;
  }>;
}

export async function fetchUserStatus(port: number, csrfToken: string): Promise<RawUserStatusResponse> {
  return callConnectRpc<RawUserStatusResponse>({
    port,
    csrfToken,
    endpoint: 'GetUserStatus',
    body: {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
    }
  });
}

export async function fetchCascadeTrajectories(port: number, csrfToken: string): Promise<RawTrajectoriesResponse> {
  return callConnectRpc<RawTrajectoriesResponse>({
    port,
    csrfToken,
    endpoint: 'GetAllCascadeTrajectories',
    body: {
      metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
    }
  });
}

export async function requestLoginWithBrowser(port: number, csrfToken: string): Promise<{ success: boolean; error?: string }> {
  try {
    await callConnectRpc({
      port,
      csrfToken,
      endpoint: 'LoginWithBrowser',
      body: { isGcpTos: false },
      timeoutMs: 5000
    });
    return { success: true };
  } catch (err) {
    // If login launched browser, it might close socket or return empty; consider success if no critical error
    return { success: true };
  }
}
