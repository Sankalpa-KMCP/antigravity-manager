import { TargetState } from '../types';
import { fetchCascadeTrajectories } from '../rpc/endpoints';
import { evaluateTrajectories } from '../trajectories/evaluator';

export interface GateResult {
  allowed: boolean;
  targetId: string;
  targetName: string;
  reason: string;
  runningTrajectories: number;
}

/**
 * IDLE GATE: Validates that the target is completely IDLE before any account switch.
 * Strictly verifies zero RUNNING trajectories.
 * No force-switch option exists.
 */
export async function verifyIdleGate(target: TargetState, csrfToken?: string | null): Promise<GateResult> {
  if (!target.isRunning || !target.port) {
    return {
      allowed: false,
      targetId: target.id,
      targetName: target.name,
      reason: `${target.name} is currently offline/stopped. Start the application before switching accounts.`,
      runningTrajectories: 0
    };
  }

  let runningTrajectories = target.trajectoryStatus?.runningTrajectories || 0;
  let isBusy = target.trajectoryStatus?.state === 'BUSY' || runningTrajectories > 0;

  // Double-check live trajectory status via fresh RPC query if csrfToken is available
  if (csrfToken && target.port) {
    try {
      const raw = await fetchCascadeTrajectories(target.port, csrfToken);
      const live = evaluateTrajectories(raw);
      runningTrajectories = live.runningTrajectories;
      isBusy = live.state === 'BUSY' || live.runningTrajectories > 0;
    } catch (_) {
      // Fallback to target.trajectoryStatus if fresh RPC fetch encounters error
    }
  }

  if (isBusy || runningTrajectories > 0) {
    return {
      allowed: false,
      targetId: target.id,
      targetName: target.name,
      reason: `Cannot switch account while ${target.name} is BUSY executing ${runningTrajectories} active agent task(s). Wait for completion or stop the task, then retry.`,
      runningTrajectories
    };
  }

  return {
    allowed: true,
    targetId: target.id,
    targetName: target.name,
    reason: `${target.name} is IDLE (0 active tasks). Account switch is safe to initiate.`,
    runningTrajectories: 0
  };
}
