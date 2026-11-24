import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupFolder } from '../src/main/backup/files';
import { AppError } from '../src/main/errors';
import { addSales, createShop, RECOVERY_PASSWORD } from './backup-env';

describe('backup service', () => {
  let shop: ReturnType<typeof createShop>;

  beforeEach(() => {
    shop = createShop();
    addSales(shop.db, 50);
  });
  afterEach(() => shop.cleanup());

  const setup = () => shop.backups.setup({ destinationPath: shop.destination, recoveryPassword: RECOVERY_PASSWORD });

  it('refuses to run before setup and refuses a weak recovery password', async () => {
    await expect(shop.backups.run('manual')).rejects.toBeInstanceOf(AppError);
    expect(() => shop.backups.setup({ destinationPath: shop.destination, recoveryPassword: 'short' })).toThrow(/at least 8/);
  });

  it('writes a verified backup and records it', async () => {
    setup();
    const result = await shop.backups.run('manual');
    expect(result.status).toBe('success');
    const file = result.results[0]!.filePath!;
    expect(existsSync(file)).toBe(true);
    expect(file.endsWith('.ndbak')).toBe(true);
    expect(readdirSync(backupFolder(shop.destination, shop.installId)).some((name) => name.endsWith('.partial'))).toBe(false);

    const history = shop.backups.history(10);
    expect(history[0]).toMatchObject({ status: 'verified', kind: 'manual' });
    const status = await shop.backups.getStatus();
    expect(status.lastVerifiedAt).not.toBeNull();
    expect(status.overdue).toBe(false);
    expect(shop.backups.verifyRecoveryPassword(RECOVERY_PASSWORD)).toBe(true);
    expect(shop.backups.verifyRecoveryPassword('wrong-password')).toBe(false);
  });

  it('reports failure, never success, when the drive is missing', async () => {
    setup();
    rmSync(shop.destination, { recursive: true, force: true });
    const result = await shop.backups.run('manual');
    expect(result.status).toBe('failed');
    expect(result.results[0]!.error).toMatch(/not found|connected/i);
    expect(shop.backups.history(1)[0]).toMatchObject({ status: 'failed' });
    expect((await shop.backups.getStatus()).overdue).toBe(true);
  });

  it('reports a partial result when one of two locations fails', async () => {
    setup();
    const second = join(shop.root, 'second-drive');
    mkdirSync(second);
    shop.backups.addDestination(second);
    rmSync(second, { recursive: true, force: true });
    const result = await shop.backups.run('manual');
    expect(result.status).toBe('partial');
    expect(result.results.map((entry) => entry.ok)).toEqual([true, false]);
  });

  it('reports failure when the folder cannot be written', async () => {
    if (process.getuid?.() === 0 || process.platform === 'win32') return; // root ignores permissions
    setup();
    chmodSync(shop.destination, 0o500);
    try {
      const result = await shop.backups.run('manual');
      expect(result.status).toBe('failed');
      expect(result.results[0]!.error).toMatch(/not allowed/);
    } finally {
      chmodSync(shop.destination, 0o700);
    }
  });

  it('refuses a second backup while one is running', async () => {
    setup();
    const first = shop.backups.run('manual');
    await expect(shop.backups.run('manual')).rejects.toThrow(/already running/);
    await first;
  });

  it('keeps at least one location and at most three', () => {
    setup();
    const only = shop.backups.history(1); // no files yet
    expect(only).toEqual([]);
    const status = shop.db.prepare('SELECT id FROM backup_destinations').get() as { id: number };
    expect(() => shop.backups.removeDestination(status.id)).toThrow(/At least one/);
    for (const name of ['b', 'c']) {
      mkdirSync(join(shop.root, name));
      shop.backups.addDestination(join(shop.root, name));
    }
    mkdirSync(join(shop.root, 'd'));
    expect(() => shop.backups.addDestination(join(shop.root, 'd'))).toThrow(/Up to 3/);
  });

  it('runs a scheduled backup when due and prunes by retention', async () => {
    setup();
    shop.db.prepare(`UPDATE backup_config SET created_at = '2026-01-01T00:00:00.000Z'`).run();
    // 20 evenings in a row: each evening's scheduled backup runs once.
    for (let day = 0; day < 20; day += 1) {
      shop.clock.now = new Date(Date.UTC(2026, 10, 1 + day, 16, 5)); // 21:05 Karachi
      const result = await shop.backups.runScheduledIfDue();
      expect(result?.status).toBe('success');
      expect(await shop.backups.runScheduledIfDue()).toBeNull();
    }
    const files = readdirSync(backupFolder(shop.destination, shop.installId)).filter((name) => name.endsWith('.ndbak'));
    // 14 daily kept; older ones kept only as weekly/monthly representatives.
    expect(files.length).toBeLessThan(20);
    expect(files.length).toBeGreaterThanOrEqual(14);
    const deleted = shop.backups.history(50).filter((entry) => entry.status === 'deleted');
    expect(deleted.length).toBe(20 - files.length);
  });

  it('marks a backup interrupted by a crash as failed', () => {
    setup();
    shop.db.prepare(`INSERT INTO backup_runs (kind, status, started_at) VALUES ('scheduled', 'running', '2026-11-24T16:00:00Z')`).run();
    shop.backups.recoverInterruptedRuns();
    const row = shop.db.prepare('SELECT status, error FROM backup_runs').get() as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/closed before/);
  });
});
