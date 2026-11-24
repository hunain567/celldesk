import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { journalPath, recoverInterruptedRestore, type RecoveryOutcome } from '../backup/swap';
import { join } from 'node:path';
import { checkIntegrity, openDatabase, snapshotDatabase, type SqliteDatabase } from './connection';
import { loadOrCreateDatabaseKey, type SecretProtector } from './keystore';
import { migrations } from './migrations';
import { latestVersion, migrate, type MigrateResult } from './migrator';

export interface DataLocations {
  /** Root folder for everything NexoDesk stores on this PC. */
  root: string;
  databasePath: string;
  keyPath: string;
  safetyDirectory: string;
  logDirectory: string;
  /** Scratch space for snapshots and extraction; emptied at start-up. */
  tempDirectory: string;
  /** Holds the restore journal and the staged database during a restore. */
  restoreDirectory: string;
}

export function resolveDataLocations(root: string): DataLocations {
  return {
    root,
    databasePath: join(root, 'data', 'nexodesk.db'),
    keyPath: join(root, 'keys', 'database.key'),
    safetyDirectory: join(root, 'safety'),
    logDirectory: join(root, 'logs'),
    tempDirectory: join(root, 'tmp'),
    restoreDirectory: join(root, 'restore'),
  };
}

export class SafetyCopyFailedError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'SafetyCopyFailedError';
  }
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Takes an encrypted snapshot of the live database and proves it is readable
 * and intact before returning its path. On any failure the partial file is removed.
 */
export function createVerifiedSafetyCopy(
  db: SqliteDatabase,
  hexKey: string,
  directory: string,
  label: string,
  now: Date = new Date(),
): string {
  const target = join(directory, `${label}-${timestamp(now)}.db`);
  if (existsSync(target)) {
    // Never overwrite or clean up a file this call did not create.
    throw new SafetyCopyFailedError(`A safety copy with the same name already exists (${target})`);
  }
  try {
    snapshotDatabase(db, target);
    const copy = openDatabase(target, hexKey, { readonly: true });
    try {
      const report = checkIntegrity(copy);
      if (!report.ok) throw new Error(report.messages.join('; '));
    } finally {
      copy.close();
    }
    return target;
  } catch (error) {
    if (existsSync(target)) rmSync(target, { force: true });
    throw new SafetyCopyFailedError(`The safety copy could not be created or verified (${label})`, error);
  }
}

export interface BootstrapResult {
  db: SqliteDatabase;
  hexKey: string;
  migration: MigrateResult;
  installId: string;
  latestSchemaVersion: number;
  /** What happened to a restore that was in progress when the app last stopped. */
  restoreOutcome: RecoveryOutcome;
}

function isHealthyDatabase(path: string, hexKey: string): boolean {
  try {
    const db = openDatabase(path, hexKey);
    try {
      return checkIntegrity(db).ok;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * Opens the encrypted database, applies pending migrations (after a verified
 * safety copy) and makes sure the install has a permanent id.
 */
export function bootstrapDatabase(options: {
  locations: DataLocations;
  protector: SecretProtector;
  appVersion: string;
}): BootstrapResult {
  const { locations, protector, appVersion } = options;
  const hexKey = loadOrCreateDatabaseKey({
    keyPath: locations.keyPath,
    databasePath: locations.databasePath,
    protector,
  });

  // Scratch files from a previous run are never needed again.
  rmSync(locations.tempDirectory, { recursive: true, force: true });

  // Finish or undo a restore that was interrupted (for example by a power cut).
  const restoreOutcome = recoverInterruptedRestore(journalPath(locations.restoreDirectory), (path) =>
    isHealthyDatabase(path, hexKey),
  );

  const db = openDatabase(locations.databasePath, hexKey);
  try {
    const migration = migrate(db, migrations, {
      appVersion,
      createSafetyCopy: (fromVersion) =>
        createVerifiedSafetyCopy(db, hexKey, locations.safetyDirectory, `pre-migration-v${fromVersion}`),
    });
    const installId = ensureInstallId(db);
    return { db, hexKey, migration, installId, latestSchemaVersion: latestVersion(migrations), restoreOutcome };
  } catch (error) {
    db.close();
    throw error;
  }
}

function ensureInstallId(db: SqliteDatabase): string {
  const existing = db.prepare(`SELECT value FROM app_meta WHERE key = 'install_id'`).get() as
    | { value: string }
    | undefined;
  if (existing) return existing.value;
  const installId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES ('install_id', ?, ?)`).run(installId, now);
  db.prepare(`INSERT INTO app_meta (key, value, updated_at) VALUES ('created_at', ?, ?)`).run(now, now);
  return installId;
}
