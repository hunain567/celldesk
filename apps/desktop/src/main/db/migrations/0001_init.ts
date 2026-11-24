import type { Migration } from '../migrator';

/**
 * Foundation tables: application metadata, user settings, migration history
 * and the tamper-evident audit log.
 */
export const migration0001: Migration = {
  version: 1,
  name: 'init',
  up(db) {
    db.exec(`
      CREATE TABLE app_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE schema_migrations (
        version     INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        applied_at  TEXT NOT NULL,
        app_version TEXT NOT NULL
      ) STRICT;

      CREATE TABLE audit_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at  TEXT NOT NULL,
        actor        TEXT NOT NULL,
        action       TEXT NOT NULL,
        entity_type  TEXT,
        entity_id    TEXT,
        details_json TEXT NOT NULL DEFAULT '{}',
        prev_hash    TEXT NOT NULL,
        hash         TEXT NOT NULL UNIQUE
      ) STRICT;

      CREATE INDEX idx_audit_log_entity ON audit_log (entity_type, entity_id);
      CREATE INDEX idx_audit_log_occurred_at ON audit_log (occurred_at);

      -- The audit log is append-only. Any attempt to change history is refused.
      CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only');
      END;

      CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only');
      END;
    `);
  },
};
