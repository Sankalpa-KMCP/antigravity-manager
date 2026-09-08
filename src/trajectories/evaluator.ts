import { TrajectoryStatus } from '../types';
import { RawTrajectoriesResponse } from '../rpc/endpoints';

export function evaluateTrajectories(raw: RawTrajectoriesResponse): TrajectoryStatus {
  const summaries = raw.trajectorySummaries || {};
  const entries = Object.values(summaries);

  const totalTrajectories = entries.length;
  const runningTrajectories = entries.filter(t => t.status === 'CASCADE_RUN_STATUS_RUNNING').length;

  const state: 'BUSY' | 'IDLE' = runningTrajectories > 0 ? 'BUSY' : 'IDLE';

  return {
    totalTrajectories,
    runningTrajectories,
    state
  };
}
