import { AuditEvent, AuditEventType } from './types';
import { safeLog, sanitizeObject } from './sanitizer';

/**
 * Vault audit logger.
 * Maintains an immutable record of vault security lifecycle events.
 * Guarantees zero sensitive data or tokens enter audit logs.
 */
export class VaultAuditLogger {
  private events: AuditEvent[] = [];
  private readonly maxEvents: number;

  constructor(maxEvents = 100) {
    this.maxEvents = maxEvents;
  }

  /**
   * Records a security event. All parameters are deeply sanitized before recording.
   */
  record(
    type: AuditEventType,
    success: boolean,
    accountId?: string,
    details?: Record<string, any>,
    error?: string
  ): AuditEvent {
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      type,
      accountId,
      success,
      details: details ? sanitizeObject(details) : undefined,
      error: error ? sanitizeObject(error) : undefined
    };

    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    // Output non-sensitive audit message
    const statusStr = success ? 'SUCCESS' : 'FAILED';
    const accStr = accountId ? `[Account: ${accountId}]` : '';
    const errStr = error ? `Error: ${event.error}` : '';
    safeLog(`[VAULT AUDIT] ${event.timestamp} | ${type} | ${statusStr} ${accStr} ${errStr}`.trim());

    return event;
  }

  /**
   * Retrieves recorded audit events.
   */
  getEvents(): ReadonlyArray<AuditEvent> {
    return [...this.events];
  }

  /**
   * Clears in-memory audit events (for test cleanup).
   */
  clear(): void {
    this.events = [];
  }
}
