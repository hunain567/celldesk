import type { BackupInspection, BackupVerification } from '@nexodesk/shared';
import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createVerifiedSafetyCopy } from '../db/bootstrap';
import { applyEncryption, checkIntegrity, openDatabase, type SqliteDatabase } from '../db/connection';
import { migrations } from '../db/migrations';
import { latestVersion, migrate } from '../db/migrator';
import { AppError } from '../errors';
import type { AuditLog } from '../services/audit';
import { appendJournal, uniqueTempPath } from './files';
import { BackupDamagedError, BackupFormatError, extractBackupFile, readBackupHeader, type BackupHeader } from './format';
import { unwrapKey, WrongRecoveryPasswordError } from './keys';
import type { BackupService } from './service';
import { journalPath, writeJournal } from './swap';

export interface RestoreServiceOptions {
  /** Username recorded in the audit log for actions taken by a person. */
  actor?: () => string;
  db: SqliteDatabase;
  databaseKeyHex: string;
  databasePath: string;
  installId: string;
  appVersion: string;
  tempDirectory: string;
  restoreDirectory: string;
  safetyDirectory: string;
  journalDirectory: string;
  backups: BackupService;
  audit: AuditLog;
  now?: () => Date;
  log?: (message: string, data?: unknown) => void;
}

function toAppError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof WrongRecoveryPasswordError) throw new AppError('VALIDATION_FAILED', error.message);
  if (error instanceof BackupFormatError || error instanceof BackupDamagedError) {
    throw new AppError('VALIDATION_FAILED', error.message);
  }
  throw error;
}

/**
 * Restore Center logic. Nothing here replaces the live database: `prepare`
 * builds a fully checked copy and a journal; the swap itself happens in the
 * main process after the live connection is closed (see swap.ts).
 */
export class RestoreService {
  private readonly now: () => Date;

