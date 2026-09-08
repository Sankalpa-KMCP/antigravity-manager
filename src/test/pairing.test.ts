import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SessionVault, VaultIntegrityError } from '../vault/vault';
import { VaultAuditLogger } from '../vault/audit';
import { Antigravity2SessionAdapter } from '../vault/targets/antigravity2-session';
import { IDESessionAdapter } from '../vault/targets/ide-session';
import { AccountRegistry, normalizeEmail } from '../pool/account-registry';
import { QuotaCache } from '../pool/quota-cache';
import { PairingController, PairingOptions } from '../vault/pairing-controller';
import { sanitizeObject, sanitizeString } from '../vault/sanitizer';

export async function runPairingTests(): Promise<boolean> {
  console.log('--- RUNNING PHASE 4G CROSS-TARGET PAIRING & SHARED ENROLLMENT TEST SUITE ---');
  let passed = true;

  function assert(cond: boolean, msg: string) {
    if (!cond) {
      console.error(`  FAIL: ${msg}`);
      passed = false;
    } else {
      console.log(`  PASS: ${msg}`);
    }
  }

  const testDir = path.join(process.cwd(), 'data', 'test_pairing_suite');
  const dynamicSecret = `SEC_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  try {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    const auditLogger = new VaultAuditLogger();
    const vault = new SessionVault(testDir, auditLogger);
    await vault.init();

    const testAccountsPath = path.join(testDir, 'accounts.json');
    const registry = new AccountRegistry(testAccountsPath);

    const testQuotaPath = path.join(testDir, 'quota-cache.json');
    const quotaCache = new QuotaCache(testQuotaPath);

    // Register initial logical accounts
    registry.registerObservedAccount({ email: 'account-a@example.invalid', label: 'Account A', priority: 1 });
    registry.registerObservedAccount({ email: 'account-b@example.invalid', label: 'Account B', priority: 2 });
    registry.registerObservedAccount({ email: 'account-c@example.invalid', label: 'Account C', priority: 3 });

    const accAId = registry.getAccount('account-a@example.invalid')!.id;
    const accBId = registry.getAccount('account-b@example.invalid')!.id;
    const accCId = registry.getAccount('account-c@example.invalid')!.id;

    // 1. Initial State: Account A is AG2-only, Account B is IDE-only
    console.log('\n  [1. Initial Vault State Setup]');
    const ag2PayloadA = {
      target: 'gemini:antigravity',
      type: 1,
      userName: 'antigravity',
      persistence: 2,
      rawBlobBase64: Buffer.from(JSON.stringify({ access_token: `ag2-token-a-${dynamicSecret}`, refresh_token: 'ref-a' })).toString('base64'),
      capturedEmail: 'account-a@example.invalid',
      capturedAt: new Date().toISOString()
    };
    await vault.storeTargetSession(accAId, 'antigravity2', ag2PayloadA, 'Initial AG2 session A');

    const idePayloadB = {
      rawItemValue: Buffer.from(`oauthTokenInfoSentinelKey-test-${dynamicSecret}`).toString('base64'),
      tokenInfo: {
        accessToken: `ide-token-b-${dynamicSecret}`,
        refreshToken: 'ref-b',
        expiryDateSeconds: Math.floor(Date.now() / 1000) + 3600
      },
      capturedEmail: 'account-b@example.invalid',
      capturedAt: new Date().toISOString()
    };
    await vault.storeTargetSession(accBId, 'ide', idePayloadB, 'Initial IDE session B');

    let capsA = vault.getTargetCapabilities(accAId);
    let capsB = vault.getTargetCapabilities(accBId);
    assert(capsA.antigravity2.sessionStored === true && capsA.ide.sessionStored === false, 'Account A is initially AG2-only');
    assert(capsB.antigravity2.sessionStored === false && capsB.ide.sessionStored === true, 'Account B is initially IDE-only');

    // 2. AG2-only -> Add IDE session
    console.log('\n  [2. AG2-Only -> Add IDE Target Session]');
    const idePayloadA = {
      rawItemValue: Buffer.from(`oauthTokenInfoSentinelKey-ide-a-${dynamicSecret}`).toString('base64'),
      tokenInfo: {
        accessToken: `ide-token-a-${dynamicSecret}`,
        refreshToken: 'ref-ide-a',
        expiryDateSeconds: Math.floor(Date.now() / 1000) + 3600
      },
      capturedEmail: 'account-a@example.invalid',
      capturedAt: new Date().toISOString()
    };
    await vault.storeTargetSession(accAId, 'ide', idePayloadA, 'Added IDE session for Account A');

    capsA = vault.getTargetCapabilities(accAId);
    assert(capsA.antigravity2.sessionStored === true && capsA.ide.sessionStored === true, 'Account A now holds BOTH AG2 and IDE targets');
    
    // Check that accounts list has exactly 2 accounts (no duplicates created)
    let accountsList = vault.listAccounts();
    assert(accountsList.length === 2, 'Vault still has exactly 2 accounts (no duplicate logical record created)');
    assert(accountsList.find(a => a.accountId === accAId)?.targets.ide !== undefined, 'Account A metadata contains targets.ide');
    assert(accountsList.find(a => a.accountId === accAId)?.targets.antigravity2 !== undefined, 'Account A metadata contains targets.antigravity2');

    // 3. IDE-only -> Add AG2 session
    console.log('\n  [3. IDE-Only -> Add AG2 Target Session]');
    const ag2PayloadB = {
      target: 'gemini:antigravity',
      type: 1,
      userName: 'antigravity',
      persistence: 2,
      rawBlobBase64: Buffer.from(JSON.stringify({ access_token: `ag2-token-b-${dynamicSecret}`, refresh_token: 'ref-ag2-b' })).toString('base64'),
      capturedEmail: 'account-b@example.invalid',
      capturedAt: new Date().toISOString()
    };
    await vault.storeTargetSession(accBId, 'antigravity2', ag2PayloadB, 'Added AG2 session for Account B');

    capsB = vault.getTargetCapabilities(accBId);
    assert(capsB.antigravity2.sessionStored === true && capsB.ide.sessionStored === true, 'Account B now holds BOTH IDE and AG2 targets');
    accountsList = vault.listAccounts();
    assert(accountsList.length === 2, 'Vault still has exactly 2 accounts');

    // 4. Verification of Both-Target In-Memory and Decrypted Retrieval
    console.log('\n  [4. Dual-Target Payload Retrieval & Integrity]');
    const retrievedA_AG2 = await vault.getTargetSession(accAId, 'antigravity2');
    const retrievedA_IDE = await vault.getTargetSession(accAId, 'ide');
    assert(retrievedA_AG2 !== null && retrievedA_AG2.payload.target === 'gemini:antigravity', 'Account A AG2 payload retrieved correctly');
    assert(retrievedA_IDE !== null && retrievedA_IDE.payload.tokenInfo.accessToken.includes('ide-token-a'), 'Account A IDE payload retrieved correctly');

    const retrievedB_IDE = await vault.getTargetSession(accBId, 'ide');
    const retrievedB_AG2 = await vault.getTargetSession(accBId, 'antigravity2');
    assert(retrievedB_IDE !== null && retrievedB_IDE.payload.tokenInfo.accessToken.includes('ide-token-b'), 'Account B IDE payload retrieved correctly');
    assert(retrievedB_AG2 !== null && retrievedB_AG2.payload.target === 'gemini:antigravity', 'Account B AG2 payload retrieved correctly');

    // 5. Target Isolation: Removing IDE Leaves AG2 Intact
    console.log('\n  [5. Target Isolation: Deleting Target Session]');
    const deleteIdeA = await vault.deleteTargetSession(accAId, 'ide');
    assert(deleteIdeA === true, 'Deleted IDE target session from Account A');

    capsA = vault.getTargetCapabilities(accAId);
    assert(capsA.ide.sessionStored === false, 'Account A IDE session is now absent');
    assert(capsA.antigravity2.sessionStored === true, 'Account A AG2 session remains intact');

    const verifyA_AG2 = await vault.getTargetSession(accAId, 'antigravity2');
    assert(verifyA_AG2 !== null && verifyA_AG2.metadata.status === 'VALID', 'Account A AG2 session is still VALID and decryptable');

    // Restore IDE session on A for subsequent tests
    await vault.storeTargetSession(accAId, 'ide', idePayloadA, 'Re-paired IDE session for Account A');

    // 6. Target Isolation: Removing AG2 Leaves IDE Intact
    const deleteAg2B = await vault.deleteTargetSession(accBId, 'antigravity2');
    assert(deleteAg2B === true, 'Deleted AG2 target session from Account B');

    capsB = vault.getTargetCapabilities(accBId);
    assert(capsB.antigravity2.sessionStored === false, 'Account B AG2 session is now absent');
    assert(capsB.ide.sessionStored === true, 'Account B IDE session remains intact');

    const verifyB_IDE = await vault.getTargetSession(accBId, 'ide');
    assert(verifyB_IDE !== null && verifyB_IDE.metadata.status === 'VALID', 'Account B IDE session is still VALID and decryptable');

    // Restore AG2 session on B
    await vault.storeTargetSession(accBId, 'antigravity2', ag2PayloadB, 'Re-paired AG2 session for Account B');

    // 7. Pairing Controller Strict Identity Matching
    console.log('\n  [7. Strict Identity Matching Enforcement]');
    const controller = new PairingController(vault, registry, quotaCache);

    // Test duplicate target session prevention
    const dupRes = await controller.enrollTargetSession(accAId, 'antigravity2');
    assert(dupRes.success === true && dupRes.state === 'COMPLETED', 'Duplicate valid target enrollment returns early with COMPLETED');

    // Test non-existent account
    const nonExistentRes = await controller.enrollTargetSession('acc-fake99999', 'ide');
    assert(nonExistentRes.success === false && nonExistentRes.errorCode === 'ACCOUNT_NOT_FOUND', 'Non-existent account rejected with ACCOUNT_NOT_FOUND');

    // 8. Normalized Email Linking
    console.log('\n  [8. Normalized Email Linking]');
    const rawEmailUpper = '  Account-A@EXAMPLE.INVALID  ';
    const normalized = normalizeEmail(rawEmailUpper);
    assert(normalized === 'account-a@example.invalid', 'Email normalization handles leading/trailing whitespace and uppercase');

    // 9. Dashboard Target Coverage Metrics Calculation
    console.log('\n  [9. Dashboard Target Coverage Calculation]');
    const currentAccounts = vault.listAccounts();
    const fullyPaired = currentAccounts.filter(a => a.targets.ide && a.targets.antigravity2).length;
    const coverageRatio = `${fullyPaired} / ${currentAccounts.length} complete`;
    assert(fullyPaired === 2 && currentAccounts.length === 2, `Coverage calculated accurately: ${coverageRatio}`);

    // Add Account C as single-target
    const ag2PayloadC = {
      target: 'gemini:antigravity',
      type: 1,
      userName: 'antigravity',
      persistence: 2,
      rawBlobBase64: Buffer.from(JSON.stringify({ access_token: `token-c-${dynamicSecret}` })).toString('base64'),
      capturedEmail: 'account-c@example.invalid',
      capturedAt: new Date().toISOString()
    };
    await vault.storeTargetSession(accCId, 'antigravity2', ag2PayloadC, 'Initial AG2 session C');

    const updatedAccounts = vault.listAccounts();
    const updatedFullyPaired = updatedAccounts.filter(a => a.targets.ide && a.targets.antigravity2).length;
    const updatedRatio = `${updatedFullyPaired} / ${updatedAccounts.length} complete`;
    assert(updatedFullyPaired === 2 && updatedAccounts.length === 3, `Coverage with 3 accounts: ${updatedRatio}`);

    // 10. Secret Redaction & Token Exposure Prevention
    console.log('\n  [10. Secret Redaction & Zero Prefix Exposure]');
    const rawSecretBlob = {
      accessToken: `ya29.a0AdM_${dynamicSecret}_leak_candidate`,
      refreshToken: `1//0gCcIlQ_${dynamicSecret}_leak_candidate`,
      tokenType: 'Bearer',
      clientSecret: 'super-secret-1234'
    };
    const sanitized = sanitizeObject(rawSecretBlob);
    assert(sanitized.accessToken === '[REDACTED]', 'Access token value strictly redacted to [REDACTED]');
    assert(sanitized.refreshToken === '[REDACTED]', 'Refresh token value strictly redacted to [REDACTED]');
    assert(!JSON.stringify(sanitized).includes('ya29.a0AdM'), 'Zero token prefixes leaked in sanitized object');
    assert(!JSON.stringify(sanitized).includes('1//0gCcIlQ'), 'Zero refresh token prefixes leaked in sanitized object');

    const logStr = `User authenticated with token ya29.a0AdM_xyz and refresh 1//0gCcIlQ_abc`;
    const cleanLog = sanitizeString(logStr);
    assert(!cleanLog.includes('ya29.a0AdM'), 'Zero token prefixes in sanitized log string');
    assert(!cleanLog.includes('1//0gCcIlQ'), 'Zero refresh token prefixes in sanitized log string');

    // Clean up temporary test vault
    fs.rmSync(testDir, { recursive: true, force: true });
    console.log('\n  [11. Cleanup of test directory]');
    assert(!fs.existsSync(testDir), 'Test directory cleaned up cleanly');

  } catch (err: any) {
    console.error('  FATAL PAIRING TEST ERROR:', err);
    passed = false;
  }

  if (passed) {
    console.log('--- ALL PHASE 4G PAIRING TESTS PASSED ---\n');
  } else {
    console.error('--- SOME PHASE 4G PAIRING TESTS FAILED ---\n');
  }

  return passed;
}

if (require.main === module) {
  runPairingTests().then(ok => {
    process.exit(ok ? 0 : 1);
  });
}
