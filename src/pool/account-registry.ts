import path from 'path';
import { AccountRegistryEntry } from './types';
import { TargetId } from '../types';
import { AtomicJsonStore } from './atomic-file';

export interface RegisterAccountOptions {
  email: string;
  targetId?: TargetId | null;
  userName?: string | null;
  label?: string;
  priority?: number;
  enabled?: boolean;
  isReserve?: boolean;
  notes?: string;
  source?: 'discovered' | 'manual';
}

/**
 * Normalizes email address by trimming whitespace and converting to lowercase.
 */
export function normalizeEmail(email: string): string {
  return (email || '').trim().toLowerCase();
}

/**
 * Multi-Account Registry
 * Maintains the persistent, non-sensitive list of authorized provider-approved accounts.
 * Strictly stores ZERO credentials or tokens.
 */
export class AccountRegistry {
  private store: AtomicJsonStore<Record<string, AccountRegistryEntry>>;
  private accounts: Map<string, AccountRegistryEntry> = new Map();
  // Transient in-memory association with active running target (IDE or Antigravity 2.0)
  private activeTargetMap: Map<string, TargetId | null> = new Map();

  constructor(filePath?: string) {
    const p = filePath || path.join(__dirname, '..', '..', 'data', 'accounts.json');
    this.store = new AtomicJsonStore<Record<string, AccountRegistryEntry>>(p);
    this.load();
  }

  private load(): void {
    const rawMap = this.store.readSync({});
    this.accounts.clear();
    for (const [key, entry] of Object.entries(rawMap)) {
      const normalized = normalizeEmail(entry.email || key);
      if (normalized) {
        this.accounts.set(normalized, {
          ...entry,
          email: normalized
        });
      }
    }
  }

  private persist(sync: boolean = false): void {
    const data: Record<string, AccountRegistryEntry> = {};
    for (const [email, entry] of this.accounts.entries()) {
      // Never write activeTarget to disk if considered transient, or store clean entry
      const { activeTarget, ...cleanEntry } = entry;
      data[email] = cleanEntry;
    }
    if (sync) {
      this.store.writeSync(data);
    } else {
      this.store.scheduleSave(data);
    }
  }

  /**
   * Flush any pending writes to disk synchronously.
   */
  flush(): void {
    this.persist(true);
    this.store.flush();
  }

  /**
   * Discovers or updates an account when observed by GetUserStatus.
   * Preserves existing user label, priority, enabled state, and notes.
   */
  registerObservedAccount(options: RegisterAccountOptions): AccountRegistryEntry {
    const email = normalizeEmail(options.email);
    if (!email) {
      throw new Error('Account email cannot be empty');
    }

    const now = new Date().toISOString();
    let existing = this.accounts.get(email);

    if (existing) {
      // Update observation timestamps while strictly preserving configured user overrides
      existing.lastSeenAt = now;
      existing.lastQuotaRefreshAt = now;
      if (options.userName && !existing.label) {
        existing.label = options.userName;
      }
      if (options.notes !== undefined) {
        existing.notes = options.notes;
      }
      if (options.isReserve !== undefined) {
        existing.isReserve = options.isReserve;
      }
    } else {
      // Determine default priority: Next sequential priority (1, 2, 3...)
      const maxPriority = Array.from(this.accounts.values()).reduce((max, a) => Math.max(max, a.priority || 0), 0);
      const nextPriority = options.priority !== undefined ? options.priority : maxPriority + 1;

      // Safe user-friendly label
      const defaultLabel = options.label || options.userName || email.split('@')[0] || `Account ${this.accounts.size + 1}`;
      const safeId = `acc-${email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '_')}`;

      existing = {
        id: safeId,
        label: defaultLabel,
        email,
        enabled: options.enabled !== undefined ? options.enabled : true,
        priority: nextPriority,
        isReserve: options.isReserve !== undefined ? options.isReserve : false,
        lastSeenAt: now,
        lastQuotaRefreshAt: now,
        source: options.source || 'discovered',
        notes: options.notes
      };
      this.accounts.set(email, existing);
    }

    // Set transient target association
    if (options.targetId) {
      this.activeTargetMap.set(email, options.targetId);
    }

    this.persist(false);
    return this.getAccount(email)!;
  }

  /**
   * Manually register or update an account configuration.
   */
  upsertAccount(options: RegisterAccountOptions): AccountRegistryEntry {
    return this.registerObservedAccount({
      ...options,
      source: options.source || 'manual'
    });
  }

  getAccount(email: string): AccountRegistryEntry | null {
    const normalized = normalizeEmail(email);
    const entry = this.accounts.get(normalized);
    if (!entry) return null;
    return {
      ...entry,
      activeTarget: this.activeTargetMap.get(normalized) || null
    };
  }

  getAccountById(id: string): AccountRegistryEntry | null {
    for (const entry of this.accounts.values()) {
      if (entry.id === id) {
        return this.getAccount(entry.email);
      }
    }
    return null;
  }

  /**
   * Returns all accounts sorted in permanently fixed order:
   * 1. configured priority (ascending, 1 = top priority)
   * 2. stable account ID (alphabetical)
   * Never reorders based on remaining percentage, reset time, or health!
   */
  getAllAccounts(): AccountRegistryEntry[] {
    const list: AccountRegistryEntry[] = [];
    for (const [email, entry] of this.accounts.entries()) {
      list.push({
        ...entry,
        activeTarget: this.activeTargetMap.get(email) || null
      });
    }

    return list.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.id.localeCompare(b.id);
    });
  }

  setAccountTarget(email: string, targetId: TargetId | null): void {
    const normalized = normalizeEmail(email);
    this.activeTargetMap.set(normalized, targetId);
  }

  clearAccountTarget(targetId: TargetId): void {
    for (const [email, tid] of this.activeTargetMap.entries()) {
      if (tid === targetId) {
        this.activeTargetMap.set(email, null);
      }
    }
  }

  updateAccountConfig(email: string, updates: Partial<Pick<AccountRegistryEntry, 'label' | 'enabled' | 'priority' | 'notes' | 'isReserve'>>): boolean {
    const normalized = normalizeEmail(email);
    const entry = this.accounts.get(normalized);
    if (!entry) return false;

    if (updates.label !== undefined) entry.label = updates.label;
    if (updates.enabled !== undefined) entry.enabled = updates.enabled;
    if (updates.priority !== undefined) entry.priority = updates.priority;
    if (updates.notes !== undefined) entry.notes = updates.notes;
    if (updates.isReserve !== undefined) entry.isReserve = updates.isReserve;

    this.persist(true);
    return true;
  }

  setReserve(email: string, isReserve: boolean): boolean {
    return this.updateAccountConfig(email, { isReserve });
  }

  deleteAccount(idOrEmail: string): boolean {
    let normalized = normalizeEmail(idOrEmail);
    // If not found directly by email, check if it matches an account ID
    if (!this.accounts.has(normalized)) {
      for (const entry of this.accounts.values()) {
        if (entry.id === idOrEmail) {
          normalized = entry.email;
          break;
        }
      }
    }

    const removed = this.accounts.delete(normalized);
    this.activeTargetMap.delete(normalized);
    if (removed) {
      this.persist(true);
    }
    return removed;
  }

  size(): number {
    return this.accounts.size;
  }
}
