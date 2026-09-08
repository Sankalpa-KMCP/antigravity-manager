import { CreditStatus, ModelQuota } from '../types';
import { RawUserStatusResponse } from '../rpc/endpoints';

export interface ParsedUserData {
  email: string | null;
  userName: string | null;
  userTier: string | null;
  planName: string | null;
  credits: CreditStatus | null;
  models: ModelQuota[];
}

export function parseUserStatus(raw: RawUserStatusResponse): ParsedUserData {
  const u = raw.userStatus;
  if (!u) {
    return {
      email: null,
      userName: null,
      userTier: null,
      planName: null,
      credits: null,
      models: []
    };
  }

  const email = u.email || null;
  const userName = u.name || null;

  // Tier info
  let userTier: string | null = null;
  if (u.userTier) {
    userTier = u.userTier.name || u.userTier.id || null;
  }

  // Plan info
  const planInfo = u.planStatus?.planInfo;
  const planName = planInfo?.planName || null;

  // Credits (Explicitly marked as COMPUTED USED since GetUserStatus provides monthly & available)
  let credits: CreditStatus | null = null;
  if (u.planStatus) {
    const monthlyPrompt = planInfo?.monthlyPromptCredits ?? 0;
    const availablePrompt = u.planStatus.availablePromptCredits ?? 0;
    const computedUsedPrompt = Math.max(0, monthlyPrompt - availablePrompt);

    const monthlyFlow = planInfo?.monthlyFlowCredits ?? 0;
    const availableFlow = u.planStatus.availableFlowCredits ?? 0;
    const computedUsedFlow = Math.max(0, monthlyFlow - availableFlow);

    credits = {
      monthlyPromptCredits: monthlyPrompt,
      availablePromptCredits: availablePrompt,
      computedUsedPromptCredits: computedUsedPrompt,
      monthlyFlowCredits: monthlyFlow,
      availableFlowCredits: availableFlow,
      computedUsedFlowCredits: computedUsedFlow
    };
  }

  // Model quotas
  const rawConfigs = u.cascadeModelConfigData?.clientModelConfigs || [];
  const models: ModelQuota[] = [];

  for (const config of rawConfigs) {
    const label = config.label || config.modelOrTier || 'Unknown Model';
    const modelOrTier = config.modelOrTier || '';
    const q = config.quotaInfo;

    const remainingFraction = typeof q?.remainingFraction === 'number' ? q.remainingFraction : 1.0;
    const resetTime = q?.resetTime || '';
    const isExhausted = Boolean(q?.isExhausted || remainingFraction <= 0);

    models.push({
      label,
      modelOrTier,
      remainingFraction,
      resetTime,
      isExhausted
    });
  }

  return {
    email,
    userName,
    userTier,
    planName,
    credits,
    models
  };
}
