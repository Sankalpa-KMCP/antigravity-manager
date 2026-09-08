import fs from 'fs';
import path from 'path';

/**
 * Utility for safe, atomic persistence using temporary file and atomic rename.
 * Prevents partial writes, corrupted JSON, and excessive disk thrashing.
 */
export class AtomicJsonStore<T> {
  private filePath: string;
  private tempFilePath: string;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingData: T | null = null;
  private lastSavedJson: string = '';

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (_) {}
    }
    this.tempFilePath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
  }

  readSync(defaultValue: T): T {
    if (!fs.existsSync(this.filePath)) {
      return defaultValue;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.lastSavedJson = raw;
      return JSON.parse(raw) as T;
    } catch (err) {
      console.warn(`AtomicJsonStore: Error reading ${this.filePath}, returning default: ${(err as Error).message}`);
      return defaultValue;
    }
  }

  writeSync(data: T): boolean {
    const json = JSON.stringify(data, null, 2);
    // Optimization: Skip write if content has not changed at all
    if (json === this.lastSavedJson && fs.existsSync(this.filePath)) {
      return true;
    }

    try {
      const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tempPath, json, 'utf8');
      fs.renameSync(tempPath, this.filePath);
      this.lastSavedJson = json;
      return true;
    } catch (err) {
      console.error(`AtomicJsonStore: Failed atomic write to ${this.filePath}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Debounced atomic write to avoid disk thrashing on every 5s polling cycle.
   */
  scheduleSave(data: T, delayMs: number = 500): void {
    this.pendingData = data;
    if (this.debounceTimer) {
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.pendingData !== null) {
        this.writeSync(this.pendingData);
        this.pendingData = null;
      }
    }, delayMs);
  }

  flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pendingData !== null) {
      this.writeSync(this.pendingData);
      this.pendingData = null;
    }
  }
}
