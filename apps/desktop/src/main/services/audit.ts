import { createHash } from 'node:crypto';
import type { SqliteDatabase } from '../db/connection';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntryInput {
  actor: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown>;
}

interface AuditRow {
  id: number;
  occurred_at: string;
  actor: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details_json: string;
  prev_hash: string;
  hash: string;
}

function computeHash(fields: Omit<AuditRow, 'id' | 'hash'>): string {
  const canonical = JSON.stringify([
    fields.prev_hash,
    fields.occurred_at,
    fields.actor,
    fields.action,
    fields.entity_type,
    fields.entity_id,
    fields.details_json,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Append-only, hash-chained audit log. Each entry stores the hash of the
 * previous one, so removing or editing a row breaks the chain and is detected
 * by `verify()`. Database triggers also refuse UPDATE and DELETE.
 */
export class AuditLog {
  constructor(private readonly db: SqliteDatabase, private readonly now: () => Date = () => new Date()) {}

  append(entry: AuditEntryInput): number {
    const write = this.db.transaction(() => {
      const last = this.db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get() as
        | { hash: string }
        | undefined;
      const fields = {
        occurred_at: this.now().toISOString(),
        actor: entry.actor,
        action: entry.action,
        entity_type: entry.entityType ?? null,
        entity_id: entry.entityId ?? null,
        details_json: JSON.stringify(entry.details ?? {}),
        prev_hash: last?.hash ?? GENESIS_HASH,
      };
      const result = this.db
        .prepare(
          `INSERT INTO audit_log (occurred_at, actor, action, entity_type, entity_id, details_json, prev_hash, hash)
           VALUES (@occurred_at, @actor, @action, @entity_type, @entity_id, @details_json, @prev_hash, @hash)`,
        )
        .run({ ...fields, hash: computeHash(fields) });
      return Number(result.lastInsertRowid);
    });
    return write.immediate();
  }

  verify(): { valid: boolean; entriesChecked: number; firstBrokenId: number | null } {
    const rows = this.db.prepare('SELECT * FROM audit_log ORDER BY id ASC').iterate() as IterableIterator<AuditRow>;
    let expectedPrev = GENESIS_HASH;
    let checked = 0;
    for (const row of rows) {
      checked += 1;
      const { id, hash, ...fields } = row;
      if (row.prev_hash !== expectedPrev || computeHash(fields) !== hash) {
        return { valid: false, entriesChecked: checked, firstBrokenId: id };
      }
      expectedPrev = hash;
    }
    return { valid: true, entriesChecked: checked, firstBrokenId: null };
  }
}
