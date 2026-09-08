# Shared Multi-Target Account Vault

## Overview

The Shared Multi-Target Account Vault is the security core of Antigravity Manager. It securely persists and isolates authentication credentials across multiple Google accounts for both **Antigravity 2.0** and **Antigravity IDE**.

---

## Vault Architecture & Storage Format

The vault directory (`data/vault/`) contains two primary files:
1. `metadata.json`: Plaintext index storing non-sensitive metadata (account IDs, email addresses, target capabilities, timestamps, and checksums).
2. `sessions.dat`: Encrypted binary container holding credential payloads for all accounts and targets.

### Encryption Standard
- **Algorithm**: Windows Data Protection API (**DPAPI**) via `CryptProtectData` and `CryptUnprotectData`.
- **Scope**: Current Windows User account (`CurrentUser`).
- **Ciphertext Protection**: Ciphertext cannot be decrypted by any other user account on the same machine, or across different machines.

### Vault V2 Schema
In Vault V2, credentials are organized hierarchically by logical account ID, then by target client:

```json
{
  "accounts": {
    "acc-account-a": {
      "targets": {
        "antigravity2": {
          "target": "gemini:antigravity",
          "type": 1,
          "userName": "antigravity",
          "persistence": 2,
          "rawBlobBase64": "<base64-wincred-blob>",
          "capturedEmail": "account-a@example.invalid",
          "capturedAt": "2026-09-08T05:58:29.673Z"
        },
        "ide": {
          "rawItemValue": "<base64-protobuf-state-blob>",
          "tokenInfo": {
            "accessToken": "ya29....",
            "refreshToken": "1//....",
            "expiryDateSeconds": 1788854817,
            "tokenType": "Bearer",
            "isGcpTos": true
          },
          "authStateWithContext": {
            "state": "signedIn"
          },
          "capturedEmail": "account-a@example.invalid",
          "capturedAt": "2026-09-08T06:12:10.120Z"
        }
      }
    }
  }
}
```

---

## Session Isolation & Integrity Verification

### Target Isolation
- Retrieving an `antigravity2` target session returns **only** the WinCred payload; it contains no IDE token information.
- Retrieving an `ide` target session returns **only** the Unified State Sync protobuf structure; it contains no AG2 payload.
- Deleting an `ide` target session from an account retains the `antigravity2` session intact, leaving the logical account active.

### SHA-256 Checksum & Fail-Closed Behavior
- Whenever `sessions.dat` is written, a SHA-256 hash of the ciphertext is computed and saved in `metadata.json`.
- During `vault.init()`, the SHA-256 hash of `sessions.dat` is computed before decryption.
- If the computed hash does not match `metadata.json`, initialization immediately throws `VaultIntegrityError` and aborts. No unverified data is loaded into memory.

---

## Automated Migration from V1 to V2

When an existing V1 vault (single AG2 session per account) is detected:
1. **Pre-Migration Backup**: The vault automatically copies `metadata.json` and `sessions.dat` into `data/vault/backups/backup-v1-<timestamp>/`.
2. **Structural Transformation**: Existing entries are converted into the `targets.antigravity2` structure under each logical account.
3. **Fail-Closed Guarantee**: If decryption, validation, or serialization fails at any step during migration, the migration rolls back and leaves the original V1 files untouched.

---

## Zero Token Leakage Policy

The vault enforces strict redaction policies:
- `metadata.json` never contains access tokens, refresh tokens, auth headers, or raw blobs.
- Audit logs (`[VAULT AUDIT]`) record account IDs, email identities, and operation results, but strictly redact token substrings (`ya29...`, `1//...`).
- When sessions are read from disk for target activation, decrypted secrets reside only in short-lived memory buffers.
