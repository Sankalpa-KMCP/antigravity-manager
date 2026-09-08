# Security Model & Token Hygiene

## Core Security Tenets

Antigravity Manager manages sensitive developer credentials across multiple accounts. The architecture is engineered around the following security principles:

1. **Zero Credential Exposure in Repositories or Logs**
2. **Local Machine-Bound Encryption (Windows DPAPI)**
3. **Fail-Closed Integrity Verification**
4. **Target Isolation & Least Privilege**
5. **Safe IDLE Boundaries for All Transitions**

---

## 1. At-Rest Credential Encryption

All stored OAuth tokens and session blobs are encrypted using the **Windows Data Protection API (DPAPI)**:
- Method: `CryptProtectData` (via PowerShell or native Node.js addons).
- Scope: `CurrentUser` scope bound to the local Windows login security identifier (SID).
- Impact:
  - Secrets cannot be decrypted by standard processes running under a different user account on the same PC.
  - Secrets cannot be decrypted if copied to another machine or downloaded from a backup.
  - The DPAPI master key is managed and protected directly by the Windows Local Security Authority Subsystem Service (LSASS).

---

## 2. Token Sanitization & Logging Hygiene

The Manager incorporates an active `TokenSanitizer` module that inspects and redacts sensitive strings from all outputs:

### Redaction Rules
- **Google OAuth Access Tokens**: Matches `ya29\.[0-9a-zA-Z\-_]+` -> `ya29.[REDACTED_ACCESS_TOKEN]`.
- **Google OAuth Refresh Tokens**: Matches `1//[0-9a-zA-Z\-_]+` -> `1//[REDACTED_REFRESH_TOKEN]`.
- **Authorization Headers**: Matches `Bearer\s+[^\s]+` -> `Bearer [REDACTED_TOKEN]`.
- **Credential Blobs**: Serialized WinCred and protobuf payloads are stored encrypted on disk and never exposed in REST API responses.

### Intercepted Surfaces
- Console `stdout` and `stderr` logs (`safeLog`).
- Audit event messages emitted to the frontend dashboard.
- REST API response payloads (`/api/status`, `/api/pool`).

---

## 3. IDLE-Gated Safety Boundaries

To prevent corruption of active coding sessions, context loss, or interruption of running agent tasks, all account transitions enforce the **IDLE Safety Gate**:

```
                       [Switch Triggered]
                               |
                               v
               +-------------------------------+
               | Query Target Trajectory State |
               +---------------+---------------+
                               |
             +-----------------+-----------------+
             |                                   |
             v (state !== 'IDLE'                 v (state === 'IDLE' &&
                || activeTrajectories > 0)          activeTrajectories === 0)
   +--------------------+               +--------------------+
   |   WAIT_FOR_IDLE    |               |  Execute Switch    |
   | (Transition Denied)|               | (Preflight Passed) |
   +--------------------+               +--------------------+
```

- If `runningTrajectories > 0` or `trajectoryStatus.state === 'BUSY'`, the Manager immediately refuses the switch and reports `WAITING_FOR_IDLE`.
- Trajectories are never forcibly terminated or interrupted.

---

## 4. Local Loopback Network Binding

The Antigravity Manager HTTP API and Web Dashboard listen strictly on `127.0.0.1`:
- Port: `39200`
- External network interfaces (LAN, WAN, 0.0.0.0) are never bound.
- Connect-RPC requests to local language servers use loopback TCP sockets with mandatory `X-Csrf-Token` validation matching the process arguments.
