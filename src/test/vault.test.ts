import fs from 'fs';
import path from 'path';
import { encryptDpapi, decryptDpapi, DpapiError } from '../vault/dpapi';
import {
  SessionVault,
  VaultIntegrityError,
  CURRENT_VAULT_FORMAT_VERSION
} from '../vault/vault';
import {
  sanitizeObject,
  sanitizeString,
  safeJsonStringify,
  isSensitiveKey
} from '../vault/sanitizer';
import { VaultAuditLogger } from '../vault/audit';

export async function runVaultTests(): Promise<boolean> {
  console.log('--- RUNNING VAULT & DPAPI SECURITY TEST SUITE ---');
  let passed = true;

  function assert(cond: boolean, msg: string) {
    if (!cond) {
      console.error(`  FAIL: ${msg}`);
      passed = false;
    } else {
      console.log(`  PASS: ${msg}`);
    }
  }

  // Dynamic token marker generator to prevent hardcoded secret strings on disk
  const markerPrefix = ['SYNTH', 'TOKEN', Date.now().toString()].join('_');
  const makeToken = (suffix: string) => `${markerPrefix}_${suffix}`;

  const tokenA = makeToken('AAA_ACCESS_SECRET');
  const tokenARefresh = makeToken('AAA_REFRESH_SECRET');
  const tokenB = makeToken('BBB_ACCESS_SECRET');
  const tokenBRefresh = makeToken('BBB_REFRESH_SECRET');
  const tokenC = makeToken('CCC_ACCESS_SECRET');

  const testVaultDir = path.join(process.cwd(), 'data', 'vault_test_temp');

  try {
    // 0. Clean up any previous test artifacts
    if (fs.existsSync(testVaultDir)) {
      fs.rmSync(testVaultDir, { recursive: true, force: true });
    }

    // 1. Windows DPAPI Encrypt / Decrypt Round Trip
    console.log('\n  [1. DPAPI Raw Round Trip]');
    const rawPlaintext = `dpapi-test-payload-${Date.now()}`;
    const plainBuf = Buffer.from(rawPlaintext, 'utf-8');
    const encBuf = await encryptDpapi(plainBuf);

    assert(encBuf.length > 0, 'DPAPI encryption produced non-empty ciphertext buffer');
    assert(encBuf.toString('utf-8') !== rawPlaintext, 'Ciphertext differs from plaintext');
    // Verify plaintext buffer was zeroed in memory
    assert(plainBuf.every(b => b === 0), 'Source plaintext buffer explicitly zeroed in memory');

    const decBuf = await decryptDpapi(encBuf);
    assert(decBuf.toString('utf-8') === rawPlaintext, 'DPAPI decryption accurately recovered original plaintext');

    // 2. Secret Redaction / Sanitizer Logic
    console.log('\n  [2. Secret Redaction & Sanitization]');
    assert(isSensitiveKey('access_token'), 'Detects access_token');
    assert(isSensitiveKey('refreshToken'), 'Detects refreshToken');
    assert(isSensitiveKey('id_token'), 'Detects id_token');
    assert(isSensitiveKey('authorization'), 'Detects authorization');
    assert(isSensitiveKey('cookie'), 'Detects cookie');
    assert(isSensitiveKey('password'), 'Detects password');
    assert(isSensitiveKey('secret'), 'Detects secret');
    assert(isSensitiveKey('csrfToken'), 'Detects csrfToken');
    assert(isSensitiveKey('credential'), 'Detects credential');

    const complexNestedObject = {
      user: 'vault-test-a@example.invalid',
      sessionData: {
        access_token: tokenA,
        refreshToken: tokenARefresh,
        inner: {
          client_secret: 'hidden-secret-val',
          publicId: 'public-123'
        }
      },
      tokens: [
        { type: 'id_token', token: 'token-abc' },
        { password: 'super-password', ok: true }
      ],
      authHeader: 'Bearer ' + tokenA
    };

    const sanitized = sanitizeObject(complexNestedObject);
    const sanitizedStr = JSON.stringify(sanitized);

    assert(!sanitizedStr.includes(tokenA), 'Sanitized object does not contain raw access token');
    assert(!sanitizedStr.includes(tokenARefresh), 'Sanitized object does not contain raw refresh token');
    assert(!sanitizedStr.includes('hidden-secret-val'), 'Sanitized object does not contain client_secret');
    assert(!sanitizedStr.includes('super-password'), 'Sanitized object does not contain nested password');
    assert(sanitized.sessionData.access_token === '[REDACTED]', 'access_token redacted to [REDACTED]');
    assert(sanitized.sessionData.refreshToken === '[REDACTED]', 'refreshToken redacted to [REDACTED]');
    assert(sanitized.sessionData.inner.client_secret === '[REDACTED]', 'nested client_secret redacted to [REDACTED]');
    assert(sanitized.sessionData.inner.publicId === 'public-123', 'Non-sensitive field preserved');

    // String redaction
    const rawString = `Authorization: Bearer ${tokenA} and access_token="${tokenB}" in request`;
    const cleanString = sanitizeString(rawString);
    assert(!cleanString.includes(tokenA), 'Bearer token string pattern sanitized');
    assert(!cleanString.includes(tokenB), 'JSON/param string pattern sanitized');

    // 3. Vault Initialization & Permissions
    console.log('\n  [3. Vault Initialization & Persistence]');
    const auditLogger = new VaultAuditLogger();
    const vault = new SessionVault(testVaultDir, auditLogger);
    await vault.init();

    const metadataPath = path.join(testVaultDir, 'metadata.json');
    const sessionsPath = path.join(testVaultDir, 'sessions.dat');

    assert(fs.existsSync(metadataPath), 'metadata.json created upon initial vault setup');
    assert(fs.existsSync(sessionsPath), 'sessions.dat created upon initial vault setup');

    const initialMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    assert(initialMeta.formatVersion === CURRENT_VAULT_FORMAT_VERSION, 'Initial formatVersion is 1');
    assert(initialMeta.encryption === 'DPAPI-CurrentUser', 'Initial encryption is DPAPI-CurrentUser');
    assert(initialMeta.entryCount === 0, 'Initial entryCount is 0');

    // Check that sessions.dat is encrypted binary bytes, not plaintext JSON
    const rawDat = fs.readFileSync(sessionsPath);
    let isPlainJson = false;
    try {
      JSON.parse(rawDat.toString('utf-8'));
      isPlainJson = true;
    } catch {}
    assert(!isPlainJson, 'sessions.dat is not plaintext JSON');
    assert(!rawDat.toString('utf-8').includes('"formatVersion"'), 'sessions.dat does not contain plaintext JSON payload keys');
    assert(!rawDat.toString('utf-8').includes(tokenA), 'sessions.dat does not contain plaintext access token');

    // 4. Storing Multiple Sessions
    console.log('\n  [4. Storing Multiple Synthetic Sessions]');
    await vault.storeSession('vault-test-a@example.invalid', 'google', 'oauth2_refresh_token', {
      accessToken: tokenA,
      refreshToken: tokenARefresh,
      scope: 'email'
    });

    await vault.storeSession('vault-test-b@example.invalid', 'google', 'oauth2_refresh_token', {
      accessToken: tokenB,
      refreshToken: tokenBRefresh
    });

    await vault.storeSession('vault-test-c@example.invalid', 'google', 'oauth2_refresh_token', {
      accessToken: tokenC
    });

    const metaAfterStore = vault.listMetadata();
    assert(metaAfterStore.length === 3, 'Metadata index contains exactly 3 entries');
    assert(
      metaAfterStore.every(m => 
        !JSON.stringify(m).includes(tokenA) && 
        !JSON.stringify(m).includes(tokenB) && 
        !JSON.stringify(m).includes(tokenC) &&
        !(m as any).accessToken && 
        !(m as any).refreshToken
      ),
      'Metadata index exposes ZERO secret tokens'
    );

    // Verify session retrieval
    const retrievedA = await vault.getSession('vault-test-a@example.invalid');
    assert(retrievedA !== null, 'Retrieved session A successfully');
    assert(retrievedA?.payload.accessToken === tokenA, 'Session A access token matches');
    assert(retrievedA?.payload.refreshToken === tokenARefresh, 'Session A refresh token matches');

    const retrievedB = await vault.getSession('vault-test-b@example.invalid');
    assert(retrievedB?.payload.accessToken === tokenB, 'Session B access token matches');

    // 5. Process Restart Persistence (New SessionVault instance pointing to same dir)
    console.log('\n  [5. Process Restart Persistence]');
    const restartedVault = new SessionVault(testVaultDir);
    await restartedVault.init();

    const restartedMeta = restartedVault.listMetadata();
    assert(restartedMeta.length === 3, 'Restarted vault loaded 3 entries from disk');

    const restartedRetrievedB = await restartedVault.getSession('vault-test-b@example.invalid');
    assert(restartedRetrievedB?.payload.accessToken === tokenB, 'Restarted vault decrypted session B successfully');

    // 6. Session Update & Deletion
    console.log('\n  [6. Session Update and Deletion]');
    const updatedTokenB = makeToken('BBB_UPDATED_ACCESS_SECRET');
    await restartedVault.storeSession('vault-test-b@example.invalid', 'google', 'oauth2_refresh_token', {
      accessToken: updatedTokenB,
      refreshToken: tokenBRefresh
    });

    const retrievedUpdatedB = await restartedVault.getSession('vault-test-b@example.invalid');
    assert(retrievedUpdatedB?.payload.accessToken === updatedTokenB, 'Session B payload updated successfully');

    // Delete session C
    const deletedC = await restartedVault.deleteSession('vault-test-c@example.invalid');
    assert(deletedC === true, 'Session C deleted successfully');
    assert(restartedVault.listMetadata().length === 2, 'Entry count reduced to 2 after deletion');
    const retrievedDeletedC = await restartedVault.getSession('vault-test-c@example.invalid');
    assert(retrievedDeletedC === null, 'Session C returns null after deletion');

    // Verify Session A and B still decrypt properly
    const checkA = await restartedVault.getSession('vault-test-a@example.invalid');
    assert(checkA?.payload.accessToken === tokenA, 'Session A remains intact after sibling deletion');

    // 7. Session Lifecycle & Locking
    console.log('\n  [7. Session Locking Lifecycle]');
    await restartedVault.markValidated('vault-test-a@example.invalid');
    assert(restartedVault.listMetadata().find(e => e.accountId === 'vault-test-a@example.invalid')?.status === 'VALID', 'Session marked as VALID');

    await restartedVault.lockSession('vault-test-a@example.invalid');
    assert(restartedVault.listMetadata().find(e => e.accountId === 'vault-test-a@example.invalid')?.status === 'LOCKED', 'Session marked as LOCKED');

    let lockThrew = false;
    try {
      await restartedVault.getSession('vault-test-a@example.invalid');
    } catch (err) {
      lockThrew = true;
    }
    assert(lockThrew, 'Retrieving LOCKED session threw access error');

    await restartedVault.unlockSession('vault-test-a@example.invalid');
    const checkUnlockedA = await restartedVault.getSession('vault-test-a@example.invalid');
    assert(checkUnlockedA?.payload.accessToken === tokenA, 'Unlocked session retrieved successfully');

    // 8. Encrypted Backup Verification
    console.log('\n  [8. Encrypted Backup & Integrity]');
    const backupFile = await restartedVault.backup();
    assert(fs.existsSync(backupFile), 'Backup file created on disk');
    const backupBytes = fs.readFileSync(backupFile);
    let isBackupJson = false;
    try {
      JSON.parse(backupBytes.toString('utf-8'));
      isBackupJson = true;
    } catch {}
    assert(!isBackupJson, 'Backup is not plaintext JSON');
    assert(!backupBytes.toString('utf-8').includes(tokenA), 'Backup contains encrypted ciphertext only (zero plaintext tokens)');

    // Verify atomic temporary files cleaned up
    const vaultFiles = fs.readdirSync(testVaultDir);
    assert(!vaultFiles.some(f => f.endsWith('.tmp')), 'Zero orphaned temporary files in vault directory');

    // 9. Fail-Closed Integrity Checks (Corruption Rejection)
    console.log('\n  [9. Fail-Closed Corruption Rejection]');

    // Corrupt sessions.dat in a copy vault dir
    const corruptVaultDir = path.join(process.cwd(), 'data', 'vault_corrupt_test');
    if (fs.existsSync(corruptVaultDir)) fs.rmSync(corruptVaultDir, { recursive: true, force: true });
    fs.mkdirSync(corruptVaultDir, { recursive: true });

    // Copy valid files
    fs.copyFileSync(metadataPath, path.join(corruptVaultDir, 'metadata.json'));
    const corruptedSessionsBytes = Buffer.from(fs.readFileSync(sessionsPath));
    // Flip bytes inside ciphertext
    corruptedSessionsBytes[30] = (corruptedSessionsBytes[30] ^ 0xff);
    fs.writeFileSync(path.join(corruptVaultDir, 'sessions.dat'), corruptedSessionsBytes);

    const corruptVault = new SessionVault(corruptVaultDir);
    let corruptThrew = false;
    try {
      await corruptVault.init();
    } catch (err) {
      corruptThrew = err instanceof VaultIntegrityError;
    }
    assert(corruptThrew, 'Corrupted ciphertext in sessions.dat rejected with VaultIntegrityError');
    // Ensure corrupted file was NOT deleted or overwritten
    assert(fs.existsSync(path.join(corruptVaultDir, 'sessions.dat')), 'Broken vault file NOT deleted (failed closed)');

    // Unsupported version test
    const badVersionVaultDir = path.join(process.cwd(), 'data', 'vault_bad_version_test');
    if (fs.existsSync(badVersionVaultDir)) fs.rmSync(badVersionVaultDir, { recursive: true, force: true });
    fs.mkdirSync(badVersionVaultDir, { recursive: true });

    const badMeta = {
      formatVersion: 999,
      encryption: 'DPAPI-CurrentUser',
      entryCount: 0,
      updatedAt: new Date().toISOString(),
      checksum: 'fake',
      entries: []
    };
    fs.writeFileSync(path.join(badVersionVaultDir, 'metadata.json'), JSON.stringify(badMeta));
    fs.writeFileSync(path.join(badVersionVaultDir, 'sessions.dat'), Buffer.from('fake'));

    const badVersionVault = new SessionVault(badVersionVaultDir);
    let versionThrew = false;
    try {
      await badVersionVault.init();
    } catch (err) {
      versionThrew = (err instanceof VaultIntegrityError) && (err as Error).message.includes('Unsupported vault format version');
    }
    assert(versionThrew, 'Unsupported vault formatVersion 999 rejected with VaultIntegrityError');

    // Clean up temporary corruption test directories
    fs.rmSync(corruptVaultDir, { recursive: true, force: true });
    fs.rmSync(badVersionVaultDir, { recursive: true, force: true });

    // 10. Audit Logging Security
    console.log('\n  [10. Audit Logger Security]');
    const auditEvents = auditLogger.getEvents();
    assert(auditEvents.length > 0, 'Audit logger captured vault events');
    const auditJson = JSON.stringify(auditEvents);
    assert(!auditJson.includes(tokenA), 'Audit logs contain zero access tokens');
    assert(!auditJson.includes(tokenARefresh), 'Audit logs contain zero refresh tokens');
    assert(!auditJson.includes(tokenB), 'Audit logs contain zero secret strings');

    // Clean up test vault directory before disk scan
    fs.rmSync(testVaultDir, { recursive: true, force: true });

    // 11. Disk Scan for Synthetic Secrets
    console.log('\n  [11. Comprehensive Plaintext Disk Scan]');
    // Search the entire Antigravity-Manager directory for any occurrence of the dynamic markerPrefix
    const filesWithMarker = searchDirectoryForMarker(process.cwd(), markerPrefix);
    assert(
      filesWithMarker.length === 0,
      `Disk scan found 0 plaintext occurrences of synthetic secret marker in ${process.cwd()} (Found: ${filesWithMarker.join(', ') || 'none'})`
    );

  } catch (testErr) {
    console.error('  FATAL TEST ERROR:', testErr);
    passed = false;
  } finally {
    // Ensure cleanup of any temp directories
    if (fs.existsSync(testVaultDir)) {
      fs.rmSync(testVaultDir, { recursive: true, force: true });
    }
  }

  if (passed) {
    console.log('--- ALL VAULT & DPAPI SECURITY TESTS PASSED ---\n');
  } else {
    console.error('--- SOME VAULT TESTS FAILED ---\n');
  }

  return passed;
}

/**
 * Recursively scans directory for any file containing a plaintext marker string,
 * ignoring node_modules and .git.
 */
function searchDirectoryForMarker(dir: string, marker: string): string[] {
  const matches: string[] = [];

  function scan(currentDir: string) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.isFile()) {
        // Exclude the test source file itself where the generator variable is defined
        if (entry.name === 'vault.test.ts' || entry.name === 'vault.test.js') {
          continue;
        }

        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (content.includes(marker)) {
            matches.push(fullPath);
          }
        } catch {
          // Binary or inaccessible file
        }
      }
    }
  }

  scan(dir);
  return matches;
}