  constructor(private readonly options: RestoreServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private compatibility(header: BackupHeader): { compatible: boolean; message: string | null } {
    const supported = latestVersion(migrations);
    if (header.schemaVersion > supported) {
      return {
        compatible: false,
        message: `This backup was made by a newer NexoDesk (${header.appVersion}). Update NexoDesk before restoring it.`,
      };
    }
    return { compatible: true, message: null };
  }

  async inspect(path: string): Promise<BackupInspection> {
    try {
      const { header } = await readBackupHeader(path);
      const config = this.options.backups.getConfig();
      const { compatible, message } = this.compatibility(header);
      return {
        filePath: path,
        fileSizeBytes: (await stat(path)).size,
        createdAt: header.createdAt,
        appVersion: header.appVersion,
        schemaVersion: header.schemaVersion,
        kind: header.kind,
        sameInstallation: header.installId === this.options.installId,
        needsPassword: !config || config.keyId !== header.keyId,
        compatible,
        compatibilityMessage: message,
      };
    } catch (error) {
      return toAppError(error);
    }
  }

  private resolveKey(header: BackupHeader, password: string | undefined): Buffer {
    const config = this.options.backups.getConfig();
    if (config && config.keyId === header.keyId) return config.backupKey;
    if (!password) {
      throw new AppError('VALIDATION_FAILED', 'Enter the recovery password that was set when this backup was made.');
    }
    return unwrapKey(header.recovery, password);
  }

  /** Decrypts into `output` and proves the database inside is intact. Returns its key and counts. */
  private async extractAndCheck(path: string, password: string | undefined, output: string) {
    const { header } = await readBackupHeader(path);
    const { compatible, message } = this.compatibility(header);
    if (!compatible) throw new AppError('CONFLICT', message ?? 'This backup cannot be restored.');
    const key = this.resolveKey(header, password);
    const { manifest } = await extractBackupFile({ path, backupKey: key, outputDatabasePath: output });
    const db = openDatabase(output, manifest.databaseKeyHex, { readonly: true });
    try {
      const report = checkIntegrity(db);
      if (!report.ok) throw new AppError('VALIDATION_FAILED', 'The database inside this backup is damaged.');
    } finally {
      db.close();
    }
    return { header, manifest };
  }

  async verify(path: string, password?: string): Promise<BackupVerification> {
    const output = uniqueTempPath(this.options.tempDirectory, 'restore-verify');
    try {
      const { manifest } = await this.extractAndCheck(path, password, output);
      return { ok: true, tableCounts: manifest.tableCounts, databaseSizeBytes: manifest.databaseSizeBytes };
    } catch (error) {
      return toAppError(error);
    } finally {
      rmSync(output, { force: true });
    }
  }

  /**
   * Builds the database that will replace the live one and writes the restore
   * journal. After this returns, the caller closes the live database and calls
   * swapDatabase(), then restarts the app.
   */
  async prepare(path: string, password?: string): Promise<{ journalFile: string }> {
    const { restoreDirectory } = this.options;
    mkdirSync(restoreDirectory, { recursive: true });
    const journalFile = journalPath(restoreDirectory);
    if (existsSync(journalFile)) throw new AppError('CONFLICT', 'Another restore is still in progress.');

    const stagingPath = join(restoreDirectory, 'staging.db');
    rmSync(stagingPath, { force: true });

    try {
      const { header, manifest } = await this.extractAndCheck(path, password, stagingPath);
      this.rekeyAndMigrate(stagingPath, manifest.databaseKeyHex);

      // Safety copy of the current data, verified, before anything is replaced.
      const safetyCopyPath = createVerifiedSafetyCopy(
        this.options.db,
        this.options.databaseKeyHex,
        this.options.safetyDirectory,
        'pre-restore',
        this.now(),
      );
      // Also send a pre-restore backup to the backup locations when they are available.
      if (this.options.backups.getConfig() && !this.options.backups.isRunning()) {
        try {
          await this.options.backups.run('pre-restore');
        } catch (error) {
          this.options.log?.('Pre-restore backup to backup locations failed', error);
        }
      }

      const startedAt = this.now();
      writeJournal(journalFile, {
        state: 'prepared',
        livePath: this.options.databasePath,
        stagingPath,
        preRestorePath: `${this.options.databasePath}.pre-restore-${startedAt.getTime()}`,
        backupFile: path,
        backupCreatedAt: header.createdAt,
        safetyCopyPath,
        startedAt: startedAt.toISOString(),
      });
      this.options.audit.append({
        actor: this.options.actor?.() ?? 'owner',
        action: 'backup.restore.prepared',
        details: { file: path, backupCreatedAt: header.createdAt, safetyCopy: safetyCopyPath },
      });
      appendJournal(this.options.journalDirectory, 'restore-journal.jsonl', {
        at: startedAt.toISOString(),
        event: 'prepared',
        file: path,
        backupCreatedAt: header.createdAt,
        safetyCopyPath,
      });
      return { journalFile };
    } catch (error) {
      rmSync(stagingPath, { force: true });
      return toAppError(error);
    }
  }

  /** Re-encrypts the staged database with this PC's key and brings its schema up to date. */
  private rekeyAndMigrate(stagingPath: string, backupDatabaseKey: string): void {
    if (backupDatabaseKey !== this.options.databaseKeyHex) {
      const raw = new Database(stagingPath);
      try {
        applyEncryption(raw, backupDatabaseKey);
        raw.pragma('journal_mode = DELETE');
        raw.pragma(`rekey='${this.options.databaseKeyHex}'`);
      } finally {
        raw.close();
      }
    }
    const db = openDatabase(stagingPath, this.options.databaseKeyHex);
    try {
      migrate(db, migrations, { appVersion: this.options.appVersion });
      const report = checkIntegrity(db);
      if (!report.ok) throw new AppError('VALIDATION_FAILED', 'The restored database failed its final check.');
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  }
}
