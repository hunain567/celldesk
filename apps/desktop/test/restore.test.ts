import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keyId, wrapKey } from '../src/main/backup/keys';
import { sha256File, writeBackupFile } from '../src/main/backup/format';
import { journalPath, readJournal, recoverInterruptedRestore, swapDatabase } from '../src/main/backup/swap';
import { checkIntegrity, openDatabase, snapshotDatabase } from '../src/main/db/connection';
import { migrations } from '../src/main/db/migrations';
import { getSchemaVersion, migrate } from '../src/main/db/migrator';
import { addSales, createShop, RECOVERY_PASSWORD, salesCount, TEST_KDF } from './backup-env';
import { tempDir } from './helpers';
import { statSync } from 'node:fs';

const shops: Array<ReturnType<typeof createShop>> = [];
function shop(options?: Parameters<typeof createShop>[0]) {
  const created = createShop(options);
  shops.push(created);
  return created;
}
afterEach(() => {
  while (shops.length) shops.pop()!.cleanup();
});

/** What the main process does after prepare(): close, swap, restart, recover. */
function finishRestore(env: ReturnType<typeof createShop>) {
  env.db.pragma('wal_checkpoint(TRUNCATE)');
  env.close();
  swapDatabase(journalPath(join(env.root, 'restore')));
  const outcome = recoverInterruptedRestore(journalPath(join(env.root, 'restore')), (path) => {
    const db = openDatabase(path, env.key);
    try {
      return checkIntegrity(db).ok;
    } finally {
      db.close();
    }
  });
  env.reopen();
  return outcome;
}

async function backupOf(env: ReturnType<typeof createShop>): Promise<string> {
  const result = await env.backups.run('manual');
  expect(result.status).toBe('success');
  return result.results[0]!.filePath!;
}

describe('restore on the same PC', () => {
  it('brings back the data exactly as it was in the backup', async () => {
    const env = shop();
    env.backups.setup({ destinationPath: env.destination, recoveryPassword: RECOVERY_PASSWORD });
    addSales(env.db, 100);
    const file = await backupOf(env);

    addSales(env.db, 25); // later work that the restore will undo
    expect(salesCount(env.db)).toBe(125);

    const inspection = await env.restore.inspect(file);
    expect(inspection).toMatchObject({ sameInstallation: true, needsPassword: false, compatible: true });
    const verification = await env.restore.verify(file);
    expect(verification.tableCounts['test_sales']).toBe(100);

    await env.restore.prepare(file);
    const outcome = finishRestore(env);
    expect(outcome.kind).toBe('completed');
    expect(salesCount(env.db)).toBe(100);
    expect(checkIntegrity(env.db).ok).toBe(true);
  });

  it('keeps a verified safety copy of the data that was replaced', async () => {
    const env = shop();
    env.backups.setup({ destinationPath: env.destination, recoveryPassword: RECOVERY_PASSWORD });
    addSales(env.db, 10);
    const file = await backupOf(env);
    addSales(env.db, 7);
    await env.restore.prepare(file);
    const journal = readJournal(journalPath(join(env.root, 'restore')))!;
    finishRestore(env);

    const safety = openDatabase(journal.safetyCopyPath, env.key, { readonly: true });
    expect(salesCount(safety)).toBe(17);
    safety.close();
    expect(existsSync(journal.preRestorePath)).toBe(true);
  });
});

describe('restore on another PC', () => {
  it('needs the recovery password, refuses a wrong one, and works with the right one', async () => {
    const oldPc = shop({ key: 'a'.repeat(64) });
    oldPc.backups.setup({ destinationPath: oldPc.destination, recoveryPassword: RECOVERY_PASSWORD });
    addSales(oldPc.db, 42);
    const file = await backupOf(oldPc);

    const newPc = shop({ key: 'b'.repeat(64), installId: '99999999-8888-4777-8666-555555555555' });
    const copied = join(newPc.root, 'from-usb.ndbak');
    copyFileSync(file, copied);

    const inspection = await newPc.restore.inspect(copied);
    expect(inspection).toMatchObject({ sameInstallation: false, needsPassword: true });
    await expect(newPc.restore.verify(copied)).rejects.toThrow(/recovery password/);
    await expect(newPc.restore.verify(copied, 'not-the-password')).rejects.toThrow(/not correct/);

    await newPc.restore.prepare(copied, RECOVERY_PASSWORD);
    expect(finishRestore(newPc).kind).toBe('completed');
    // The restored data now opens with the new PC's own key.
    expect(salesCount(newPc.db)).toBe(42);
    // Backup settings came with the data, so this PC can open the old backups without the password.
    expect((await newPc.restore.inspect(copied)).needsPassword).toBe(false);
  });
});

