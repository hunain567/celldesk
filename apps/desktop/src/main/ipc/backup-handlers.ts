import type { RestoreOutcome } from '@nexodesk/shared';
import { AppError } from '../errors';
import type { BackupService } from '../backup/service';
import type { RestoreService } from '../backup/restore';
import type { IpcRouter } from './router';

/**
 * Remembers paths the user picked in a native dialog during this session.
 * Backup locations and restore files can only come from such a pick (or be an
 * existing configured location), so a compromised screen cannot point the
 * backend at arbitrary paths.
 */
export class PathGrants {
  private readonly granted = new Set<string>();

  grant(path: string): void {
    this.granted.add(path);
  }

  require(path: string): void {
    if (!this.granted.has(path)) {
      throw new AppError('FORBIDDEN', 'Choose the folder or file again using the Browse button.');
    }
  }
}

export interface BackupHandlerDependencies {
  backups: BackupService;
  restore: RestoreService;
  grants: PathGrants;
  chooseFolder: () => Promise<string | null>;
  chooseBackupFile: () => Promise<string | null>;
  /** Runs a backup and pushes start/finish events to the screen. */
  runBackup: (kind: 'manual') => ReturnType<BackupService['run']>;
  /** Called after a restore has been prepared; closes the database, swaps it in and restarts. */
  onRestorePrepared: () => void;
  lastRestoreOutcome: () => RestoreOutcome;
}

export function registerBackupHandlers(router: IpcRouter, deps: BackupHandlerDependencies): void {
  router.register('backup:status', () => deps.backups.getStatus());

  router.register('backup:chooseFolder', async () => {
    const path = await deps.chooseFolder();
    if (path) deps.grants.grant(path);
    return { path };
  });

  router.register('backup:setup', ({ destinationPath, recoveryPassword }) => {
    deps.grants.require(destinationPath);
    deps.backups.setup({ destinationPath, recoveryPassword });
    return null;
  });

  router.register('backup:addDestination', ({ path }) => {
    deps.grants.require(path);
    deps.backups.addDestination(path);
    return null;
  });

  router.register('backup:removeDestination', ({ id }) => {
    deps.backups.removeDestination(id);
    return null;
  });

  router.register('backup:setSchedule', (schedule) => {
    deps.backups.setSchedule(schedule);
    return null;
  });

  router.register('backup:runNow', () => deps.runBackup('manual'));

  router.register('backup:history', ({ limit }) => deps.backups.history(limit));

  router.register('restore:chooseFile', async () => {
    const path = await deps.chooseBackupFile();
    if (path) deps.grants.grant(path);
    return { path };
  });

  router.register('restore:inspect', ({ path }) => {
    deps.grants.require(path);
    return deps.restore.inspect(path);
  });

  router.register('restore:verify', ({ path, recoveryPassword }) => {
    deps.grants.require(path);
    return deps.restore.verify(path, recoveryPassword);
  });

  router.register('restore:start', async ({ path, recoveryPassword }) => {
    deps.grants.require(path);
    if (deps.backups.isRunning()) throw new AppError('CONFLICT', 'Wait for the running backup to finish, then restore.');
    await deps.restore.prepare(path, recoveryPassword);
    deps.onRestorePrepared();
    return null;
  });

  router.register('restore:lastOutcome', () => deps.lastRestoreOutcome());
}
