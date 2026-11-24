import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackupDamagedError,
  BackupFormatError,
  extractBackupFile,
  readBackupHeader,
  sha256File,
  writeBackupFile,
} from '../src/main/backup/format';
import { generateBackupKey, keyId, unwrapKey, validateRecoveryPassword, WrongRecoveryPasswordError, wrapKey } from '../src/main/backup/keys';
import { openDatabase } from '../src/main/db/connection';
import { TEST_KDF } from './backup-env';
import { tempDir, TEST_KEY } from './helpers';

describe('recovery password key wrapping', () => {
  it('unwraps with the right password and refuses a wrong one', () => {
    const key = generateBackupKey();
    const wrapped = wrapKey(key, 'correct horse battery', TEST_KDF);
    expect(unwrapKey(wrapped, 'correct horse battery').equals(key)).toBe(true);
    expect(() => unwrapKey(wrapped, 'correct horse batterY')).toThrow(WrongRecoveryPasswordError);
  });

  it('requires at least 8 characters', () => {
    expect(validateRecoveryPassword('short')).toMatch(/at least 8/);
    expect(validateRecoveryPassword('long enough')).toBeNull();
  });
});

describe('.ndbak file format', () => {
  let dir: ReturnType<typeof tempDir>;
  let databasePath: string;
  let backupKey: Buffer;
  let manifest: Parameters<typeof writeBackupFile>[0]['manifest'];

  beforeEach(async () => {
    dir = tempDir();
    databasePath = join(dir.path, 'snapshot.db');
    const db = openDatabase(databasePath, TEST_KEY);
    db.exec('CREATE TABLE t (v BLOB)');
    const insert = db.prepare('INSERT INTO t VALUES (?)');
    for (let i = 0; i < 200; i += 1) insert.run(randomBytes(512));
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
    db.close();
    backupKey = generateBackupKey();
    manifest = {
      databaseKeyHex: TEST_KEY,
      databaseSha256: await sha256File(databasePath),
      databaseSizeBytes: statSync(databasePath).size,
      tableCounts: { t: 200 },
    };
  });
  afterEach(() => dir.cleanup());

  async function write(target: string) {
    return writeBackupFile({
      target,
      databasePath,
      backupKey,
      manifest,
      header: {
        createdAt: '2026-11-24T16:00:00.000Z',
        appVersion: '0.1.0',
        schemaVersion: 2,
        installId: 'install-1',
        kind: 'manual',
        keyId: keyId(backupKey),
        recovery: wrapKey(backupKey, 'recovery-pass', TEST_KDF),
      },
    });
  }

  it('round-trips the exact database bytes', async () => {
    const file = join(dir.path, 'a.ndbak');
    await write(file);
    const out = join(dir.path, 'restored.db');
    const result = await extractBackupFile({ path: file, backupKey, outputDatabasePath: out });
    expect(result.manifest.tableCounts).toEqual({ t: 200 });
    expect(await sha256File(out)).toBe(manifest.databaseSha256);
  });

  it('shows header details without any key', async () => {
    const file = join(dir.path, 'a.ndbak');
    await write(file);
    const { header } = await readBackupHeader(file);
    expect(header).toMatchObject({ product: 'NexoDesk', kind: 'manual', schemaVersion: 2, installId: 'install-1' });
  });

  it('never stores the database in readable form', async () => {
    const file = join(dir.path, 'a.ndbak');
    await write(file);
    expect(readFileSync(file).includes(Buffer.from(TEST_KEY))).toBe(false);
  });

  it('refuses to overwrite an existing file', async () => {
    const file = join(dir.path, 'a.ndbak');
    writeFileSync(file, 'existing');
    await expect(write(file)).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('existing');
  });

  it('detects a single changed byte anywhere in the file', async () => {
    const file = join(dir.path, 'a.ndbak');
    await write(file);
    const original = readFileSync(file);
    const positions = [20, Math.floor(original.length / 2), original.length - 5];
    for (const [index, position] of positions.entries()) {
      const damaged = Buffer.from(original);
      damaged[position] = damaged[position]! ^ 0x01;
      const copy = join(dir.path, `damaged-${index}.ndbak`);
      writeFileSync(copy, damaged);
      const out = join(dir.path, `out-${index}.db`);
      await expect(extractBackupFile({ path: copy, backupKey, outputDatabasePath: out })).rejects.toBeInstanceOf(Error);
      expect(existsSync(out)).toBe(false);
    }
  });

  it('rejects a truncated file and a wrong key', async () => {
    const file = join(dir.path, 'a.ndbak');
    await write(file);
    const truncated = join(dir.path, 'truncated.ndbak');
    writeFileSync(truncated, readFileSync(file).subarray(0, statSync(file).size - 1000));
    await expect(
      extractBackupFile({ path: truncated, backupKey, outputDatabasePath: join(dir.path, 'o1.db') }),
    ).rejects.toBeInstanceOf(BackupDamagedError);
    await expect(
      extractBackupFile({ path: file, backupKey: generateBackupKey(), outputDatabasePath: join(dir.path, 'o2.db') }),
    ).rejects.toBeInstanceOf(BackupDamagedError);
  });

  it('rejects files that are not NexoDesk backups', async () => {
    const other = join(dir.path, 'photo.ndbak');
    writeFileSync(other, randomBytes(4096));
    await expect(readBackupHeader(other)).rejects.toBeInstanceOf(BackupFormatError);
  });
});
