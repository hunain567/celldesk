import type { Migration } from '../migrator';

/**
 * Backup configuration, destinations and history.
 *
 * The backup key lives in this encrypted database, so a restored database
 * brings its own backup settings with it.
 */
export const migration0002: Migration = {
  version: 2,
  name: 'backup',
  up(db) {
    db.exec(`
      CREATE TABLE backup_config (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        backup_key_hex  TEXT NOT NULL,
        key_id          TEXT NOT NULL,
        recovery_json   TEXT NOT NULL,
        schedule_json   TEXT NOT NULL,
        retention_json  TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      ) STRICT;

      CREATE TABLE backup_destinations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        path        TEXT NOT NULL UNIQUE,
        enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at  TEXT NOT NULL
      ) STRICT;

      CREATE TABLE backup_runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT NOT NULL,
        status       TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
        started_at   TEXT NOT NULL,
        finished_at  TEXT,
        error        TEXT
      ) STRICT;

      CREATE TABLE backup_files (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id          INTEGER NOT NULL REFERENCES backup_runs (id),
        destination_id  INTEGER REFERENCES backup_destinations (id) ON DELETE SET NULL,
        destination     TEXT NOT NULL,
        file_path       TEXT,
        kind            TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        size_bytes      INTEGER,
        sha256          TEXT,
        status          TEXT NOT NULL CHECK (status IN ('verified', 'failed', 'deleted')),
        error           TEXT,
        deleted_at      TEXT
      ) STRICT;

      CREATE INDEX idx_backup_files_destination ON backup_files (destination_id, status, created_at);
      CREATE INDEX idx_backup_runs_started ON backup_runs (started_at);
    `);
  },
};
