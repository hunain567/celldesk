import type { AppEvent, RestoreOutcome } from '@nexodesk/shared';
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL } from '@nexodesk/shared/channels';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { appendJournal } from './backup/files';
import { RestoreService } from './backup/restore';
import { BackupService } from './backup/service';
import { journalPath, swapDatabase } from './backup/swap';
import { bootstrapDatabase, resolveDataLocations, type BootstrapResult } from './db/bootstrap';
import { KeyFileMissingError, KeyFileUnreadableError } from './db/keystore';
import { MigrationFailedError, SchemaTooNewError } from './db/migrator';
import { PathGrants, registerBackupHandlers } from './ipc/backup-handlers';
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

const SCHEDULER_INTERVAL_MS = 60 * 1000;
/** Missed scheduled backups are caught up shortly after start, not during start-up. */
const SCHEDULER_FIRST_CHECK_MS = 2 * 60 * 1000;

const startedAt = new Date();
const windowOptions: WindowOptions = {
  devServerUrl: app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'],
  isPackaged: app.isPackaged,
};

let database: BootstrapResult | null = null;
let schedulerTimers: NodeJS.Timeout[] = [];

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

function sendEvent(event: AppEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC_EVENT_CHANNEL, event);
  }
}

function stopScheduler(): void {
  for (const timer of schedulerTimers) clearTimeout(timer);
  schedulerTimers = [];
}

/** Closes the live database cleanly. Safe to call more than once. */
function closeDatabase(): void {
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

  const { db, hexKey, migration, installId, latestSchemaVersion, restoreOutcome } = database;
  const audit = new AuditLog(db);
  const settings = new SettingsStore(db);

  audit.append({ actor: 'system', action: 'app.start', details: { version: app.getVersion() } });
  if (migration.applied.length > 0) {
    logger.info('Database migrated', migration);
    audit.append({
      actor: 'system',
      action: 'database.migrate',
      details: { from: migration.fromVersion, to: migration.toVersion, safetyCopy: migration.safetyCopyPath !== null },
    });
  }

  let lastRestoreOutcome: RestoreOutcome = null;
  if (restoreOutcome.kind !== 'none') {
    const at = new Date().toISOString();
    const reason = restoreOutcome.kind === 'rolled-back' ? restoreOutcome.reason : null;
    lastRestoreOutcome = { kind: restoreOutcome.kind, backupCreatedAt: restoreOutcome.journal.backupCreatedAt, reason, at };
    logger.info('Restore finished at start-up', lastRestoreOutcome);
    audit.append({
      actor: 'system',
      action: restoreOutcome.kind === 'completed' ? 'backup.restore.completed' : 'backup.restore.rolled_back',
      details: { file: restoreOutcome.journal.backupFile, backupCreatedAt: restoreOutcome.journal.backupCreatedAt, reason },
    });
    appendJournal(locations.logDirectory, 'restore-journal.jsonl', {
      at,
      event: restoreOutcome.kind,
      file: restoreOutcome.journal.backupFile,
      reason,
    });
  }

  const backups = new BackupService({
    db,
    databaseKeyHex: hexKey,
    installId,
    appVersion: app.getVersion(),
    tempDirectory: locations.tempDirectory,
    journalDirectory: locations.logDirectory,
    audit,
    log: (message, data) => logger.warn(message, data),
  });
  backups.recoverInterruptedRuns();

  const restore = new RestoreService({
    db,
    databaseKeyHex: hexKey,
    databasePath: locations.databasePath,
    installId,
    appVersion: app.getVersion(),
    tempDirectory: locations.tempDirectory,
    restoreDirectory: locations.restoreDirectory,
    safetyDirectory: locations.safetyDirectory,
    journalDirectory: locations.logDirectory,
    backups,
    audit,
    log: (message, data) => logger.warn(message, data),
  });

  const runBackup = async (kind: 'manual' | 'scheduled') => {
    sendEvent({ type: 'backup.started', kind });
    const result = await backups.run(kind);
    sendEvent({ type: 'backup.finished', kind, status: result.status, error: result.error ?? result.results.find((r) => !r.ok)?.error ?? null });
    return result;
  };

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

  let mainWindow: BrowserWindow | null = null;
  registerBackupHandlers(router, {
    backups,
    restore,
    grants: new PathGrants(),
    chooseFolder: async () => {
      const options = { title: 'Choose a backup location', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
      const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    chooseBackupFile: async () => {
      const options = {
        title: 'Choose a NexoDesk backup',
        properties: ['openFile'] as Array<'openFile'>,
        filters: [{ name: 'NexoDesk backup', extensions: ['ndbak'] }],
      };
      const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    runBackup: (kind) => runBackup(kind),
    onRestorePrepared: () => {
      // Let the IPC reply reach the screen, then replace the database and restart.
      setTimeout(() => {
        stopScheduler();
        closeDatabase();
        try {
          swapDatabase(journalPath(locations.restoreDirectory));
        } catch (error) {
          logger.error('Restore swap failed; original database kept', error);
        }
        app.relaunch();
        app.exit(0);
      }, 500);
    },
    lastRestoreOutcome: () => lastRestoreOutcome,
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

  // Scheduled backups: check every minute; the first check waits until start-up has settled.
  const checkSchedule = () => {
    if (!database || backups.isRunning()) return;
    void backups
      .runScheduledIfDue()
      .then((result) => {
        if (result) {
          sendEvent({
            type: 'backup.finished',
            kind: 'scheduled',
            status: result.status,
            error: result.error ?? result.results.find((r) => !r.ok)?.error ?? null,
          });
        }
      })
      .catch((error: unknown) => logger.error('Scheduled backup check failed', error));
  };
  schedulerTimers.push(
    setTimeout(() => {
      checkSchedule();
      schedulerTimers.push(setInterval(checkSchedule, SCHEDULER_INTERVAL_MS));
    }, SCHEDULER_FIRST_CHECK_MS),
  );

  hardenSession();
  mainWindow = createMainWindow(windowOptions);

  app.on('second-instance', () => {
    if (!mainWindow) return;
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
  stopScheduler();
  closeDatabase();
});