describe('restore refuses unsafe input', () => {
  it('rejects a damaged backup and leaves the live data untouched', async () => {
    const env = shop();
    env.backups.setup({ destinationPath: env.destination, recoveryPassword: RECOVERY_PASSWORD });
    addSales(env.db, 5);
    const file = await backupOf(env);
    const damaged = Buffer.from(readFileSync(file));
    damaged[damaged.length - 100] = damaged[damaged.length - 100]! ^ 0xff;
    const damagedFile = join(env.root, 'damaged.ndbak');
    writeFileSync(damagedFile, damaged);

    await expect(env.restore.verify(damagedFile)).rejects.toThrow(/damaged/);
    await expect(env.restore.prepare(damagedFile)).rejects.toThrow(/damaged/);
    expect(existsSync(journalPath(join(env.root, 'restore')))).toBe(false);
    expect(salesCount(env.db)).toBe(5);
  });

  it('refuses a backup from a newer NexoDesk', async () => {
    const env = shop();
    env.backups.setup({ destinationPath: env.destination, recoveryPassword: RECOVERY_PASSWORD });
    const config = env.backups.getConfig()!;
    const dir = tempDir();
    try {
      const snapshot = join(dir.path, 'snap.db');
      env.db.pragma('user_version = 99');
      snapshotDatabase(env.db, snapshot);
      env.db.pragma(`user_version = ${migrations.length}`);
      const file = join(dir.path, 'future.ndbak');
      await writeBackupFile({
        target: file,
        databasePath: snapshot,
        backupKey: config.backupKey,
        manifest: {
          databaseKeyHex: env.key,
          databaseSha256: await sha256File(snapshot),
          databaseSizeBytes: statSync(snapshot).size,
          tableCounts: {},
        },
        header: {
          createdAt: new Date().toISOString(),
          appVersion: '9.0.0',
          schemaVersion: 99,
          installId: env.installId,
          kind: 'manual',
          keyId: config.keyId,
          recovery: config.recovery,
        },
      });
      expect(await env.restore.inspect(file)).toMatchObject({ compatible: false });
      await expect(env.restore.prepare(file)).rejects.toThrow(/newer NexoDesk/);
    } finally {
      dir.cleanup();
    }
  });

  it('upgrades a backup made by an older NexoDesk during restore', async () => {
    const env = shop();
    env.backups.setup({ destinationPath: env.destination, recoveryPassword: RECOVERY_PASSWORD });
    const config = env.backups.getConfig()!;
    const dir = tempDir();
    try {
      // A database that only has schema 1, as an older release would have made.
      const oldDb = join(dir.path, 'old.db');
      const db = openDatabase(oldDb, 'c'.repeat(64));
      migrate(db, migrations.slice(0, 1), { appVersion: '0.0.9' });
      db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('ui.theme', '"dark"', 'x')`).run();
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.pragma('journal_mode = DELETE');
      db.close();

      const file = join(dir.path, 'old.ndbak');
      await writeBackupFile({
        target: file,
        databasePath: oldDb,
        backupKey: config.backupKey,
        manifest: {
          databaseKeyHex: 'c'.repeat(64),
          databaseSha256: await sha256File(oldDb),
          databaseSizeBytes: statSync(oldDb).size,
          tableCounts: {},
        },
        header: {
          createdAt: new Date().toISOString(),
          appVersion: '0.0.9',
          schemaVersion: 1,
          installId: env.installId,
          kind: 'manual',
          keyId: keyId(config.backupKey),
          recovery: wrapKey(config.backupKey, RECOVERY_PASSWORD, TEST_KDF),
        },
      });
      await env.restore.prepare(file);
      expect(finishRestore(env).kind).toBe('completed');
      expect(getSchemaVersion(env.db)).toBe(migrations.length);
      expect(env.db.prepare(`SELECT value_json FROM settings WHERE key = 'ui.theme'`).get()).toEqual({ value_json: '"dark"' });
    } finally {
      dir.cleanup();
    }
  });
});

describe('power cut during restore', () => {
  async function prepared() {
    const env = shop();
    env.backups.setup({ destinationPath: env.destination, recoveryPassword: RECOVERY_PASSWORD });
    addSales(env.db, 30);
    const file = await backupOf(env);
    addSales(env.db, 3);
    await env.restore.prepare(file);
    env.db.pragma('wal_checkpoint(TRUNCATE)');
    env.close();
    return env;
  }

  const healthy = (key: string) => (path: string) => {
    try {
      const db = openDatabase(path, key);
      try {
        return checkIntegrity(db).ok;
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  };

  it('keeps the original data when the power cut happens before the swap', async () => {
    const env = await prepared();
    const outcome = recoverInterruptedRestore(journalPath(join(env.root, 'restore')), healthy(env.key));
    expect(outcome.kind).toBe('rolled-back');
    env.reopen();
    expect(salesCount(env.db)).toBe(33);
  });

  it('puts the original back when the power cut happens half-way through the swap', async () => {
    const env = await prepared();
    const journal = readJournal(journalPath(join(env.root, 'restore')))!;
    // Simulate: the live file was moved aside, then power was lost before the new one moved in.
    const { renameSync } = await import('node:fs');
    renameSync(journal.livePath, journal.preRestorePath);
    expect(existsSync(journal.livePath)).toBe(false);

    const outcome = recoverInterruptedRestore(journalPath(join(env.root, 'restore')), healthy(env.key));
    expect(outcome.kind).toBe('rolled-back');
    env.reopen();
    expect(salesCount(env.db)).toBe(33);
  });

  it('rolls back when the restored database cannot be opened after restart', async () => {
    const env = await prepared();
    swapDatabase(journalPath(join(env.root, 'restore')));
    // Damage the newly placed database before the "restart".
    const bytes = readFileSync(env.databasePath);
    bytes.fill(0, 0, 4096);
    writeFileSync(env.databasePath, bytes);

    const outcome = recoverInterruptedRestore(journalPath(join(env.root, 'restore')), healthy(env.key));
    expect(outcome.kind).toBe('rolled-back');
    env.reopen();
    expect(salesCount(env.db)).toBe(33);
  });
});
