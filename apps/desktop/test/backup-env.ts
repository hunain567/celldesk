import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BackupService } from '../src/main/backup/service';
import { RestoreService } from '../src/main/backup/restore';
import { openDatabase, type SqliteDatabase } from '../src/main/db/connection';
import { migrations } from '../src/main/db/migrations';
import { migrate } from '../src/main/db/migrator';
import { AuditLog } from '../src/main/services/audit';
import { tempDir } from './helpers';

/** Fast key derivation for tests only. */
export const TEST_KDF = { N: 2 ** 12, r: 8, p: 1 };
export const RECOVERY_PASSWORD = 'shop-recovery-2026';

export interface ShopEnv {
  root: string;
  databasePath: string;
  key: string;
  installId: string;
  db: SqliteDatabase;
  audit: AuditLog;
  backups: BackupService;
  restore: RestoreService;
  destination: string;
  clock: { now: Date };
  reopen(): void;
  close(): void;
}

/** A self-contained "shop PC" with its own encrypted database and folders. */
export function createShop(options: { key?: string; installId?: string; dir?: string } = {}): ShopEnv & {
  cleanup: () => void;
} {
  const dir = options.dir ? { path: options.dir, cleanup: () => undefined } : tempDir();
  const root = dir.path;
  const databasePath = join(root, 'data', 'nexodesk.db');
  const key = options.key ?? 'a'.repeat(64);
  const installId = options.installId ?? '11111111-2222-4333-8444-555555555555';
  const destination = join(root, 'usb');
  mkdirSync(destination, { recursive: true });
  const clock = { now: new Date('2026-11-24T16:00:00Z') };

  const env = {} as ShopEnv & { cleanup: () => void };

  const build = () => {
    const db = openDatabase(databasePath, key);
    migrate(db, migrations, { appVersion: '0.1.0' });
    const audit = new AuditLog(db, () => clock.now);
    const backups = new BackupService({
      db,
      databaseKeyHex: key,
      installId,
      appVersion: '0.1.0',
      tempDirectory: join(root, 'tmp'),
      journalDirectory: join(root, 'logs'),
      audit,
      now: () => clock.now,
      kdf: TEST_KDF,
    });
    const restore = new RestoreService({
      db,
      databaseKeyHex: key,
      databasePath,
      installId,
      appVersion: '0.1.0',
      tempDirectory: join(root, 'tmp'),
      restoreDirectory: join(root, 'restore'),
      safetyDirectory: join(root, 'safety'),
      journalDirectory: join(root, 'logs'),
      backups,
      audit,
      now: () => clock.now,
    });
    Object.assign(env, { db, audit, backups, restore });
  };

  build();
  Object.assign(env, {
    root,
    databasePath,
    key,
    installId,
    destination,
    clock,
    reopen: () => {
      env.db.close();
      build();
    },
    close: () => env.db.close(),
    cleanup: () => {
      try {
        env.db.close();
      } catch {
        // Already closed.
      }
      dir.cleanup();
    },
  });
  return env;
}

export function addSales(db: SqliteDatabase, count: number): void {
  db.exec('CREATE TABLE IF NOT EXISTS test_sales (id INTEGER PRIMARY KEY, total INTEGER NOT NULL)');
  const insert = db.prepare('INSERT INTO test_sales (total) VALUES (?)');
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i += 1) insert.run(1000 + i);
  });
  tx();
}

export function salesCount(db: SqliteDatabase): number {
  return (db.prepare('SELECT count(*) AS n FROM test_sales').get() as { n: number }).n;
}
