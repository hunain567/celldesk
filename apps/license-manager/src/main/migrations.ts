import type { Migration } from '@desktop-main/db/migrator';

/** License Manager database schema. Never edit a released migration; add a new one. */
export const lmMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    up(db) {
      db.exec(`
        CREATE TABLE schema_migrations (
          version     INTEGER PRIMARY KEY,
          name        TEXT NOT NULL,
          applied_at  TEXT NOT NULL,
          app_version TEXT NOT NULL
        ) STRICT;

        CREATE TABLE app_meta (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE vendor_key (
          id               INTEGER PRIMARY KEY CHECK (id = 1),
          private_key_pem  TEXT NOT NULL,
          public_key_pem   TEXT NOT NULL,
          created_at       TEXT NOT NULL
        ) STRICT;

        CREATE TABLE customers (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          shop_name   TEXT NOT NULL,
          owner_name  TEXT NOT NULL DEFAULT '',
          phone       TEXT NOT NULL DEFAULT '',
          city        TEXT NOT NULL DEFAULT '',
          created_at  TEXT NOT NULL
        ) STRICT;

        CREATE TABLE licenses (
          id            TEXT PRIMARY KEY,
          customer_id   INTEGER NOT NULL REFERENCES customers (id),
          plan          TEXT NOT NULL CHECK (plan IN ('monthly', 'six-months', 'yearly', 'custom')),
          status        TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
          valid_from    TEXT NOT NULL,
          valid_until   TEXT NOT NULL,
          grace_days    INTEGER NOT NULL,
          device_limit  INTEGER NOT NULL,
          notes         TEXT NOT NULL DEFAULT '',
          created_at    TEXT NOT NULL
        ) STRICT;

        CREATE TABLE devices (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          license_id          TEXT NOT NULL REFERENCES licenses (id),
          device_id           TEXT NOT NULL,
          device_public_key   TEXT NOT NULL,
          machine_name        TEXT NOT NULL,
          app_version         TEXT NOT NULL,
          status              TEXT NOT NULL CHECK (status IN ('active', 'removed')),
          first_activated_at  TEXT NOT NULL,
          last_issued_at      TEXT NOT NULL,
          UNIQUE (license_id, device_id)
        ) STRICT;

        CREATE TABLE issued_licenses (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          license_id   TEXT NOT NULL REFERENCES licenses (id),
          device_row   INTEGER NOT NULL REFERENCES devices (id),
          serial       INTEGER NOT NULL,
          valid_until  TEXT NOT NULL,
          issued_at    TEXT NOT NULL,
          UNIQUE (license_id, serial)
        ) STRICT;

        CREATE TABLE events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          at          TEXT NOT NULL,
          license_id  TEXT,
          kind        TEXT NOT NULL,
          details     TEXT NOT NULL DEFAULT ''
        ) STRICT;

        CREATE INDEX idx_events_license ON events (license_id, at);
      `);
    },
  },
];
