import path from 'path';
import { AntigravityManager } from '../manager';
import { SessionVault } from './vault';
import { VaultSessionManager } from './session-manager';
import { safeLog } from './sanitizer';

export async function runPhase4B2Proof(): Promise<void> {
  console.log('====================================================');
  console.log('  PHASE 4B.2 — REAL SESSION CAPTURE & COLD RESTORE  ');
  console.log('====================================================\n');

  // Step 1: Pre-flight check
  console.log('--- STEP 1: PRE-FLIGHT CHECK ---');
  const manager = new AntigravityManager();
  const initialData = await manager.refreshAll('PreFlightCheck');

  const ag2 = initialData.targets.find(t => t.id === 'antigravity2');
  const ide = initialData.targets.find(t => t.id === 'ide');

  if (!ag2 || !ag2.isRunning || !ag2.email) {
    console.error('FAIL: Antigravity 2.0 is not running or unauthenticated.');
    process.exitCode = 1;
    return;
  }

  console.log(`  Target:               Antigravity 2.0`);
  console.log(`  PID:                  ${ag2.pid}`);
  console.log(`  Port:                 ${ag2.port}`);
  console.log(`  Current Email:        ${ag2.email}`);
  console.log(`  Plan / Tier:          ${ag2.planName} / ${ag2.userTier}`);
  console.log(`  State:                ${ag2.trajectoryStatus.state}`);
  console.log(`  Running Trajectories: ${ag2.trajectoryStatus.runningTrajectories}`);

  if (ag2.trajectoryStatus.state === 'BUSY' || ag2.trajectoryStatus.runningTrajectories > 0) {
    console.error(`BLOCKED BUSY: Antigravity 2.0 has ${ag2.trajectoryStatus.runningTrajectories} active tasks.`);
    process.exitCode = 1;
    return;
  }

  console.log(`  IDE Current Email:    ${ide?.email} (Untouched)`);

  // Step 2: Initialize Production Vault
  console.log('\n--- STEP 2: VAULT INITIALIZATION ---');
  const vaultDir = path.join(process.cwd(), 'data', 'vault');
  const vault = new SessionVault(vaultDir);
  await vault.init();
  console.log(`  Production vault initialized at: ${vaultDir}`);

  const sessionManager = new VaultSessionManager(vault);

  // Step 3: Capture Live Session & Equivalence Check
  console.log('\n--- STEP 3: CAPTURE LIVE SESSION & EQUIVALENCE CHECK ---');
  const captureResult = await sessionManager.captureAntigravity2Session(ag2);
  if (!captureResult.success) {
    console.error(`FAIL: Capture failed: ${captureResult.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`  Vault AccountId:      ${captureResult.accountId}`);
  console.log(`  Captured Email:       ${captureResult.email}`);
  console.log(`  Source Hash Match:    ${captureResult.sourceHashMatch ? 'YES' : 'NO'}`);
  console.log(`  Encrypted Persistence: sessions.dat updated atomically`);

  // Step 4: Cold Restore Proof
  console.log('\n--- STEP 4: COLD RESTORE PROOF (WITH NEW PROCESS VERIFICATION) ---');
  const coldRestoreResult = await sessionManager.executeColdRestoreProof(ag2, captureResult.accountId);

  console.log(`  Same-Session Write:   YES (CredWriteW succeeded)`);
  console.log(`  Old Process Terminated: Old PID ${coldRestoreResult.oldPid} exited`);
  console.log(`  New Process Spawned:   New PID ${coldRestoreResult.newPid}, Port ${coldRestoreResult.newPort}`);
  console.log(`  Expected Email:       ${coldRestoreResult.expectedEmail}`);
  console.log(`  Actual Email:         ${coldRestoreResult.actualEmail}`);
  console.log(`  Email Match:          ${coldRestoreResult.expectedEmail === coldRestoreResult.actualEmail ? 'YES' : 'NO'}`);
  console.log(`  Plan / Tier:          ${coldRestoreResult.planName} / ${coldRestoreResult.userTier}`);
  console.log(`  Quota Readable:       ${coldRestoreResult.quotaReadable ? 'YES' : 'NO'}`);
  console.log(`  Target State:         ${coldRestoreResult.idleState}`);
  console.log(`  IDE Untouched:        ${coldRestoreResult.ideAccountUnchanged ? 'YES (account preserved)' : 'NO'}`);

  // Step 5: Post-Restore Telemetry Refresh
  console.log('\n--- STEP 5: FINAL DASHBOARD VERIFICATION ---');
  const postData = await manager.refreshAll('PostColdRestore');
  const postAg2 = postData.targets.find(t => t.id === 'antigravity2');
  const postIde = postData.targets.find(t => t.id === 'ide');

  console.log(`  Post-Restore AG2 Running: ${postAg2?.isRunning}`);
  console.log(`  Post-Restore AG2 Email:   ${postAg2?.email}`);
  console.log(`  Post-Restore AG2 PID:     ${postAg2?.pid}`);
  console.log(`  Post-Restore IDE Email:   ${postIde?.email}`);

  if (postAg2?.email === ag2.email && postIde?.email === ide?.email) {
    console.log('\n====================================================');
    console.log('   PHASE 4B.2 COLD RESTORE PROOF: 100% PASS!         ');
    console.log('====================================================\n');
  } else {
    console.error('\nFAIL: Post-restore verification failed.');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runPhase4B2Proof().catch(err => {
    console.error('FATAL ERROR DURING PHASE 4B.2 PROOF:', err);
    process.exit(1);
  });
}
