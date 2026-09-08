# Testing & Verification Guide

## Test Architecture

Antigravity Manager features an extensive automated test suite covering unit-level mechanics, vault encryption, routing logic, anti-flapping constraints, and end-to-end live integration against running target instances.

---

## Running Tests

```powershell
# Run the complete test suite
npm test

# Run build verification
npm run build
```

---

## Test Suites Summary

### 1. Shared Multi-Target Vault Suite (`src/test/shared-vault.test.ts`)
Validates DPAPI encryption mechanics, storage isolation, and version upgrades:
- **DPAPI Roundtrip**: Verifies encryption and decryption using Windows DPAPI CurrentUser.
- **V1 to V2 Migration**: Simulates upgrading legacy single-target vaults to the multi-target V2 schema while verifying that backup files are created.
- **Fail-Closed Rollback**: Intentionally corrupts the ciphertext and verifies that the vault refuses initialization without corrupting files.
- **Target Session Isolation**: Proves that reading an AG2 session does not leak IDE fields, and vice versa.
- **Audit Token Redaction**: Asserts that `metadata.json`, `sessions.dat`, and console audit logs contain zero plaintext credentials.

### 2. Target Session Pairing Suite (`src/test/pairing.test.ts`)
Validates cross-target account identity management:
- **Account Identity Linking**: Links separate target sessions to a single logical account using normalized email matching.
- **Duplicate Prevention**: Re-enrolling an existing valid target session returns early without creating redundant records.
- **Coverage Ratio Calculations**: Calculates pairing metrics (e.g., `3 / 3 complete`) displayed on the dashboard.
- **Zero Prefix Leakage**: Injects synthetic tokens and asserts that token sanitizer interceptors redact all instances.

### 3. Quota Routing & Anti-Flapping Suite (`src/test/routing.test.ts`)
Validates the router decision engine:
- **Health Classification**: Asserts accurate state transitions (`HEALTHY`, `WARNING`, `CRITICAL`, `EXHAUSTED`).
- **Scoring Function**: Ranks accounts using model quota percentage, priority weights, and freshness.
- **Hysteresis Enforcement**: Proves that a switch is rejected if the candidate account offers less than a 15% quota improvement.
- **Dwell Time Enforcement**: Asserts that accounts cannot be switched away from within 120 seconds of activation.
- **Failure Cooldown**: Asserts that failed activations trigger a 300-second cooldown period.

### 4. Shadow Routing Suite (`src/test/shadow-routing.test.ts`)
Validates the zero-mutation guarantee:
- **Zero Mutation Guarantee**: Verifies that in `SHADOW` mode, zero activation methods or process recycles are executed.
- **Hypothetical Action Plans**: Validates the generation of `shadowPlan` records containing recommended actions (`AUTOMATIC_COLD_TARGET_RELOAD` vs `INTERACTION_REQUIRED`).
- **Priority Tie-Breaking**: Proves deterministic selection when multiple candidate accounts offer identical quota.
- **Synchronized Shadow Planning**: Verifies multi-target coordinated plan generation under `SYNCED` mode.

### 5. Live Target Integration Suite (`src/test/run-all-tests.ts`)
Executes against live running instances of Antigravity IDE and Antigravity 2.0:
- **Endpoint Discovery**: Verifies process detection, port resolution, and Connect-RPC connectivity.
- **Model Normalization**: Asserts that all Medium/Low variants are hidden and only high-tier models are presented in exact order.
- **Zero-Subprocess Steady-State Polling**: Monitors consecutive telemetry polls and asserts that exactly **0 PowerShell** and **0 Netstat** subprocesses are spawned.
- **Idle Gate Verification**: Proves that live target switches are permitted only when `trajectoryStatus.state === 'IDLE'`.
- **Security Audit**: Asserts that the live dashboard payload contains zero passwords, access tokens, or refresh tokens.
