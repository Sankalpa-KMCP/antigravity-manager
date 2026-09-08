import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import {
  AuditEventType,
  DecryptedSessionPayload,
  SharedVaultAccountMetadata,
  SharedVaultContainer,
  TargetCapabilities,
  TargetId,
  TargetSessionMetadata,
  VaultHeader,
  VaultMetadataFile,
  VaultSessionEntry,
  VaultSessionStatus,
  VaultStoreContainer,
  VaultStoreContainerV1
} from './types';
import { decryptDpapi, encryptDpapi } from './dpapi';
import { VaultAuditLogger } from './audit';
import { sanitizeObject } from './sanitizer';

export const CURRENT_VAULT_FORMAT_VERSION = 2;
export const CURRENT_ENCRYPTION_SCHEME = 'DPAPI-CurrentUser';

export class VaultIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultIntegrityError';
  }
}

export class VaultOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultOperationError';
  }
}

/**
 * Production-quality local encrypted session vault.
 * Secures multi-target account session credentials using Windows DPAPI scoped to CurrentUser.
 * Separates non-sensitive metadata index from DPAPI-encrypted payload.
 * Strictly fails closed on corruption or format mismatch.
 */
export class SessionVault {
  private readonly vaultDir: string;
  private readonly metadataPath: string;
  private readonly sessionsDataPath: string;
  private readonly auditLogger: VaultAuditLogger;
  private isInitialized = false;

  constructor(vaultDir?: string, auditLogger?: VaultAuditLogger) {
    this.vaultDir = vaultDir || path.join(process.cwd(), 'data', 'vault');
    this.metadataPath = path.join(this.vaultDir, 'metadata.json');
    this.sessionsDataPath = path.join(this.vaultDir, 'sessions.dat');
    this.auditLogger = auditLogger || new VaultAuditLogger();
  }

  getAuditLogger(): VaultAuditLogger {
    return this.auditLogger;
  }

  getVaultDir(): string {
    return this.vaultDir;
  }

  /**
   * Initializes the vault directory, enforces file permissions,
   * validates format version and checksum integrity, and performs atomic migration if V1.
   */
  async init(): Promise<void> {
    if (!fs.existsSync(this.vaultDir)) {
      fs.mkdirSync(this.vaultDir, { recursive: true, mode: 0o700 });
      this.restrictWindowsDirectoryPermissions(this.vaultDir);
    }

    const metadataExists = fs.existsSync(this.metadataPath);
    const sessionsExists = fs.existsSync(this.sessionsDataPath);

    // Initial first-time setup: create empty secure vault (Format Version 2)
    if (!metadataExists && !sessionsExists) {
      const initialContainer: SharedVaultContainer = {
        formatVersion: CURRENT_VAULT_FORMAT_VERSION,
        accounts: {}
      };

      const plainBuffer = Buffer.from(JSON.stringify(initialContainer), 'utf-8');
      const encryptedBuffer = await encryptDpapi(plainBuffer);

      // Write initial files atomically
      this.atomicWriteFile(this.sessionsDataPath, encryptedBuffer);

      const checksum = this.computeSha256(encryptedBuffer);
      const initialMetadata: VaultMetadataFile = {
        formatVersion: CURRENT_VAULT_FORMAT_VERSION,
        encryption: CURRENT_ENCRYPTION_SCHEME,
        accountCount: 0,
        entryCount: 0,
        updatedAt: new Date().toISOString(),
        checksum,
        accounts: [],
        entries: []
      };

      this.atomicWriteFile(this.metadataPath, Buffer.from(JSON.stringify(initialMetadata, null, 2), 'utf-8'));

      this.auditLogger.record('VAULT_INIT', true, undefined, { action: 'initial_creation', formatVersion: 2 });
      this.isInitialized = true;
      return;
    }

    // Fail closed if state is inconsistent
    if (metadataExists && !sessionsExists) {
      const err = new VaultIntegrityError('Vault metadata exists but encrypted sessions.dat is missing. Failing closed.');
      this.auditLogger.record('CORRUPTION_DETECTED', false, undefined, { error: err.message });
      throw err;
    }

    if (!metadataExists && sessionsExists) {
      const err = new VaultIntegrityError('Encrypted sessions.dat exists but metadata.json is missing. Failing closed.');
      this.auditLogger.record('CORRUPTION_DETECTED', false, undefined, { error: err.message });
      throw err;
    }

    // Check if migration from V1 is required
    const metaContent = fs.readFileSync(this.metadataPath, 'utf-8');
    const rawMeta: VaultMetadataFile = JSON.parse(metaContent);

    if (rawMeta.formatVersion === 1) {
      await this.migrateV1ToV2();
    } else {
      // Both files exist: Validate header, checksum, and decryptability
      await this.verifyIntegrity();
    }

    this.auditLogger.record('VAULT_INIT', true, undefined, { action: 'loaded_existing', formatVersion: CURRENT_VAULT_FORMAT_VERSION });
    this.isInitialized = true;
  }

