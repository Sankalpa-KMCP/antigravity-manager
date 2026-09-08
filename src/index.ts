import { AntigravityManager } from './manager';
import { createServer } from './server/app';

async function main() {
  const port = parseInt(process.env.PORT || '39200', 10);
  const host = '127.0.0.1'; // BIND STRICTLY TO LOCALHOST

  console.log('====================================================');
  console.log('  ANTIGRAVITY MANAGER V2.0 (MANUAL IDLE-SAFE SWITCH)');
  console.log('====================================================');
  console.log(`Starting telemetry engine on http://${host}:${port} ...\n`);

  const manager = new AntigravityManager();

  console.log('Running initial process and port discovery (one-time startup)...');
  try {
    const initialData = await manager.refreshAll('Initial startup');
    console.log(`Discovered ${initialData.targets.length} targets:`);
    for (const t of initialData.targets) {
      if (t.isRunning) {
        console.log(`  [+] ${t.name}: RUNNING (PID ${t.pid}, Port ${t.port})`);
        console.log(`      Account:   ${t.email || 'Unknown'} | Plan: ${t.planName || t.userTier || 'Standard'}`);
        console.log(`      State:     ${t.trajectoryStatus.state} (${t.trajectoryStatus.runningTrajectories} active tasks)`);
        console.log(`      Discovery: ${t.discovery.discoveryReason} (Count: ${t.discovery.discoveryCount})`);
      } else {
        console.log(`  [-] ${t.name}: STOPPED ${t.error ? `(${t.error})` : ''}`);
      }
    }

    console.log('\nCredit Aggregates (Strictly Segregated Resource Pools):');
    console.log(`  Prompt Pool: ${initialData.aggregate.prompt.available.toLocaleString()} available / ${initialData.aggregate.prompt.monthly.toLocaleString()} monthly (Computed Used: ${initialData.aggregate.prompt.computedUsed.toLocaleString()})`);
    console.log(`  Flow Pool:   ${initialData.aggregate.flow.available.toLocaleString()} available / ${initialData.aggregate.flow.monthly.toLocaleString()} monthly (Computed Used: ${initialData.aggregate.flow.computedUsed.toLocaleString()})`);
  } catch (err) {
    console.warn(`Initial scan completed with warning: ${(err as Error).message}`);
  }

  const app = createServer(manager, { port, host });
  await app.start();

  console.log(`\n>>> Dashboard available at: http://${host}:${port}`);
  console.log('>>> Steady-state 5s polling uses direct local Connect-RPC (ZERO shell subprocesses).');
  console.log('>>> Press Ctrl+C to terminate cleanly.\n');

  // Background polling interval (5 seconds, cached RPC only)
  const pollInterval = setInterval(async () => {
    try {
      await manager.refreshAll();
    } catch (_) {}
  }, 5000);

  const shutdown = async () => {
    console.log('\nShutting down Antigravity Manager cleanly...');
    clearInterval(pollInterval);
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal error starting Antigravity Manager:', err);
  process.exit(1);
});
