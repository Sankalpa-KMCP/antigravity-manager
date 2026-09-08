# System Architecture

## Overview

Antigravity Manager is designed as a modular, lightweight daemon that bridges two distinct developer environments:
- **Antigravity IDE**: A customized VS Code environment running an embedded language server.
- **Antigravity 2.0**: A standalone language server daemon operating as an external assistant hub.

Both applications communicate with local language server processes over Connect-RPC (an HTTP/2 & HTTP/1.1 compatible RPC protocol). Antigravity Manager discovers these endpoints dynamically, collects quota and trajectory telemetry, maintains an encrypted vault of multi-target sessions, and coordinates safe account switching.

```
                  +----------------------------------------------+
                  |              Antigravity Manager             |
                  |             (http://127.0.0.1:39200)         |
                  +----------------------+-----------------------+
                                         |
            +----------------------------+----------------------------+
            |                                                         |
            v                                                         v
  +--------------------+                                    +--------------------+
  |  Antigravity IDE   |                                    |  Antigravity 2.0   |
  |  (Editor Process)  |                                    |  (Standalone LS)   |
  +---------+----------+                                    +---------+----------+
            |                                                         |
            | Connect-RPC                                             | Connect-RPC
            v                                                         v
  +--------------------+                                    +--------------------+
  | Language Server    |                                    | Language Server    |
  | (state.vscdb auth) |                                    | (WinCred auth)     |
  +--------------------+                                    +--------------------+
```

---

## 1. Discovery Subsystem

The Discovery Subsystem is responsible for discovering running target instances with zero user intervention:

### Process & Command-Line Inspection
- Inspects running processes (`language_server.exe`) to determine whether an instance belongs to Antigravity IDE or Antigravity 2.0.
- Extracts process arguments to identify the target type:
  - Antigravity IDE: Started with parent process belonging to VS Code / Antigravity IDE executable.
  - Antigravity 2.0: Started with `--subclient_type hub` and executable paths in `AppData\Local\Programs\antigravity`.
- Extracts `--csrf_token` and `--app_data_dir` directly from process command-line arguments.

### Port Binding Resolution
- Queries active TCP listening sockets bound to the detected process ID.
- Identifies the Connect-RPC HTTP server port dynamically assigned on startup.

### Zero-Steady-State Subprocess Polling
- Initial discovery requires command-line and socket inspection.
- Once a target is discovered, the Manager caches the `pid`, `port`, and `csrfToken`.
- All subsequent status and quota queries execute directly over TCP loopback via `http.request`.
- Steady-state monitoring launches **zero external processes (`powershell.exe` or `netstat.exe`)**.
- If a target terminates or returns a connection error, the Manager smoothly invalidates the cache and transitions to discovery mode.

---

## 2. Telemetry & RPC Client

The Manager communicates with language servers using Connect-RPC JSON over HTTP:
- Endpoint: `/antigravity.v1.AntigravityLanguageServerService/GetUserStatus`
- Headers:
  - `Content-Type: application/json`
  - `X-Csrf-Token: <csrfToken>`
  - `Connect-Protocol-Version: 1`

### Normalized Data Model
The raw RPC response is parsed into clean, strongly-typed internal structures:
1. **User Identity & Tier**: User email, display name, plan tier (`free`, `pro`, `ultra`).
2. **Global Pool Limits**: Available and monthly limits for Prompt and Flow credits.
3. **Model-Specific Quota**: Array of models filtered for high-tier capabilities, normalized with:
   - `modelId` (e.g., `gemini-3.8-flash`, `claude-3.5-sonnet`)
   - `displayName`
   - `remainingPercent`
   - `resetTime` & `timeToReset`
4. **Trajectory Status**: Active tasks and running execution state (`IDLE` vs `BUSY`).

---

## 3. Account Registry & Shared Vault

A multi-account environment requires separating the concept of a **logical account** from a **client target session**:
- **Logical Account**: Represents an individual user identity (e.g., `account-a@example.invalid`), indexed by a unique `accountId` (e.g., `acc-account-a`).
- **Target Session**: Concrete credentials required by a specific target:
  - `antigravity2`: Encrypted Windows Credential Manager blob.
  - `ide`: Protobuf-serialized OAuth token structure from `state.vscdb`.

Both target sessions are stored inside a single encrypted DPAPI vault file (`sessions.dat`), linked by the logical account entry in `metadata.json`.

---

## 4. Quota Router Engine

The Quota Router continuously evaluates target quota levels against configurable thresholds:
- Evaluates individual target models and overall account capacities.
- Computes health state: `HEALTHY` (>30%), `WARNING` (10–30%), `CRITICAL` (1–10%), `EXHAUSTED` (0%).
- Selects the best eligible account using a multi-factor deterministic scoring function.
- Supports **OFF**, **SHADOW**, and **LIVE** operating modes.
- In **SHADOW** mode, decisions and action plans are recorded with zero side effects.
- In **LIVE** mode, switches are executed when safe IDLE conditions are satisfied.
