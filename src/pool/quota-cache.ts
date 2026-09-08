import path from 'path';
import { AccountQuotaCacheEntry, FreshnessState } from './types';
import { CreditStatus, ModelQuota } from '../types';
import { filterAndOrderModels } from '../models/filter';
import { evaluateFreshness } from './freshness';
import { normalizeEmail } from './account-registry';
import { AtomicJsonStore } from './atomic-file';

export interface UpdateQuotaCacheOptions {
  email: string;
  planName?: string | null;
  userTier?: string | null;
  credits?: CreditStatus | null;
  models?: ModelQuota[] | null;
  capturedAt?: string;
}

/**
 * Quota Cache
 * Persists last-known quota telemetry per account in data/quota-cache.json.
 * Never erases last-known quota when an account becomes inactive or offline.
 */
function sanitizeModelQuotas(raw: any[]): ModelQuota[] {
  return filterAndOrderModels(raw || []).map(m => ({
    label: m.label,
    modelOrTier: m.modelOrTier || '',
    remainingFraction: m.remainingFraction,
    resetTime: m.resetTime,
    isExhausted: m.isExhausted
  }));
}

export class QuotaCache {
  private store: AtomicJsonStore<Record<string, AccountQuotaCacheEntry>>;
  private cache: Map<string, AccountQuotaCacheEntry> = new Map();

  constructor(filePath?: string) {
    const p = filePath || path.join(__dirname, '..', '..', 'data', 'quota-cache.json');
    this.store = new AtomicJsonStore<Record<string, AccountQuotaCacheEntry>>(p);
    this.load();
  }

  private load(): void {
    const raw = this.store.readSync({});
    this.cache.clear();
    for (const [key, val] of Object.entries(raw)) {
      const email = normalizeEmail(val.email || key);
      if (email) {
        this.cache.set(email, {
          ...val,
          email,
          // Guarantee models adhere to the 6 filtered models
          models: sanitizeModelQuotas(val.models || [])
        });
      }
    }
  }

  private persist(sync: boolean = false): void {
    const data: Record<string, AccountQuotaCacheEntry> = {};
    for (const [email, entry] of this.cache.entries()) {
      data[email] = {
        email: entry.email,
        capturedAt: entry.capturedAt,
        planName: entry.planName || 'Standard',
        userTier: entry.userTier || 'Standard',
        promptCredits: entry.promptCredits,
        flowCredits: entry.flowCredits,
        models: entry.models.map(m => ({
          label: m.label,
          modelOrTier: m.modelOrTier,
          remainingFraction: m.remainingFraction,
          resetTime: m.resetTime,
          isExhausted: m.isExhausted
        }))
      };
    }

    if (sync) {
      this.store.writeSync(data);
    } else {
      this.store.scheduleSave(data);
    }
  }

  flush(): void {
    this.persist(true);
    this.store.flush();
  }

  /**
   * Updates cache entry when fresh GetUserStatus telemetry is observed.
   * Only the 6 High/Thinking models are stored.
   */
  updateCache(options: UpdateQuotaCacheOptions): AccountQuotaCacheEntry {
    const email = normalizeEmail(options.email);
    if (!email) {
      throw new Error('Account email cannot be empty');
    }

    const capturedAt = options.capturedAt || new Date().toISOString();
    const filteredModels = sanitizeModelQuotas(options.models || []);

    const promptCredits = options.credits ? {
      monthly: options.credits.monthlyPromptCredits || 0,
      available: options.credits.availablePromptCredits || 0,
      computedUsed: options.credits.computedUsedPromptCredits || 0
    } : { monthly: 0, available: 0, computedUsed: 0 };

    const flowCredits = options.credits ? {
      monthly: options.credits.monthlyFlowCredits || 0,
      available: options.credits.availableFlowCredits || 0,
      computedUsed: options.credits.computedUsedFlowCredits || 0
    } : { monthly: 0, available: 0, computedUsed: 0 };

    const entry: AccountQuotaCacheEntry = {
      email,
      capturedAt,
      planName: options.planName || 'Standard',
      userTier: options.userTier || options.planName || 'Standard',
      promptCredits,
      flowCredits,
      models: filteredModels
    };

    this.cache.set(email, entry);
    this.persist(false);

    return this.getQuota(email)!;
  }

  /**
   * Retrieves last-known quota with dynamic freshness evaluation.
   */
  getQuota(email: string, nowMs: number = Date.now()): (AccountQuotaCacheEntry & { freshness: FreshnessState }) | null {
    const normalized = normalizeEmail(email);
    const entry = this.cache.get(normalized);
    if (!entry) return null;

    const freshness = evaluateFreshness(entry.capturedAt, nowMs);
    return {
      ...entry,
      freshness
    };
  }

  getAllQuotas(nowMs: number = Date.now()): Array<AccountQuotaCacheEntry & { freshness: FreshnessState }> {
    const list: Array<AccountQuotaCacheEntry & { freshness: FreshnessState }> = [];
    for (const [email, entry] of this.cache.entries()) {
      list.push({
        ...entry,
        freshness: evaluateFreshness(entry.capturedAt, nowMs)
      });
    }
    return list;
  }

  deleteQuota(email: string): boolean {
    const normalized = normalizeEmail(email);
    const removed = this.cache.delete(normalized);
    if (removed) {
      this.persist(true);
    }
    return removed;
  }

  size(): number {
    return this.cache.size;
  }
}
