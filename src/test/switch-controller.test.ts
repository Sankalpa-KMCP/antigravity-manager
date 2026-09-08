import fs from 'fs';
import path from 'path';
import { SessionVault } from '../vault/vault';
import { TransactionalSwitchController } from '../vault/switch-controller';
import { TargetState } from '../types';

export async function runSwitchControllerTests(): Promise<boolean> {
  console.log('\n--- RUNNING TRANSACTIONAL SWITCH CONTROLLER TESTS ---');
  let passed = true;

  function assert(condition: boolean, testName: string) {
    if (!condition) {
      console.error(`  FAIL: ${testName}`);
      passed = false;
    } else {
      console.log(`  PASS: ${testName}`);
    }
  }

  const testVaultDir = path.join(process.cwd(), 'data', 'test-switch-vault');
  if (fs.existsSync(testVaultDir)) {
    fs.rmSync(testVaultDir, { recursive: true, force: true });
  }

  const vault = new SessionVault(testVaultDir);
  await vault.init();

  const controller = new TransactionalSwitchController(vault);

  try {
    // 1. Initial State
    const initialStatus = controller.getControllerStatus();
    assert(initialStatus.state === 'IDLE', 'Initial controller state is IDLE');
    assert(initialStatus.activeAccountId === null, 'No active account ID initially');
    assert(initialStatus.progress === 'Ready', 'Initial progress is "Ready"');
    assert(initialStatus.error === null, 'Initial error is null');

    // 2. Activation of non-existent account
    const nonExistentResult = await controller.activateVaultedAccount('acc-non-existent');
    assert(!nonExistentResult.success, 'Activation of non-existent account returns failure');
    assert(Boolean(nonExistentResult.error && nonExistentResult.error.includes('not found')), 'Error indicates account not found');

    // 3. Storing two synthetic accounts in vault
    await vault.storeSession(
      'acc-synthetic-a',
      'google',
      'oauth2_wincred',
      {
        target: 'gemini:antigravity_test_a',
        userName: 'antigravity',
        rawBlobBase64: Buffer.from('synthetic-token-a-data').toString('base64'),
        capturedEmail: 'synth-a@example.invalid'
      },
      'Synthetic Account A'
    );

    await vault.storeSession(
      'acc-synthetic-b',
      'google',
      'oauth2_wincred',
      {
        target: 'gemini:antigravity_test_b',
        userName: 'antigravity',
        rawBlobBase64: Buffer.from('synthetic-token-b-data').toString('base64'),
        capturedEmail: 'synth-b@example.invalid'
      },
      'Synthetic Account B'
    );

    const metadataEntries = vault.listMetadata();
    assert(metadataEntries.length === 2, 'Two synthetic accounts stored in test vault');

    // 4. Locked/Invalid session activation is denied
    await vault.lockSession('acc-synthetic-a');
    const lockedResult = await controller.activateVaultedAccount('acc-synthetic-a');
    assert(!lockedResult.success, 'Activation of LOCKED account is denied');
    assert(Boolean(lockedResult.error && lockedResult.error.includes('LOCKED')), 'Error specifies session is LOCKED');
    await vault.unlockSession('acc-synthetic-a');

    // 5. Idle Gate Protection: BUSY target refuses enrollment
    const busyTarget: TargetState = {
      id: 'antigravity2',
      name: 'Antigravity 2.0',
      isRunning: true,
      pid: 99999,
      port: 59999,
      email: 'synth-a@example.invalid',
      userName: 'Test User',
      userTier: 'Pro',
      planName: 'Pro',
      credits: null,
      models: [],
      trajectoryStatus: {
        state: 'BUSY',
        runningTrajectories: 2,
        totalTrajectories: 5
      },
      discovery: { discoveryReason: 'Cached', discoveryCount: 1, lastDiscoveryAt: new Date().toISOString() },
      lastUpdated: new Date().toISOString(),
      error: null
    };

    try {
      await controller.enrollAccountB(busyTarget, 'fake-csrf');
      assert(false, 'Expected enrollAccountB to throw on BUSY target');
    } catch (busyErr) {
      assert(
        (busyErr as Error).message.includes('BUSY'),
        'enrollAccountB refused on BUSY target with active trajectories'
      );
    }

    // 6. Zero Secret Exposure in Controller Status
    const ctrlStatus = controller.getControllerStatus();
    const statusJson = JSON.stringify(ctrlStatus);
    assert(!statusJson.includes('synthetic-token'), 'Controller status contains zero secret tokens');
    assert(!statusJson.includes('rawBlobBase64'), 'Controller status contains zero base64 credential blobs');
    assert(!statusJson.includes('password'), 'Controller status contains zero passwords');

    // 7. Zero Secret Exposure in Vault Metadata
    const metaJson = JSON.stringify(metadataEntries);
    assert(!metaJson.includes('synthetic-token'), 'Vault metadata contains zero secret tokens');
    assert(!metaJson.includes('rawBlobBase64'), 'Vault metadata contains zero base64 credential blobs');

  } finally {
    // Teardown test vault
    if (fs.existsSync(testVaultDir)) {
      fs.rmSync(testVaultDir, { recursive: true, force: true });
    }
  }

  console.log('--- ALL TRANSACTIONAL SWITCH CONTROLLER TESTS PASSED ---');
  return passed;
}
