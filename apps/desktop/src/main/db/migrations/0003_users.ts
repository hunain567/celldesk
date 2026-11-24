import type { Migration } from '../migrator';

/** Shop profile and user accounts. Roles and their permissions are defined in code. */
export const migration0003: Migration = {
  version: 3,
  name: 'users',
  up(db) {
    db.exec(`
      CREATE TABLE shop_profile (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        shop_name       TEXT NOT NULL,
        owner_name      TEXT NOT NULL DEFAULT '',
        phone           TEXT NOT NULL DEFAULT '',
        address         TEXT NOT NULL DEFAULT '',
        city            TEXT NOT NULL DEFAULT '',
        receipt_footer  TEXT NOT NULL DEFAULT '',
        updated_at      TEXT NOT NULL
      ) STRICT;

      CREATE TABLE users (
        id                    TEXT PRIMARY KEY,
        full_name             TEXT NOT NULL,
        username              TEXT NOT NULL UNIQUE COLLATE NOCASE,
        role                  TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'salesman', 'technician')),
        password_hash         TEXT NOT NULL,
        pin_hash              TEXT,
        is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        must_change_password  INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
        failed_attempts       INTEGER NOT NULL DEFAULT 0,
        locked_until          TEXT,
        last_login_at         TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      ) STRICT;
    `);
  },
};
