import http from 'http';
import fs from 'fs';
import path from 'path';
import { AntigravityManager } from '../manager';
import { TargetId } from '../types';

export interface ServerConfig {
  port: number;
  host: string;
}

export function createServer(manager: AntigravityManager, config: ServerConfig = { port: 39200, host: '127.0.0.1' }) {
  let uiDir = path.join(__dirname, '..', 'ui');
  if (!fs.existsSync(uiDir)) {
    uiDir = path.join(__dirname, '..', '..', 'src', 'ui');
  }

  const parseBody = (req: http.IncomingMessage): Promise<any> => {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => data += chunk);
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    // API: GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
      try {
        let data = manager.getLastData();
        if (!data) {
          data = await manager.refreshAll();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: POST /api/refresh
    if (pathname === '/api/refresh' && (req.method === 'POST' || req.method === 'GET')) {
      try {
        const data = await manager.refreshAll('Manual refresh');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: POST /api/switch/initiate
    if (pathname === '/api/switch/initiate' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const targetId = body.targetId as TargetId;
        if (!targetId || (targetId !== 'ide' && targetId !== 'antigravity2')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Valid targetId ("ide" or "antigravity2") is required.' }));
          return;
        }

        const result = await manager.initiateTargetSwitch(targetId);
        if (!result.success) {
          res.writeHead(409, { 'Content-Type': 'application/json' }); // 409 Conflict / Idle Gate refusal
          res.end(JSON.stringify(result));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: POST /api/switch/cancel
    if (pathname === '/api/switch/cancel' && req.method === 'POST') {
      const result = manager.cancelSwitch();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: GET /api/switch/status
    if (pathname === '/api/switch/status' && req.method === 'GET') {
      const session = manager.getSwitchManager().getActiveSession();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session }));
      return;
    }

    // API: Project Mappings (GET / POST / DELETE)
    if (pathname === '/api/projects') {
      const store = manager.getProjectStore();

      if (req.method === 'GET') {
        const projects = store.getProjects();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects }));
        return;
      }

      if (req.method === 'POST') {
        try {
          const body = await parseBody(req);
          store.addOrUpdateProject(body);
          await manager.refreshAll();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, projects: store.getProjects() }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }

      if (req.method === 'DELETE') {
        const name = url.searchParams.get('name');
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Query parameter "name" is required.' }));
          return;
        }
        const removed = store.removeProject(name);
        await manager.refreshAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: removed }));
        return;
      }
    }

    // API: Multi-Account Pool & Quota Engine (Phase 4A)
    if (pathname === '/api/pool' && req.method === 'GET') {
      const data = manager.getLastData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data?.pool || {}));
      return;
    }

    // API: Account Registry Management
    if (pathname === '/api/accounts') {
      const registry = manager.getAccountRegistry();

      if (req.method === 'GET') {
        const accounts = registry.getAllAccounts();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accounts }));
        return;
      }

      if (req.method === 'POST') {
        try {
          const body = await parseBody(req);
          if (body.email) {
            const entry = registry.upsertAccount({
              email: body.email,
              label: body.label,
              priority: body.priority,
              enabled: body.enabled,
              notes: body.notes
            });
            await manager.refreshAll();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, account: entry }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Field "email" is required.' }));
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }
    }

    // API: Account Updates & Settings (Phase 4D)
    if (pathname === '/api/accounts/update' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        if (!body.email) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Field "email" is required.' }));
          return;
        }
        const ok = manager.getAccountRegistry().updateAccountConfig(body.email, {
          label: body.label,
          priority: body.priority !== undefined ? Number(body.priority) : undefined,
          enabled: body.enabled,
          isReserve: body.isReserve,
          notes: body.notes
        });
        await manager.refreshAll('AccountUpdated');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: ok, account: manager.getAccountRegistry().getAccount(body.email) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: Safe Account Removal (Phase 4D)
    if (pathname === '/api/accounts/remove' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        if (!body.accountId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Field "accountId" is required.' }));
          return;
        }
        const result = await manager.removeAccount(body.accountId, { deleteQuotaCache: body.deleteQuotaCache !== false });
        if (!result.success) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: Vault Status & Accounts (Phase 4B/4C/4D/4G)
    if (pathname === '/api/vault/status' && req.method === 'GET') {
      try {
        const vault = manager.getSessionVault();
        const entries = vault.listMetadata();
        const accounts = vault.listAccounts();
        const ctrl = manager.getSwitchController().getControllerStatus();
        const enrollment = manager.getEnrollmentController().getEnrollmentStatus();
        const pairing = manager.getPairingController().getPairingStatus();
        const fullyPaired = accounts.filter(a => a.targets.ide && a.targets.antigravity2).length;

        const data = manager.getLastData();
        const ideTarget = data?.targets.find(t => t.id === 'ide');
        const ag2Target = data?.targets.find(t => t.id === 'antigravity2');
        const ideTrajectories = ideTarget?.trajectoryStatus?.runningTrajectories || 0;
        const ag2Trajectories = ag2Target?.trajectoryStatus?.runningTrajectories || 0;
        const unattended = manager.getUnattendedController().getControllerStatus(ideTrajectories, ag2Trajectories);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          accounts: entries,
          sharedAccounts: accounts,
          targetCoverage: {
            fullyPaired,
            totalAccounts: accounts.length,
            ratio: `${fullyPaired} / ${accounts.length} complete`
          },
          controller: ctrl,
          enrollment,
          pairing,
          unattended
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: Unattended Feasibility Status & Safety Gate (Phase 4H)
    if (pathname === '/api/vault/unattended/status' && req.method === 'GET') {
      try {
        const data = manager.getLastData();
        const ideTarget = data?.targets.find(t => t.id === 'ide');
        const ag2Target = data?.targets.find(t => t.id === 'antigravity2');
        const ideTrajectories = ideTarget?.trajectoryStatus?.runningTrajectories || 0;
        const ag2Trajectories = ag2Target?.trajectoryStatus?.runningTrajectories || 0;

        const status = manager.getUnattendedController().getControllerStatus(ideTrajectories, ag2Trajectories);
        const synced = manager.getUnattendedController().getSyncedFeasibility();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ...status,
          syncedDetails: synced
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: Evaluate Unattended Activation Request (Phase 4H)
    if (pathname === '/api/vault/unattended/evaluate' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const accountId = body.accountId;
        if (!accountId || typeof accountId !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Field "accountId" is required.' }));
          return;
        }

        const data = manager.getLastData();
        const ideTarget = data?.targets.find(t => t.id === 'ide');
        const ag2Target = data?.targets.find(t => t.id === 'antigravity2');
        const ideTrajectories = ideTarget?.trajectoryStatus?.runningTrajectories || 0;
        const ag2Trajectories = ag2Target?.trajectoryStatus?.runningTrajectories || 0;

        const evaluation = manager.getUnattendedController().evaluateActivationRequest(
          accountId,
          ideTrajectories,
          ag2Trajectories
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(evaluation));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: GET /api/router/status (Phase 4I)
    if (pathname === '/api/router/status' && req.method === 'GET') {
      try {
        const router = manager.getQuotaRouter();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(router.getStatus()));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: POST /api/router/config (Phase 4I)
    if (pathname === '/api/router/config' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const router = manager.getQuotaRouter();
        const updated = router.updateConfig(body);
        await manager.refreshAll('RouterConfigUpdated');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(updated));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: POST /api/router/acknowledge-enable (Phase 4I)
    if (pathname === '/api/router/acknowledge-enable' && req.method === 'POST') {
      try {
        const router = manager.getQuotaRouter();
        const updated = router.acknowledgeEnable();
        await manager.refreshAll('RouterEnabled');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(updated));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: POST /api/router/disable (Phase 4I)
    if (pathname === '/api/router/disable' && req.method === 'POST') {
      try {
        const router = manager.getQuotaRouter();
        const updated = router.disableRouting();
        await manager.refreshAll('RouterDisabled');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(updated));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: POST /api/router/switch-ide (Phase 4I)
    if (pathname === '/api/router/switch-ide' && req.method === 'POST') {
      try {
        // Triggers the supported IDE switch session for user interaction
        const result = await manager.initiateTargetSwitch('ide');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: POST /api/router/cancel (Phase 4I)
    if (pathname === '/api/router/cancel' && req.method === 'POST') {
      try {
        const router = manager.getQuotaRouter();
        router.cancelIdeHandoff();
        manager.getSwitchManager().cancelSwitch();
        await manager.refreshAll('RouterCancelled');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Router pending interaction cancelled' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: Vault Account Activation (Transactional A<->B Switch)
    if (pathname === '/api/vault/activate' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const accountId = body.accountId;
        if (!accountId || typeof accountId !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Field "accountId" is required.' }));
          return;
        }

        const controller = manager.getSwitchController();
        const result = await controller.activateVaultedAccount(accountId);
        await manager.refreshAll('VaultAccountActivated');

        if (!result.success) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: Multi-Account Reusable Enrollment Flow (Phase 4D)
    if ((pathname === '/api/vault/enroll/start' || pathname === '/api/vault/enroll') && req.method === 'POST') {
      try {
        const body = await parseBody(req).catch(() => ({}));
        const data = await manager.refreshAll();
        const target = data.targets.find(t => t.id === 'antigravity2');
        if (!target || !target.isRunning || !target.port) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Antigravity 2.0 is not running.' }));
          return;
        }

        const csrfToken = manager.getCsrfToken('antigravity2');
        if (!csrfToken) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'CSRF token for Antigravity 2.0 not found.' }));
          return;
        }

        const controller = manager.getEnrollmentController();
        const returnToBase = body.returnToBase !== undefined ? Boolean(body.returnToBase) : true;
        const timeoutMs = body.timeoutMs ? Number(body.timeoutMs) : 300000;
        const shouldWait = url.searchParams.get('wait') === 'true';

        if (shouldWait) {
          const result = await controller.beginEnrollment(target, csrfToken, { returnToBase, timeoutMs });
          await manager.refreshAll('EnrollmentFinished');
          res.writeHead(result.success ? 200 : (result.errorCode === 'DUPLICATE_ACCOUNT' || result.errorCode === 'BUSY' ? 409 : 500), { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } else {
          controller.beginEnrollment(target, csrfToken, { returnToBase, timeoutMs }).then(() => {
            manager.refreshAll('EnrollmentFinished');
          }).catch(() => {
            manager.refreshAll('EnrollmentError');
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: 'Enrollment initiated. Please complete Google sign-in in your browser or application.',
            returnToBase
          }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: Cancel Active Enrollment
    if (pathname === '/api/vault/enroll/cancel' && req.method === 'POST') {
      const result = manager.getEnrollmentController().cancelEnrollment();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: Enrollment Status Telemetry
    if (pathname === '/api/vault/enroll/status' && req.method === 'GET') {
      const status = manager.getEnrollmentController().getEnrollmentStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    // API: Cross-Target Enrollment (Phase 4G)
    if (pathname === '/api/vault/enroll-target' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { accountId, targetId, returnToBase, timeoutMs } = body;

        if (!accountId || typeof accountId !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Field "accountId" is required.' }));
          return;
        }

        if (targetId !== 'ide' && targetId !== 'antigravity2') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Field "targetId" must be "ide" or "antigravity2".' }));
          return;
        }

        const controller = manager.getPairingController();
        const shouldWait = url.searchParams.get('wait') === 'true';

        if (shouldWait) {
          const result = await controller.enrollTargetSession(accountId, targetId, {
            returnToBase: Boolean(returnToBase),
            timeoutMs: timeoutMs ? Number(timeoutMs) : undefined
          });
          await manager.refreshAll('TargetEnrollmentCompleted');

          if (!result.success) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // Asynchronous start
        const startRes = await controller.startEnrollment(accountId, targetId, {
          returnToBase: Boolean(returnToBase),
          timeoutMs: timeoutMs ? Number(timeoutMs) : undefined
        });

        res.writeHead(startRes.success ? 202 : 409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ...startRes,
          status: controller.getPairingStatus()
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: Cancel Cross-Target Pairing
    if (pathname === '/api/vault/enroll-target/cancel' && req.method === 'POST') {
      const result = manager.getPairingController().cancelPairing();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: Cross-Target Pairing Status Telemetry
    if (pathname === '/api/vault/enroll-target/status' && req.method === 'GET') {
      const status = manager.getPairingController().getPairingStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    // API: Router Status
    if (pathname === '/api/router/status' && req.method === 'GET') {
      const status = manager.getQuotaRouter().getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    // API: Update Router Config
    if (pathname === '/api/router/config' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const config = manager.getQuotaRouter().updateConfig(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: Set Router Operating Mode (OFF, SHADOW)
    if (pathname === '/api/router/operating-mode' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const config = manager.getQuotaRouter().setOperatingMode(body.mode);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: Acknowledge Enable Router (Activates SHADOW mode in Phase 4J)
    if (pathname === '/api/router/acknowledge-enable' && req.method === 'POST') {
      try {
        const config = manager.getQuotaRouter().acknowledgeEnable();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // API: Disable Router
    if (pathname === '/api/router/disable' && req.method === 'POST') {
      const config = manager.getQuotaRouter().disableRouting();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
      return;
    }

    // API: Cancel Router Handoff
    if (pathname === '/api/router/cancel' && req.method === 'POST') {
      manager.getQuotaRouter().cancelIdeHandoff();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Router handoff cancelled.' }));
      return;
    }

    // Static Asset Serving
    let filePath = path.join(uiDir, pathname === '/' ? 'index.html' : pathname);

    if (!filePath.startsWith(uiDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(uiDir, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml'
    };

    const contentType = mimeMap[ext] || 'application/octet-stream';

    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch (readErr) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File Not Found');
    }
  });

  return {
    server,
    start: () => {
      return new Promise<void>((resolve) => {
        server.listen(config.port, config.host, () => {
          resolve();
        });
      });
    },
    stop: () => {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  };
}
