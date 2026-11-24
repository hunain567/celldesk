import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqliteDatabase } from '../db/connection';
import type { SecretProtector } from '../db/keystore';

/**
 * Remembers the newest time this installation has ever seen, in several
 * independent places, so moving the Windows clock back is detected even if
 * one of them is deleted or edited.
 */
export interface TimeStore {
  readonly name: string;
  read(): number | null;
  write(ms: number): void;
}

/** Inside the encrypted database. */
export class DatabaseTimeStore implements TimeStore {
  readonly name = 'database';

  constructor(private readonly db: SqliteDatabase) {}

  read(): number | null {
    const mark = this.db.prepare(`SELECT value FROM app_meta WHERE key = 'clock_high_water'`).get() as
      | { value: string }
      | undefined;
    const value = mark ? Number(mark.value) : NaN;
    return Number.isFinite(value) ? value : null;
  }

  write(ms: number): void {
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES ('clock_high_water', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(String(ms), new Date(ms).toISOString());
  }
}

/** A small file sealed with Windows DPAPI, outside the database. */
export class SealedFileTimeStore implements TimeStore {
  readonly name = 'sealed-file';

  constructor(private readonly path: string, private readonly protector: SecretProtector) {}

  read(): number | null {
    try {
      if (!existsSync(this.path)) return null;
      const value = Number(this.protector.unprotect(readFileSync(this.path)).toString('utf8'));
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  write(ms: number): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, this.protector.protect(Buffer.from(String(ms), 'utf8')));
    renameSync(temp, this.path);
  }
}

const REGISTRY_KEY = 'HKCU\\Software\\NexoERP\\NexoDesk';
const REGISTRY_VALUE = 'SessionMark';

/** In the Windows registry, which survives uninstalling the app and deleting its folder. */
export class RegistryTimeStore implements TimeStore {
  readonly name = 'registry';

  read(): number | null {
    if (process.platform !== 'win32') return null;
    try {
      const output = execFileSync('reg', ['query', REGISTRY_KEY, '/v', REGISTRY_VALUE], {
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = /REG_SZ\s+(\d+)/.exec(output);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  write(ms: number): void {
    if (process.platform !== 'win32') return;
    try {
      execFileSync('reg', ['add', REGISTRY_KEY, '/v', REGISTRY_VALUE, '/t', 'REG_SZ', '/d', String(ms), '/f'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      // The other stores still hold the mark.
    }
  }
}

export class ClockGuard {
  constructor(private readonly stores: TimeStore[]) {}

  /** The newest time seen by any store, or null on a brand-new installation. */
  latest(): Date | null {
    const values = this.stores.map((store) => store.read()).filter((value): value is number => value !== null);
    return values.length ? new Date(Math.max(...values)) : null;
  }

  /**
   * Moves every store forward to `now`. Never moves a store backwards, and is
   * not called while the clock is behind (the licence service checks first).
   */
  record(now: Date): void {
    const latest = this.latest()?.getTime() ?? 0;
    const mark = Math.max(latest, now.getTime());
    for (const store of this.stores) {
      const current = store.read();
      if (current === null || current < mark) store.write(mark);
    }
  }

  /**
   * Sets every store to `ms`, also backwards. Used only with the issue time of a
   * newly imported, vendor-signed licence: that time is trusted, so a clock that
   * was once set far ahead by mistake stops blocking the shop.
   */
  reset(ms: number): void {
    for (const store of this.stores) store.write(ms);
  }
}
