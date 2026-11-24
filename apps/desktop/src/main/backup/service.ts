import {
  BackupScheduleSchema,
  DEFAULT_BACKUP_SCHEDULE,
  DEFAULT_RETENTION,
  RetentionPolicySchema,
  type BackupDestinationInfo,
  type BackupHistoryEntry,
  type BackupRunResult,
  type BackupSchedule,
  type BackupStatus,
  type RetentionPolicy,
} from '@nexodesk/shared';
import { rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { checkIntegrity, openDatabase, snapshotDatabase, type SqliteDatabase } from '../db/connection';
import { getSchemaVersion } from '../db/migrator';
import { AppError } from '../errors';
import type { AuditLog } from '../services/audit';
import {
  appendJournal,
  backupFileName,
  backupFolder,
  checkDestination,
  friendlyFileError,
  uniqueTempPath,
} from './files';
import { extractBackupFile, sha256File, writeBackupFile, type BackupKind, type PayloadManifest } from './format';
import {
  DEFAULT_KDF,
  generateBackupKey,
  keyId,
  unwrapKey,
  validateRecoveryPassword,
  WrappedKeySchema,
  wrapKey,
  type KdfParams,
  type WrappedKey,
} from './keys';
import { selectForDeletion } from './retention';
import { isScheduledBackupDue, nextSlot } from './schedule';

const OVERDUE_MS = 48 * 60 * 60 * 1000;

type RunStatus = NonNullable<BackupStatus['lastRun']>['status'];

interface ConfigRow {
  backup_key_hex: string;
  key_id: string;
  recovery_json: string;
  schedule_json: string;
  retention_json: string;
  created_at: string;
}

export interface BackupConfig {
  backupKey: Buffer;
  keyId: string;
  recovery: WrappedKey;
  schedule: BackupSchedule;
  retention: RetentionPolicy;
  createdAt: Date;
}

export interface BackupServiceOptions {
  /** Username recorded in the audit log for actions taken by a person. */
  actor?: () => string;
  db: SqliteDatabase;
  databaseKeyHex: string;
  installId: string;
  appVersion: string;
  tempDirectory: string;
  journalDirectory: string;
  audit: AuditLog;
  now?: () => Date;
  kdf?: KdfParams;
  log?: (message: string, data?: unknown) => void;
}

interface Snapshot {
  path: string;
  manifest: PayloadManifest;
  schemaVersion: number;
}

function tableCounts(db: SqliteDatabase): Record<string, number> {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as Array<{ name: string }>;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const row = db.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number };
    counts[name] = row.n;
  }
  return counts;
}

/** True when `child` is inside `parent` (used before deleting old backups). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(normalize(parent), normalize(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Creates, verifies, schedules and prunes backups.
 *
 * A backup file is reported as successful only after it has been written to
 * the destination, flushed to disk, read back, decrypted and matched against
 * the checksum of the snapshot it was made from.
 */
export class BackupService {
  private running = false;
  private readonly now: () => Date;
  private readonly kdf: KdfParams;

  constructor(private readonly options: BackupServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.kdf = options.kdf ?? DEFAULT_KDF;
  }

  private get db(): SqliteDatabase {
    return this.options.db;
  }

  isRunning(): boolean {
    return this.running;
  }

  getConfig(): BackupConfig | null {
    const row = this.db.prepare('SELECT * FROM backup_config WHERE id = 1').get() as ConfigRow | undefined;
    if (!row) return null;
    const schedule = BackupScheduleSchema.safeParse(JSON.parse(row.schedule_json));
    const retention = RetentionPolicySchema.safeParse(JSON.parse(row.retention_json));
    return {
      backupKey: Buffer.from(row.backup_key_hex, 'hex'),
      keyId: row.key_id,
      recovery: WrappedKeySchema.parse(JSON.parse(row.recovery_json)),
      schedule: schedule.success ? schedule.data : DEFAULT_BACKUP_SCHEDULE,
      retention: retention.success ? retention.data : DEFAULT_RETENTION,
      createdAt: new Date(row.created_at),
    };
  }

