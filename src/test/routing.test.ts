import fs from 'fs';
import path from 'path';
import { ProjectStore } from '../routing/store';
import { TargetState } from '../types';

export function runRoutingTests(): boolean {
  console.log('--- RUNNING PROJECT ROUTING FOUNDATION TESTS ---');
  let passed = true;

  function assert(condition: boolean, testName: string) {
    if (!condition) {
      console.error(`  FAIL: ${testName}`);
      passed = false;
    } else {
      console.log(`  PASS: ${testName}`);
    }
  }

  // Use a temporary test data directory
  const testDataDir = path.join(__dirname, '..', '..', 'data', 'test-routing');
  if (fs.existsSync(testDataDir)) {
    try { fs.rmSync(testDataDir, { recursive: true, force: true }); } catch (_) {}
  }
  fs.mkdirSync(testDataDir, { recursive: true });

  try {
    const store = new ProjectStore(testDataDir);

    // Default projects loaded
    const initialProjects = store.getProjects();
    assert(initialProjects.length === 2, 'Default non-sensitive project mappings loaded');

    // Add a custom mapping
    store.addOrUpdateProject({
      name: 'DentCare',
      path: 'D:\\Projects\\DentCare',
      target: 'ide',
      preferredAccountEmail: 'account-a@example.com'
    });

    store.addOrUpdateProject({
      name: 'Research',
      path: 'D:\\Projects\\Research',
      target: 'antigravity2',
      preferredAccountEmail: 'account-b@example.com'
    });

    // Verify stored JSON has ZERO credentials
    const rawSaved = fs.readFileSync(path.join(testDataDir, 'projects.json'), 'utf8');
    const parsedSaved = JSON.parse(rawSaved);
    assert(!rawSaved.includes('token'), 'Stored project data contains zero token fields');
    assert(!rawSaved.includes('password'), 'Stored project data contains zero password fields');
    assert(!rawSaved.includes('secret'), 'Stored project data contains zero secret fields');
    assert(parsedSaved['DentCare'].preferredAccountEmail === 'account-a@example.com', 'Preferred account saved correctly');

    // Mock targets
    const mockTargets: TargetState[] = [
      {
        id: 'ide',
        name: 'Antigravity IDE',
        isRunning: true,
        pid: 1001,
        port: 50001,
        email: 'account-a@example.com', // Matches DentCare!
        userName: 'User A',
        userTier: 'Pro',
        planName: 'Pro',
        credits: null,
        models: [],
        trajectoryStatus: { state: 'IDLE', runningTrajectories: 0, totalTrajectories: 1 },
        discovery: { discoveryReason: 'Cached', discoveryCount: 1, lastDiscoveryAt: new Date().toISOString() },
        lastUpdated: new Date().toISOString(),
        error: null
      },
      {
        id: 'antigravity2',
        name: 'Antigravity 2.0',
        isRunning: true,
        pid: 1002,
        port: 50002,
        email: 'wrong-account@example.com', // Mismatch with Research (expects account-b@example.com)!
        userName: 'Wrong User',
        userTier: 'Standard',
        planName: 'Standard',
        credits: null,
        models: [],
        trajectoryStatus: { state: 'BUSY', runningTrajectories: 2, totalTrajectories: 3 },
        discovery: { discoveryReason: 'Cached', discoveryCount: 1, lastDiscoveryAt: new Date().toISOString() },
        lastUpdated: new Date().toISOString(),
        error: null
      }
    ];

    // Evaluate statuses
    const statuses = store.evaluateStatuses(mockTargets);
    const dentCareStatus = statuses.find(s => s.name === 'DentCare');
    const researchStatus = statuses.find(s => s.name === 'Research');

    // 1. Match detection -> READY
    assert(dentCareStatus?.status === 'READY', 'DentCare matches target email -> Status is READY');
    assert(dentCareStatus?.isTargetRunning === true, 'DentCare target is running');
    assert(dentCareStatus?.isTargetBusy === false, 'DentCare target is not busy');

    // 2. Mismatch detection -> SWITCH_REQUIRED
    assert(researchStatus?.status === 'SWITCH_REQUIRED', 'Research email mismatch -> Status is SWITCH_REQUIRED');
    assert(researchStatus?.currentAccountEmail === 'wrong-account@example.com', 'Current email correctly captured');
    assert(researchStatus?.preferredAccountEmail === 'account-b@example.com', 'Preferred email correctly captured');
    assert(researchStatus?.isTargetBusy === true, 'Research target busy state correctly reported');

    // 3. Offline target detection -> TARGET_OFFLINE
    const offlineTargets: TargetState[] = [
      { ...mockTargets[0], isRunning: false }
    ];
    const offlineStatuses = store.evaluateStatuses(offlineTargets);
    const offlineDentCare = offlineStatuses.find(s => s.name === 'DentCare');
    assert(offlineDentCare?.status === 'TARGET_OFFLINE', 'Stopped target -> Status is TARGET_OFFLINE');

    // 4. Remove project mapping
    const removed = store.removeProject('DentCare');
    assert(removed === true, 'Successfully removed DentCare mapping');
    assert(store.getProjects().length === 1, 'Store contains 1 mapping after removal');

  } finally {
    // Clean up temporary directory
    try { fs.rmSync(testDataDir, { recursive: true, force: true }); } catch (_) {}
  }

  return passed;
}
