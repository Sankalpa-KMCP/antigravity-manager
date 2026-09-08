import { evaluateTrajectories } from '../trajectories/evaluator';
import { RawTrajectoriesResponse } from '../rpc/endpoints';

export function runEvaluatorTests(): boolean {
  console.log('--- RUNNING EVALUATOR TESTS ---');
  let passed = true;

  function assert(condition: boolean, msg: string) {
    if (!condition) {
      console.error(`  FAIL: ${msg}`);
      passed = false;
    } else {
      console.log(`  PASS: ${msg}`);
    }
  }

  // Test 1: Active running trajectory -> BUSY
  const busyPayload: RawTrajectoriesResponse = {
    trajectorySummaries: {
      'traj-1': { status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 5 },
      'traj-2': { status: 'CASCADE_RUN_STATUS_RUNNING', stepCount: 12 },
      'traj-3': { status: 'CASCADE_RUN_STATUS_DONE', stepCount: 8 }
    }
  };

  const busyStatus = evaluateTrajectories(busyPayload);
  assert(busyStatus.totalTrajectories === 3, 'Total trajectories count is 3');
  assert(busyStatus.runningTrajectories === 1, 'Running trajectories count is 1');
  assert(busyStatus.state === 'BUSY', 'State evaluated as BUSY');

  // Test 2: All idle/completed trajectories -> IDLE
  const idlePayload: RawTrajectoriesResponse = {
    trajectorySummaries: {
      'traj-1': { status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 5 },
      'traj-2': { status: 'CASCADE_RUN_STATUS_DONE', stepCount: 12 }
    }
  };

  const idleStatus = evaluateTrajectories(idlePayload);
  assert(idleStatus.totalTrajectories === 2, 'Total trajectories count is 2');
  assert(idleStatus.runningTrajectories === 0, 'Running trajectories count is 0');
  assert(idleStatus.state === 'IDLE', 'State evaluated as IDLE');

  // Test 3: Empty trajectories -> IDLE
  const emptyStatus = evaluateTrajectories({});
  assert(emptyStatus.totalTrajectories === 0, 'Empty summaries count is 0');
  assert(emptyStatus.runningTrajectories === 0, 'Empty summaries running is 0');
  assert(emptyStatus.state === 'IDLE', 'Empty state evaluated as IDLE');

  return passed;
}
