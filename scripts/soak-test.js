const http = require('http');

async function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function runSoakTest(durationSeconds = 300, intervalSeconds = 30) {
  console.log(`================================================================`);
  console.log(`  STARTING 5-MINUTE SOAK TEST MONITORING                        `);
  console.log(`  Duration: ${durationSeconds}s | Sample Interval: ${intervalSeconds}s         `);
  console.log(`================================================================\n`);

  const startTime = Date.now();
  const samples = [];

  const headers = ['Elapsed', 'PS Launches', 'Netstat', 'RPC Polls', 'IDE State', '2.0 State', 'IDE Discovery', '2.0 Discovery'];
  console.log(headers.map(h => h.padEnd(13)).join(' | '));
  console.log('-'.repeat(120));

  while (true) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    try {
      const data = await getJson('http://127.0.0.1:39200/api/status');
      const sys = data.systemTelemetry || {};
      const ide = data.targets.find(t => t.id === 'ide');
      const ag2 = data.targets.find(t => t.id === 'antigravity2');

      const sample = {
        elapsed: `${elapsed}s`,
        ps: sys.powershellLaunches,
        netstat: sys.netstatLaunches,
        rpc: sys.rpcPollCount,
        ideState: ide?.trajectoryStatus?.state || 'N/A',
        ag2State: ag2?.trajectoryStatus?.state || 'N/A',
        ideDisc: `Count=${ide?.discovery?.discoveryCount || 0}`,
        ag2Disc: `Count=${ag2?.discovery?.discoveryCount || 0}`
      };

      samples.push(sample);

      const row = [
        sample.elapsed.padEnd(13),
        String(sample.ps).padEnd(13),
        String(sample.netstat).padEnd(13),
        String(sample.rpc).padEnd(13),
        sample.ideState.padEnd(13),
        sample.ag2State.padEnd(13),
        sample.ideDisc.padEnd(13),
        sample.ag2Disc.padEnd(13)
      ];
      console.log(row.join(' | '));

    } catch (err) {
      console.error(`Error at elapsed ${elapsed}s:`, err.message);
    }

    if (elapsed >= durationSeconds) {
      break;
    }

    const waitMs = Math.min(intervalSeconds * 1000, (durationSeconds - elapsed) * 1000);
    await new Promise(r => setTimeout(r, waitMs));
  }

  console.log('-'.repeat(120));
  console.log('\n================================================================');
  console.log('  5-MINUTE SOAK TEST COMPLETED                                  ');
  console.log('================================================================\n');

  const first = samples[0];
  const last = samples[samples.length - 1];

  const psDelta = last.ps - first.ps;
  const netstatDelta = last.netstat - first.netstat;
  const rpcDelta = last.rpc - first.rpc;

  console.log('SOAK TEST RESULTS:');
  console.log(`  Initial Subprocess Launches (Startup): PS=${first.ps}, Netstat=${first.netstat}`);
  console.log(`  Final Subprocess Launches (after 5m):   PS=${last.ps}, Netstat=${last.netstat}`);
  console.log(`  Subprocess Delta in 5m Soak:            PS=${psDelta}, Netstat=${netstatDelta}`);
  console.log(`  Total RPC Polls Completed:             ${last.rpc} (+${rpcDelta} in 5m)`);
  console.log(`  Target 1 (IDE) State & Discovery:      ${last.ideState} (${last.ideDisc})`);
  console.log(`  Target 2 (2.0) State & Discovery:      ${last.ag2State} (${last.ag2Disc})`);
  console.log(`  Zero Subprocess Rule in 5s Polling:    ${psDelta === 0 && netstatDelta === 0 ? 'PASSED (STRICT 0)' : 'FAILED'}`);
}

runSoakTest(305, 30).catch(console.error);
