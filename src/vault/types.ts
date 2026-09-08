export type TargetId = 'antigravity2' | 'ide';

export type VaultSessionStatus = 'ACTIVE' | 'VALID' | 'INVALID' | 'EXPIRED' | 'REVOKED' | 'LOCKED';

/**
 * Non-sensitive descriptor of a specific target session.
 * Exposes only metadata, never secrets.
 */
export interface TargetSessionMetadata {
  target: TargetId;
  capturedAt: string;
  lastValidatedAt: string | null;
  status: VaultSessionStatus;
  notes?: string;
}

/**
 * Non-sensitive metadata for a logical account in the vault.
 * Stored in data/vault/metadata.json (Format Version 2).
 */
export interface SharedVaultAccountMetadata {
  accountId: string;
  updatedAt: string;
  targets: Partial<Record<TargetId, TargetSessionMetadata>>;
}

/**
 * Target activation capabilities model.
 */
export interface TargetCapabilities {
  antigravity2: {
    sessionStored: boolean;
    activationMode: 'COLD_RESTORE' | 'INTERACTIVE_HOT';
  };
  ide: {
    sessionStored: boolean;
    activationMode: 'INTERACTIVE_HOT' | 'UNSUPPORTED_EXTERNAL' | 'UNKNOWN';
  };
}

/**
 * Backward-compatible non-sensitive descriptor for legacy V1 views.
 */
export interface VaultSessionEntry {
  accountId: string;
  target?: TargetId;
  provider: string; // e.g. "google"
  authMethod: string; // e.g. "oauth2_wincred" | "oauth2_uss"
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string | null;
  status: VaultSessionStatus;
  notes?: string;
}

/**
 * Decrypted session payload containing actual authorization secrets.
 * Kept in memory only as long as necessary, then wiped.
 */
export interface DecryptedSessionPayload {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
  rawBlobBase64?: string;
  rawItemValue?: string;
  [key: string]: any;
}

/**
 * Non-sensitive vault format/version header.
 */
export interface VaultHeader {
  formatVersion: number;
  encryption: 'DPAPI-CurrentUser';
  entryCount?: number;
  accountCount?: number;
  updatedAt: string;
}

/**
 * Metadata index file structure stored in data/vault/metadata.json
 */
export interface VaultMetadataFile extends VaultHeader {
  checksum: string; // SHA-256 hex digest of sessions.dat
  accounts?: SharedVaultAccountMetadata[];
  entries?: VaultSessionEntry[]; // V1 fallback/compat
}

/**
 * Container encrypted inside sessions.dat for V1
 */
export interface VaultStoreContainerV1 {
  formatVersion: 1;
  sessions: Record<string, DecryptedSessionPayload>;
}

/**
 * Container encrypted inside sessions.dat for V2
 */
export interface SharedVaultContainer {
  formatVersion: 2;
  accounts: Record<string, {
    targets: Partial<Record<TargetId, any>>;
  }>;
}

/**
 * Union for container types
 */
export type VaultStoreContainer = SharedVaultContainer | VaultStoreContainerV1;

/**
 * Audit log event for vault lifecycle operations.
 */
export type AuditEventType =
  | 'VAULT_INIT'
  | 'VAULT_MIGRATION'
  | 'SESSION_STORED'
  | 'SESSION_RETRIEVED'
  | 'SESSION_DELETED'
  | 'SESSION_VALIDATED'
  | 'SESSION_INVALIDATED'
  | 'TARGET_SESSION_STORED'
  | 'TARGET_SESSION_RETRIEVED'
  | 'TARGET_SESSION_DELETED'
  | 'INTEGRITY_CHECK'
  | 'BACKUP_CREATED'
  | 'CORRUPTION_DETECTED'
  | 'ACCESS_DENIED';

export interface AuditEvent {
  timestamp: string;
  type: AuditEventType;
  accountId?: string;
  details?: Record<string, any>;
  success: boolean;
  error?: string;
}
