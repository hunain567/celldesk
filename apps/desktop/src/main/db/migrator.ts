import type { SqliteDatabase } from './connection';

export interface Migration {
  /** Consecutive integers starting at 1. */
  version: number;
  name: string;
  up(db: SqliteDatabase): void;
}

export class SchemaTooNewError extends Error {
  constructor(readonly databaseVersion: number, readonly appVersion: number) {
    super(
      `This database was created by a newer version of NexoDesk (schema ${databaseVersion}). ` +
        `This copy of NexoDesk supports schema ${appVersion}. Please update NexoDesk.`,
    );
    this.name = 'SchemaTooNewError';
  }
}

export class MigrationFailedError extends Error {
  constructor(readonly migration: Migration, readonly safetyCopyPath: string | null, cause: unknown) {
    super(
      `Database upgrade step ${migration.version} (${migration.name}) failed. ` +
        'No changes were applied. ' +
        (safetyCopyPath ? `A safety copy was saved at ${safetyCopyPath}.` : ''),
      { cause },
    );
    this.name = 'MigrationFailedError';
  }
}

export interface MigrateOptions {
  appVersion: string;
  /**
   * Called once before any migration runs on a database that already has data.
   * Must return the path of a verified safety copy, or throw to stop the upgrade.
   */
  createSafetyCopy?: (fromVersion: number) => string;
  now?: () => Date;
}

export interface MigrateResult {
  fromVersion: number;
  toVersion: number;
  applied: Array<{ version: number; name: string }>;
  safetyCopyPath: string | null;
}

export function getSchemaVersion(db: SqliteDatabase): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
}

function assertWellFormed(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migrations must be numbered 1, 2, 3... without gaps; found ${migration.version} at position ${index + 1}`,
      );
    }
  });
}

/**
 * Brings the database schema up to date.
 *
 * All pending migrations run inside a single transaction: either every step is
 * applied or none is. A database newer than the app is never modified.
 */
export function migrate(db: SqliteDatabase, migrations: readonly Migration[], options: MigrateOptions): MigrateResult {
  assertWellFormed(migrations);
  const now = options.now ?? (() => new Date());
  const fromVersion = getSchemaVersion(db);
  const target = latestVersion(migrations);

  if (fromVersion > target) throw new SchemaTooNewError(fromVersion, target);

  const pending = migrations.filter((migration) => migration.version > fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [], safetyCopyPath: null };
  }

  const safetyCopyPath = fromVersion > 0 && options.createSafetyCopy ? options.createSafetyCopy(fromVersion) : null;

  let current: Migration | undefined;
  const run = db.transaction(() => {
    for (const migration of pending) {
      current = migration;
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at, app_version) VALUES (?, ?, ?, ?)',
      ).run(migration.version, migration.name, now().toISOString(), options.appVersion);
      db.pragma(`user_version = ${migration.version}`);
    }
  });

  try {
    run();
  } catch (error) {
    throw new MigrationFailedError(current ?? pending[0]!, safetyCopyPath, error);
  }

  return {
    fromVersion,
    toVersion: target,
    applied: pending.map(({ version, name }) => ({ version, name })),
    safetyCopyPath,
  };
}
