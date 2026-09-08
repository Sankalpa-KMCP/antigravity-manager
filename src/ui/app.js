// Dashboard Client Logic (V2.0 Manual Idle-Safe Account Switching & Phase 4A Multi-Account Pool)
let autoRefreshTimer = null;
let lastSwitchSessionStatus = null;
let lastDashboardData = null;
let currentSelectedPoolModel = 'Gemini 3.8 Flash (High)';

function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  return Number(num).toLocaleString();
}

function formatPercent(fraction) {
  if (fraction === null || fraction === undefined || isNaN(fraction)) return '0.0%';
  return (fraction * 100).toFixed(1) + '%';
}

function formatTime(isoString) {
  if (!isoString) return '-';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' (' + d.toLocaleDateString() + ')';
  } catch (_) {
    return isoString;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function fetchStatus(isManual = false) {
  const refreshBtn = document.getElementById('btn-refresh');
  if (isManual && refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.innerText = 'Refreshing...';
  }

  try {
    const res = await fetch(isManual ? '/api/refresh' : '/api/status', {
      method: isManual ? 'POST' : 'GET'
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: Failed to fetch status`);
    }
    const data = await res.json();
    lastDashboardData = data;
    renderDashboard(data);
  } catch (err) {
    console.error('Error updating dashboard:', err);
  } finally {
    if (isManual && refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = '<span class="btn-icon">↻</span> Refresh Now';
    }
  }
}

async function initiateSwitch(targetId) {
  try {
    const res = await fetch('/api/switch/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetId })
    });

    const body = await res.json();

    if (res.status === 409) {
      // Idle Gate Refusal: Target is BUSY or Offline
      alert(`[IDLE GATE REFUSAL]\n\n${body.error || 'Cannot switch account: target is busy.'}`);
      await fetchStatus(true);
      return;
    }

    if (!res.ok) {
      alert(`Error initiating switch: ${body.error || 'Unknown error'}`);
      return;
    }

    // Refresh immediately to show waiting session banner
    await fetchStatus(false);
  } catch (err) {
    alert(`Network error initiating switch: ${err.message}`);
  }
}

async function cancelSwitch() {
  try {
    await fetch('/api/switch/cancel', { method: 'POST' });
    const panel = document.getElementById('switch-session-panel');
    if (panel) panel.classList.add('hidden');
    await fetchStatus(false);
  } catch (err) {
    console.error('Failed to cancel switch:', err);
  }
}

async function deleteProject(name) {
  if (!confirm(`Remove project mapping "${name}"?`)) return;
  try {
    const res = await fetch(`/api/projects?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (res.ok) {
      await fetchStatus(true);
    }
  } catch (err) {
    console.error('Failed to delete project:', err);
  }
}

function renderSwitchSession(session) {
  const panel = document.getElementById('switch-session-panel');
  if (!panel) return;

  if (!session || session.status === 'CANCELLED') {
    panel.classList.add('hidden');
    lastSwitchSessionStatus = null;
    return;
  }

  panel.classList.remove('hidden');
  panel.classList.remove('panel-success', 'panel-timeout');

  const titleEl = document.getElementById('switch-status-title');
  const spinnerEl = document.getElementById('switch-spinner');
  const targetNameEl = document.getElementById('switch-target-name');
  const oldEmailEl = document.getElementById('switch-old-email');
  const timerWrap = document.getElementById('switch-timer-wrap');
  const countdownEl = document.getElementById('switch-countdown');
  const instructionEl = document.getElementById('switch-instruction');
  const cancelBtn = document.getElementById('btn-cancel-switch');

  const targetHealthEl = document.getElementById('switch-target-health');
  const currentEmailEl = document.getElementById('switch-current-email');
  const elapsedEl = document.getElementById('switch-elapsed');

  targetNameEl.innerText = session.targetName || session.targetId;
  oldEmailEl.innerText = session.oldEmail || 'None';
  if (targetHealthEl) targetHealthEl.innerText = session.targetHealth || 'HEALTHY (RUNNING)';
  if (currentEmailEl) currentEmailEl.innerText = session.currentDetectedEmail || session.oldEmail || 'Checking...';
  instructionEl.innerText = session.message || '';

  if (session.status === 'WAITING') {
    titleEl.innerText = 'WAITING FOR ACCOUNT CHANGE...';
    spinnerEl.style.display = 'inline-block';
    timerWrap.style.display = 'block';

    const expiresAt = new Date(session.expiresAt).getTime();
    const remainingSec = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    countdownEl.innerText = `${remainingSec}s`;
    if (elapsedEl) elapsedEl.innerText = `${session.elapsedSeconds || 0}s`;

    cancelBtn.innerText = 'Cancel Switch';
    cancelBtn.onclick = cancelSwitch;
  } else if (session.status === 'SUCCESS') {
    panel.classList.add('panel-success');
    titleEl.innerText = '✓ ACCOUNT SWITCH CONFIRMED';
    spinnerEl.style.display = 'none';
    timerWrap.style.display = 'none';
    cancelBtn.innerText = 'Dismiss';
    cancelBtn.onclick = () => panel.classList.add('hidden');
  } else if (session.status === 'TIMEOUT') {
    panel.classList.add('panel-timeout');
    titleEl.innerText = '⚠️ SWITCH NOT CONFIRMED';
    spinnerEl.style.display = 'none';
    timerWrap.style.display = 'none';
    cancelBtn.innerText = 'Dismiss';
    cancelBtn.onclick = () => panel.classList.add('hidden');
  }

  lastSwitchSessionStatus = session.status;
}

function renderProjects(projects) {
  const tbody = document.getElementById('projects-table-body');
  if (!tbody) return;

  if (!projects || projects.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-muted text-center">No project mappings configured.</td></tr>';
    return;
  }

  tbody.innerHTML = projects.map(p => {
    let statusBadge = '<span class="badge-offline">TARGET OFFLINE</span>';
    let actionHtml = '';

    if (p.status === 'READY') {
      statusBadge = '<span class="badge-ready">READY</span>';
    } else if (p.status === 'SWITCH_REQUIRED') {
      statusBadge = '<span class="badge-switch-req">SWITCH REQUIRED</span>';
      
      const isBusy = p.isTargetBusy;
      const isOffline = !p.isTargetRunning;
      const disabledAttr = (isBusy || isOffline) ? 'disabled' : '';
      const btnTitle = isBusy ? 'Target is BUSY: Finish current tasks first' : (isOffline ? 'Target is offline' : `Switch ${p.targetName} to preferred account`);

      actionHtml = `
        <button class="btn btn-secondary btn-sm" ${disabledAttr} title="${btnTitle}" onclick="initiateSwitch('${p.target}')">
          Switch to Preferred
        </button>
      `;
    }

    const stateBadge = p.isTargetRunning
      ? (p.isTargetBusy ? '<span class="status-badge badge-busy">BUSY</span>' : '<span class="status-badge badge-idle">IDLE</span>')
      : '<span class="status-badge badge-stopped">STOPPED</span>';

    const currentEmailDisplay = p.currentAccountEmail || (p.isTargetRunning ? 'Pending' : 'Offline');

    return `
      <tr>
        <td><strong>${p.name}</strong>${p.path ? `<br><span class="text-muted" style="font-size:11px">${p.path}</span>` : ''}</td>
        <td>${p.targetName}</td>
        <td><code>${p.preferredAccountEmail}</code></td>
        <td><code>${currentEmailDisplay}</code></td>
        <td>${stateBadge}</td>
        <td>${statusBadge}</td>
        <td>
          <div style="display:flex; align-items:center; gap:8px;">
            ${actionHtml}
            <button class="btn-icon-danger" title="Delete mapping" onclick="deleteProject('${p.name}')">×</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

const PREFERRED_MODEL_ORDER = [
  'Gemini 3.8 Flash (High)',
  'Gemini 3.1 Pro (High)',
  'Gemini 3.7 Flash (High)',
  'Gemini 3.6 Flash (High)',
  'Claude Sonnet 4.6 (Thinking)',
  'Claude Opus 4.6 (Thinking)'
];

function filterAndOrderModels(rawModels) {
  if (!rawModels || !Array.isArray(rawModels)) return [];

  // Filter: Display only labels containing "(High)" OR "(Thinking)"
  // Hide: Low, Medium, and any other reasoning variants
  const filtered = rawModels.filter(m => {
    if (!m || !m.label) return false;
    const l = m.label;
    return l.includes('(High)') || l.includes('(Thinking)');
  });

  // Fixed stable ordering: Predefined sequence, then unknown models sorted alphabetically
  return filtered.sort((a, b) => {
    const idxA = PREFERRED_MODEL_ORDER.indexOf(a.label);
    const idxB = PREFERRED_MODEL_ORDER.indexOf(b.label);

    if (idxA !== -1 && idxB !== -1) {
      return idxA - idxB;
    }
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;

    return a.label.localeCompare(b.label);
  });
}

function renderTargets(targets) {
  const container = document.getElementById('targets-container');
  if (!container) return;

  // Remove initial loading state if present
  const loading = container.querySelector('.loading-state');
  if (loading) loading.remove();

  for (const target of targets || []) {
    let card = document.getElementById(`target-card-${target.id}`);
    const isBusy = target.trajectoryStatus?.state === 'BUSY';
    const statusText = target.isRunning 
      ? (isBusy ? `BUSY (${target.trajectoryStatus.runningTrajectories} tasks)` : 'IDLE')
      : 'STOPPED';
    const statusBadgeClass = target.isRunning 
      ? (isBusy ? 'badge-busy' : 'badge-idle')
      : 'badge-stopped';

    const pidText = target.isRunning && target.pid ? `PID: ${target.pid} | Port: ${target.port}` : '';
    const emailDisplay = target.email || (target.isRunning ? 'Authorized (Pending Status)' : 'Offline');
    const userNameDisplay = target.userName || '-';
    const tierDisplay = target.userTier || target.planName || '-';

    const disc = target.discovery || {};
    const discReason = disc.discoveryReason || 'Cached';
    const discCount = disc.discoveryCount || 1;
    const discTime = disc.lastDiscoveryAt ? new Date(disc.lastDiscoveryAt).toLocaleTimeString() : '-';

    const pAvail = target.credits ? formatNumber(target.credits.availablePromptCredits) : '-';
    const pMax = target.credits ? formatNumber(target.credits.monthlyPromptCredits) : '-';
    const pUsed = target.credits ? formatNumber(target.credits.computedUsedPromptCredits) : '-';

    const fAvail = target.credits ? formatNumber(target.credits.availableFlowCredits) : '-';
    const fMax = target.credits ? formatNumber(target.credits.monthlyFlowCredits) : '-';
    const fUsed = target.credits ? formatNumber(target.credits.computedUsedFlowCredits) : '-';

    const orderedModels = filterAndOrderModels(target.models);

    // Initial creation if card does not exist
    if (!card) {
      card = document.createElement('div');
      card.id = `target-card-${target.id}`;
      card.className = 'target-card';

      card.innerHTML = `
        <div class="target-card-header">
          <div class="target-title-block">
            <h3>${target.name}</h3>
          </div>
          <div class="target-actions">
            <div class="target-badges">
              <span class="badge-pid" id="pid-${target.id}" style="${pidText ? '' : 'display:none'}">${pidText}</span>
              <span class="status-badge ${statusBadgeClass}" id="status-badge-${target.id}">${statusText}</span>
            </div>
            <div id="switch-btn-wrap-${target.id}"></div>
          </div>
        </div>
        <div class="target-card-body">
          <div class="meta-section">
            <div class="meta-item">
              <span class="meta-key">Account Email</span>
              <span class="meta-val" id="email-${target.id}" title="${emailDisplay}">${emailDisplay}</span>
            </div>
            <div class="meta-item">
              <span class="meta-key">User Name</span>
              <span class="meta-val" id="username-${target.id}" title="${userNameDisplay}">${userNameDisplay}</span>
            </div>
            <div class="meta-item">
              <span class="meta-key">Tier / Plan</span>
              <span class="meta-val" id="tier-${target.id}" title="${tierDisplay}">${tierDisplay}</span>
            </div>
          </div>
          <div class="discovery-strip" id="discovery-${target.id}">
            <div class="discovery-item">Discovery: <strong>${discReason}</strong></div>
            <div class="discovery-item">Triggered: <strong>${discTime}</strong> (Count: <strong>${discCount}</strong>)</div>
          </div>
          <div class="credits-block" id="credits-wrap-${target.id}">
            <div class="credit-box">
              <div class="credit-box-title">Prompt Credits</div>
              <div class="credit-box-figures">
                <span class="credit-figures-avail" id="p-avail-${target.id}">${pAvail}</span>
                <span class="credit-figures-max" id="p-max-${target.id}">/ ${pMax}</span>
              </div>
              <div class="credit-computed-used" id="p-used-${target.id}">COMPUTED USED: ${pUsed}</div>
            </div>
            <div class="credit-box">
              <div class="credit-box-title">Flow Credits</div>
              <div class="credit-box-figures">
                <span class="credit-figures-avail" id="f-avail-${target.id}">${fAvail}</span>
                <span class="credit-figures-max" id="f-max-${target.id}">/ ${fMax}</span>
              </div>
              <div class="credit-computed-used" id="f-used-${target.id}">COMPUTED USED: ${fUsed}</div>
            </div>
          </div>
          <div class="models-section">
            <h4 id="models-title-${target.id}">Model Quotas (${orderedModels.length} Models Monitored)</h4>
            <div class="models-table-container">
              <table class="models-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Quota Remaining</th>
                    <th>Resets At</th>
                  </tr>
                </thead>
                <tbody id="models-tbody-${target.id}">
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `;

      container.appendChild(card);
    }

    // Keyed in-place DOM updates (Stable across 5s refreshes)
    // 1. Status & Badges
    const statusBadgeEl = document.getElementById(`status-badge-${target.id}`);
    if (statusBadgeEl) {
      statusBadgeEl.className = `status-badge ${statusBadgeClass}`;
      statusBadgeEl.innerText = statusText;
    }

    const pidEl = document.getElementById(`pid-${target.id}`);
    if (pidEl) {
      pidEl.style.display = pidText ? '' : 'none';
      pidEl.innerText = pidText;
    }

    // 2. Switch button
    const btnWrap = document.getElementById(`switch-btn-wrap-${target.id}`);
    if (btnWrap) {
      if (!target.isRunning) {
        btnWrap.innerHTML = `
          <button class="btn btn-switch btn-sm" disabled title="Target application is offline">
            Switch Account (Offline)
          </button>
        `;
      } else if (isBusy) {
        btnWrap.innerHTML = `
          <button class="btn btn-switch btn-sm" disabled title="Cannot switch while target is BUSY executing ${target.trajectoryStatus.runningTrajectories} task(s)">
            Switch Account (Busy)
          </button>
        `;
      } else {
        btnWrap.innerHTML = `
          <button class="btn btn-switch btn-sm" onclick="initiateSwitch('${target.id}')">
            Switch Account
          </button>
        `;
      }
    }

    // 3. Metadata
    const emailEl = document.getElementById(`email-${target.id}`);
    if (emailEl) {
      emailEl.innerText = emailDisplay;
      emailEl.title = emailDisplay;
    }

    const usernameEl = document.getElementById(`username-${target.id}`);
    if (usernameEl) {
      usernameEl.innerText = userNameDisplay;
      usernameEl.title = userNameDisplay;
    }

    const tierEl = document.getElementById(`tier-${target.id}`);
    if (tierEl) {
      tierEl.innerText = tierDisplay;
      tierEl.title = tierDisplay;
    }

    // 4. Discovery
    const discEl = document.getElementById(`discovery-${target.id}`);
    if (discEl) {
      discEl.innerHTML = `
        <div class="discovery-item">Discovery: <strong>${discReason}</strong></div>
        <div class="discovery-item">Triggered: <strong>${discTime}</strong> (Count: <strong>${discCount}</strong>)</div>
      `;
    }

    // 5. Credits
    const pAvailEl = document.getElementById(`p-avail-${target.id}`);
    if (pAvailEl) pAvailEl.innerText = pAvail;
    const pMaxEl = document.getElementById(`p-max-${target.id}`);
    if (pMaxEl) pMaxEl.innerText = `/ ${pMax}`;
    const pUsedEl = document.getElementById(`p-used-${target.id}`);
    if (pUsedEl) pUsedEl.innerText = `COMPUTED USED: ${pUsed}`;

    const fAvailEl = document.getElementById(`f-avail-${target.id}`);
    if (fAvailEl) fAvailEl.innerText = fAvail;
    const fMaxEl = document.getElementById(`f-max-${target.id}`);
    if (fMaxEl) fMaxEl.innerText = `/ ${fMax}`;
    const fUsedEl = document.getElementById(`f-used-${target.id}`);
    if (fUsedEl) fUsedEl.innerText = `COMPUTED USED: ${fUsed}`;

    // 6. Stable Keyed Models Table Update (Zero jumping, permanent row order)
    const modelsTbody = document.getElementById(`models-tbody-${target.id}`);
    const modelsTitle = document.getElementById(`models-title-${target.id}`);
    if (modelsTitle) {
      modelsTitle.innerText = `Model Quotas (${orderedModels.length} Models Monitored)`;
    }

    if (modelsTbody) {
      const existingRows = modelsTbody.querySelectorAll('tr[data-model-label]');
      const needsFullRender = existingRows.length !== orderedModels.length;

      if (needsFullRender) {
        // Render rows strictly once in predefined fixed sequence
        modelsTbody.innerHTML = orderedModels.map(m => {
          const pct = (m.remainingFraction * 100).toFixed(1);
          const fillClass = m.isExhausted ? 'model-quota-fill exhausted' : 'model-quota-fill';
          const widthPct = Math.min(100, Math.max(0, m.remainingFraction * 100));
          const exhaustedBadge = m.isExhausted 
            ? '<span class="status-badge badge-busy model-exhausted-badge" style="margin-left:6px; font-size:9px; padding:1px 5px;">EXHAUSTED</span>' 
            : '<span class="model-exhausted-badge"></span>';

          return `
            <tr data-model-label="${m.label}">
              <td class="model-name-cell">
                <span>${m.label}</span>
                ${exhaustedBadge}
              </td>
              <td>
                <div class="model-quota-cell">
                  <div class="model-quota-bar">
                    <div class="${fillClass}" style="width: ${widthPct}%"></div>
                  </div>
                  <span class="model-quota-pct">${pct}%</span>
                </div>
              </td>
              <td class="model-reset-cell">${formatTime(m.resetTime)}</td>
            </tr>
          `;
        }).join('');
      } else {
        // In-place updates: Never reorder, never recreate rows
        for (const m of orderedModels) {
          const row = modelsTbody.querySelector(`tr[data-model-label="${CSS.escape(m.label)}"]`);
          if (row) {
            const pct = (m.remainingFraction * 100).toFixed(1);
            const widthPct = Math.min(100, Math.max(0, m.remainingFraction * 100));

            // Update percentage text
            const pctEl = row.querySelector('.model-quota-pct');
            if (pctEl && pctEl.innerText !== `${pct}%`) {
              pctEl.innerText = `${pct}%`;
            }

            // Update quota bar width and class
            const fillEl = row.querySelector('.model-quota-fill');
            if (fillEl) {
              fillEl.style.width = `${widthPct}%`;
              fillEl.className = m.isExhausted ? 'model-quota-fill exhausted' : 'model-quota-fill';
            }

            // Update reset time
            const resetEl = row.querySelector('.model-reset-cell');
            const timeStr = formatTime(m.resetTime);
            if (resetEl && resetEl.innerText !== timeStr) {
              resetEl.innerText = timeStr;
            }

            // Update exhausted badge
            const exBadge = row.querySelector('.model-exhausted-badge');
            if (exBadge) {
              if (m.isExhausted) {
                exBadge.className = 'status-badge badge-busy model-exhausted-badge';
                exBadge.style.cssText = 'margin-left:6px; font-size:9px; padding:1px 5px;';
                exBadge.innerText = 'EXHAUSTED';
              } else {
                exBadge.className = 'model-exhausted-badge';
                exBadge.style.cssText = '';
                exBadge.innerText = '';
              }
            }
          }
        }
      }
    }
  }
}

function renderPool(pool) {
  if (!pool) return;

  const modelStats = pool.modelStats || {};
  const accounts = pool.accounts || [];
  const bestCandidates = pool.bestCandidates || {};
  const candidateRankings = pool.candidateRankings || {};
  const events = pool.events || [];

  const mStat = modelStats[currentSelectedPoolModel] || {
    accountCount: 0,
    readyCount: 0,
    lowCount: 0,
    criticalCount: 0,
    exhaustedCount: 0,
    averageRemainingPercent: 0,
    totalEquivalentCapacityRemaining: 0
  };

  // 1. Update Best Candidate Banner
  const best = bestCandidates[currentSelectedPoolModel];
  const candidateTitle = document.getElementById('candidate-title');
  const candidateReasons = document.getElementById('candidate-reasons');
  const candidatePct = document.getElementById('candidate-quota-pct');
  const candidateHealthWrap = document.getElementById('candidate-health-wrap');

  if (best) {
    if (candidateTitle) candidateTitle.innerText = `${best.accountLabel} (${best.accountEmail})`;
    if (candidateReasons) candidateReasons.innerText = best.reasons.join(' • ');
    if (candidatePct) candidatePct.innerText = `${best.remainingPercent}%`;
    if (candidateHealthWrap) {
      candidateHealthWrap.innerHTML = `<span class="badge-health-${best.health.toLowerCase()}">${best.health}</span>`;
    }
  } else {
    if (candidateTitle) candidateTitle.innerText = 'No Eligible Candidate Available';
    if (candidateReasons) candidateReasons.innerText = `All enabled accounts are exhausted, unavailable, or unobserved for ${currentSelectedPoolModel}.`;
    if (candidatePct) candidatePct.innerText = '0%';
    if (candidateHealthWrap) {
      candidateHealthWrap.innerHTML = `<span class="badge-tier-unavailable">UNAVAILABLE</span>`;
    }
  }

  // 2. Update Pool Summary Counters (Phase 4D)
  const elAcc = document.getElementById('pool-stat-accounts');
  const elVaultValid = document.getElementById('pool-stat-vault-valid');
  const elReady = document.getElementById('pool-stat-ready');
  const elLow = document.getElementById('pool-stat-low');
  const elCrit = document.getElementById('pool-stat-critical');
  const elReserve = document.getElementById('pool-stat-reserve');
  const elExhaust = document.getElementById('pool-stat-exhausted');
  const elStale = document.getElementById('pool-stat-stale');

  if (elAcc) elAcc.innerText = pool.poolSummary?.totalRegisteredAccounts || 0;
  if (elVaultValid) elVaultValid.innerText = pool.poolSummary?.validVaultSessionsCount || 0;
  if (elReady) elReady.innerText = pool.poolSummary?.readyCount || 0;
  if (elLow) elLow.innerText = pool.poolSummary?.lowCount || 0;
  if (elCrit) elCrit.innerText = pool.poolSummary?.criticalCount || 0;
  if (elReserve) elReserve.innerText = pool.poolSummary?.reserveCount || 0;
  if (elExhaust) elExhaust.innerText = pool.poolSummary?.exhaustedCount || 0;
  if (elStale) elStale.innerText = pool.poolSummary?.staleCount || 0;

  // 3. Render Multi-Account Table
  const tbody = document.getElementById('pool-table-body');
  if (!tbody) return;

  const rankingsForModel = candidateRankings[currentSelectedPoolModel] || [];
  const tierLookup = {};
  for (const r of rankingsForModel) {
    tierLookup[r.accountEmail] = r.tier;
  }

  // Sort strictly in fixed order: 1. Priority ascending, 2. Account ID
  const sortedAccounts = [...accounts].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.accountId.localeCompare(b.accountId);
  });

  const existingRows = tbody.querySelectorAll('tr[data-account-email]');
  const needsFullRender = existingRows.length !== sortedAccounts.length;

  if (needsFullRender) {
    tbody.innerHTML = sortedAccounts.map(acc => {
      const modelData = acc.models[currentSelectedPoolModel] || {
        remainingFraction: 0,
        remainingPercent: 0,
        health: 'EXHAUSTED'
      };
      const tier = tierLookup[acc.accountEmail] || 'SECONDARY';
      const tierBadgeClass = tier === 'BEST_CANDIDATE' ? 'badge-tier-best' : (tier === 'UNAVAILABLE' ? 'badge-tier-unavailable' : 'badge-tier-secondary');
      const healthBadgeClass = `badge-health-${modelData.health.toLowerCase()}`;
      const freshBadgeClass = `badge-freshness-${acc.freshness.toLowerCase()}`;
      const activeTargetText = acc.activeTarget ? (acc.activeTarget === 'ide' ? 'Antigravity IDE' : 'Antigravity 2.0') : '<span class="text-muted">-</span>';
      const fillWidth = Math.min(100, Math.max(0, modelData.remainingPercent));

      return `
        <tr data-account-email="${acc.accountEmail}">
          <td class="account-priority-cell"><span class="badge-priority" style="font-weight:700; color:var(--text-secondary);">#${acc.priority}</span></td>
          <td>
            <strong>${acc.accountLabel}</strong> ${acc.isReserve ? '<span class="badge-reserve">RESERVE</span>' : ''}
            <div class="text-muted" style="font-size:11px">${acc.accountEmail}</div>
          </td>
          <td>
            <div class="model-quota-cell">
              <div class="model-quota-bar">
                <div class="model-quota-fill pool-quota-fill ${modelData.health === 'EXHAUSTED' ? 'exhausted' : ''}" style="width: ${fillWidth}%"></div>
              </div>
              <span class="pool-quota-pct">${modelData.remainingPercent}%</span>
            </div>
          </td>
          <td><span class="${healthBadgeClass} pool-health-badge">${modelData.health}</span></td>
          <td><span class="${freshBadgeClass} pool-freshness-badge">${acc.freshness}</span></td>
          <td style="font-size:11px; color:var(--text-muted);">${formatResetTime(modelData.resetTime)}</td>
          <td><span class="badge-vault-status ${acc.vaultStatus === 'VALID' || acc.vaultStatus === 'ACTIVE' ? 'badge-vault-valid' : ''}">${acc.vaultStatus || 'UNKNOWN'}</span></td>
          <td>${acc.enabled ? '<span class="text-success" style="font-weight:600;">YES</span>' : '<span class="text-muted">NO</span>'}</td>
          <td class="account-target-cell">${activeTargetText}</td>
        </tr>
      `;
    }).join('');
  } else {
    // In-place updates by data-account-email (Never reorder rows)
    for (const acc of sortedAccounts) {
      const row = tbody.querySelector(`tr[data-account-email="${CSS.escape(acc.accountEmail)}"]`);
      if (row) {
        const modelData = acc.models[currentSelectedPoolModel] || {
          remainingFraction: 0,
          remainingPercent: 0,
          health: 'EXHAUSTED'
        };
        const tier = tierLookup[acc.accountEmail] || 'SECONDARY';

        // Update quota text and bar
        const pctEl = row.querySelector('.pool-quota-pct');
        if (pctEl && pctEl.innerText !== `${modelData.remainingPercent}%`) {
          pctEl.innerText = `${modelData.remainingPercent}%`;
        }
        const fillEl = row.querySelector('.pool-quota-fill');
        if (fillEl) {
          fillEl.style.width = `${Math.min(100, Math.max(0, modelData.remainingPercent))}%`;
          fillEl.className = `model-quota-fill pool-quota-fill ${modelData.health === 'EXHAUSTED' ? 'exhausted' : ''}`;
        }

        // Update health badge
        const healthEl = row.querySelector('.pool-health-badge');
        if (healthEl) {
          healthEl.className = `badge-health-${modelData.health.toLowerCase()} pool-health-badge`;
          healthEl.innerText = modelData.health;
        }

        // Update freshness badge
        const freshEl = row.querySelector('.pool-freshness-badge');
        if (freshEl) {
          freshEl.className = `badge-freshness-${acc.freshness.toLowerCase()} pool-freshness-badge`;
          freshEl.innerText = acc.freshness;
        }

        // Update tier badge
        const tierEl = row.querySelector('.pool-tier-badge');
        if (tierEl) {
          tierEl.className = `${tier === 'BEST_CANDIDATE' ? 'badge-tier-best' : (tier === 'UNAVAILABLE' ? 'badge-tier-unavailable' : 'badge-tier-secondary')} pool-tier-badge`;
          tierEl.innerText = tier.replace(/_/g, ' ');
        }

        // Update active target
        const targetEl = row.querySelector('.account-target-cell');
        const targetHtml = acc.activeTarget ? (acc.activeTarget === 'ide' ? 'Antigravity IDE' : 'Antigravity 2.0') : '<span class="text-muted">-</span>';
        if (targetEl && targetEl.innerHTML !== targetHtml) {
          targetEl.innerHTML = targetHtml;
        }
      }
    }
  }

  // 4. Render Event Stream
  const eventsListEl = document.getElementById('pool-events-list');
  if (eventsListEl && events.length > 0) {
    eventsListEl.innerHTML = events.slice(0, 5).map(ev => {
      const timeStr = new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `
        <div class="pool-event-item">
          <span class="pool-event-time">${timeStr}</span>
          <span class="pool-event-badge type-${ev.type}">${ev.type.replace(/_/g, ' ')}</span>
          <span>${ev.message}</span>
        </div>
      `;
    }).join('');
  }
}

function renderDashboard(data) {
  // 1. Update Aggregated Banner (Separate Resource Classes)
  const agg = data.aggregate || {};
  const promptPool = agg.prompt || { monthly: 0, available: 0, computedUsed: 0 };
  const flowPool = agg.flow || { monthly: 0, available: 0, computedUsed: 0 };

  // Prompt Pool
  document.getElementById('agg-prompt-monthly').innerText = formatNumber(promptPool.monthly);
  document.getElementById('agg-prompt-available').innerText = formatNumber(promptPool.available);
  document.getElementById('agg-prompt-used').innerText = formatNumber(promptPool.computedUsed);
  const promptPct = promptPool.monthly > 0 
    ? Math.min(100, Math.max(0, (promptPool.available / promptPool.monthly) * 100))
    : 0;
  document.getElementById('agg-prompt-bar').style.width = promptPct.toFixed(1) + '%';

  // Flow Pool
  document.getElementById('agg-flow-monthly').innerText = formatNumber(flowPool.monthly);
  document.getElementById('agg-flow-available').innerText = formatNumber(flowPool.available);
  document.getElementById('agg-flow-used').innerText = formatNumber(flowPool.computedUsed);
  const flowPct = flowPool.monthly > 0 
    ? Math.min(100, Math.max(0, (flowPool.available / flowPool.monthly) * 100))
    : 0;
  document.getElementById('agg-flow-bar').style.width = flowPct.toFixed(1) + '%';

  // System & Polling Efficiency Telemetry
  const sys = data.systemTelemetry || { powershellLaunches: 0, netstatLaunches: 0, rpcPollCount: 0 };
  document.getElementById('sys-rpc-count').innerText = `${formatNumber(sys.rpcPollCount)} RPCs`;
  document.getElementById('sys-subproc-stat').innerText = 
    `Subprocesses: ${sys.powershellLaunches} ps / ${sys.netstatLaunches} netstat (0 in steady 5s polling)`;

  const runningCount = (data.targets || []).filter(t => t.isRunning).length;
  const totalTargets = (data.targets || []).length;
  document.getElementById('agg-instance-count').innerText = `${runningCount} / ${totalTargets} Active`;
  document.getElementById('agg-last-sync').innerText = `Last updated: ${new Date(data.timestamp || Date.now()).toLocaleTimeString()}`;

  // 2. Active Switch Session Banner
  renderSwitchSession(data.activeSwitchSession);

  // 3. Render Targets Grid with Stable Keyed Updates
  renderTargets(data.targets);

  // 4. Render Project Routing Table
  renderProjects(data.projects);

  // 5. Render Multi-Account Pool & Quota Engine (Phase 4A)
  if (data.pool) {
    renderPool(data.pool);
  }

  // 6. Render Session Vault & Fast Switcher (Phase 4B/4C)
  renderVault(data.vault, data.targets);

  // 7. Render Automatic Quota Router (Phase 4I)
  renderRouter(data.router, data.targets);
}

async function activateVaultAccount(accountId) {
  if (!confirm(`Switch Antigravity 2.0 to vaulted account "${accountId}"?`)) return;
  try {
    const banner = document.getElementById('vault-progress-banner');
    if (banner) banner.classList.remove('hidden');
    const stateEl = document.getElementById('vault-progress-state');
    const msgEl = document.getElementById('vault-progress-msg');
    if (stateEl) stateEl.innerText = 'STATE: PRECHECK';
    if (msgEl) msgEl.innerText = 'Initiating atomic session switch...';

    const res = await fetch('/api/vault/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId })
    });

    const body = await res.json();
    if (!res.ok) {
      alert(`[VAULT SWITCH FAILED]\n\n${body.error || 'Switch failed. Rollback executed.'}`);
    }
    await fetchStatus(true);
  } catch (err) {
    alert(`Network error during activation: ${err.message}`);
  }
}

let enrollmentPollTimer = null;

function formatResetTime(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '-';
  }
}

function openEnrollmentModal() {
  const modal = document.getElementById('enrollment-modal');
  const stepperView = document.getElementById('enroll-stepper-view');
  const configView = document.getElementById('enroll-config-view');
  const startBtn = document.getElementById('btn-start-enrollment');
  const cancelBtn = document.getElementById('btn-cancel-enroll-modal');

  if (stepperView) stepperView.classList.add('hidden');
  if (configView) configView.classList.remove('hidden');
  if (startBtn) {
    startBtn.innerText = 'Start Sign-In';
    startBtn.disabled = false;
  }
  if (cancelBtn) cancelBtn.innerText = 'Cancel';
  if (modal) modal.classList.remove('hidden');
}

function closeEnrollmentModal() {
  const modal = document.getElementById('enrollment-modal');
  if (modal) modal.classList.add('hidden');
  if (enrollmentPollTimer) {
    clearInterval(enrollmentPollTimer);
    enrollmentPollTimer = null;
  }
}

async function startEnrollmentFlow() {
  const returnToBase = document.getElementById('enroll-return-to-base')?.checked ?? true;
  const stepperView = document.getElementById('enroll-stepper-view');
  const configView = document.getElementById('enroll-config-view');
  const startBtn = document.getElementById('btn-start-enrollment');
  const cancelBtn = document.getElementById('btn-cancel-enroll-modal');

  if (configView) configView.classList.add('hidden');
  if (stepperView) stepperView.classList.remove('hidden');
  if (startBtn) startBtn.disabled = true;
  if (cancelBtn) {
    cancelBtn.innerText = 'Cancel Enrollment';
    cancelBtn.onclick = cancelActiveEnrollment;
  }

  updateEnrollmentStepper({ state: 'PRECHECK', progress: 'Initiating enrollment workflow...' });

  try {
    const res = await fetch('/api/vault/enroll/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnToBase, timeoutMs: 300000 })
    });

    const body = await res.json();
    if (!res.ok) {
      alert(`Enrollment rejected: ${body.error || 'Unknown error'}`);
      closeEnrollmentModal();
      return;
    }

    // Start status polling
    pollEnrollmentStatus();
  } catch (err) {
    alert(`Network error starting enrollment: ${err.message}`);
    closeEnrollmentModal();
  }
}

async function cancelActiveEnrollment() {
  try {
    await fetch('/api/vault/enroll/cancel', { method: 'POST' });
    updateEnrollmentStepper({ state: 'CANCELLING', progress: 'Cancelling and rolling back...' });
  } catch (err) {
    console.error('Failed to cancel enrollment:', err);
  }
}

function pollEnrollmentStatus() {
  if (enrollmentPollTimer) clearInterval(enrollmentPollTimer);

  enrollmentPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/vault/enroll/status');
      if (!res.ok) return;
      const status = await res.json();
      updateEnrollmentStepper(status);

      if (status.state === 'COMPLETED' || status.state === 'FAILED') {
        clearInterval(enrollmentPollTimer);
        enrollmentPollTimer = null;
        const cancelBtn = document.getElementById('btn-cancel-enroll-modal');
        if (cancelBtn) {
          cancelBtn.innerText = 'Close';
          cancelBtn.onclick = closeEnrollmentModal;
        }
        await fetchStatus(true);
      }
    } catch {
      // keep polling
    }
  }, 1500);
}

function updateEnrollmentStepper(status) {
  const badge = document.getElementById('enroll-stepper-badge');
  const msg = document.getElementById('enroll-stepper-msg');
  if (badge) badge.innerText = status.state || 'IDLE';
  if (msg) msg.innerText = status.progress || status.error || 'Working...';

  const order = [
    'PRECHECK',
    'PRESERVE_CURRENT',
    'START_OAUTH',
    'WAITING_FOR_USER',
    'DETECT_ACCOUNT_CHANGE',
    'VALIDATING_NEW_ACCOUNT',
    'CAPTURING',
    'COLD_VERIFYING',
    'COMPLETED'
  ];

  const currentIdx = order.indexOf(status.state);
  const steps = document.querySelectorAll('#enroll-steps-grid .stepper-step');

  steps.forEach(stepEl => {
    const stepName = stepEl.getAttribute('data-step');
    const stepIdx = order.indexOf(stepName);

    stepEl.classList.remove('active', 'done', 'failed');
    if (status.state === 'FAILED' && stepIdx === currentIdx) {
      stepEl.classList.add('failed');
    } else if (stepIdx < currentIdx || status.state === 'COMPLETED') {
      stepEl.classList.add('done');
    } else if (stepIdx === currentIdx) {
      stepEl.classList.add('active');
    }
  });
}

function openEditAccountModal(email, accountId, label, priority, isReserve, enabled) {
  const modal = document.getElementById('account-edit-modal');
  document.getElementById('edit-acc-email').value = email;
  document.getElementById('edit-acc-id').value = accountId;
  document.getElementById('edit-acc-label').value = label || email.split('@')[0];
  document.getElementById('edit-acc-priority').value = priority || 1;
  document.getElementById('edit-acc-reserve').checked = Boolean(isReserve);
  document.getElementById('edit-acc-enabled').checked = enabled !== false;
  if (modal) modal.classList.remove('hidden');
}

function closeEditAccountModal() {
  const modal = document.getElementById('account-edit-modal');
  if (modal) modal.classList.add('hidden');
}

async function removeAccountFromVault(accountId, email) {
  if (!confirm(`Are you sure you want to remove account "${email}" (${accountId}) from Antigravity Manager?\n\nThis deletes the local encrypted vault credential and registry entry. It will NOT delete your Google account or affect IDE authentication.`)) return;

  try {
    const res = await fetch('/api/accounts/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, deleteQuotaCache: true })
    });

    const body = await res.json();
    if (!res.ok) {
      alert(`Account removal rejected: ${body.error || 'Unknown error'}`);
      return;
    }
    alert(`Account "${email}" successfully removed.`);
    await fetchStatus(true);
  } catch (err) {
    alert(`Network error removing account: ${err.message}`);
  }
}

function renderVault(vault, targets) {
  const banner = document.getElementById('vault-progress-banner');
  const pairingBanner = document.getElementById('pairing-progress-banner');
  const grid = document.getElementById('vault-accounts-grid');
  if (!grid) return;

  const ag2 = (targets || []).find(t => t.id === 'antigravity2');
  const currentAg2Email = ag2 && ag2.isRunning ? ag2.email : null;

  const ide = (targets || []).find(t => t.id === 'ide');
  const currentIdeEmail = ide && ide.isRunning ? ide.email : null;

  // Transactional Switch Banner
  if (vault && vault.controllerState && vault.controllerState !== 'IDLE' && vault.controllerState !== 'COMPLETED') {
    if (banner) {
      banner.classList.remove('hidden');
      const stateEl = document.getElementById('vault-progress-state');
      const msgEl = document.getElementById('vault-progress-msg');
      if (stateEl) stateEl.innerText = `STATE: ${vault.controllerState}`;
      if (msgEl) msgEl.innerText = vault.progress || 'Processing transactional operation...';
    }
  } else if (banner) {
    banner.classList.add('hidden');
  }

  // Cross-Target Pairing Banner (Phase 4G)
  if (pairingBanner) {
    const pairing = vault?.pairing;
    if (pairing && pairing.state && pairing.state !== 'IDLE' && pairing.state !== 'COMPLETED') {
      pairingBanner.classList.remove('hidden');
      const stateEl = document.getElementById('pairing-progress-state');
      const msgEl = document.getElementById('pairing-progress-msg');
      if (stateEl) {
        stateEl.innerText = pairing.state === 'WAITING_FOR_USER_LOGIN'
          ? `WAITING FOR USER LOGIN — ${pairing.expectedEmail}`
          : `STATE: ${pairing.state}`;
      }
      if (msgEl) msgEl.innerText = pairing.progress || 'Processing target enrollment...';
    } else {
      pairingBanner.classList.add('hidden');
    }
  }

  const accounts = vault?.accounts || [];
  if (accounts.length === 0) {
    grid.innerHTML = '<div class="text-muted" style="padding:16px; font-size:13px;">No accounts stored in the encrypted session vault yet. Click "+ Add Account" to begin.</div>';
    return;
  }

  // Compute Target Coverage
  const fullyPairedCount = accounts.filter(a => {
    const hasAg2 = Boolean(a.targets?.antigravity2 || a.target === 'antigravity2' || a.authMethod === 'oauth2_wincred');
    const hasIde = Boolean(a.targets?.ide || a.target === 'ide' || a.authMethod === 'oauth2_uss');
    return hasAg2 && hasIde;
  }).length;
  const coverageRatio = `${fullyPairedCount} / ${accounts.length} complete`;

  const rows = accounts.map(acc => {
    const email = acc.email || (acc.notes?.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)?.[1]) || acc.accountId;
    const hasAg2 = Boolean(acc.targets?.antigravity2 || acc.target === 'antigravity2' || acc.authMethod === 'oauth2_wincred');
    const hasIde = Boolean(acc.targets?.ide || acc.target === 'ide' || acc.authMethod === 'oauth2_uss');

    const isAg2Active = currentAg2Email && email.toLowerCase() === currentAg2Email.toLowerCase();
    const isIdeActive = currentIdeEmail && email.toLowerCase() === currentIdeEmail.toLowerCase();

    const targetBadges = [];
    if (isAg2Active) targetBadges.push('<span class="badge-target-ag2">AG2 ACTIVE</span>');
    if (isIdeActive) targetBadges.push('<span class="badge-target-ide">IDE ACTIVE</span>');
    if (targetBadges.length === 0) targetBadges.push('<span class="text-muted">—</span>');

    const ag2Cell = hasAg2
      ? `<div>
           <span class="badge-session-present">✓ VALID</span>
           <div class="target-capability-sub">Cold Restore / Interactive Hot</div>
         </div>`
      : '<span class="badge-session-absent">—</span>';

    const ideCell = hasIde
      ? `<div>
           <span class="badge-session-present">✓ VALID</span>
           <div class="target-capability-sub">Interactive Hot</div>
         </div>`
      : '<span class="badge-session-absent">—</span>';

    // Cross-Target Pairing Action Column (Phase 4G)
    let pairingActionHtml = '';
    if (hasAg2 && hasIde) {
      pairingActionHtml = '<span class="badge-fully-paired">✓ FULLY PAIRED</span>';
    } else if (hasAg2 && !hasIde) {
      pairingActionHtml = `
        <button class="btn btn-secondary btn-sm" onclick="startTargetEnrollment('${acc.accountId}', 'ide', '${email}')">
          + Add IDE Session
        </button>
      `;
    } else if (!hasAg2 && hasIde) {
      pairingActionHtml = `
        <button class="btn btn-secondary btn-sm" onclick="startTargetEnrollment('${acc.accountId}', 'antigravity2', '${email}')">
          + Add AG2 Session
        </button>
      `;
    }

    const freshnessBadge = `<span class="badge-freshness-${(acc.freshness || 'unknown').toLowerCase()}" style="font-size:10px; padding:2px 6px;">${acc.freshness || 'UNKNOWN'}</span>`;

    const switchBtn = hasAg2
      ? (isAg2Active
          ? '<button class="btn btn-secondary btn-sm" disabled title="Currently active on Antigravity 2.0">AG2 Active</button>'
          : `<button class="btn btn-primary btn-sm" onclick="activateVaultAccount('${acc.accountId}')">Switch AG2</button>`)
      : '';

    const editBtn = `<button class="btn btn-secondary btn-sm" onclick="openEditAccountModal('${email}', '${acc.accountId}', '${escapeHtml(acc.label || '')}', ${acc.priority || 1}, ${Boolean(acc.isReserve)}, ${acc.enabled !== false})">Edit</button>`;

    const removeBtn = (isAg2Active || isIdeActive)
      ? `<button class="btn btn-danger btn-sm" disabled title="Cannot remove active session">Remove</button>`
      : `<button class="btn btn-danger btn-sm" onclick="removeAccountFromVault('${acc.accountId}', '${email}')">Remove</button>`;

    return `
      <tr class="${(isAg2Active || isIdeActive) ? 'active-account-row' : ''}">
        <td>
          <div style="font-weight:600; color:var(--text-primary); font-family:monospace;">${email}</div>
          <div style="font-size:12px; color:var(--text-secondary); margin-top:2px;">
            <span>${escapeHtml(acc.label || acc.accountId)}</span>
            <span class="badge-priority" style="font-weight:700; margin-left:6px;">#${acc.priority || 1}</span>
            ${acc.isReserve ? '<span class="badge-reserve">RESERVE</span>' : ''}
            ${acc.enabled === false ? '<span class="text-muted" style="font-size:10px; margin-left:4px;">(DISABLED)</span>' : ''}
          </div>
        </td>
        <td>
          <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
            ${targetBadges.join('')}
          </div>
        </td>
        <td>${ideCell}</td>
        <td>${ag2Cell}</td>
        <td>${pairingActionHtml}</td>
        <td>
          <div>${freshnessBadge}</div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${acc.lastQuotaRefreshAt ? formatTime(acc.lastQuotaRefreshAt) : 'No refresh'}</div>
        </td>
        <td>
          <div style="display:flex; gap:6px; align-items:center;">
            ${switchBtn}
            ${editBtn}
            ${removeBtn}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  grid.innerHTML = `
    <div class="target-coverage-bar" style="margin-bottom:12px; padding:10px 14px; background:rgba(59,130,246,0.06); border:1px solid rgba(59,130,246,0.2); border-radius:6px; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <span style="font-size:12px; font-weight:700; letter-spacing:0.5px; color:#93c5fd; text-transform:uppercase;">Target Coverage</span>
        <span style="font-size:11px; color:var(--text-muted); margin-left:8px;">Dual IDE + Antigravity 2.0 sessions bound to single logical accounts</span>
      </div>
      <div>
        <span style="font-family:monospace; font-size:13px; font-weight:700; color:#38bdf8;">${coverageRatio}</span>
      </div>
    </div>
    <div class="unattended-feasibility-bar" style="margin-bottom:14px; padding:12px 16px; background:rgba(15,23,42,0.6); border:1px solid rgba(234,179,8,0.3); border-radius:6px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#eab308;"></span>
          <span style="font-size:12px; font-weight:700; letter-spacing:0.5px; color:#fde047; text-transform:uppercase;">Unattended Hot Activation Feasibility (Phase 4H)</span>
        </div>
        <span style="font-size:11px; padding:2px 8px; border-radius:4px; font-weight:600; background:rgba(234,179,8,0.15); color:#fde047; border:1px solid rgba(234,179,8,0.3);">INTERACTION_REQUIRED</span>
      </div>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:10px; font-size:11px; line-height:1.5;">
        <div style="background:rgba(0,0,0,0.25); padding:8px 10px; border-radius:4px; border:1px solid rgba(255,255,255,0.06);">
          <div style="font-weight:600; color:#e2e8f0;">Antigravity 2.0: <span style="color:#fde047;">INTERACTION_REQUIRED</span></div>
          <div style="color:var(--text-muted); margin-top:2px;">No supported stored-session runtime reload RPC; LoginWithBrowser deprecated; login_hint not exposed.</div>
        </div>
        <div style="background:rgba(0,0,0,0.25); padding:8px 10px; border-radius:4px; border:1px solid rgba(255,255,255,0.06);">
          <div style="font-weight:600; color:#e2e8f0;">Antigravity IDE: <span style="color:#fde047;">INTERACTION_REQUIRED</span></div>
          <div style="color:var(--text-muted); margin-top:2px;">Hardcoded prompt="consent"; silent prompt=none & login_hint unavailable through supported Electron Main path.</div>
        </div>
        <div style="background:rgba(0,0,0,0.25); padding:8px 10px; border-radius:4px; border:1px solid rgba(255,255,255,0.06);">
          <div style="font-weight:600; color:#e2e8f0;">Synced Hot Activation: <span style="color:#f87171;">NOT AVAILABLE</span></div>
          <div style="color:var(--text-muted); margin-top:2px;">Not available through currently supported interfaces in installed versions. Automatic routing safely disabled.</div>
        </div>
      </div>
    </div>
    <div class="vault-table-wrap">
      <table class="vault-table">
        <thead>
          <tr>
            <th>Account / Identity</th>
            <th>Active Targets</th>
            <th>Antigravity IDE</th>
            <th>Antigravity 2.0</th>
            <th>Pairing Status</th>
            <th>Quota Freshness</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

window.startTargetEnrollment = async function(accountId, targetId, email) {
  const targetLabel = targetId === 'ide' ? 'Antigravity IDE' : 'Antigravity 2.0';
  const confirmMsg = `Enroll missing ${targetLabel} session for account "${email}" (${accountId})?\n\nYou will be prompted to authenticate as "${email}".`;
  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch('/api/vault/enroll-target', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, targetId, returnToBase: true })
    });
    const data = await res.json();
    if (!res.ok) {
      alert(`Enrollment could not start: ${data.error || data.message || 'Unknown error'}`);
      return;
    }
    await fetchStatus(true);
  } catch (err) {
    alert(`Network error initiating target enrollment: ${err.message}`);
  }
};

window.cancelTargetEnrollment = async function() {
  try {
    const res = await fetch('/api/vault/enroll-target/cancel', {
      method: 'POST'
    });
    const data = await res.json();
    await fetchStatus(true);
  } catch (err) {
    alert(`Failed to cancel target enrollment: ${err.message}`);
  }
};

function renderRouter(router, targets) {
  const grid = document.getElementById('router-targets-grid');
  if (!grid) return;

  if (!router) {
    grid.innerHTML = '<div class="text-muted" style="padding:12px; font-size:13px;">Router telemetry initializing...</div>';
    return;
  }

  const config = router.config || {};
  const isEnabled = config.enabled === true;
  const opMode = config.operatingMode || (isEnabled ? 'LIVE' : 'OFF');

  // 1. Operating mode select sync
  const opModeSelect = document.getElementById('router-operating-mode-select');
  if (opModeSelect && !opModeSelect.matches(':focus')) {
    opModeSelect.value = opMode;
  }

  // 2. Power toggle update
  const powerBtn = document.getElementById('btn-toggle-router');
  const powerDot = document.getElementById('router-power-indicator');
  const powerText = document.getElementById('router-power-text');

  if (powerDot) {
    if (opMode === 'SHADOW') {
      powerDot.style.background = '#06b6d4';
    } else if (opMode === 'LIVE') {
      powerDot.style.background = '#10b981';
    } else {
      powerDot.style.background = '#ef4444';
    }
  }

  if (powerText) {
    if (opMode === 'SHADOW') {
      powerText.innerText = 'Routing: SHADOW';
    } else if (opMode === 'LIVE') {
      powerText.innerText = 'Routing: LIVE';
    } else {
      powerText.innerText = 'Routing: OFF';
    }
  }

  if (powerBtn) {
    if (opMode === 'SHADOW') {
      powerBtn.className = 'btn btn-sm';
      powerBtn.style.cssText = 'font-weight:700; background:rgba(6,182,212,0.15); color:#22d3ee; border:1px solid rgba(6,182,212,0.4);';
    } else if (opMode === 'LIVE') {
      powerBtn.className = 'btn btn-success btn-sm';
      powerBtn.style.cssText = 'font-weight:700;';
    } else {
      powerBtn.className = 'btn btn-secondary btn-sm';
      powerBtn.style.cssText = 'font-weight:700;';
    }
  }

  // 3. Monitored model dropdown
  const modelSelect = document.getElementById('router-model-select');
  if (modelSelect && !modelSelect.matches(':focus') && config.selectedModel) {
    modelSelect.value = config.selectedModel;
  }

  // 4. Mode select
  const modeSelect = document.getElementById('router-mode-select');
  if (modeSelect && !modeSelect.matches(':focus') && config.mode) {
    modeSelect.value = config.mode;
  }

  // 5. Target cards
  const rTargets = router.targets || {};
  const targetIds = ['ide', 'antigravity2'];

  grid.innerHTML = targetIds.map(tId => {
    const st = rTargets[tId] || {
      targetName: tId === 'ide' ? 'Antigravity IDE' : 'Antigravity 2.0',
      state: 'MONITORING',
      currentEmail: null,
      currentModelQuotaPercent: null,
      health: 'READY',
      recommendedCandidate: null,
      activationCapability: tId === 'ide' ? 'INTERACTION_REQUIRED' : 'AUTOMATIC_COLD_TARGET_RELOAD',
      actionRequired: 'Monitoring quota',
      isIdle: true,
      runningTrajectories: 0,
      dwellRemainingSeconds: 0,
      shadowPlan: null
    };

    const quotaPct = st.currentModelQuotaPercent !== null ? `${st.currentModelQuotaPercent}%` : '-';
    const healthBadge = `<span class="badge-health-${(st.health || 'ready').toLowerCase()}">${st.health || 'READY'}</span>`;

    let stateColor = '#10b981';
    if (st.state === 'ROUTE_NEEDED' || st.state === 'WAITING_FOR_USER') stateColor = '#f59e0b';
    if (st.state === 'ACTIVATING') stateColor = '#3b82f6';
    if (st.state === 'WAITING_FOR_IDLE' || st.state === 'WAIT_FOR_RESET') stateColor = '#f97316';
    if (st.state === 'FAILED' || st.state === 'COOLDOWN') stateColor = '#ef4444';

    const stateBadge = `<span style="font-size:11px; padding:2px 8px; border-radius:4px; font-weight:700; background:rgba(0,0,0,0.3); color:${stateColor}; border:1px solid ${stateColor};">STATE: ${st.state}</span>`;

    const dwellBadge = st.dwellRemainingSeconds > 0
      ? `<span style="font-size:11px; color:#93c5fd; background:rgba(59,130,246,0.1); padding:2px 6px; border-radius:4px;">Dwell: ${Math.ceil(st.dwellRemainingSeconds / 60)}m</span>`
      : `<span style="font-size:11px; color:var(--text-muted);">Dwell: Complete</span>`;

    const taskBadge = st.runningTrajectories > 0
      ? `<span style="font-size:11px; color:#f97316; font-weight:600;">BUSY (${st.runningTrajectories} tasks)</span>`
      : `<span style="font-size:11px; color:#10b981;">IDLE</span>`;

    const candidate = st.recommendedCandidate;
    let candidateHtml = '<span class="text-muted">None recommended</span>';
    if (candidate) {
      candidateHtml = `
        <div style="font-weight:600; color:#38bdf8;">${candidate.accountLabel} (${candidate.accountEmail})</div>
        <div style="font-size:11px; color:var(--text-muted);">
          Quota: <strong>${candidate.remainingPercent}%</strong> • Score: <strong>${candidate.score}</strong> • Freshness: <strong>${candidate.freshness}</strong>
        </div>
      `;
    }

    // Shadow hypothetical action plan card
    let shadowPlanHtml = '';
    if (st.shadowPlan) {
      shadowPlanHtml = `
        <div class="shadow-plan-card" style="margin-top:10px; padding:10px 12px; background:rgba(6,182,212,0.08); border:1px solid rgba(6,182,212,0.3); border-radius:6px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
            <span style="font-size:11px; font-weight:700; color:#22d3ee; text-transform:uppercase; letter-spacing:0.5px;">⚡ Hypothetical Action (Shadow Mode)</span>
            <span style="font-size:10px; color:#67e8f9; background:rgba(6,182,212,0.2); padding:1px 6px; border-radius:3px;">NO MUTATION</span>
          </div>
          <div style="font-size:12px; color:#e2e8f0; font-weight:600; margin-bottom:3px;">${escapeHtml(st.shadowPlan.actionDescription)}</div>
          <div style="font-size:11px; color:#94a3b8;">
            Candidate: <strong style="color:#38bdf8;">${escapeHtml(st.shadowPlan.candidateEmail)}</strong> (${st.shadowPlan.candidateModelQuotaPercent}%) • Strategy: <code>${st.shadowPlan.wouldPerform}</code>
          </div>
        </div>
      `;
    }

    // Action button for IDE interaction (live mode only)
    let actionBtnHtml = '';
    if (tId === 'ide' && st.state === 'WAITING_FOR_USER' && opMode === 'LIVE') {
      actionBtnHtml = `
        <div style="margin-top:10px; display:flex; gap:8px;">
          <button class="btn btn-primary btn-sm" onclick="triggerIdeSwitchHandoff()" style="background:#f59e0b; border-color:#d97706; color:#000; font-weight:700;">
            👉 [ Switch IDE ]
          </button>
          <button class="btn btn-secondary btn-sm" onclick="cancelRouterHandoff()">
            Cancel
          </button>
        </div>
      `;
    }

    return `
      <div class="router-target-card" style="background:rgba(0,0,0,0.25); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:14px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <h4 style="margin:0; font-size:14px; color:var(--text-primary); font-weight:700;">${st.targetName}</h4>
          ${stateBadge}
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:12px; margin-bottom:10px;">
          <div>
            <span style="color:var(--text-muted);">Current Account:</span>
            <div style="font-weight:600; color:var(--text-primary);">${st.currentEmail || 'Offline'}</div>
          </div>
          <div>
            <span style="color:var(--text-muted);">Model Quota:</span>
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-weight:700; color:var(--text-primary); font-family:monospace;">${quotaPct}</span>
              ${healthBadge}
            </div>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; font-size:11px;">
          <div>${taskBadge}</div>
          <div>${dwellBadge}</div>
          <div style="color:var(--text-muted); font-size:10px;">Capability: <code>${st.activationCapability}</code></div>
        </div>

        <div style="background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.05); border-radius:4px; padding:8px 10px; margin-bottom:8px;">
          <span style="font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:700; letter-spacing:0.5px;">Recommended Candidate:</span>
          ${candidateHtml}
        </div>

        <div style="font-size:11px; color:#cbd5e1; line-height:1.4;">
          <strong>Action:</strong> ${st.actionRequired}
        </div>

        ${shadowPlanHtml}
        ${actionBtnHtml}
      </div>
    `;
  }).join('');
}

window.triggerIdeSwitchHandoff = async function() {
  try {
    const res = await fetch('/api/router/switch-ide', { method: 'POST' });
    const data = await res.json();
    await fetchStatus(true);
  } catch (err) {
    alert(`Error initiating IDE switch: ${err.message}`);
  }
};

window.cancelRouterHandoff = async function() {
  try {
    const res = await fetch('/api/router/cancel', { method: 'POST' });
    const data = await res.json();
    await fetchStatus(true);
  } catch (err) {
    alert(`Error cancelling router handoff: ${err.message}`);
  }
};

function init() {
  fetchStatus();

  // Setup Router Controls (Phase 4I / Phase 4J)
  const toggleRouterBtn = document.getElementById('btn-toggle-router');
  if (toggleRouterBtn) {
    toggleRouterBtn.addEventListener('click', () => {
      const currentMode = lastDashboardData?.router?.config?.operatingMode || (lastDashboardData?.router?.config?.enabled ? 'LIVE' : 'OFF');
      if (currentMode !== 'OFF') {
        fetch('/api/router/disable', { method: 'POST' }).then(() => fetchStatus(true));
      } else {
        const modal = document.getElementById('router-enable-modal');
        if (modal) modal.classList.remove('hidden');
      }
    });
  }

  const confirmRouterBtn = document.getElementById('btn-confirm-router-enable');
  if (confirmRouterBtn) {
    confirmRouterBtn.addEventListener('click', async () => {
      await fetch('/api/router/acknowledge-enable', { method: 'POST' });
      const modal = document.getElementById('router-enable-modal');
      if (modal) modal.classList.add('hidden');
      await fetchStatus(true);
    });
  }

  const cancelRouterBtn = document.getElementById('btn-cancel-router-enable');
  const closeRouterModalBtn = document.getElementById('btn-close-router-modal');
  [cancelRouterBtn, closeRouterModalBtn].forEach(b => {
    if (b) b.addEventListener('click', () => {
      const modal = document.getElementById('router-enable-modal');
      if (modal) modal.classList.add('hidden');
    });
  });

  const routerOpModeSelect = document.getElementById('router-operating-mode-select');
  if (routerOpModeSelect) {
    routerOpModeSelect.addEventListener('change', async (e) => {
      const newMode = e.target.value;
      if (newMode === 'LIVE') {
        alert('LIVE routing is disabled during Phase 4J. Operating in SHADOW mode only.');
        e.target.value = 'SHADOW';
        return;
      }
      try {
        const res = await fetch('/api/router/operating-mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: newMode })
        });
        if (!res.ok) {
          const body = await res.json();
          alert(`Failed to set operating mode: ${body.error || 'Unknown error'}`);
        }
        await fetchStatus(true);
      } catch (err) {
        alert(`Network error: ${err.message}`);
      }
    });
  }

  const routerModelSelect = document.getElementById('router-model-select');
  if (routerModelSelect) {
    routerModelSelect.addEventListener('change', async (e) => {
      await fetch('/api/router/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedModel: e.target.value })
      });
      await fetchStatus(true);
    });
  }

  const routerModeSelect = document.getElementById('router-mode-select');
  if (routerModeSelect) {
    routerModeSelect.addEventListener('change', async (e) => {
      await fetch('/api/router/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: e.target.value })
      });
      await fetchStatus(true);
    });
  }

  // Setup Model Selector in Multi-Account Pool
  const poolSelect = document.getElementById('pool-model-select');
  if (poolSelect) {
    poolSelect.addEventListener('change', (e) => {
      currentSelectedPoolModel = e.target.value;
      if (lastDashboardData && lastDashboardData.pool) {
        renderPool(lastDashboardData.pool);
      }
    });
  }

  // Setup Enroll Account button in Vault Panel
  const enrollBtn = document.getElementById('btn-enroll-account');
  if (enrollBtn) {
    enrollBtn.addEventListener('click', openEnrollmentModal);
  }

  // Enrollment Modal Buttons
  const closeEnrollBtn = document.getElementById('btn-close-enroll-modal');
  if (closeEnrollBtn) closeEnrollBtn.addEventListener('click', closeEnrollmentModal);

  const cancelEnrollModalBtn = document.getElementById('btn-cancel-enroll-modal');
  if (cancelEnrollModalBtn) cancelEnrollModalBtn.addEventListener('click', closeEnrollmentModal);

  const startEnrollBtn = document.getElementById('btn-start-enrollment');
  if (startEnrollBtn) startEnrollBtn.addEventListener('click', startEnrollmentFlow);

  // Edit Account Modal Buttons & Form
  const closeEditBtn = document.getElementById('btn-close-edit-modal');
  if (closeEditBtn) closeEditBtn.addEventListener('click', closeEditAccountModal);

  const cancelEditBtn = document.getElementById('btn-cancel-edit-modal');
  if (cancelEditBtn) cancelEditBtn.addEventListener('click', closeEditAccountModal);

  const editForm = document.getElementById('form-edit-account');
  if (editForm) {
    editForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('edit-acc-email').value;
      const label = document.getElementById('edit-acc-label').value.trim();
      const priority = parseInt(document.getElementById('edit-acc-priority').value, 10);
      const isReserve = document.getElementById('edit-acc-reserve').checked;
      const enabled = document.getElementById('edit-acc-enabled').checked;

      try {
        const res = await fetch('/api/accounts/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, label, priority, isReserve, enabled })
        });
        const body = await res.json();
        if (!res.ok) {
          alert(`Failed to update account: ${body.error || 'Unknown error'}`);
          return;
        }
        closeEditAccountModal();
        await fetchStatus(true);
      } catch (err) {
        alert(`Network error updating account: ${err.message}`);
      }
    });
  }

  // Setup Refresh Button (Manual triggers force-scan)
  const refreshBtn = document.getElementById('btn-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => fetchStatus(true));
  }

  // Setup Auto-refresh toggle
  const autoToggle = document.getElementById('auto-refresh-toggle');
  if (autoToggle) {
    autoRefreshTimer = setInterval(() => {
      if (autoToggle.checked) {
        fetchStatus(false);
      }
    }, 5000);

    autoToggle.addEventListener('change', () => {
      if (autoToggle.checked) {
        fetchStatus(false);
      }
    });
  }

  // Setup Project Mapping Form Toggle
  const toggleBtn = document.getElementById('btn-toggle-add-project');
  const addForm = document.getElementById('form-add-project');
  const cancelAddBtn = document.getElementById('btn-cancel-add-project');

  if (toggleBtn && addForm) {
    toggleBtn.addEventListener('click', () => {
      addForm.classList.toggle('hidden');
    });
  }

  if (cancelAddBtn && addForm) {
    cancelAddBtn.addEventListener('click', () => {
      addForm.classList.add('hidden');
    });
  }

  if (addForm) {
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('proj-name').value.trim();
      const path = document.getElementById('proj-path').value.trim();
      const target = document.getElementById('proj-target').value;
      const preferredAccountEmail = document.getElementById('proj-email').value.trim();

      if (!name || !target || !preferredAccountEmail) {
        alert('Please fill in project name, target instance, and preferred email.');
        return;
      }

      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, path, target, preferredAccountEmail })
        });

        if (!res.ok) {
          const errData = await res.json();
          alert(`Failed to save project mapping: ${errData.error || 'Unknown error'}`);
          return;
        }

        addForm.reset();
        addForm.classList.add('hidden');
        await fetchStatus(true);
      } catch (err) {
        alert(`Error saving project: ${err.message}`);
      }
    });
  }
}

window.addEventListener('DOMContentLoaded', init);
