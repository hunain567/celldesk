import type { SqliteDatabase } from '../db/connection';
import { AppError } from '../errors';
import type { AuditLog } from './audit';

/** What every business service needs. */
export interface BusinessContext {
  db: SqliteDatabase;
  audit: AuditLog;
  /** Throws when the licence does not allow new business records. */
  assertCanWrite: () => void;
  now?: () => Date;
}

export function nowOf(context: BusinessContext): Date {
  return context.now?.() ?? new Date();
}

/** Today's local date as YYYY-MM-DD. */
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Next document number such as PI-2026-000042. Must be called inside the
 * transaction that creates the document, so numbers never repeat or skip
 * when a posting fails.
 */
export function nextNumber(db: SqliteDatabase, prefix: string, date: Date): string {
  const year = date.getFullYear();
  const row = db.prepare('SELECT next_value FROM number_series WHERE prefix = ? AND year = ?').get(prefix, year) as
    | { next_value: number }
    | undefined;
  const value = row?.next_value ?? 1;
  if (row) db.prepare('UPDATE number_series SET next_value = ? WHERE prefix = ? AND year = ?').run(value + 1, prefix, year);
  else db.prepare('INSERT INTO number_series (prefix, year, next_value) VALUES (?, ?, ?)').run(prefix, year, value + 1);
  return `${prefix}-${year}-${String(value).padStart(6, '0')}`;
}

export function notFound(what: string): AppError {
  return new AppError('NOT_FOUND', `${what} was not found. It may have been removed.`);
}

/** Maps SQLite unique-constraint failures to a message the user can act on. */
export function uniqueViolation(error: unknown, message: string): never {
  if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
    throw new AppError('CONFLICT', message);
  }
  throw error;
}

export function accountExists(db: SqliteDatabase, accountId: number): void {
  const account = db.prepare('SELECT is_active FROM accounts WHERE id = ?').get(accountId) as { is_active: number } | undefined;
  if (!account || account.is_active !== 1) throw new AppError('VALIDATION_FAILED', 'Choose an active payment account.');
}
