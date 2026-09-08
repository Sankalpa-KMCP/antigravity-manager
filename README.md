# Antigravity Manager

Antigravity Manager is an enterprise-grade multi-instance session manager, quota router, and secure account vault designed specifically for **Antigravity IDE** and **Antigravity 2.0**. It provides unified discovery, model-level quota telemetry, cross-target account pooling, zero-steady-state subprocess polling, and safe idle-boundary switching between multiple authorized Google accounts.

---

## Key Capabilities

### 1. Dual-Target Discovery & Unified Telemetry
- Automatically detects running instances of **Antigravity IDE** and **Antigravity 2.0 (Language Server)** via Windows command-line inspection and TCP port binding discovery.
- Polls live status through high-performance Connect-RPC protocol (`/antigravity.v1.AntigravityLanguageServerService/GetUserStatus`).
- Segregates telemetry between targets to prevent cross-contamination while computing global aggregate quota capacities.

### 2. Zero-Steady-State Subprocess Polling
- Caches process IDs, listening ports, and CSRF authentication tokens after initial discovery.
- Subsequent health and quota telemetry polls execute exclusively over local in-memory HTTP/RPC requests.
- **Zero subprocess invocations (`powershell.exe`, `netstat.exe`)** during steady-state monitoring, ensuring minimal CPU overhead and zero window flicker.

### 3. High-Tier Model Quota Filtering
- Normalizes disparate quota formats across Google AI tiers (Free, Google AI Pro, Google AI Ultra).
- Intelligently filters out legacy/medium/low model entries, presenting a curated view of top-tier models (e.g., Gemini 3.8 Flash, Gemini 3.8 Pro, Claude 4.6 Sonnet Thinking).
- Extracts precise reset timestamps and computes dynamic time-to-reset countdowns.

### 4. Shared Multi-Target Account Vault
- Encrypted local persistence utilizing Windows **DPAPI (Data Protection API) CurrentUser** scope.
- Unified storage schema supporting multi-target session binding: a single logical account record holds separate credentials for `antigravity2` (WinCred blob) and `ide` (Unified State Sync / `state.vscdb` format).
- Automated format migration from V1 (single-target) to V2 (shared multi-target) with fail-closed SHA-256 integrity verification and automatic pre-migration backups.
- Complete session isolation: operations targeting one client target never leak or overwrite tokens for another.

### 5. Account Scoring & Intelligent Quota Routing
- **Account Health Classification**: Evaluates accounts dynamically into `HEALTHY`, `WARNING`, `CRITICAL`, or `EXHAUSTED` based on active quota thresholds.
- **Deterministic Candidate Selection**: Multi-factor ranking algorithm prioritizing remaining model quota percentage, account priority weights, freshness penalties, and cooldown windows.
- **Hysteresis, Dwell Time & Cooldowns**: Prevents rapid oscillating switches between accounts ("route flapping") by enforcing minimum quota improvement margins (15%), switch dwell times (120s), and failure cooldowns (300s).
- **Synchronized vs. Independent Routing**: Supports coordinated multi-target switching for project contexts requiring identical identities across both IDE and AG2, or independent switching per target.

### 6. Router Operating Modes
- **`OFF`**: Quota monitoring and telemetry active; no automatic switching or recommendations executed.
- **`SHADOW`**: Real-time evaluation of quota triggers and candidate selection; generates hypothetical action plans (`shadowPlan`) recorded to audit logs with a **strict Zero-Mutation Guarantee**.
- **`LIVE`**: Automated activation planner armed to execute safe account switching at verified idle boundaries.

---

## Authentication & Switching Feasibility: Reality & Architecture

| Target Client | Switching Method | Automation Capability | Process Continuity | User Interaction |
| :--- | :--- | :--- | :--- | :--- |
| **Antigravity 2.0 (AG2)** | Vaulted Credential Restore + Language Server Recycle | **SUPPORTED & FULLY AUTOMATIC** | LS process recycles cleanly; IDE unaffected | **Zero interaction** |
| **Antigravity IDE** | Interactive OAuth Browser Handoff | **SUPPORTED (INTERACTION REQUIRED)** | App & LS remain running; open editors & chats preserved | **Requires user Google auth prompt** |

