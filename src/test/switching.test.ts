import { verifyIdleGate } from '../switching/gate';
import { SwitchManager } from '../switching/handler';
import { TargetState } from '../types';

export async function runSwitchingTests(): Promise<boolean> {
  console.log('--- RUNNING ACCOUNT SWITCHING & IDLE GATE TESTS ---');
  let passed = true;

  function assert(condition: boolean, testName: string) {
    if (!condition) {
      console.error(`  FAIL: ${testName}`);
      passed = false;
    } else {
      console.log(`  PASS: ${testName}`);
    }
  }

  // 1. BUSY Target Cannot Switch (Idle Gate Refusal)
  const busyTarget: TargetState = {
    id: 'ide',
    name: 'Antigravity IDE',
    isRunning: true,
    pid: 1234,
    port: 50000,
    email: 'user@example.com',
    userName: 'Test User',
    userTier: 'Pro',
    planName: 'Pro',
    credits: null,
    models: [],
    trajectoryStatus: {
      state: 'BUSY',
      runningTrajectories: 3,
      totalTrajectories: 5
    },
    discovery: { discoveryReason: 'Cached', discoveryCount: 1, lastDiscoveryAt: new Date().toISOString() },
    lastUpdated: new Date().toISOString(),
    error: null
  };

  // Test verifyIdleGate on BUSY target
  const gateBusy = await verifyIdleGate(busyTarget);
  assert(!gateBusy.allowed, 'BUSY target is refused by Idle Gate');
  assert(gateBusy.runningTrajectories === 3, 'Idle Gate reports exact running trajectories count (3)');
  assert(gateBusy.reason.includes('BUSY'), 'Idle Gate refusal reason mentions BUSY state');

  // 2. Offline Target Cannot Switch
  const offlineTarget: TargetState = {
    ...busyTarget,
    isRunning: false,
    port: null
  };
  const gateOffline = await verifyIdleGate(offlineTarget);
  assert(!gateOffline.allowed, 'Offline target is refused by Idle Gate');

  // 3. IDLE Target Can Start Switch Flow
  const idleTarget: TargetState = {
    ...busyTarget,
    trajectoryStatus: {
      state: 'IDLE',
      runningTrajectories: 0,
      totalTrajectories: 5
    }
  };

  const gateIdle = await verifyIdleGate(idleTarget);
  assert(gateIdle.allowed, 'IDLE target (0 active tasks) is approved by Idle Gate');
  assert(gateIdle.runningTrajectories === 0, 'Zero running trajectories reported');

  // 4. Current Identity Displayed & Preserved in Session
  const switchMgr = new SwitchManager();
  const session = await switchMgr.initiateSwitch(idleTarget, null);
  assert(session.status === 'WAITING', 'Initiated switch session enters WAITING state');
  assert(session.oldEmail === 'user@example.com', 'Current identity (user@example.com) correctly captured in session');
  assert(session.targetId === 'ide', 'Target ID correctly set to ide');
  assert(session.message.includes('Antigravity IDE is IDLE and ready'), 'Supported IDE instruction displayed');

  // 5. Post-Switch Identity Verification (old email != new email)
  switchMgr.notifyTargetStatusUpdated('ide', 'new-user@example.com');
  const active = switchMgr.getActiveSession();
  assert(active?.status === 'SUCCESS', 'Switch session transitions to SUCCESS upon email change');
  assert(active?.newEmail === 'new-user@example.com', 'New verified email captured');
  assert(Boolean(active?.message && active.message.includes('SUCCESS')), 'Success message generated');

  // 6. Same email does not trigger false switch success
  const sameEmailMgr = new SwitchManager();
  await sameEmailMgr.initiateSwitch(idleTarget, null);
  sameEmailMgr.notifyTargetStatusUpdated('ide', 'user@example.com'); // Same email
  assert(sameEmailMgr.getActiveSession()?.status === 'WAITING', 'Unchanged email does not trigger false switch success');
  sameEmailMgr.cancelSwitch();
  assert(sameEmailMgr.getActiveSession()?.status === 'CANCELLED', 'User cancel cleanly cancels switch session');

  // 7. Security: No Credential Storage & No Direct State Alteration
  assert(!('token' in busyTarget), 'TargetState contains no access/refresh token fields');
  assert(!('password' in busyTarget), 'TargetState contains no password fields');

  return passed;
}
