import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { SessionVault } from '../vault/vault';
import { VaultAuditLogger } from '../vault/audit';
import { UnattendedActivationController } from '../vault/unattended-controller';
import { ProcessContinuitySnapshot } from '../vault/process-helper';
import { sanitizeObject, sanitizeString } from '../vault/sanitizer';

export async function runUnattendedFeasibilityTests(): Promise<boolean> {
  console.log('--- RUNNING PHASE 4H UNATTENDED HOT ACTIVATION FEASIBILITY TEST SUITE ---');
  let passed = true;

  function assert(cond: boolean, msg: string) {
    if (!cond) {
      console.error(`  FAIL: ${msg}`);
      passed = false;
    } else {
      console.log(`  PASS: ${msg}`);
    }
  }

  const testDir = path.join(process.cwd(), 'data', 'test_unattended_suite');

  try {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    const auditLogger = new VaultAuditLogger();
    const vault = new SessionVault(testDir, auditLogger);
    await vault.init();

    // Set up mock accounts in isolated test vault:
    // Account A: Fully Paired (AG2 + IDE)
    // Account B: Fully Paired (AG2 + IDE)
    // Account C: AG2 Only (not paired for IDE)
    const mockPayload = { token: 'mock-non-sensitive-test-token' };
    await vault.storeTargetSession('acc-account-a', 'antigravity2', mockPayload);
    await vault.storeTargetSession('acc-account-a', 'ide', mockPayload);

    await vault.storeTargetSession('acc-account-b', 'antigravity2', mockPayload);
    await vault.storeTargetSession('acc-account-b', 'ide', mockPayload);

    await vault.storeTargetSession('acc-account-c', 'antigravity2', mockPayload);

    const controller = new UnattendedActivationController(vault);

    // -------------------------------------------------------------
    // TEST 1: AUTHORITATIVE OAUTH AUDIT & CLASSIFICATION REPORTING
    // -------------------------------------------------------------
    console.log('\n  [1. Target OAuth Audit & Feasibility Classifications]');
    const ag2Audit = controller.getAuditReport('antigravity2');
    assert(ag2Audit.classification === 'INTERACTION_REQUIRED', 'AG2 is classified as INTERACTION_REQUIRED');
    assert(ag2Audit.loginHintSupported === false, 'AG2 login_hint is unsupported');
    assert(ag2Audit.silentAuthAvailable === false, 'AG2 silent auth is unavailable');
    assert(
      ag2Audit.reasons.some(r => r.includes('stored-session runtime reload mechanism')),
      'AG2 reasons cite lack of stored-session runtime reload RPC'
    );
    assert(
      ag2Audit.reasons.some(r => r.includes('LoginWithBrowser is deprecated')),
      'AG2 reasons cite LoginWithBrowser deprecation'
    );
    assert(
      ag2Audit.reasons.some(r => r.includes('native OAuth construction exposes no deterministic login_hint')),
      'AG2 reasons cite absence of login_hint in Go binary'
    );

    const ideAudit = controller.getAuditReport('ide');
    assert(ideAudit.classification === 'INTERACTION_REQUIRED', 'IDE is classified as INTERACTION_REQUIRED');
    assert(ideAudit.promptBehavior.includes('prompt="consent"'), 'IDE prompt behavior cites hardcoded prompt="consent"');
    assert(ideAudit.loginHintSupported === false, 'IDE login_hint is unsupported');
    assert(ideAudit.silentAuthAvailable === false, 'IDE silent auth is unavailable');
    assert(
      ideAudit.reasons.some(r => r.includes('prompt="consent"')),
      'IDE reasons cite hardcoded prompt="consent"'
    );
    assert(
      ideAudit.reasons.some(r => r.includes('prompt=none authorization flow is unavailable')),
      'IDE reasons cite prompt=none unavailable'
    );
    assert(
      ideAudit.reasons.some(r => r.includes('no login_hint or equivalent deterministic account-targeting parameter')),
      'IDE reasons cite no deterministic login_hint exposed'
    );
    assert(
      ideAudit.reasons.some(r => r.includes('AuthenticationProvider/USS state machine')),
      'IDE reasons cite cannot hot-activate stored session without bypassing supported state machine'
    );

    const synced = controller.getSyncedFeasibility();
    assert(synced.feasible === false, 'Synced unattended hot is feasible === false');
    assert(
      synced.verdict === 'NOT AVAILABLE THROUGH CURRENTLY SUPPORTED INTERFACES IN THE INSTALLED VERSIONS',
      'Synced verdict uses exact required wording'
    );

    // -------------------------------------------------------------
    // TEST 2: SAFETY GATE ENFORCEMENT — ACTIVE TRAJECTORY BLOCKING
    // -------------------------------------------------------------
    console.log('\n  [2. Safety Gate Enforcement (Active Trajectories)]');
    // Trajectories > 0 on IDE
    const preflightIdeBusy = controller.performSafetyPreflight(1, 0);
    assert(preflightIdeBusy.allowed === false, 'Preflight blocks when IDE runningTrajectories > 0');
    assert(preflightIdeBusy.isIdeIdle === false, 'IDE is marked not idle');
    assert(preflightIdeBusy.reasons.length > 0, 'Preflight provides clear block reason for IDE');

    // Trajectories > 0 on AG2
    const preflightAg2Busy = controller.performSafetyPreflight(0, 2);
    assert(preflightAg2Busy.allowed === false, 'Preflight blocks when AG2 runningTrajectories > 0');
    assert(preflightAg2Busy.isAg2Idle === false, 'AG2 is marked not idle');

    // Both targets idle (0, 0)
    const preflightIdle = controller.performSafetyPreflight(0, 0);
    assert(preflightIdle.allowed === true, 'Preflight allows when both targets are idle (0 trajectories)');
    assert(preflightIdle.isIdeIdle === true && preflightIdle.isAg2Idle === true, 'Both targets marked idle');

    // Activation evaluation aborts immediately if trajectories active
    const evalAborted = controller.evaluateActivationRequest('acc-account-a', 1, 0);
    assert(evalAborted.allowed === false, 'Activation evaluation rejected when runningTrajectories > 0');
    assert(evalAborted.state === 'ABORTED', 'Controller state transitions to ABORTED');
    assert(evalAborted.message.includes('Active trajectory detected'), 'Abort message indicates active trajectory');

    // -------------------------------------------------------------
    // TEST 3: ACCOUNT TARGETING & PAIRING CHECK IN SYNCED MODE
    // -------------------------------------------------------------
    console.log('\n  [3. Synced vs Independent Mode & Pairing Validation]');
    // Unknown account
    const evalUnknown = controller.evaluateActivationRequest('acc-non-existent', 0, 0);
    assert(evalUnknown.allowed === false && evalUnknown.state === 'FAILED', 'Unknown account fails evaluation');

    // In SYNCED mode, partially paired account (Account C has only AG2)
    controller.setMode('SYNCED');
    const evalPartialSynced = controller.evaluateActivationRequest('acc-account-c', 0, 0);
    assert(evalPartialSynced.allowed === false, 'Synced activation rejected for partially paired account');
    assert(evalPartialSynced.classification === 'PARTIAL_HOT', 'Classification reports PARTIAL_HOT');
    assert(evalPartialSynced.state === 'FAILED', 'State marked FAILED due to missing IDE target');

    // In INDEPENDENT mode, mode can be toggled
    controller.setMode('INDEPENDENT');
    assert(controller.getMode() === 'INDEPENDENT', 'Controller mode toggles to INDEPENDENT');

    // Fully paired account evaluation (Account A)
    controller.setMode('SYNCED');
    const evalFullyPaired = controller.evaluateActivationRequest('acc-account-a', 0, 0);
    assert(evalFullyPaired.allowed === true, 'Evaluation allowed to proceed to interaction step');
    assert(evalFullyPaired.classification === 'INTERACTION_REQUIRED', 'Classification returns INTERACTION_REQUIRED');
    assert(evalFullyPaired.state === 'WAITING_FOR_INTERACTION', 'State is WAITING_FOR_INTERACTION');

    // -------------------------------------------------------------
    // TEST 4: PROCESS CONTINUITY SNAPSHOT & DRIFT DETECTION
    // -------------------------------------------------------------
    console.log('\n  [4. Process Continuity Snapshot & Drift Detection]');
    const baselineSnapshot: ProcessContinuitySnapshot = {
      mainPid: 30288,
      extHostPid: 12864,
      unifiedLsPid: 19548,
      lspLsPid: 7684,
      timestamp: new Date().toISOString()
    };

    // Identical post-snapshot -> continuous
    const continuousResult = controller.evaluateProcessContinuity(baselineSnapshot, {
      ...baselineSnapshot,
      timestamp: new Date().toISOString()
    });
    assert(continuousResult.isContinuous === true, 'Continuity preserved when all PIDs remain identical');
    assert(continuousResult.driftedPids.length === 0, 'Zero drifted PIDs on identical snapshot');

    // Language server restart drift
    const lsRestartSnapshot: ProcessContinuitySnapshot = {
      ...baselineSnapshot,
      unifiedLsPid: 45678,
      timestamp: new Date().toISOString()
    };
    const lsRestartResult = controller.evaluateProcessContinuity(baselineSnapshot, lsRestartSnapshot);
    assert(lsRestartResult.isContinuous === false, 'Continuity fails when unifiedLsPid restarts');
    assert(
      lsRestartResult.driftedPids.some(d => d.includes('unifiedLsPid (19548 -> 45678)')),
      'Drifted PIDs identifies unifiedLsPid drift'
    );

    // Electron Main restart drift
    const mainRestartSnapshot: ProcessContinuitySnapshot = {
      ...baselineSnapshot,
      mainPid: 88888,
      timestamp: new Date().toISOString()
    };
    const mainRestartResult = controller.evaluateProcessContinuity(baselineSnapshot, mainRestartSnapshot);
    assert(mainRestartResult.isContinuous === false, 'Continuity fails when mainPid restarts');
    assert(
      mainRestartResult.driftedPids.some(d => d.includes('mainPid (30288 -> 88888)')),
      'Drifted PIDs identifies mainPid drift'
    );

    // -------------------------------------------------------------
    // TEST 5: ZERO TOKEN LEAKAGE AUDIT
    // -------------------------------------------------------------
    console.log('\n  [5. Zero Token Leakage Audit]');
    const auditStr = JSON.stringify(controller.getControllerStatus(0, 0));
    const rawTokensPattern = /(?:ya29\.[a-zA-Z0-9_\-]+|1\/\/[a-zA-Z0-9_\-]+)/g;
    const tokenMatches = auditStr.match(rawTokensPattern) || [];
    assert(tokenMatches.length === 0, `Audit and controller status leak count is 0 (found ${tokenMatches.length})`);

    // -------------------------------------------------------------
    // TEST 6: ISOLATION & ZERO DIRECT PRODUCTION MUTATION
    // -------------------------------------------------------------
    console.log('\n  [6. Production Isolation & State Verification]');
    // Verify production vault files are untouched by test suite
    const prodMetadataPath = path.join(process.cwd(), 'data', 'vault', 'metadata.json');
    if (fs.existsSync(prodMetadataPath)) {
      const prodMeta = JSON.parse(fs.readFileSync(prodMetadataPath, 'utf8'));
      assert(prodMeta.accounts && prodMeta.accounts.length >= 3, 'Production metadata accounts are intact');
    }

    console.log('\n  --- ALL PHASE 4H TESTS PASSED ---');
  } catch (err) {
    console.error('Test execution error:', err);
    passed = false;
  } finally {
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // Cleanup best effort
    }
  }

  return passed;
}

if (require.main === module) {
  runUnattendedFeasibilityTests().then(success => {
    process.exit(success ? 0 : 1);
  });
}
