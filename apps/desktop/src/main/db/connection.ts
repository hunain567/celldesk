import Database from 'better-sqlite3-multiple-ciphers';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqliteDatabase = Database.Database;

export class DatabaseOpenError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DatabaseOpenError';
  }
}

/**
 * Applies the cipher settings and key to a fresh connection.
 * SQLCipher v4 format is used so the file can be opened by standard SQLCipher
 * tools for support work, given the key.
 */
export function applyEncryption(db: SqliteDatabase, hexKey: string): void {
  if (!/^[0-9a-f]{64}$/.test(hexKey)) {
    throw new DatabaseOpenError('Database key has an invalid format');
  }
  db.pragma(`cipher='sqlcipher'`);
  db.pragma('legacy=4');
  db.pragma(`key='${hexKey}'`);
}

/** Opens (or creates) the encrypted business database with safe defaults. */
export function openDatabase(path: string, hexKey: string, options: { readonly?: boolean } = {}): SqliteDatabase {
  if (!options.readonly) mkdirSync(dirname(path), { recursive: true });

  let db: SqliteDatabase;
  try {
    db = new Database(path, { readonly: options.readonly ?? false, fileMustExist: options.readonly ?? false });
  } catch (error) {
    throw new DatabaseOpenError(`Could not open the database file at ${path}`, error);
  }

  try {
    applyEncryption(db, hexKey);
    // Reading the schema forces SQLite to decrypt page 1; a wrong key fails here.
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (error) {
    db.close();
    throw new DatabaseOpenError('The database could not be decrypted with the stored key', error);
  }

  if (!options.readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Escapes a value for use inside a single-quoted SQL string literal. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Writes a consistent, encrypted (same key) snapshot of the live database to `targetPath`.
 * Safe to call while the app is in use. The target must not exist.
 */
export function snapshotDatabase(db: SqliteDatabase, targetPath: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  db.exec(`VACUUM INTO ${sqlString(targetPath)}`);
}

export interface IntegrityReport {
  ok: boolean;
  messages: string[];
}

/** Runs SQLite's full integrity and foreign key checks. */
export function checkIntegrity(db: SqliteDatabase): IntegrityReport {
  const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const messages = integrity.map((row) => row.integrity_check).filter((message) => message !== 'ok');
  const foreignKeys = db.pragma('foreign_key_check') as Array<{ table: string; rowid: number; parent: string }>;
  for (const row of foreignKeys) {
    messages.push(`Foreign key problem in ${row.table} row ${row.rowid} (missing ${row.parent})`);
  }
  return { ok: messages.length === 0, messages };
}
