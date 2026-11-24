import { IPC_CHANNEL_NAMES, ipcContract } from '@nexodesk/shared';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../src/main/db/connection';
import { migrations } from '../src/main/db/migrations';
import { migrate } from '../src/main/db/migrator';
import { AppError } from '../src/main/errors';
import { registerHandlers } from '../src/main/ipc/handlers';
import { IpcRouter } from '../src/main/ipc/router';
import { AuditLog } from '../src/main/services/audit';
import { SettingsStore } from '../src/main/services/settings';
import { tempDir, TEST_KEY } from './helpers';

const context = { senderUrl: 'file:///app/renderer/index.html' };

describe('IPC contract', () => {
  it('the preload channel list matches the contract exactly', () => {
    expect([...IPC_CHANNEL_NAMES].sort()).toEqual(Object.keys(ipcContract).sort());
  });
});

describe('IPC router', () => {
  let dir: ReturnType<typeof tempDir>;
  let db: SqliteDatabase;
  let router: IpcRouter;
  let logged: string[];

  beforeEach(() => {
    dir = tempDir();
    db = openDatabase(join(dir.path, 'ipc.db'), TEST_KEY);
    migrate(db, migrations, { appVersion: '0.1.0' });
    logged = [];
    router = new IpcRouter({ validateOutput: true, logError: (message) => logged.push(message) });
    registerHandlers(router, {
      db,
      settings: new SettingsStore(db),
      audit: new AuditLog(db),
      databasePath: join(dir.path, 'ipc.db'),
      dataDirectory: dir.path,
      installId: '00000000-0000-4000-8000-000000000000',
      latestSchemaVersion: migrations.length,
      startedAt: new Date('2026-11-24T05:00:00Z'),
      app: { name: 'NexoDesk', version: '0.1.0', electronVersion: 'test', platform: 'test' },
    });
  });
  afterEach(() => {
    db.close();
    dir.cleanup();
  });

  it('has a handler for every channel in the contract', () => {
    expect(router.missingHandlers()).toEqual([]);
  });

  it('refuses unknown channels', async () => {
    const result = await router.dispatch('fs:readFile', { path: 'C:\\' }, context);
    expect(result).toEqual({ ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'Unknown request' } });
  });

  it('validates input before any handler runs', async () => {
    const result = await router.dispatch('settings:set', { key: 'ui.theme', value: 'purple' }, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');

    const badKey = await router.dispatch('settings:get', { key: 'license.expiry' }, context);
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) expect(badKey.error.code).toBe('VALIDATION_FAILED');
  });

  it('round-trips a setting', async () => {
    expect(await router.dispatch('settings:get', { key: 'ui.theme' }, context)).toEqual({ ok: true, data: 'system' });
    expect(await router.dispatch('settings:set', { key: 'ui.theme', value: 'dark' }, context)).toEqual({
      ok: true,
      data: null,
    });
    expect(await router.dispatch('settings:get', { key: 'ui.theme' }, context)).toEqual({ ok: true, data: 'dark' });
  });

  it('returns system info that matches the contract', async () => {
    const result = await router.dispatch('system:info', undefined, context);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const info = result.data as { schemaVersion: number; databaseEncrypted: boolean };
      expect(info.schemaVersion).toBe(migrations.length);
      expect(info.databaseEncrypted).toBe(true);
    }
  });

  it('runs an integrity check and records it in the audit log', async () => {
    const result = await router.dispatch('system:integrityCheck', undefined, context);
    expect(result.ok).toBe(true);
    const verify = await router.dispatch('audit:verify', undefined, context);
    expect(verify).toEqual({ ok: true, data: { valid: true, entriesChecked: 1, firstBrokenId: null } });
  });

  it('hides internal error details from the renderer but logs them', async () => {
    const isolated = new IpcRouter({ validateOutput: true, logError: (message) => logged.push(message) });
    isolated.register('audit:verify', () => {
      throw new Error('SQLITE_CORRUPT at page 17');
    });
    const result = await isolated.dispatch('audit:verify', undefined, context);
    expect(result).toEqual({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' },
    });
    expect(logged).toContain('IPC handler audit:verify failed');
  });

  it('passes user-safe AppError messages through', async () => {
    const isolated = new IpcRouter({ validateOutput: true, logError: () => undefined });
    isolated.register('audit:verify', () => {
      throw new AppError('LICENSE_RESTRICTED', 'Your subscription has expired.');
    });
    const result = await isolated.dispatch('audit:verify', undefined, context);
    expect(result).toEqual({ ok: false, error: { code: 'LICENSE_RESTRICTED', message: 'Your subscription has expired.' } });
  });
});
