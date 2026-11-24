import type { SystemInfo } from '@nexodesk/shared';
import { statSync } from 'node:fs';
import { checkIntegrity, type SqliteDatabase } from '../db/connection';
import { getSchemaVersion } from '../db/migrator';
import { AppError } from '../errors';
import type { AuditLog } from '../services/audit';
import { SettingValidationError, type SettingsStore } from '../services/settings';
import type { IpcRouter } from './router';

export interface HandlerDependencies {
  db: SqliteDatabase;
  settings: SettingsStore;
  audit: AuditLog;
  databasePath: string;
  dataDirectory: string;
  installId: string;
  latestSchemaVersion: number;
  startedAt: Date;
  app: { name: string; version: string; electronVersion: string; platform: string };
  /** True when the signed-in user may change shop-wide security settings. */
  canChangeSecuritySettings?: () => boolean;
  actor?: () => string;
}

function fileSize(path: string): number {
  try {
    const main = statSync(path).size;
    let wal = 0;
    try {
      wal = statSync(`${path}-wal`).size;
    } catch {
      wal = 0;
    }
    return main + wal;
  } catch {
    return 0;
  }
}

export function registerHandlers(router: IpcRouter, deps: HandlerDependencies): void {
  router.register('system:info', (): SystemInfo => ({
    appName: deps.app.name,
    appVersion: deps.app.version,
    electronVersion: deps.app.electronVersion,
    platform: deps.app.platform,
    schemaVersion: getSchemaVersion(deps.db),
    latestSchemaVersion: deps.latestSchemaVersion,
    databaseEncrypted: true,
    dataDirectory: deps.dataDirectory,
    databaseSizeBytes: fileSize(deps.databasePath),
    installId: deps.installId,
    startedAt: deps.startedAt.toISOString(),
  }));

  router.register('system:integrityCheck', () => {
    const report = checkIntegrity(deps.db);
    deps.audit.append({
      actor: deps.actor?.() ?? 'system',
      action: 'database.integrity_check',
      details: { ok: report.ok, problems: report.messages.length },
    });
    return { ok: report.ok, messages: report.messages, checkedAt: new Date().toISOString() };
  });

  router.register('settings:get', ({ key }) => deps.settings.get(key));

  router.register('settings:set', ({ key, value }) => {
    if (key.startsWith('security.') && !(deps.canChangeSecuritySettings?.() ?? false)) {
      throw new AppError('FORBIDDEN', 'Only the shop owner can change security settings.');
    }
    try {
      deps.settings.set(key, value);
    } catch (error) {
      if (error instanceof SettingValidationError) {
        throw new AppError('VALIDATION_FAILED', error.message, error.details);
      }
      throw error;
    }
    return null;
  });

  router.register('audit:verify', () => deps.audit.verify());
}
