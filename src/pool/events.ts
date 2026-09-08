import { AccountHealthState, CandidateScore, FreshnessState, PoolEvent, PoolEventType } from './types';

export class PoolEventManager {
  private events: PoolEvent[] = [];
  private maxEvents: number = 50;
  // Dedup trackers
  private lastHealthState: Map<string, AccountHealthState> = new Map();
  private lastFraction: Map<string, number> = new Map();
  private lastFreshness: Map<string, FreshnessState> = new Map();
  private lastBestCandidate: Map<string, string | null> = new Map(); // modelLabel -> accountEmail
  private cooldownMap: Map<string, number> = new Map();
  private cooldownMs: number = 5 * 60 * 1000; // 5 minutes cooldown for repeat events

  private isCoolingDown(key: string, nowMs: number): boolean {
    const lastTime = this.cooldownMap.get(key);
    if (!lastTime) return false;
    return (nowMs - lastTime) < this.cooldownMs;
  }

  private addEvent(event: PoolEvent, cooldownKey?: string, nowMs: number = Date.now()): void {
    if (cooldownKey) {
      this.cooldownMap.set(cooldownKey, nowMs);
    }
    this.events.unshift(event);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(0, this.maxEvents);
    }
  }

  /**
   * Evaluates state transitions and generates deduplicated informational events.
   * Strictly emits zero automatic account switches.
   */
  evaluateTransitions(options: {
    accounts: Array<{
      accountId: string;
      accountEmail: string;
      accountLabel: string;
      freshness: FreshnessState;
      models: Record<string, {
        remainingFraction: number;
        remainingPercent: number;
        health: AccountHealthState;
      }>;
    }>;
    bestCandidates: Record<string, CandidateScore | null>;
    nowMs?: number;
  }): PoolEvent[] {
    const { accounts, bestCandidates, nowMs = Date.now() } = options;
    const newEvents: PoolEvent[] = [];

    // 1. Evaluate Account & Model Health Transitions
    for (const acc of accounts) {
      const email = acc.accountEmail;

      // Freshness Transition: check if data became STALE
      const freshnessKey = `${email}:freshness`;
      const prevFreshness = this.lastFreshness.get(freshnessKey);
      if (prevFreshness && prevFreshness !== 'STALE' && acc.freshness === 'STALE') {
        const cdKey = `${email}:STALE`;
        if (!this.isCoolingDown(cdKey, nowMs)) {
          const ev: PoolEvent = {
            id: `ev-${nowMs}-${Math.random().toString(36).substr(2, 6)}`,
            type: 'QUOTA_DATA_STALE',
            accountId: acc.accountId,
            accountEmail: email,
            timestamp: new Date(nowMs).toISOString(),
            message: `Telemetry for ${acc.accountLabel} (${email}) has become STALE (> 5 minutes without update).`
          };
          this.addEvent(ev, cdKey, nowMs);
          newEvents.push(ev);
        }
      }
      this.lastFreshness.set(freshnessKey, acc.freshness);

      // Model Health Transitions
      for (const [modelLabel, m] of Object.entries(acc.models)) {
        const stateKey = `${email}:${modelLabel}:health`;
        const fracKey = `${email}:${modelLabel}:fraction`;

        const prevHealth = this.lastHealthState.get(stateKey);
        const prevFrac = this.lastFraction.get(fracKey) ?? m.remainingFraction;

        // Quota Reset detection: jump from <= 20% to >= 80%
        if (prevFrac <= 0.20 && m.remainingFraction >= 0.80) {
          const cdKey = `${email}:${modelLabel}:RESET`;
          if (!this.isCoolingDown(cdKey, nowMs)) {
            const ev: PoolEvent = {
              id: `ev-${nowMs}-${Math.random().toString(36).substr(2, 6)}`,
              type: 'QUOTA_RESET',
              accountId: acc.accountId,
              accountEmail: email,
              modelLabel,
              timestamp: new Date(nowMs).toISOString(),
              message: `Quota reset detected on ${acc.accountLabel} for ${modelLabel} (${(prevFrac * 100).toFixed(0)}% -> ${m.remainingPercent}%).`
            };
            this.addEvent(ev, cdKey, nowMs);
            newEvents.push(ev);
          }
        }

        // State Transitions to LOW, CRITICAL, EXHAUSTED
        if (prevHealth && prevHealth !== m.health) {
          let eventType: PoolEventType | null = null;
          let msg = '';

          if (m.health === 'EXHAUSTED' && prevHealth !== 'EXHAUSTED') {
            eventType = 'ACCOUNT_EXHAUSTED';
            msg = `Quota EXHAUSTED on ${acc.accountLabel} for ${modelLabel}.`;
          } else if (m.health === 'CRITICAL' && prevHealth !== 'CRITICAL' && prevHealth !== 'EXHAUSTED') {
            eventType = 'ACCOUNT_CRITICAL';
            msg = `Critical quota remaining on ${acc.accountLabel} for ${modelLabel} (${m.remainingPercent}%).`;
          } else if (m.health === 'LOW' && prevHealth === 'READY') {
            eventType = 'ACCOUNT_LOW';
            msg = `Low quota remaining on ${acc.accountLabel} for ${modelLabel} (${m.remainingPercent}%).`;
          }

          if (eventType) {
            const cdKey = `${email}:${modelLabel}:${eventType}`;
            if (!this.isCoolingDown(cdKey, nowMs)) {
              const ev: PoolEvent = {
                id: `ev-${nowMs}-${Math.random().toString(36).substr(2, 6)}`,
                type: eventType,
                accountId: acc.accountId,
                accountEmail: email,
                modelLabel,
                timestamp: new Date(nowMs).toISOString(),
                message: msg
              };
              this.addEvent(ev, cdKey, nowMs);
              newEvents.push(ev);
            }
          }
        }

        this.lastHealthState.set(stateKey, m.health);
        this.lastFraction.set(fracKey, m.remainingFraction);
      }
    }

    // 2. Evaluate Best Candidate Changes per Model
    for (const [modelLabel, best] of Object.entries(bestCandidates)) {
      const prevBestEmail = this.lastBestCandidate.get(modelLabel);
      const currentBestEmail = best ? best.accountEmail : null;

      if (prevBestEmail !== undefined && prevBestEmail !== currentBestEmail && currentBestEmail !== null) {
        const cdKey = `BEST:${modelLabel}`;
        if (!this.isCoolingDown(cdKey, nowMs)) {
          const ev: PoolEvent = {
            id: `ev-${nowMs}-${Math.random().toString(36).substr(2, 6)}`,
            type: 'BEST_CANDIDATE_CHANGED',
            accountId: best!.accountId,
            accountEmail: currentBestEmail,
            modelLabel,
            timestamp: new Date(nowMs).toISOString(),
            message: `Best candidate for ${modelLabel} changed to ${best!.accountLabel} (${best!.remainingPercent}% remaining).`
          };
          this.addEvent(ev, cdKey, nowMs);
          newEvents.push(ev);
        }
      }

      this.lastBestCandidate.set(modelLabel, currentBestEmail);
    }

    return newEvents;
  }

  getRecentEvents(): PoolEvent[] {
    return [...this.events];
  }

  clearEvents(): void {
    this.events = [];
    this.cooldownMap.clear();
    this.lastHealthState.clear();
    this.lastFraction.clear();
    this.lastFreshness.clear();
    this.lastBestCandidate.clear();
  }
}
