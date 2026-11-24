import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapDatabase, resolveDataLocations } from '../src/main/db/bootstrap';
import { checkIntegrity, DatabaseOpenError, openDatabase } from '../src/main/db/connection';
import { migrations } from '../src/main/db/migrations';
import {
  getSchemaVersion,
  migrate,
  MigrationFailedError,
  SchemaTooNewError,
  type Migration,
} from '../src/main/db/migrator';
import { fakeProtector, tempDir, TEST_KEY } from './helpers';

describe('encrypted database', () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.cleanup());

  it('cannot be read without the key', () => {
    const path = join(dir.path, 'shop.db');
    const db = openDatabase(path, TEST_KEY);
    db.exec('CREATE TABLE t (v TEXT); INSERT INTO t VALUES (\'secret\')');
    db.close();

    const plain = new Database(path);
    expect(() => plain.prepare('SELECT * FROM t').all()).toThrow();
    plain.close();

    expect(() => openDatabase(path, 'b'.repeat(64))).toThrow(DatabaseOpenError);
    const reopened = openDatabase(path, TEST_KEY);
    expect(reopened.prepare('SELECT v FROM t').get()).toEqual({ v: 'secret' });
    reopened.close();
  });

  it('rejects malformed keys before touching the file', () => {
    expect(() => openDatabase(join(dir.path, 'x.db'), "abc'; DROP TABLE t; --")).toThrow(DatabaseOpenError);
  });
});

describe('migrations', () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.cleanup());

  const extra = (version: number, sql: string): Migration => ({ version, name: `m${version}`, up: (db) => db.exec(sql) });

  it('applies every shipped migration to a new database and records them', () => {
    const db = openDatabase(join(dir.path, 'a.db'), TEST_KEY);
    const result = migrate(db, migrations, { appVersion: '0.1.0' });
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(migrations.length);
    expect(getSchemaVersion(db)).toBe(migrations.length);
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: migrations.length });
    expect(checkIntegrity(db).ok).toBe(true);
    db.close();
  });

  it('does nothing when already up to date', () => {
    const db = openDatabase(join(dir.path, 'b.db'), TEST_KEY);
    migrate(db, migrations, { appVersion: '0.1.0' });
    const again = migrate(db, migrations, { appVersion: '0.1.0' });
    expect(again.applied).toEqual([]);
    db.close();
  });

  it('rolls back every step when one migration fails', () => {
    const db = openDatabase(join(dir.path, 'c.db'), TEST_KEY);
    migrate(db, migrations, { appVersion: '0.1.0' });
    const base = migrations.length;
    const broken = [
      ...migrations,
      extra(base + 1, 'CREATE TABLE good_step (id INTEGER)'),
      extra(base + 2, 'CREATE TABLE broken ('),
    ];
    expect(() => migrate(db, broken, { appVersion: '0.2.0', createSafetyCopy: () => 'copy.db' })).toThrow(
      MigrationFailedError,
    );
    expect(getSchemaVersion(db)).toBe(base);
    const table = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'good_step'`).get();
    expect(table).toBeUndefined();
    db.close();
  });

  it('refuses to touch a database from a newer app version', () => {
    const db = openDatabase(join(dir.path, 'd.db'), TEST_KEY);
    db.pragma('user_version = 99');
    expect(() => migrate(db, migrations, { appVersion: '0.1.0' })).toThrow(SchemaTooNewError);
    expect(getSchemaVersion(db)).toBe(99);
    db.close();
  });

  it('stops the upgrade if the safety copy cannot be made', () => {
    const db = openDatabase(join(dir.path, 'e.db'), TEST_KEY);
    migrate(db, migrations, { appVersion: '0.1.0' });
    const next = [...migrations, extra(migrations.length + 1, 'CREATE TABLE later (id INTEGER)')];
    expect(() =>
      migrate(db, next, {
        appVersion: '0.2.0',
        createSafetyCopy: () => {
          throw new Error('disk full');
        },
      }),
    ).toThrow('disk full');
    expect(getSchemaVersion(db)).toBe(migrations.length);
    db.close();
  });

  it('rejects migration lists with gaps', () => {
    const db = openDatabase(join(dir.path, 'f.db'), TEST_KEY);
    expect(() => migrate(db, [extra(2, 'SELECT 1')], { appVersion: '0.1.0' })).toThrow(/without gaps/);
    db.close();
  });
});

describe('bootstrap', () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.cleanup());

  it('creates the database, key and a permanent install id', () => {
    const locations = resolveDataLocations(dir.path);
    const first = bootstrapDatabase({ locations, protector: fakeProtector(), appVersion: '0.1.0' });
    const installId = first.installId;
    first.db.close();

    expect(existsSync(locations.databasePath)).toBe(true);
    expect(existsSync(locations.keyPath)).toBe(true);

    const second = bootstrapDatabase({ locations, protector: fakeProtector(), appVersion: '0.1.0' });
    expect(second.installId).toBe(installId);
    expect(second.migration.applied).toEqual([]);
    second.db.close();
  });

  it('makes no safety copy for a brand-new database', () => {
    const locations = resolveDataLocations(dir.path);
    const result = bootstrapDatabase({ locations, protector: fakeProtector(), appVersion: '0.1.0' });
    expect(result.migration.safetyCopyPath).toBeNull();
    expect(existsSync(locations.safetyDirectory) ? readdirSync(locations.safetyDirectory) : []).toEqual([]);
    result.db.close();
  });
});
