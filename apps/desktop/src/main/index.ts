import { IPC_INVOKE_CHANNEL } from '@nexodesk/shared/channels';
import { app, dialog, ipcMain } from 'electron';
import { bootstrapDatabase, resolveDataLocations, type BootstrapResult } from './db/bootstrap';
import { KeyFileMissingError, KeyFileUnreadableError } from './db/keystore';
import { MigrationFailedError, SchemaTooNewError } from './db/migrator';
import { registerHandlers } from './ipc/handlers';
import { IpcRouter } from './ipc/router';
import { logger } from './logger';
import { createSecretProtector } from './platform/protector';
import { AuditLog } from './services/audit';
import { SettingsStore } from './services/settings';
import { createMainWindow, hardenSession, isTrustedUrl, type WindowOptions } from './window';

app.setName('NexoDesk');
app.setAppUserModelId('com.nexoerp.nexodesk');
app.enableSandbox();

// Two copies writing the same database would be unsafe, so only one may run.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const startedAt = new Date();
const windowOptions: WindowOptions = {
  devServerUrl: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'],
  isPackaged: app.isPackaged,
};

let database: BootstrapResult | null = null;

function dataRoot(): string {
  // A separate folder can be used during development; packaged builds always use AppData.
  const override = process.env['NEXODESK_DATA_DIR'];
  return !app.isPackaged && override ? override : app.getPath('userData');
}

function startupErrorMessage(error: unknown): string {
  if (
    error instanceof KeyFileMissingError ||
    error instanceof KeyFileUnreadableError ||
    error instanceof SchemaTooNewError ||
    error instanceof MigrationFailedError
  ) {
    return error.message;
  }
  return 'NexoDesk could not open its database. Your data has not been changed. Please contact support.';
}

function start(): void {
  const locations = resolveDataLocations(dataRoot());
  logger.init(locations.logDirectory);
  logger.info('NexoDesk starting', { version: app.getVersion(), packaged: app.isPackaged });

  try {
    const protector = createSecretProtector({ allowUnprotected: !app.isPackaged });
    if (!protector.isOsBacked) logger.warn('OS key protection unavailable; development key stored unprotected');
    database = bootstrapDatabase({ locations, protector, appVersion: app.getVersion() });
  } catch (error) {
    logger.error('Database start-up failed', error);
    dialog.showErrorBox('NexoDesk cannot start', `${startupErrorMessage(error)}\n\nData folder: ${locations.root}`);
    app.exit(1);
    return;
  }

  const { db, migration, installId, latestSchemaVersion } = database;
  const audit = new AuditLog(db);
  const settings = new SettingsStore(db);

  audit.append({ actor: 'system', action: 'app.start', details: { version: app.getVersion() } });
  if (migration.applied.length > 0) {
    logger.info('Database migrated', migration);
    audit.append({
      actor: 'system',
      action: 'database.migrate',
      details: {
        from: migration.fromVersion,
        to: migration.toVersion,
        safetyCopy: migration.safetyCopyPath !== null,
      },
    });
  }

  const router = new IpcRouter({
    validateOutput: !app.isPackaged,
    logError: (message, error) => logger.error(message, error),
  });
  registerHandlers(router, {
    db,
    settings,
    audit,
    databasePath: locations.databasePath,
    dataDirectory: locations.root,
    installId,
    latestSchemaVersion,
    startedAt,
    app: {
      name: 'NexoDesk',
      version: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      platform: `${process.platform === 'win32' ? 'Windows' : process.platform} ${process.arch}`,
    },
  });
  const missing = router.missingHandlers();
  if (missing.length > 0) logger.warn('IPC channels without handlers', missing);

  ipcMain.handle(IPC_INVOKE_CHANNEL, (event, channel: unknown, input: unknown) => {
    const senderUrl = event.senderFrame?.url ?? '';
    if (!isTrustedUrl(senderUrl, windowOptions)) {
      logger.warn('Refused IPC from untrusted page', { senderUrl });
      return { ok: false, error: { code: 'FORBIDDEN', message: 'Request refused' } };
    }
    return router.dispatch(channel, input, { senderUrl });
  });

  hardenSession();
  const mainWindow = createMainWindow(windowOptions);

  app.on('second-instance', () => {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

app.whenReady().then(start, (error: unknown) => {
  logger.error('Electron failed to initialise', error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  if (!database) return;
  try {
    // Fold the WAL file back into the main database so the file on disk is complete.
    database.db.pragma('wal_checkpoint(TRUNCATE)');
    database.db.close();
    logger.info('Database closed cleanly');
  } catch (error) {
    logger.error('Database close failed', error);
  }
  database = null;
});
