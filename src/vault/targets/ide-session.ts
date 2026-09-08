import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { TargetSessionMetadata, VaultSessionStatus } from '../types';

export interface IDETokenInfo {
  accessToken?: string;
  refreshToken?: string;
  expiryDateSeconds?: number;
  tokenType?: string;
  isGcpTos?: boolean;
}

export interface IDESessionPayload {
  rawItemValue: string; // Base64 serialized protobuf string from state.vscdb
  tokenInfo: IDETokenInfo;
  authStateWithContext?: {
    state?: string;
    context?: Record<string, any>;
  };
  capturedEmail: string;
  capturedAt: string;
}

export class IDESessionAdapter {
  static readonly TARGET_ID = 'ide' as const;
  static readonly DEFAULT_STATE_DB = process.env.ANTIGRAVITY_IDE_STATE_DB || 'D:\\Antigravity-IDE-Data\\user-data\\User\\globalStorage\\state.vscdb';
  static readonly DEFAULT_SQLITE_MODULE = process.env.ANTIGRAVITY_IDE_SQLITE_MODULE || 'D:\\Antigravity IDE\\resources\\app\\node_modules\\@vscode\\sqlite3';

  /**
   * Validates that the payload contains the required IDE session fields.
   */
  static validatePayload(payload: any): payload is IDESessionPayload {
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.rawItemValue !== 'string' || payload.rawItemValue.length === 0) return false;
    if (typeof payload.capturedEmail !== 'string' || payload.capturedEmail.length === 0) return false;
    if (!payload.tokenInfo || typeof payload.tokenInfo !== 'object') return false;
    return true;
  }

  /**
   * Creates initial non-sensitive target session metadata.
   */
  static createInitialMetadata(notes?: string): TargetSessionMetadata {
    const now = new Date().toISOString();
    return {
      target: 'ide',
      capturedAt: now,
      lastValidatedAt: now,
      status: 'VALID',
      notes
    };
  }

  /**
   * Reads the current live IDE session directly from state.vscdb in READ-ONLY mode.
   * Extracts the raw serialized token and parses token metadata without persisting plaintext files.
   */
  static async readCurrentLiveIDESession(
    email: string,
    stateDbPath: string = IDESessionAdapter.DEFAULT_STATE_DB,
    sqliteModulePath: string = IDESessionAdapter.DEFAULT_SQLITE_MODULE
  ): Promise<IDESessionPayload> {
    if (!fs.existsSync(stateDbPath)) {
      throw new Error(`IDE state database not found at: ${stateDbPath}`);
    }

    if (!fs.existsSync(sqliteModulePath)) {
      throw new Error(`@vscode/sqlite3 native module not found at: ${sqliteModulePath}`);
    }

    const Database = require(sqliteModulePath);
    const db = new Database.Database(stateDbPath, Database.OPEN_READONLY);

    return new Promise((resolve, reject) => {
      db.get(
        "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.oauthToken'",
        (err: Error | null, row?: { value: string }) => {
          db.close();

          if (err) {
            return reject(new Error(`Failed to read state.vscdb: ${err.message}`));
          }
          if (!row || !row.value) {
            return reject(new Error("Key 'antigravityUnifiedStateSync.oauthToken' not found in state.vscdb"));
          }

          try {
            const rawItemValue = row.value;
            const parsedToken = IDESessionAdapter.parseRawItemValue(rawItemValue);

            const payload: IDESessionPayload = {
              rawItemValue,
              tokenInfo: parsedToken.tokenInfo,
              authStateWithContext: parsedToken.authStateWithContext,
              capturedEmail: email,
              capturedAt: new Date().toISOString()
            };

            resolve(payload);
          } catch (parseErr) {
            reject(new Error(`Failed to parse IDE session from state.vscdb: ${(parseErr as Error).message}`));
          }
        }
      );
    });
  }

  /**
   * Internal parser for the base64-encoded protobuf item from state.vscdb.
   */
  static parseRawItemValue(rawItemValue: string): {
    tokenInfo: IDETokenInfo;
    authStateWithContext?: { state?: string; context?: Record<string, any> };
  } {
    const outerBuf = Buffer.from(rawItemValue, 'base64');
    const outerStr = outerBuf.toString('binary');

    const tokenInfo: IDETokenInfo = {};
    let authStateWithContext: { state?: string; context?: Record<string, any> } | undefined;

    // 1. Find and parse authStateWithContext JSON
    const jsonMatch = outerStr.match(/\{"state":[^}]+\}/);
    if (jsonMatch) {
      try {
        const j = JSON.parse(jsonMatch[0]);
        authStateWithContext = {
          state: j.state,
          context: j.context
        };
      } catch (_) {}
    }

    // 2. Find and parse oauthTokenInfoSentinelKey inner protobuf
    const idx = outerStr.indexOf('oauthTokenInfoSentinelKey');
    if (idx !== -1) {
      const sub = outerStr.substring(idx + 'oauthTokenInfoSentinelKey'.length);
      const m = sub.match(/([A-Za-z0-9+/=]{100,})/);
      if (m) {
        const innerBuf = Buffer.from(m[1], 'base64');
        try {
          let offset = 0;
          const readVarint = () => {
            let res = 0;
            let shift = 0;
            while (offset < innerBuf.length) {
              const b = innerBuf[offset++];
              res |= (b & 0x7f) << shift;
              if (!(b & 0x80)) break;
              shift += 7;
            }
            return res;
          };

          while (offset < innerBuf.length) {
            const tag = readVarint();
            const fieldNum = tag >> 3;
            const wireType = tag & 0x7;
            if (wireType === 2) {
              const len = readVarint();
              const slice = innerBuf.subarray(offset, offset + len);
              offset += len;
              if (fieldNum === 1) {
                tokenInfo.accessToken = slice.toString('utf8');
              } else if (fieldNum === 2) {
                tokenInfo.tokenType = slice.toString('utf8');
              } else if (fieldNum === 3) {
                tokenInfo.refreshToken = slice.toString('utf8');
              } else if (fieldNum === 4) {
                // expiry submessage: field 1 = seconds (varint)
                let subOff = 0;
                while (subOff < slice.length) {
                  const sTag = slice[subOff++];
                  const sNum = sTag >> 3;
                  const sWire = sTag & 0x7;
                  if (sWire === 0 && sNum === 1) {
                    let sVal = 0;
                    let sShift = 0;
                    while (subOff < slice.length) {
                      const sb = slice[subOff++];
                      sVal |= (sb & 0x7f) << sShift;
                      if (!(sb & 0x80)) break;
                      sShift += 7;
                    }
                    tokenInfo.expiryDateSeconds = sVal;
                  } else {
                    break;
                  }
                }
              }
            } else if (wireType === 0) {
              const v = readVarint();
              if (fieldNum === 5) {
                tokenInfo.isGcpTos = Boolean(v);
              }
            } else {
              break;
            }
          }
        } finally {
          innerBuf.fill(0);
        }
      }
    }

    outerBuf.fill(0);
    return { tokenInfo, authStateWithContext };
  }

  /**
   * Sanitizes payload for logging/reporting (redacts raw tokens).
   */
  static sanitizeForReporting(payload: IDESessionPayload): Record<string, any> {
    return {
      rawItemLength: payload.rawItemValue ? payload.rawItemValue.length : 0,
      hasAccessToken: Boolean(payload.tokenInfo?.accessToken),
      accessTokenLength: payload.tokenInfo?.accessToken ? payload.tokenInfo.accessToken.length : 0,
      hasRefreshToken: Boolean(payload.tokenInfo?.refreshToken),
      refreshTokenLength: payload.tokenInfo?.refreshToken ? payload.tokenInfo.refreshToken.length : 0,
      expiryDateSeconds: payload.tokenInfo?.expiryDateSeconds,
      tokenType: payload.tokenInfo?.tokenType,
      isGcpTos: payload.tokenInfo?.isGcpTos,
      authState: payload.authStateWithContext?.state,
      capturedEmail: payload.capturedEmail,
      capturedAt: payload.capturedAt
    };
  }
}
