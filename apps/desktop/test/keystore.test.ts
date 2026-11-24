import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KeyFileMissingError, KeyFileUnreadableError, loadOrCreateDatabaseKey } from '../src/main/db/keystore';
import { fakeProtector, tempDir } from './helpers';

describe('database keystore', () => {
  let dir: ReturnType<typeof tempDir>;
  let keyPath: string;
  let databasePath: string;

  beforeEach(() => {
    dir = tempDir();
    keyPath = join(dir.path, 'keys', 'database.key');
    databasePath = join(dir.path, 'data', 'nexodesk.db');
  });
  afterEach(() => dir.cleanup());

  it('creates a 256-bit key on first run and returns the same key afterwards', () => {
    const protector = fakeProtector();
    const first = loadOrCreateDatabaseKey({ keyPath, databasePath, protector });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(keyPath)).toBe(true);
    expect(loadOrCreateDatabaseKey({ keyPath, databasePath, protector })).toBe(first);
  });

  it('never stores the key in plain text', () => {
    const key = loadOrCreateDatabaseKey({ keyPath, databasePath, protector: fakeProtector() });
    expect(readFileSync(keyPath, 'utf8')).not.toContain(key);
  });

  it('refuses to create a new key when the database already exists', () => {
    const existingDatabase = join(dir.path, 'existing.db');
    writeFileSync(existingDatabase, 'business data');
    expect(() =>
      loadOrCreateDatabaseKey({ keyPath, databasePath: existingDatabase, protector: fakeProtector() }),
    ).toThrow(KeyFileMissingError);
    expect(existsSync(keyPath)).toBe(false);
  });

  it('cannot read a key file copied to another machine', () => {
    loadOrCreateDatabaseKey({ keyPath, databasePath, protector: fakeProtector(0x11) });
    expect(() => loadOrCreateDatabaseKey({ keyPath, databasePath, protector: fakeProtector(0x22) })).toThrow(
      KeyFileUnreadableError,
    );
  });

  it('rejects a tampered key file', () => {
    loadOrCreateDatabaseKey({ keyPath, databasePath, protector: fakeProtector() });
    const content = JSON.parse(readFileSync(keyPath, 'utf8'));
    content.sealed = Buffer.from('short').toString('base64');
    writeFileSync(keyPath, JSON.stringify(content));
    expect(() => loadOrCreateDatabaseKey({ keyPath, databasePath, protector: fakeProtector() })).toThrow(
      KeyFileUnreadableError,
    );
  });
});