  private requireConfig(): BackupConfig {
    const config = this.getConfig();
    if (!config) throw new AppError('CONFLICT', 'Backups have not been set up yet.');
    return config;
  }

  /** First-time setup: recovery password and the first destination. */
  setup(input: { destinationPath: string; recoveryPassword: string }): void {
    if (this.getConfig()) throw new AppError('CONFLICT', 'Backups are already set up.');
    const problem = validateRecoveryPassword(input.recoveryPassword);
    if (problem) throw new AppError('VALIDATION_FAILED', problem);

    const key = generateBackupKey();
    const now = this.now().toISOString();
    const save = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO backup_config (id, backup_key_hex, key_id, recovery_json, schedule_json, retention_json, created_at, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          key.toString('hex'),
          keyId(key),
          JSON.stringify(wrapKey(key, input.recoveryPassword, this.kdf)),
          JSON.stringify(DEFAULT_BACKUP_SCHEDULE),
          JSON.stringify(DEFAULT_RETENTION),
          now,
          now,
        );
      this.insertDestination(input.destinationPath, now);
    });
    save();
    this.options.audit.append({ actor: this.options.actor?.() ?? 'owner', action: 'backup.setup', details: { destination: input.destinationPath } });
  }

  verifyRecoveryPassword(password: string): boolean {
    const config = this.requireConfig();
    try {
      return unwrapKey(config.recovery, password).equals(config.backupKey);
    } catch {
      return false;
    }
  }

  private insertDestination(path: string, now: string): void {
    if (!isAbsolute(path)) throw new AppError('VALIDATION_FAILED', 'Choose a full folder path.');
    const existing = this.db.prepare('SELECT id FROM backup_destinations WHERE path = ?').get(path);
    if (existing) throw new AppError('CONFLICT', 'This folder is already a backup location.');
    this.db.prepare('INSERT INTO backup_destinations (path, enabled, created_at) VALUES (?, 1, ?)').run(path, now);
  }

  addDestination(path: string): void {
    this.requireConfig();
    const count = (this.db.prepare('SELECT count(*) AS n FROM backup_destinations').get() as { n: number }).n;
    if (count >= 3) throw new AppError('CONFLICT', 'Up to 3 backup locations can be used.');
    this.insertDestination(path, this.now().toISOString());
    this.options.audit.append({ actor: this.options.actor?.() ?? 'owner', action: 'backup.destination.add', details: { path } });
  }

  removeDestination(id: number): void {
    this.requireConfig();
    const row = this.db.prepare('SELECT path FROM backup_destinations WHERE id = ?').get(id) as { path: string } | undefined;
    if (!row) throw new AppError('NOT_FOUND', 'This backup location no longer exists.');
    const count = (this.db.prepare('SELECT count(*) AS n FROM backup_destinations').get() as { n: number }).n;
    if (count <= 1) throw new AppError('CONFLICT', 'At least one backup location is required. Add another one first.');
    this.db.prepare('DELETE FROM backup_destinations WHERE id = ?').run(id);
    this.options.audit.append({ actor: this.options.actor?.() ?? 'owner', action: 'backup.destination.remove', details: { path: row.path } });
  }

  setSchedule(schedule: BackupSchedule): void {
    this.requireConfig();
    this.db
      .prepare('UPDATE backup_config SET schedule_json = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(schedule), this.now().toISOString());
    this.options.audit.append({ actor: this.options.actor?.() ?? 'owner', action: 'backup.schedule.update', details: schedule });
  }

  history(limit: number): BackupHistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, kind, destination, file_path, size_bytes, status, error
         FROM backup_files ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      created_at: string;
      kind: string;
      destination: string;
      file_path: string | null;
      size_bytes: number | null;
      status: 'verified' | 'failed' | 'deleted';
      error: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      kind: row.kind,
      destination: row.destination,
      filePath: row.file_path,
      sizeBytes: row.size_bytes,
      status: row.status,
      error: row.error,
    }));
  }

  /** Time of the newest backup file that still exists and was verified. */
  private lastVerifiedAt(): string | null {
    const row = this.db
      .prepare(`SELECT max(created_at) AS at FROM backup_files WHERE status = 'verified'`)
      .get() as { at: string | null };
    return row.at;
  }

  async getStatus(): Promise<BackupStatus> {
    const config = this.getConfig();
    const destinations = this.db
      .prepare('SELECT id, path, enabled FROM backup_destinations ORDER BY id')
      .all() as Array<{ id: number; path: string; enabled: number }>;
    const databaseSize = await this.liveDatabaseSize();

    const infos: BackupDestinationInfo[] = [];
    for (const destination of destinations) {
      const check = config
        ? await checkDestination(destination.path, this.options.installId, databaseSize * 2)
        : { ok: false, freeBytes: null, error: null };
      const last = this.db
        .prepare(
          `SELECT max(created_at) AS at FROM backup_files WHERE destination_id = ? AND status = 'verified'`,
        )
        .get(destination.id) as { at: string | null };
      const lastFailure = this.db
        .prepare(
          `SELECT status, error FROM backup_files WHERE destination_id = ? AND status != 'deleted' ORDER BY id DESC LIMIT 1`,
        )
        .get(destination.id) as { status: string; error: string | null } | undefined;
      infos.push({
        id: destination.id,
        path: destination.path,
        enabled: destination.enabled === 1,
        reachable: check.ok,
        freeBytes: check.freeBytes,
        lastVerifiedAt: last.at,
        lastError: check.error ?? (lastFailure?.status === 'failed' ? lastFailure.error : null),
      });
    }

    const lastRun = this.db
      .prepare('SELECT kind, status, started_at, error FROM backup_runs ORDER BY id DESC LIMIT 1')
      .get() as { kind: string; status: RunStatus; started_at: string; error: string | null } | undefined;
    const lastVerifiedAt = this.lastVerifiedAt();
    const now = this.now();
    const next = config ? nextSlot(config.schedule, now) : null;

    return {
      configured: config !== null,
      running: this.running,
      destinations: infos,
      schedule: config?.schedule ?? DEFAULT_BACKUP_SCHEDULE,
      retention: config?.retention ?? DEFAULT_RETENTION,
      lastVerifiedAt,
      lastRun: lastRun
        ? { kind: lastRun.kind, status: lastRun.status, startedAt: lastRun.started_at, error: lastRun.error }
        : null,
      nextScheduledAt: next ? next.toISOString() : null,
      overdue: config !== null && (!lastVerifiedAt || now.getTime() - new Date(lastVerifiedAt).getTime() > OVERDUE_MS),
    };
  }

  private async liveDatabaseSize(): Promise<number> {
    const file = this.db.name;
    let size = 0;
    for (const path of [file, `${file}-wal`]) {
      try {
        size += (await stat(path)).size;
      } catch {
        // Missing WAL file is normal.
      }
    }
    return size;
  }

  /** Takes an encrypted, integrity-checked snapshot of the live database. */
  private async takeSnapshot(): Promise<Snapshot> {
    const path = uniqueTempPath(this.options.tempDirectory, 'snapshot');
    snapshotDatabase(this.db, path);
    try {
      const copy = openDatabase(path, this.options.databaseKeyHex, { readonly: true });
      let counts: Record<string, number>;
      let schemaVersion: number;
      try {
        const report = checkIntegrity(copy);
        if (!report.ok) {
          throw new AppError(
            'INTERNAL_ERROR',
            `The database failed its integrity check, so no backup was made: ${report.messages.slice(0, 3).join('; ')}`,
          );
        }
        counts = tableCounts(copy);
        schemaVersion = getSchemaVersion(copy);
      } finally {
        copy.close();
      }
      const info = await stat(path);
      return {
        path,
        schemaVersion,
        manifest: {
          databaseKeyHex: this.options.databaseKeyHex,
          databaseSha256: await sha256File(path),
          databaseSizeBytes: info.size,
          tableCounts: counts,
        },
      };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  /** Writes one backup file to one destination and proves it can be restored. */
  private async writeAndVerify(
    destination: { id: number; path: string },
    snapshot: Snapshot,
    config: BackupConfig,
    kind: BackupKind,
    createdAt: Date,
  ): Promise<{ filePath: string; sizeBytes: number }> {
    const check = await checkDestination(destination.path, this.options.installId, snapshot.manifest.databaseSizeBytes * 2);
    if (!check.ok) throw new Error(check.error ?? 'The backup location cannot be used.');

    const folder = backupFolder(destination.path, this.options.installId);
    const finalPath = join(folder, backupFileName(kind, createdAt));
    const partialPath = `${finalPath}.partial`;
    const verifyPath = uniqueTempPath(this.options.tempDirectory, 'verify');

    try {
      const { sizeBytes } = await writeBackupFile({
        target: partialPath,
        databasePath: snapshot.path,
        backupKey: config.backupKey,
        manifest: snapshot.manifest,
        header: {
          createdAt: createdAt.toISOString(),
          appVersion: this.options.appVersion,
          schemaVersion: snapshot.schemaVersion,
          installId: this.options.installId,
          kind,
          keyId: config.keyId,
          recovery: config.recovery,
        },
      });

      // Read the file back from the destination and prove it restores to the same bytes.
      const extracted = await extractBackupFile({
        path: partialPath,
        backupKey: config.backupKey,
        outputDatabasePath: verifyPath,
      });
      if (extracted.manifest.databaseSha256 !== snapshot.manifest.databaseSha256) {
        throw new Error('The backup file did not match the database after writing.');
      }

      await rename(partialPath, finalPath);
      return { filePath: finalPath, sizeBytes };
    } catch (error) {
      await rm(partialPath, { force: true });
      throw error;
    } finally {
      await rm(verifyPath, { force: true });
    }
  }

  /**
   * Runs a backup to every enabled destination. Never throws for destination
   * problems: each destination's outcome is recorded and returned.
   */
  async run(kind: BackupKind): Promise<BackupRunResult> {
    if (this.running) throw new AppError('CONFLICT', 'A backup is already running.');
    const config = this.requireConfig();
    this.running = true;
    try {
      return await this.runLocked(kind, config);
    } finally {
      this.running = false;
    }
  }

  private async runLocked(kind: BackupKind, config: BackupConfig): Promise<BackupRunResult> {

    const startedAt = this.now();
    const runId = Number(
      this.db
        .prepare(`INSERT INTO backup_runs (kind, status, started_at) VALUES (?, 'running', ?)`)
        .run(kind, startedAt.toISOString()).lastInsertRowid,
    );
    const destinations = this.db
      .prepare('SELECT id, path FROM backup_destinations WHERE enabled = 1 ORDER BY id')
      .all() as Array<{ id: number; path: string }>;

    const results: BackupRunResult['results'] = [];
    let runError: string | null = null;
    let snapshot: Snapshot | null = null;

    try {
      if (destinations.length === 0) throw new AppError('CONFLICT', 'No backup location is enabled.');
      snapshot = await this.takeSnapshot();

      for (const destination of destinations) {
        try {
          const written = await this.writeAndVerify(destination, snapshot, config, kind, startedAt);
          this.db
            .prepare(
              `INSERT INTO backup_files (run_id, destination_id, destination, file_path, kind, created_at, size_bytes, sha256, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified')`,
            )
            .run(
              runId,
              destination.id,
              destination.path,
              written.filePath,
              kind,
              startedAt.toISOString(),
              written.sizeBytes,
              snapshot.manifest.databaseSha256,
            );
          results.push({ destination: destination.path, ok: true, filePath: written.filePath, sizeBytes: written.sizeBytes, error: null });
        } catch (error) {
          const message = friendlyFileError(error);
          this.options.log?.(`Backup to ${destination.path} failed`, error);
          this.db
            .prepare(
              `INSERT INTO backup_files (run_id, destination_id, destination, kind, created_at, status, error)
               VALUES (?, ?, ?, ?, ?, 'failed', ?)`,
            )
            .run(runId, destination.id, destination.path, kind, startedAt.toISOString(), message);
          results.push({ destination: destination.path, ok: false, filePath: null, sizeBytes: null, error: message });
        }
      }
    } catch (error) {
      runError = error instanceof AppError ? error.message : friendlyFileError(error);
      this.options.log?.('Backup run failed', error);
    } finally {
      if (snapshot) await rm(snapshot.path, { force: true });
    }

    const succeeded = results.filter((result) => result.ok).length;
    const status: BackupRunResult['status'] =
      runError !== null || succeeded === 0 ? 'failed' : succeeded === results.length ? 'success' : 'partial';
    const finishedAt = this.now().toISOString();
    this.db
      .prepare('UPDATE backup_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?')
      .run(status, finishedAt, runError ?? results.find((result) => !result.ok)?.error ?? null, runId);

    if (status !== 'failed') await this.applyRetention(config);

    this.options.audit.append({
      actor: kind === 'manual' ? (this.options.actor?.() ?? 'owner') : 'system',
      action: `backup.${status}`,
      entityType: 'backup_run',
      entityId: String(runId),
      details: { kind, succeeded, destinations: results.length, error: runError },
    });
    appendJournal(this.options.journalDirectory, 'backup-journal.jsonl', {
      runId,
      kind,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt,
      results,
      error: runError,
    });

    return { status, results, error: runError };
  }

  /** Removes old verified backups according to the retention policy, per destination. */
  private async applyRetention(config: BackupConfig): Promise<void> {
    const destinations = this.db.prepare('SELECT id, path FROM backup_destinations').all() as Array<{
      id: number;
      path: string;
    }>;
    for (const destination of destinations) {
      const files = this.db
        .prepare(
          `SELECT id, kind, created_at, file_path FROM backup_files
           WHERE destination_id = ? AND status = 'verified' ORDER BY created_at DESC`,
        )
        .all(destination.id) as Array<{ id: number; kind: string; created_at: string; file_path: string }>;
      const toDelete = new Set(
        selectForDeletion(
          files.map((file) => ({ id: file.id, kind: file.kind, createdAt: new Date(file.created_at) })),
          config.retention,
          this.now(),
        ),
      );
      const folder = backupFolder(destination.path, this.options.installId);
      for (const file of files) {
        if (!toDelete.has(file.id) || !isInside(folder, file.file_path)) continue;
        try {
          await rm(file.file_path, { force: true });
          this.db
            .prepare(`UPDATE backup_files SET status = 'deleted', deleted_at = ? WHERE id = ?`)
            .run(this.now().toISOString(), file.id);
        } catch (error) {
          this.options.log?.(`Could not remove old backup ${file.file_path}`, error);
        }
      }
    }
  }

  /** Called every minute by the scheduler; runs a scheduled backup when one is due. */
  async runScheduledIfDue(): Promise<BackupRunResult | null> {
    const config = this.getConfig();
    if (!config || this.running) return null;
    const success = this.db
      .prepare(`SELECT max(started_at) AS at FROM backup_runs WHERE kind = 'scheduled' AND status IN ('success', 'partial')`)
      .get() as { at: string | null };
    const attempt = this.db
      .prepare(`SELECT max(started_at) AS at FROM backup_runs WHERE kind = 'scheduled'`)
      .get() as { at: string | null };
    const due = isScheduledBackupDue({
      schedule: config.schedule,
      now: this.now(),
      configuredAt: config.createdAt,
      lastScheduledSuccessAt: success.at ? new Date(success.at) : null,
      lastScheduledAttemptAt: attempt.at ? new Date(attempt.at) : null,
    });
    return due ? this.run('scheduled') : null;
  }

  /** Marks runs left as "running" by a crash or power cut as failed. */
  recoverInterruptedRuns(): void {
    this.db
      .prepare(
        `UPDATE backup_runs SET status = 'failed', finished_at = ?, error = 'NexoDesk was closed before the backup finished.'
         WHERE status = 'running'`,
      )
      .run(this.now().toISOString());
  }
}
