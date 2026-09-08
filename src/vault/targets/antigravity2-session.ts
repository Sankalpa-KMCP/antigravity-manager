import crypto from 'crypto';
import { TargetSessionMetadata, VaultSessionStatus } from '../types';

export interface Antigravity2SessionPayload {
  target: string;         // 'gemini:antigravity'
  type: number;           // 1 (CRED_TYPE_GENERIC)
  userName: string;       // 'antigravity'
  persistence: number;    // 2 (CRED_PERSIST_LOCAL_MACHINE)
  rawBlobBase64: string;  // Base64 encoded JSON credential blob
  capturedEmail?: string;
  capturedAt: string;
}

export class Antigravity2SessionAdapter {
  static readonly TARGET_ID = 'antigravity2' as const;

  /**
   * Validates that the payload contains required WinCred fields and valid base64 credential blob.
   */
  static validatePayload(payload: any): payload is Antigravity2SessionPayload {
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.rawBlobBase64 !== 'string' || payload.rawBlobBase64.length === 0) return false;
    if (typeof payload.target !== 'string' || payload.target !== 'gemini:antigravity') return false;
    return true;
  }

  /**
   * Creates initial non-sensitive target session metadata.
   */
  static createInitialMetadata(notes?: string): TargetSessionMetadata {
    const now = new Date().toISOString();
    return {
      target: 'antigravity2',
      capturedAt: now,
      lastValidatedAt: null,
      status: 'VALID',
      notes
    };
  }

  /**
   * Computes a SHA-256 hash of the credential blob for integrity verification without exposing secrets.
   */
  static computeBlobHash(payload: Antigravity2SessionPayload): string {
    const buf = Buffer.from(payload.rawBlobBase64, 'base64');
    try {
      return crypto.createHash('sha256').update(buf).digest('hex');
    } finally {
      buf.fill(0);
    }
  }

  /**
   * Sanitizes payload for logging/reporting (redacts raw credentials).
   */
  static sanitizeForReporting(payload: Antigravity2SessionPayload): Record<string, any> {
    const buf = Buffer.from(payload.rawBlobBase64, 'base64');
    const len = buf.length;
    buf.fill(0);
    return {
      target: payload.target,
      type: payload.type,
      userName: payload.userName,
      persistence: payload.persistence,
      blobByteLength: len,
      capturedEmail: payload.capturedEmail,
      capturedAt: payload.capturedAt
    };
  }
}
