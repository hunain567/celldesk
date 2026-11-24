import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../src/main/db/connection';
import { migrations } from '../src/main/db/migrations';
import { migrate } from '../src/main/db/migrator';
import { AuditLog, GENESIS_HASH } from '../src/main/services/audit';
import { tempDir, TEST_KEY } from './helpers';

describe('audit log', () => {
  let dir: ReturnType<typeof tempDir>;
  let db: SqliteDatabase;
  let audit: AuditLog;

  beforeEach(() => {
    dir = tempDir();
    db = openDatabase(join(dir.path, 'audit.db'), TEST_KEY);
    migrate(db, migrations, { appVersion: '0.1.0' });
    audit = new AuditLog(db);
  });
  afterEach(() => {
    db.close();
    dir.cleanup();
  });

  it('chains each entry to the previous one', () => {
    audit.append({ actor: 'owner', action: 'sale.post', entityType: 'sale', entityId: 'SI-1', details: { total: 100 } });
    audit.append({ actor: 'owner', action: 'sale.return', entityType: 'sale', entityId: 'SI-1' });
    const rows = db.prepare('SELECT prev_hash, hash FROM audit_log ORDER BY id').all() as Array<{
      prev_hash: string;
      hash: string;
    }>;
    expect(rows[0]!.prev_hash).toBe(GENESIS_HASH);
    expect(rows[1]!.prev_hash).toBe(rows[0]!.hash);
    expect(audit.verify()).toEqual({ valid: true, entriesChecked: 2, firstBrokenId: null });
  });

  it('refuses updates and deletes at the database level', () => {
    audit.append({ actor: 'owner', action: 'x' });
    expect(() => db.prepare(`UPDATE audit_log SET actor = 'someone else'`).run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });

  it('detects a row edited after the protective triggers were removed', () => {
    for (let i = 0; i < 5; i += 1) audit.append({ actor: 'salesman', action: 'sale.post', details: { i } });
    db.exec('DROP TRIGGER audit_log_no_update');
    db.prepare(`UPDATE audit_log SET details_json = '{"i":99}' WHERE id = 3`).run();
    expect(audit.verify()).toEqual({ valid: false, entriesChecked: 3, firstBrokenId: 3 });
  });

  it('detects a deleted row in the middle of the chain', () => {
    for (let i = 0; i < 4; i += 1) audit.append({ actor: 'owner', action: 'cash.out', details: { i } });
    db.exec('DROP TRIGGER audit_log_no_delete');
    db.prepare('DELETE FROM audit_log WHERE id = 2').run();
    expect(audit.verify().valid).toBe(false);
    expect(audit.verify().firstBrokenId).toBe(3);
  });
});
