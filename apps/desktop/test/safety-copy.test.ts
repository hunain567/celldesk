import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVerifiedSafetyCopy, SafetyCopyFailedError } from '../src/main/db/bootstrap';
import { openDatabase } from '../src/main/db/connection';
import { tempDir, TEST_KEY } from './helpers';

describe('verified safety copy', () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.cleanup());

  it('produces an encrypted, readable copy of the live database', () => {
    const db = openDatabase(join(dir.path, 'live.db'), TEST_KEY);
    db.exec('CREATE TABLE sales (id INTEGER PRIMARY KEY, total INTEGER)');
    const insert = db.prepare('INSERT INTO sales (total) VALUES (?)');
    for (let i = 0; i < 500; i += 1) insert.run(i * 100);

    const path = createVerifiedSafetyCopy(db, TEST_KEY, join(dir.path, 'safety'), 'pre-migration-v1');
    db.close();

    const copy = openDatabase(path, TEST_KEY, { readonly: true });
    expect(copy.prepare('SELECT count(*) AS n, sum(total) AS s FROM sales').get()).toEqual({ n: 500, s: 12475000 });
    copy.close();
    expect(() => openDatabase(path, 'c'.repeat(64), { readonly: true })).toThrow();
  });

  it('removes the partial file and reports failure when the copy cannot be written', () => {
    const db = openDatabase(join(dir.path, 'live.db'), TEST_KEY);
    db.exec('CREATE TABLE t (v INTEGER)');
    const safety = join(dir.path, 'safety');
    const now = new Date('2026-11-24T10:00:00Z');
    createVerifiedSafetyCopy(db, TEST_KEY, safety, 'label', now);
    // Same label and time means the target already exists; the existing copy must survive.
    expect(() => createVerifiedSafetyCopy(db, TEST_KEY, safety, 'label', now)).toThrow(SafetyCopyFailedError);
    expect(readdirSync(safety)).toHaveLength(1);
    expect(existsSync(join(safety, readdirSync(safety)[0]!))).toBe(true);
    db.close();
  });
});
