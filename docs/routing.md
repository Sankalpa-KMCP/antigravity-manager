# Quota Routing & Shadow Mode

## Overview

The Quota Router is responsible for continuously evaluating quota telemetry across running targets and selecting the optimal account when quotas are depleted. It combines a deterministic candidate selection algorithm, anti-flapping controls (hysteresis and cooldowns), and multiple operating modes.

---

## Operating Modes

| Mode | Telemetry Polling | Candidate Selection | Action Plan Generation | Live Target Modification |
| :--- | :--- | :--- | :--- | :--- |
| **`OFF`** | Active | Disabled | Disabled | None |
| **`SHADOW`** | Active | Active | Active (`shadowPlan`) | **Strictly None (Zero Mutation)** |
| **`LIVE`** | Active | Active | Active | Executed at IDLE boundary |

### Shadow Mode: Zero-Mutation Guarantee
In `SHADOW` mode, the router evaluates all routing triggers and determines the best candidate account exactly as it would in `LIVE` mode. However:
- It **never calls** `activateVaultedAccount()`.
- It **never recycles** the AG2 language server process.
- It **never prompts** the user for IDE OAuth login.
- It outputs a hypothetical action plan (`shadowPlan`) in the telemetry data and writes audit records to the event bus.

---

## Candidate Selection Algorithm

When a routing trigger occurs (e.g., active model quota drops below threshold), the router ranks all registered pool accounts:

```
Score = (Remaining Quota % * 1.0)
      + (Priority Weight * 10)
      - Freshness Penalty
      - Cooldown Penalty
```

### Ranking Factors:
1. **Model Quota Capacity (Primary Weight)**: The remaining quota percentage for the target model.
2. **Account Priority (Tie-Breaker)**: Configurable integer priority (1 = highest priority). Accounts with higher priority win ties when quota percentages are identical.
3. **Freshness Penalty**: Accounts whose telemetry was observed recently (LIVE) receive higher scores than accounts with cached or stale telemetry.
4. **Target Session Eligibility**: The account must possess a valid vaulted session for the target client.
5. **Cooldown Status**: Accounts that recently failed activation or were switched away from within the cooldown window are temporarily excluded.

---

## Hysteresis & Anti-Flapping Safeguards

To prevent frequent, disruptive account switches ("route flapping"), the router enforces three strict criteria:

1. **Hysteresis Margin (15%)**: A candidate account must offer at least **15% higher remaining quota** than the currently active account to justify a switch.
2. **Dwell Time (120 seconds)**: Once an account is activated, it cannot be switched away from for at least 120 seconds, even if another account gains higher quota.
3. **Failure Cooldown (300 seconds)**: If an account switch fails or returns an error, that account is placed in cooldown for 5 minutes before it can be considered again.

---

## Multi-Target Coordination: Synchronized vs. Independent

The router supports two routing topologies:

### Independent Routing (`INDEPENDENT`)
- Each target client (`antigravity2` and `ide`) evaluates and routes its account independently.
- Ideal when the IDE is working on one project while AG2 assists with a different task under a separate account.

### Synchronized Routing (`SYNCED`)
- Both targets switch together to the same logical account.
- If a switch is triggered on either target, the router verifies that the selected candidate has valid sessions for **both** clients before proceeding.
- If either target fails its idle preflight or session validation, the entire synchronized switch is aborted (fail-closed rollback).