### Antigravity 2.0: Automatic Stored-Session Switching
- **Verified & Live-Proven**: AG2 stores authentication tokens in Windows Credential Manager (`gemini:antigravity`).
- At a verified IDLE boundary (0 running trajectories), the Manager restores the target account's WinCred credential blob and recycles the AG2 language server process.
- The new AG2 instance initializes authenticated as the chosen account with **zero user OAuth interaction required**. Antigravity IDE and its open chats remain 100% isolated and uninterrupted.

### Antigravity IDE: Interactive-Auth Handoff
- Antigravity IDE manages authentication via VS Code SecretStorage and an internal OAuth loop that hardcodes `prompt=consent`.
- No deterministic `login_hint` parameter is exposed by the installed IDE binary, meaning a silent `prompt=none` unattended flow is unavailable.
- Antigravity Manager implements a safe **Interactive Handoff Controller**: when an IDE switch is required, it arms the session, verifies idle trajectory state, triggers the supported login flow, and tracks completion without app restart or conversation loss.
- Fully unattended, zero-interaction switching for Antigravity IDE is **NOT supported** by the current installed Antigravity authentication interfaces. The Manager adheres strictly to supported interfaces and does not perform unsafe binary patching or memory injection.

---

## Security Model & Protections

1. **At-Rest Encryption**: All session tokens and credential blobs are encrypted with Windows DPAPI bound to the running Windows user account (`CryptProtectData`).
2. **Fail-Closed Integrity**: Vault files (`metadata.json`, `sessions.dat`) carry SHA-256 integrity checksums. Any detected tampering or corruption aborts initialization immediately.
3. **Strict Zero-Token Logging**: Sanitizer interceptors redact Google OAuth access tokens (`ya29...`), refresh tokens (`1//...`), authorization headers, and cookies from all console logs, API responses, and disk traces.
4. **IDLE Safety Gates**: Switching is strictly gated on target trajectory status (`state === 'IDLE'` and `runningTrajectories === 0`), preventing prompt interruption or generation aborts.
5. **Local Loopback Only**: The Manager REST API and dashboard listen exclusively on `127.0.0.1:39200`.

---

## Getting Started

### Prerequisites
- Windows 10/11 (64-bit)
- Node.js >= 18.0.0
- Antigravity IDE and/or Antigravity 2.0 installed

### Installation & Build
```powershell
# Clone the repository
git clone https://github.com/Sankalpa-KMCP/antigravity-manager.git
cd antigravity-manager

# Install dependencies
npm install

# Compile TypeScript and copy UI assets
npm run build
```

### Running the Manager
```powershell
# Start the server (runs on http://127.0.0.1:39200)
npm start
```

### Configuration Templates
Configuration files reside in `data/`. Example templates are provided:
- `data/accounts.example.json` -> Copy to `data/accounts.json`
- `data/projects.example.json` -> Copy to `data/projects.json`
- `.env.example` -> Copy to `.env`

---

## Verification & Test Suite

The repository includes a comprehensive automated test suite validating security, vault mechanics, process continuity, quota routing, and live integration:

```powershell
# Run the complete test suite
npm test
```

### Verified Test Suites:
1. **`shared-vault.test.ts`**: DPAPI encryption/decryption, V1 to V2 migration, fail-closed rollback on checksum mismatch, dual-target isolation, and audit log token redaction.
2. **`pairing.test.ts`**: Cross-target account linking, email normalization, single-to-dual target progression, and duplicate prevention.
3. **`routing.test.ts`**: Account health classification, scoring algorithm, hysteresis margin checks, dwell time enforcement, and cooldown prevention.
4. **`shadow-routing.test.ts`**: Zero-mutation guarantee in SHADOW mode, hypothetical action plan creation, priority tie-breaking, and synchronized multi-target planning.
5. **`run-all-tests.ts`**: Full integration verification against live running targets, zero-subprocess polling proof, and API security audits.

---

## Documentation Index

- [Architecture & Target Discovery](docs/architecture.md)
- [Shared Multi-Target Vault](docs/vault.md)
- [Quota Routing & Shadow Mode](docs/routing.md)
- [Security Model & Token Hygiene](docs/security.md)
- [Testing & Verification Guide](docs/testing.md)

---

## License

Private & Proprietary. All rights reserved.
