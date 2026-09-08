import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SessionVault, VaultIntegrityError } from '../vault/vault';
import { encryptDpapi } from '../vault/dpapi';
import { Antigravity2SessionAdapter } from '../vault/targets/antigravity2-session';
import { IDESessionAdapter } from '../vault/targets/ide-session';
import { normalizeEmail, AccountRegistry } from '../pool/account-registry';
import { VaultSessionManager } from '../vault/session-manager';
import { TargetState } from '../types';

export async function runSharedVaultTests(): Promise<boolean> {
  console.log('--- RUNNING PHASE 4F SHARED VAULT & MULTI-TARGET TEST SUITE ---');
  let passed = true;

  function assert(cond: boolean, msg: string) {
    if (!cond) {
      console.error(`  FAIL: ${msg}`);
      passed = false;
    } else {
      console.log(`  PASS: ${msg}`);
    }
  }

  const testVaultDir = path.join(process.cwd(), 'data', 'shared_vault_test_temp');
  const dynamicSecretPrefix = `SEC_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const makeSecret = (suffix: string) => `${dynamicSecretPrefix}_${suffix}`;

  try {
    if (fs.existsSync(testVaultDir)) {
      fs.rmSync(testVaultDir, { recursive: true, force: true });
    }

    // 1. Existing AG2 V1 Vault Migration
    console.log('\n  [1. Backward-Compatible V1 -> V2 Migration]');
    fs.mkdirSync(testVaultDir, { recursive: true });

    const v1SecretA = makeSecret('AG2_V1_TOKEN_A');
    const v1SecretB = makeSecret('AG2_V1_TOKEN_B');

    // Synthesize a valid V1 container and metadata
    const v1Container = {
      formatVersion: 1,
      sessions: {
        'acc-test-account-a': {
          target: 'gemini:antigravity',
          type: 1,
          userName: 'antigravity',
          persistence: 2,
          rawBlobBase64: Buffer.from(JSON.stringify({ access_token: v1SecretA, refresh_token: 'ref-a' })).toString('base64'),
          capturedEmail: 'test-account-a@example.invalid',
          capturedAt: '2026-09-08T05:58:29.673Z'
        },
        'acc-test-account-b': {
          target: 'gemini:antigravity',
          type: 1,
          userName: 'antigravity',
          persistence: 2,
          rawBlobBase64: Buffer.from(JSON.stringify({ access_token: v1SecretB, refresh_token: 'ref-b' })).toString('base64'),
          capturedEmail: 'test-account-b@example.invalid',
          capturedAt: '2026-09-08T06:38:42.775Z'
        }
      }
    };

    const v1Plain = Buffer.from(JSON.stringify(v1Container), 'utf-8');
    const v1Enc = await encryptDpapi(v1Plain);
    const v1Checksum = crypto.createHash('sha256').update(v1Enc).digest('hex');

    const v1Meta = {
      formatVersion: 1,
      encryption: 'DPAPI-CurrentUser',
      entryCount: 2,
      updatedAt: '2026-09-08T06:40:48.962Z',
      checksum: v1Checksum,
      entries: [
        {
          accountId: 'acc-test-account-a',
          provider: 'google',
          authMethod: 'oauth2_wincred',
          createdAt: '2026-09-08T05:58:29.673Z',
          updatedAt: '2026-09-08T06:40:48.962Z',
          lastValidatedAt: '2026-09-08T06:40:48.962Z',
          status: 'VALID',
          notes: 'Captured live session for test-account-a@example.invalid'
        },
        {
          accountId: 'acc-test-account-b',
          provider: 'google',
          authMethod: 'oauth2_wincred',
          createdAt: '2026-09-08T06:38:42.775Z',
          updatedAt: '2026-09-08T06:40:17.500Z',
          lastValidatedAt: '2026-09-08T06:40:17.500Z',
          status: 'VALID',
          notes: 'Enrolled live account test-account-b@example.invalid'
        }
      ]
    };

    fs.writeFileSync(path.join(testVaultDir, 'sessions.dat'), v1Enc);
    fs.writeFileSync(path.join(testVaultDir, 'metadata.json'), JSON.stringify(v1Meta, null, 2));

    const migrationVault = new SessionVault(testVaultDir);
    await migrationVault.init();

    // Verify V2 migration outcome
    const migratedMetaContent = JSON.parse(fs.readFileSync(path.join(testVaultDir, 'metadata.json'), 'utf-8'));
    assert(migratedMetaContent.formatVersion === 2, 'Vault formatVersion migrated to 2');
    assert(migratedMetaContent.accounts.length === 2, 'Migrated accounts count is 2');
    assert(migratedMetaContent.accounts[0].targets.antigravity2 !== undefined, 'Account 0 contains targets.antigravity2');
    assert(migratedMetaContent.accounts[1].targets.antigravity2 !== undefined, 'Account 1 contains targets.antigravity2');

    // Verify backup created
    const backupDir = path.join(testVaultDir, 'backups');
    assert(fs.existsSync(backupDir) && fs.readdirSync(backupDir).length >= 2, 'Pre-migration backup files created');

    // Verify sessions decrypt properly after migration
    const resA = await migrationVault.getTargetSession('acc-test-account-a', 'antigravity2');
    assert(resA !== null, 'Account A antigravity2 session decrypted successfully');
    const jsonA = JSON.parse(Buffer.from(resA?.payload.rawBlobBase64, 'base64').toString('utf-8'));
    assert(jsonA.access_token === v1SecretA, 'Account A access token recovered intact');

    const resB = await migrationVault.getTargetSession('acc-test-account-b', 'antigravity2');
    assert(resB !== null, 'Account B antigravity2 session decrypted successfully');
    const jsonB = JSON.parse(Buffer.from(resB?.payload.rawBlobBase64, 'base64').toString('utf-8'));
    assert(jsonB.access_token === v1SecretB, 'Account B access token recovered intact');

    // Verify backward-compatible getSession works seamlessly
    const legacyA = await migrationVault.getSession('acc-test-account-a');
    assert(legacyA !== null && legacyA.payload.target === 'gemini:antigravity', 'Backward-compatible getSession returned AG2 session');

    // 2. Rollback on Failed Migration (Checksum Corruption in V1)
    console.log('\n  [2. Migration Fail-Closed Rollback]');
    const corruptV1Dir = path.join(process.cwd(), 'data', 'shared_vault_corrupt_v1');
    if (fs.existsSync(corruptV1Dir)) fs.rmSync(corruptV1Dir, { recursive: true, force: true });
    fs.mkdirSync(corruptV1Dir, { recursive: true });

    fs.writeFileSync(path.join(corruptV1Dir, 'metadata.json'), JSON.stringify(v1Meta, null, 2));
    const badBytes = Buffer.from(v1Enc);
    badBytes[10] ^= 0xff; // corrupt
    fs.writeFileSync(path.join(corruptV1Dir, 'sessions.dat'), badBytes);

    const corruptV1Vault = new SessionVault(corruptV1Dir);
    let corruptV1Threw = false;
    try {
      await corruptV1Vault.init();
    } catch (err) {
      corruptV1Threw = err instanceof VaultIntegrityError;
    }
    assert(corruptV1Threw, 'Corrupted V1 vault fails closed without migrating');
    fs.rmSync(corruptV1Dir, { recursive: true, force: true });

    // 3. Storing Target Sessions: Shared Account with Both Targets
    console.log('\n  [3. Shared Account with Both Target Sessions]');
    const ideToken = makeSecret('IDE_ACCESS_TOKEN');
    const ideRefreshToken = makeSecret('IDE_REFRESH_TOKEN');

    const idePayload = {
      rawItemValue: Buffer.from(`mock-proto-payload-for-ide-${ideToken}`).toString('base64'),
      tokenInfo: {
        accessToken: ideToken,
        refreshToken: ideRefreshToken,
        expiryDateSeconds: 1788854817,
        tokenType: 'Bearer',
        isGcpTos: true
      },
      authStateWithContext: {
        state: 'signedIn'
      },
      capturedEmail: 'test-account-a@example.invalid',
      capturedAt: new Date().toISOString()
    };

    // Attach IDE session to Account A (now has BOTH antigravity2 and ide)
    await migrationVault.storeTargetSession('acc-test-account-a', 'ide', idePayload, 'Captured IDE session');

    const bothCheck = migrationVault.listAccounts().find(a => a.accountId === 'acc-test-account-a');
    assert(bothCheck !== undefined, 'Account A found in shared accounts');
    assert(bothCheck?.targets.antigravity2 !== undefined, 'Account A has targets.antigravity2');
    assert(bothCheck?.targets.ide !== undefined, 'Account A has targets.ide');

    const bothCapabilities = migrationVault.getTargetCapabilities('acc-test-account-a');
    assert(bothCapabilities.antigravity2.sessionStored === true, 'AG2 capability sessionStored is true');
    assert(bothCapabilities.ide.sessionStored === true, 'IDE capability sessionStored is true');
    assert(bothCapabilities.antigravity2.activationMode === 'COLD_RESTORE', 'AG2 activation mode is COLD_RESTORE');
    assert(bothCapabilities.ide.activationMode === 'INTERACTIVE_HOT', 'IDE activation mode is INTERACTIVE_HOT');

    // 4. Account with IDE Only
    console.log('\n  [4. Account with IDE Session Only]');
    const ideOnlyEmail = 'ideonly@example.invalid';
    const ideOnlyAccId = 'acc-ideonly';
    const ideOnlyPayload = {
      rawItemValue: Buffer.from('mock-ide-only-proto').toString('base64'),
      tokenInfo: {
        accessToken: makeSecret('IDE_ONLY_ACCESS'),
        refreshToken: makeSecret('IDE_ONLY_REFRESH'),
        tokenType: 'Bearer'
      },
      capturedEmail: ideOnlyEmail,
      capturedAt: new Date().toISOString()
    };

    await migrationVault.storeTargetSession(ideOnlyAccId, 'ide', ideOnlyPayload, 'IDE only session');
    const ideOnlyAcc = migrationVault.listAccounts().find(a => a.accountId === ideOnlyAccId);
    assert(ideOnlyAcc?.targets.ide !== undefined, 'ideOnlyAcc has targets.ide');
    assert(ideOnlyAcc?.targets.antigravity2 === undefined, 'ideOnlyAcc has NO targets.antigravity2');

    const ideOnlyCaps = migrationVault.getTargetCapabilities(ideOnlyAccId);
    assert(ideOnlyCaps.ide.sessionStored === true, 'ideOnlyCaps.ide.sessionStored is true');
    assert(ideOnlyCaps.antigravity2.sessionStored === false, 'ideOnlyCaps.antigravity2.sessionStored is false');

    // 5. Account with AG2 Only
    console.log('\n  [5. Account with AG2 Session Only]');
    const ag2OnlyAcc = migrationVault.listAccounts().find(a => a.accountId === 'acc-test-account-b');
    assert(ag2OnlyAcc?.targets.antigravity2 !== undefined, 'Account B has targets.antigravity2');
    assert(ag2OnlyAcc?.targets.ide === undefined, 'Account B has NO targets.ide');

    const ag2OnlyCaps = migrationVault.getTargetCapabilities('acc-test-account-b');
    assert(ag2OnlyCaps.antigravity2.sessionStored === true, 'ag2OnlyCaps.antigravity2.sessionStored is true');
    assert(ag2OnlyCaps.ide.sessionStored === false, 'ag2OnlyCaps.ide.sessionStored is false');

    // 6. Target Session Isolation
    console.log('\n  [6. Target Session Isolation]');
    // Retrieving AG2 session does not return IDE session data and vice-versa
    const retrievedAg2 = await migrationVault.getTargetSession('acc-test-account-a', 'antigravity2');
    const retrievedIde = await migrationVault.getTargetSession('acc-test-account-a', 'ide');

    assert(retrievedAg2?.payload.target === 'gemini:antigravity', 'AG2 payload isolated to WinCred');
    assert(retrievedIde?.payload.rawItemValue !== undefined, 'IDE payload isolated to USS format');
    assert((retrievedAg2?.payload as any).rawItemValue === undefined, 'AG2 payload does not leak IDE fields');
    assert((retrievedIde?.payload as any).target === undefined, 'IDE payload does not leak AG2 fields');

    // 7. Removing One Target Session without Deleting Logical Account
    console.log('\n  [7. Removing One Target Session without Deleting Account]');
    // Delete IDE session from Account A
    const delIdeOk = await migrationVault.deleteTargetSession('acc-test-account-a', 'ide');
    assert(delIdeOk === true, 'Deleted IDE target session from Account A');

    const accACheck = migrationVault.listAccounts().find(a => a.accountId === 'acc-test-account-a');
    assert(accACheck !== undefined, 'Account A still exists in vault');
    assert(accACheck?.targets.antigravity2 !== undefined, 'Account A still retains antigravity2 session');
    assert(accACheck?.targets.ide === undefined, 'Account A targets.ide is gone');

    const ag2StillDecrypts = await migrationVault.getTargetSession('acc-test-account-a', 'antigravity2');
    assert(ag2StillDecrypts !== null, 'Account A AG2 session still decrypts perfectly');

    // 8. Normalized Cross-Target Account Linking
    console.log('\n  [8. Normalized Cross-Target Account Linking]');
    const testRegistryFile = path.join(testVaultDir, 'test-accounts.json');
    const testRegistry = new AccountRegistry(testRegistryFile);

    testRegistry.registerObservedAccount({
      email: 'Test-Account-A@Example.Invalid', // unnormalized casing
      userName: 'TestUser',
      source: 'manual'
    });

    const matchedAcc = testRegistry.getAccount('test-account-a@example.invalid');
    assert(matchedAcc !== undefined, 'AccountRegistry matched unnormalized email correctly');
    assert(matchedAcc?.id === 'acc-test-account-a', 'Account ID resolved to standard accountId');

    // 9. Zero Token Exposure in Metadata and Audit Logs
    console.log('\n  [9. Zero Token Exposure Verification]');
    const metaList = migrationVault.listAccounts();
    const metaJson = JSON.stringify(metaList);
    assert(!metaJson.includes(dynamicSecretPrefix), 'Account metadata contains ZERO dynamic secrets');

    const rawDatBytes = fs.readFileSync(path.join(testVaultDir, 'sessions.dat'));
    assert(!rawDatBytes.toString('utf-8').includes(dynamicSecretPrefix), 'sessions.dat contains ZERO plaintext tokens on disk');

    // 10. Clean up test vault
    fs.rmSync(testVaultDir, { recursive: true, force: true });
    console.log('\n  [10. Cleaned up temporary test artifacts]');

  } catch (err) {
    console.error('  FATAL SHARED VAULT TEST ERROR:', err);
    passed = false;
  } finally {
    if (fs.existsSync(testVaultDir)) {
      fs.rmSync(testVaultDir, { recursive: true, force: true });
    }
  }

  if (passed) {
    console.log('--- ALL PHASE 4F SHARED VAULT TESTS PASSED ---\n');
  } else {
    console.error('--- SOME PHASE 4F SHARED VAULT TESTS FAILED ---\n');
  }

  return passed;
}

if (require.main === module) {
  runSharedVaultTests().then(ok => {
    process.exit(ok ? 0 : 1);
  });
}
