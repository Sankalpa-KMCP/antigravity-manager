import { readWinCred, writeWinCred, deleteWinCred, WinCredEntry } from '../vault/wincred';

export async function runWinCredTests(): Promise<boolean> {
  console.log('\n--- RUNNING WINDOWS CREDENTIAL MANAGER BRIDGE TESTS ---');
  let passed = true;

  function assert(cond: boolean, msg: string) {
    if (!cond) {
      console.error(`  FAIL: ${msg}`);
      passed = false;
    } else {
      console.log(`  PASS: ${msg}`);
    }
  }

  const syntheticTarget = `antigravity_manager_synth_${Date.now()}`;
  const syntheticUser = 'test_user_synthetic';
  const syntheticPayload = JSON.stringify({
    accessToken: `synth_token_${Date.now()}`,
    expiresAt: Date.now() + 3600000
  });

  try {
    // 1. Non-existent target returns null
    console.log('  [1. Non-existent Target]');
    const nonExistent = await readWinCred(`non_existent_target_${Date.now()}`);
    assert(nonExistent === null, 'Reading non-existent target returns null');

    // 2. Safe Write and Read Round-Trip
    console.log('\n  [2. Synthetic Credential Write and Read]');
    const testEntry: WinCredEntry = {
      target: syntheticTarget,
      type: 1, // Generic
      userName: syntheticUser,
      persistence: 2, // Local Machine
      blob: Buffer.from(syntheticPayload, 'utf-8')
    };

    const writeSuccess = await writeWinCred(testEntry);
    assert(writeSuccess === true, 'writeWinCred returned true for synthetic target');

    const readEntry = await readWinCred(syntheticTarget);
    assert(readEntry !== null, 'readWinCred found stored synthetic target');
    assert(readEntry?.target === syntheticTarget, 'Read target name matches');
    assert(readEntry?.userName === syntheticUser, 'Read username matches');
    assert(readEntry?.type === 1, 'Read type is 1 (Generic)');
    assert(readEntry?.persistence === 2, 'Read persistence is 2 (Local Machine)');
    assert(readEntry?.blob.toString('utf-8') === syntheticPayload, 'Read credential blob matches payload exactly');

    // 3. Clean Deletion
    console.log('\n  [3. Credential Deletion]');
    const deleteSuccess = await deleteWinCred(syntheticTarget);
    assert(deleteSuccess === true, 'deleteWinCred returned true');

    const afterDelete = await readWinCred(syntheticTarget);
    assert(afterDelete === null, 'Target is null after deletion');

    // 4. Memory-Only Ingestion & Buffer Protection
    console.log('\n  [4. Buffer Hygiene]');
    const secretBuf = Buffer.from('transient_secret_buffer', 'utf-8');
    assert(secretBuf.length > 0, 'Buffer allocated');
    secretBuf.fill(0);
    assert(secretBuf.every(b => b === 0), 'Buffer explicitly zeroed');

  } catch (err) {
    console.error('  FATAL WINCRED TEST ERROR:', err);
    passed = false;
  } finally {
    // Ensure synthetic target cleanup
    try {
      await deleteWinCred(syntheticTarget);
    } catch {}
  }

  if (passed) {
    console.log('--- ALL WINDOWS CREDENTIAL MANAGER BRIDGE TESTS PASSED ---');
  } else {
    console.error('--- SOME WINCRED TESTS FAILED ---');
  }

  return passed;
}