  /**
   * Performs an atomic, zero-loss migration from V1 (single-session) to V2 (shared multi-target).
   * 1. Verifies V1 integrity.
   * 2. Creates an encrypted backup before any modification.
   * 3. Wraps all existing sessions under targets.antigravity2.
   * 4. Atomically writes V2 sessions.dat and metadata.json.
   * 5. Verifies V2 decryptability and integrity.
   */
  async migrateV1ToV2(): Promise<void> {
    this.auditLogger.record('VAULT_MIGRATION', true, undefined, { step: 'start_migration_v1_to_v2' });

    // 1. Verify V1 integrity
    const metaContent = fs.readFileSync(this.metadataPath, 'utf-8');
    const v1Meta: VaultMetadataFile = JSON.parse(metaContent);

    const sessionsBytes = fs.readFileSync(this.sessionsDataPath);
    const actualChecksum = this.computeSha256(sessionsBytes);
    if (actualChecksum !== v1Meta.checksum) {
      throw new VaultIntegrityError('V1 vault checksum mismatch before migration. Migration aborted.');
    }

    const decryptedBytes = await decryptDpapi(sessionsBytes);
    let v1Container: VaultStoreContainerV1;
    try {
      v1Container = JSON.parse(decryptedBytes.toString('utf-8'));
    } finally {
      decryptedBytes.fill(0);
    }

    // 2. Create encrypted pre-migration backup
    const backupDir = path.join(this.vaultDir, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      this.restrictWindowsDirectoryPermissions(backupDir);
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupSessionsPath = path.join(backupDir, `pre_migration_v1_sessions_${timestamp}.dat`);
    const backupMetadataPath = path.join(backupDir, `pre_migration_v1_metadata_${timestamp}.json`);
    this.atomicWriteFile(backupSessionsPath, sessionsBytes);
    this.atomicWriteFile(backupMetadataPath, Buffer.from(metaContent, 'utf-8'));

    // 3. Build V2 container and metadata
    const v2Container: SharedVaultContainer = {
      formatVersion: 2,
      accounts: {}
    };

    const v2Accounts: SharedVaultAccountMetadata[] = [];
    const legacyEntries: VaultSessionEntry[] = [];
    const v1Entries = v1Meta.entries || [];

    for (const v1Entry of v1Entries) {
      const accId = v1Entry.accountId;
      const payload = v1Container.sessions[accId];
      if (!payload) {
        throw new VaultIntegrityError(`Session entry ${accId} missing in V1 encrypted container during migration.`);
      }

      const targetMeta: TargetSessionMetadata = {
        target: 'antigravity2',
        capturedAt: v1Entry.createdAt,
        lastValidatedAt: v1Entry.lastValidatedAt,
        status: v1Entry.status,
        notes: v1Entry.notes
      };

      v2Container.accounts[accId] = {
        targets: {
          antigravity2: payload
        }
      };

      v2Accounts.push({
        accountId: accId,
        updatedAt: v1Entry.updatedAt || new Date().toISOString(),
        targets: {
          antigravity2: targetMeta
        }
      });

      legacyEntries.push({
        ...v1Entry,
        target: 'antigravity2'
      });
    }

    // 4. Encrypt V2 container
    const v2Json = JSON.stringify(v2Container);
    const v2PlainBuffer = Buffer.from(v2Json, 'utf-8');
    const v2EncryptedBuffer = await encryptDpapi(v2PlainBuffer);
    const v2Checksum = this.computeSha256(v2EncryptedBuffer);

    const v2Meta: VaultMetadataFile = {
      formatVersion: 2,
      encryption: CURRENT_ENCRYPTION_SCHEME,
      accountCount: v2Accounts.length,
      entryCount: legacyEntries.length,
      updatedAt: new Date().toISOString(),
      checksum: v2Checksum,
      accounts: v2Accounts,
      entries: legacyEntries
    };

    // 5. Atomic persistence
    this.atomicWriteFile(this.sessionsDataPath, v2EncryptedBuffer);
    this.atomicWriteFile(this.metadataPath, Buffer.from(JSON.stringify(v2Meta, null, 2), 'utf-8'));

    // 6. Verify V2 integrity
    await this.verifyIntegrity();

    this.auditLogger.record('VAULT_MIGRATION', true, undefined, {
      step: 'completed_migration_v1_to_v2',
      migratedAccounts: v2Accounts.length
    });
  }

  /**
   * Verifies the complete integrity of the vault:
   * 1. Metadata format and schema (V2)
   * 2. SHA-256 checksum of sessions.dat
   * 3. DPAPI decryptability of sessions.dat
   * 4. Inner container format and consistency
   */
  async verifyIntegrity(): Promise<{ valid: boolean; accountCount: number }> {
    if (!fs.existsSync(this.metadataPath) || !fs.existsSync(this.sessionsDataPath)) {
      throw new VaultIntegrityError('Vault files missing during integrity check');
    }

    let metadata: VaultMetadataFile;
    try {
      const metaContent = fs.readFileSync(this.metadataPath, 'utf-8');
      metadata = JSON.parse(metaContent);
    } catch (err) {
      throw new VaultIntegrityError(`Corrupted or unreadable metadata.json: ${(err as Error).message}`);
    }

    if (metadata.formatVersion !== CURRENT_VAULT_FORMAT_VERSION) {
      throw new VaultIntegrityError(`Unsupported vault format version: ${metadata.formatVersion}. Expected ${CURRENT_VAULT_FORMAT_VERSION}`);
    }

    if (metadata.encryption !== CURRENT_ENCRYPTION_SCHEME) {
      throw new VaultIntegrityError(`Unsupported encryption scheme: ${metadata.encryption}. Expected ${CURRENT_ENCRYPTION_SCHEME}`);
    }

    const sessionsBytes = fs.readFileSync(this.sessionsDataPath);
    const actualChecksum = this.computeSha256(sessionsBytes);
    if (actualChecksum !== metadata.checksum) {
      throw new VaultIntegrityError(`Vault checksum mismatch: Expected ${metadata.checksum}, found ${actualChecksum}.`);
    }

    let decryptedBytes: Buffer;
    try {
      decryptedBytes = await decryptDpapi(sessionsBytes);
    } catch (err) {
      throw new VaultIntegrityError(`DPAPI decryption failed: ${(err as Error).message}`);
    }

    try {
      const container: SharedVaultContainer = JSON.parse(decryptedBytes.toString('utf-8'));

      if (container.formatVersion !== CURRENT_VAULT_FORMAT_VERSION) {
        throw new VaultIntegrityError(`Encrypted container formatVersion mismatch: ${container.formatVersion}`);
      }

      const accountKeys = Object.keys(container.accounts || {});
      const expectedCount = metadata.accountCount !== undefined ? metadata.accountCount : (metadata.accounts?.length || 0);

      if (accountKeys.length !== expectedCount) {
        throw new VaultIntegrityError(`Account count mismatch: metadata reports ${expectedCount}, encrypted payload has ${accountKeys.length}`);
      }

      return { valid: true, accountCount: expectedCount };
    } catch (err) {
      if (err instanceof VaultIntegrityError) throw err;
      throw new VaultIntegrityError(`Failed to parse decrypted container payload: ${(err as Error).message}`);
    } finally {
      decryptedBytes.fill(0);
    }
  }

  /**
   * Returns list of shared accounts with target metadata from metadata.json.
   * Does NOT decrypt sessions.dat or expose secrets.
   */
  listAccounts(): SharedVaultAccountMetadata[] {
    this.ensureInitialized();
    const metadata = this.readMetadataFile();
    if (metadata.accounts) {
      return metadata.accounts.map(acc => ({
        accountId: acc.accountId,
        updatedAt: acc.updatedAt,
        targets: { ...acc.targets }
      }));
    }
    return [];
  }

  /**
   * Retrieves non-sensitive account metadata for a specific accountId.
   */
  getAccount(accountId: string): SharedVaultAccountMetadata | null {
    this.ensureInitialized();
    const metadata = this.readMetadataFile();
    const acc = metadata.accounts?.find(a => a.accountId === accountId);
    if (!acc) return null;
    return {
      accountId: acc.accountId,
      updatedAt: acc.updatedAt,
      targets: { ...acc.targets }
    };
  }

  /**
   * Returns non-sensitive session metadata list directly from metadata.json.
   * Backward-compatible helper for existing UI and switch controller.
   */
  listMetadata(): VaultSessionEntry[] {
    this.ensureInitialized();
    const metadata = this.readMetadataFile();

    if (metadata.entries && metadata.entries.length > 0) {
      return metadata.entries.map(entry => ({ ...entry }));
    }

    // Synthesize entries from accounts for complete backward compatibility
    const entries: VaultSessionEntry[] = [];
    if (metadata.accounts) {
      for (const acc of metadata.accounts) {
        for (const [targetId, tMeta] of Object.entries(acc.targets)) {
          if (!tMeta) continue;
          entries.push({
            accountId: acc.accountId,
            target: targetId as TargetId,
            provider: 'google',
            authMethod: targetId === 'ide' ? 'oauth2_uss' : 'oauth2_wincred',
            createdAt: tMeta.capturedAt,
            updatedAt: acc.updatedAt,
            lastValidatedAt: tMeta.lastValidatedAt,
            status: tMeta.status,
            notes: tMeta.notes
          });
        }
      }
    }
    return entries;
  }

  /**
   * Retrieves non-sensitive target capabilities for an account.
   */
  getTargetCapabilities(accountId: string): TargetCapabilities {
    this.ensureInitialized();
    const metadata = this.readMetadataFile();
    const acc = metadata.accounts?.find(a => a.accountId === accountId);

    return {
      antigravity2: {
        sessionStored: Boolean(acc?.targets?.antigravity2),
        activationMode: 'COLD_RESTORE'
      },
      ide: {
        sessionStored: Boolean(acc?.targets?.ide),
        activationMode: 'INTERACTIVE_HOT'
      }
    };
  }

  /**
   * Stores a target session into the DPAPI vault under the specified logical accountId.
   */
  async storeTargetSession(
    accountId: string,
    targetId: TargetId,
    payload: any,
    notes?: string
  ): Promise<TargetSessionMetadata> {
    this.ensureInitialized();

    if (!accountId || typeof accountId !== 'string') {
      throw new VaultOperationError('Valid accountId is required');
    }

    const container = await this.readEncryptedContainer();
    const metadata = this.readMetadataFile();

    const now = new Date().toISOString();

    if (!container.accounts[accountId]) {
      container.accounts[accountId] = { targets: {} };
    }
    container.accounts[accountId].targets[targetId] = { ...payload };

    if (!metadata.accounts) {
      metadata.accounts = [];
    }

    let accountMeta = metadata.accounts.find(a => a.accountId === accountId);
    if (!accountMeta) {
      accountMeta = {
        accountId,
        updatedAt: now,
        targets: {}
      };
      metadata.accounts.push(accountMeta);
    }

    const existingTargetMeta = accountMeta.targets[targetId];
    const targetMeta: TargetSessionMetadata = {
      target: targetId,
      capturedAt: existingTargetMeta ? existingTargetMeta.capturedAt : now,
      lastValidatedAt: existingTargetMeta ? existingTargetMeta.lastValidatedAt : null,
      status: existingTargetMeta ? existingTargetMeta.status : 'VALID',
      notes: notes || existingTargetMeta?.notes
    };

    accountMeta.targets[targetId] = targetMeta;
    accountMeta.updatedAt = now;

    // Maintain backward-compatible legacy entries
    this.syncLegacyEntries(metadata);

    // Encrypt and persist
    await this.persistContainerAndMetadata(container, metadata);

    this.auditLogger.record('TARGET_SESSION_STORED', true, accountId, { targetId });
    return targetMeta;
  }

  /**
   * Retrieves a target session payload for controlled activation or verification.
   */
  async getTargetSession(
    accountId: string,
    targetId: TargetId
  ): Promise<{ metadata: TargetSessionMetadata; payload: any } | null> {
    this.ensureInitialized();

    const metadata = this.readMetadataFile();
    const acc = metadata.accounts?.find(a => a.accountId === accountId);
    if (!acc || !acc.targets[targetId]) {
      return null;
    }

    const tMeta = acc.targets[targetId]!;
    if (tMeta.status === 'LOCKED') {
      this.auditLogger.record('ACCESS_DENIED', false, accountId, { reason: 'session_locked', targetId });
      throw new VaultOperationError(`Target session ${targetId} for ${accountId} is LOCKED`);
    }

    const container = await this.readEncryptedContainer();
    const accData = container.accounts[accountId];
    const targetPayload = accData?.targets[targetId];

    if (!targetPayload) {
      throw new VaultIntegrityError(`Target session ${targetId} for ${accountId} exists in metadata but not in encrypted store`);
    }

    this.auditLogger.record('TARGET_SESSION_RETRIEVED', true, accountId, { targetId });
    return {
      metadata: { ...tMeta },
      payload: { ...targetPayload }
    };
  }

  /**
   * Deletes a specific target session (e.g. removing IDE session without deleting AG2 session).
   */
  async deleteTargetSession(accountId: string, targetId: TargetId): Promise<boolean> {
    this.ensureInitialized();

    const metadata = this.readMetadataFile();
    const acc = metadata.accounts?.find(a => a.accountId === accountId);
    if (!acc || !acc.targets[targetId]) {
      return false;
    }

    const container = await this.readEncryptedContainer();
    if (container.accounts[accountId]?.targets) {
      delete container.accounts[accountId].targets[targetId];
    }
    delete acc.targets[targetId];
    acc.updatedAt = new Date().toISOString();

    // If account has no remaining target sessions, we remove the account from metadata
    if (Object.keys(acc.targets).length === 0 && metadata.accounts) {
      const idx = metadata.accounts.findIndex(a => a.accountId === accountId);
      if (idx !== -1) {
        metadata.accounts.splice(idx, 1);
      }
      delete container.accounts[accountId];
    }

    this.syncLegacyEntries(metadata);
    await this.persistContainerAndMetadata(container, metadata);

    this.auditLogger.record('TARGET_SESSION_DELETED', true, accountId, { targetId });
    return true;
  }

  /**
   * Backward-compatible storeSession for callers assuming AG2 session.
   */
  async storeSession(
    accountId: string,
    provider: string,
    authMethod: string,
    payload: DecryptedSessionPayload,
    notes?: string
  ): Promise<VaultSessionEntry> {
    const targetMeta = await this.storeTargetSession(accountId, 'antigravity2', payload, notes);
    return {
      accountId,
      target: 'antigravity2',
      provider,
      authMethod,
      createdAt: targetMeta.capturedAt,
      updatedAt: new Date().toISOString(),
      lastValidatedAt: targetMeta.lastValidatedAt,
      status: targetMeta.status,
      notes: targetMeta.notes
    };
  }

  /**
   * Backward-compatible getSession for callers defaulting to AG2 session.
   */
  async getSession(
    accountId: string,
    targetId: TargetId = 'antigravity2'
  ): Promise<{ entry: VaultSessionEntry; payload: DecryptedSessionPayload } | null> {
    const res = await this.getTargetSession(accountId, targetId);
    if (!res) return null;

    return {
      entry: {
        accountId,
        target: targetId,
        provider: 'google',
        authMethod: targetId === 'ide' ? 'oauth2_uss' : 'oauth2_wincred',
        createdAt: res.metadata.capturedAt,
        updatedAt: res.metadata.capturedAt,
        lastValidatedAt: res.metadata.lastValidatedAt,
        status: res.metadata.status,
        notes: res.metadata.notes
      },
      payload: res.payload
    };
  }

  /**
   * Deletes an entire logical account from the vault.
   */
  async deleteSession(accountId: string): Promise<boolean> {
    this.ensureInitialized();

    const metadata = this.readMetadataFile();
    const idx = metadata.accounts?.findIndex(a => a.accountId === accountId) ?? -1;
    if (idx === -1) {
      return false;
    }

    const container = await this.readEncryptedContainer();
    delete container.accounts[accountId];
    metadata.accounts!.splice(idx, 1);

    this.syncLegacyEntries(metadata);
    await this.persistContainerAndMetadata(container, metadata);

    this.auditLogger.record('SESSION_DELETED', true, accountId);
    return true;
  }

  /**
   * Updates validation timestamp and marks status VALID.
   */
  async markValidated(accountId: string, targetId: TargetId = 'antigravity2'): Promise<void> {
    this.ensureInitialized();
    const metadata = this.readMetadataFile();
    const acc = metadata.accounts?.find(a => a.accountId === accountId);
    if (!acc || !acc.targets[targetId]) {
      throw new VaultOperationError(`Target ${targetId} for account ${accountId} not found in vault`);
    }

    const now = new Date().toISOString();
    acc.targets[targetId]!.lastValidatedAt = now;
    acc.targets[targetId]!.status = 'VALID';
    acc.updatedAt = now;

    this.syncLegacyEntries(metadata);
    this.atomicWriteFile(this.metadataPath, Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8'));
    this.auditLogger.record('SESSION_VALIDATED', true, accountId, { targetId });
  }

  /**
   * Sets status to INVALID.
   */
  async markInvalid(accountId: string, targetId: TargetId = 'antigravity2', reason?: string): Promise<void> {
    this.ensureInitialized();
    const metadata = this.readMetadataFile();
    const acc = metadata.accounts?.find(a => a.accountId === accountId);
    if (!acc || !acc.targets[targetId]) {
      throw new VaultOperationError(`Target ${targetId} for account ${accountId} not found in vault`);
    }

    const now = new Date().toISOString();
    acc.targets[targetId]!.status = 'INVALID';
    acc.updatedAt = now;

    this.syncLegacyEntries(metadata);
    this.atomicWriteFile(this.metadataPath, Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8'));
    this.auditLogger.record('SESSION_INVALIDATED', true, accountId, { targetId, reason });
  }

  /**
   * Locks all target sessions for an account to prevent retrieval/activation.
   */
  async lockSession(accountId: string): Promise<void> {
    this.ensureInitialized();
    const metadata = this.readMetadataFile();
    const acc = metadata.accounts?.find(a => a.accountId === accountId);
    if (!acc) throw new VaultOperationError(`Account ${accountId} not found`);

    for (const tMeta of Object.values(acc.targets)) {
      if (tMeta) tMeta.status = 'LOCKED';
    }
    acc.updatedAt = new Date().toISOString();

    this.syncLegacyEntries(metadata);
    this.atomicWriteFile(this.metadataPath, Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8'));
  }

  /**
   * Unlocks all target sessions for an account.
   */
  async unlockSession(accountId: string): Promise<void> {
    this.ensureInitialized();
    const metadata = this.readMetadataFile();
    const acc = metadata.accounts?.find(a => a.accountId === accountId);
    if (!acc) throw new VaultOperationError(`Account ${accountId} not found`);

    for (const tMeta of Object.values(acc.targets)) {
      if (tMeta) tMeta.status = 'VALID';
    }
    acc.updatedAt = new Date().toISOString();

    this.syncLegacyEntries(metadata);
    this.atomicWriteFile(this.metadataPath, Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8'));
  }

  /**
   * Creates a versioned, encrypted backup of the vault.
   */
  async backup(customBackupDir?: string): Promise<string> {
    this.ensureInitialized();

    const backupDir = customBackupDir || path.join(this.vaultDir, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      this.restrictWindowsDirectoryPermissions(backupDir);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupSessionsFile = path.join(backupDir, `sessions_${timestamp}.dat`);
    const backupMetadataFile = path.join(backupDir, `metadata_${timestamp}.json`);

    await this.verifyIntegrity();

    const currentSessionsBytes = fs.readFileSync(this.sessionsDataPath);
    const currentMetadataBytes = fs.readFileSync(this.metadataPath);

    this.atomicWriteFile(backupSessionsFile, currentSessionsBytes);
    this.atomicWriteFile(backupMetadataFile, currentMetadataBytes);

    const backupBytes = fs.readFileSync(backupSessionsFile);
    const decrypted = await decryptDpapi(backupBytes);
    decrypted.fill(0);

    this.auditLogger.record('BACKUP_CREATED', true, undefined, { backupSessionsFile });
    return backupSessionsFile;
  }

  // --- PRIVATE UTILITIES ---

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new VaultOperationError('SessionVault is not initialized. Call init() first.');
    }
  }

  private readMetadataFile(): VaultMetadataFile {
    if (!fs.existsSync(this.metadataPath)) {
      throw new VaultIntegrityError('metadata.json does not exist');
    }
    const raw = fs.readFileSync(this.metadataPath, 'utf-8');
    return JSON.parse(raw);
  }

  private async readEncryptedContainer(): Promise<SharedVaultContainer> {
    if (!fs.existsSync(this.sessionsDataPath)) {
      throw new VaultIntegrityError('sessions.dat does not exist');
    }

    const encryptedBytes = fs.readFileSync(this.sessionsDataPath);
    let decryptedBytes: Buffer;
    try {
      decryptedBytes = await decryptDpapi(encryptedBytes);
    } catch (err) {
      throw new VaultIntegrityError(`DPAPI decryption failure: ${(err as Error).message}`);
    }

    try {
      const container: SharedVaultContainer = JSON.parse(decryptedBytes.toString('utf-8'));
      if (!container.accounts) {
        container.accounts = {};
      }
      return container;
    } finally {
      decryptedBytes.fill(0);
    }
  }

  private async persistContainerAndMetadata(
    container: SharedVaultContainer,
    metadata: VaultMetadataFile
  ): Promise<void> {
    const now = new Date().toISOString();
    container.formatVersion = CURRENT_VAULT_FORMAT_VERSION;

    const plainBuffer = Buffer.from(JSON.stringify(container), 'utf-8');
    const encryptedBytes = await encryptDpapi(plainBuffer);

    metadata.formatVersion = CURRENT_VAULT_FORMAT_VERSION;
    metadata.accountCount = metadata.accounts?.length || 0;
    metadata.entryCount = metadata.entries?.length || 0;
    metadata.updatedAt = now;
    metadata.checksum = this.computeSha256(encryptedBytes);

    this.atomicWriteFile(this.sessionsDataPath, encryptedBytes);
    this.atomicWriteFile(this.metadataPath, Buffer.from(JSON.stringify(metadata, null, 2), 'utf-8'));
  }

  private syncLegacyEntries(metadata: VaultMetadataFile): void {
    const entries: VaultSessionEntry[] = [];
    if (metadata.accounts) {
      for (const acc of metadata.accounts) {
        for (const [targetId, tMeta] of Object.entries(acc.targets)) {
          if (!tMeta) continue;
          entries.push({
            accountId: acc.accountId,
            target: targetId as TargetId,
            provider: 'google',
            authMethod: targetId === 'ide' ? 'oauth2_uss' : 'oauth2_wincred',
            createdAt: tMeta.capturedAt,
            updatedAt: acc.updatedAt,
            lastValidatedAt: tMeta.lastValidatedAt,
            status: tMeta.status,
            notes: tMeta.notes
          });
        }
      }
    }
    metadata.entries = entries;
    metadata.entryCount = entries.length;
  }

  private atomicWriteFile(targetPath: string, data: Buffer): void {
    const tempPath = `${targetPath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tempPath, 'w', 0o600);
    try {
      fs.writeSync(fd, data, 0, data.length);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, targetPath);
  }

  private computeSha256(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private restrictWindowsDirectoryPermissions(dirPath: string): void {
    if (process.platform !== 'win32') return;
    try {
      const username = process.env.USERNAME;
      if (!username) return;
      exec(`icacls "${dirPath}" /inheritance:r /grant:r "${username}:(OI)(CI)F"`, () => {});
    } catch {}
  }
}
