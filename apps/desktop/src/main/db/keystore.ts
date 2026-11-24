import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Encrypts and decrypts small secrets with an operating-system facility.
 * On Windows the production implementation is Electron safeStorage (DPAPI),
 * which ties the secret to the current Windows user on this PC.
 */
export interface SecretProtector {
  /** True when the protection is backed by the operating system. */
  readonly isOsBacked: boolean;
  protect(plain: Buffer): Buffer;
  unprotect(sealed: Buffer): Buffer;
}

export class KeyFileMissingError extends Error {
  constructor(readonly keyPath: string) {
    super(
      'The database exists but its encryption key file is missing. ' +
        'The data cannot be opened without it. Restore the key file or restore from a backup.',
    );
    this.name = 'KeyFileMissingError';
  }
}

export class KeyFileUnreadableError extends Error {
  constructor(readonly keyPath: string, cause: unknown) {
    super(
      'The database key file could not be decrypted on this computer or Windows account. ' +
        'Restore from a backup with the recovery password.',
      { cause },
    );
    this.name = 'KeyFileUnreadableError';
  }
}

// File format identifier only (not branding); changing it would make existing key files unreadable.
const KEY_FILE_MAGIC = 'CDKEY1';
const KEY_BYTES = 32;

interface KeyFileContent {
  magic: string;
  osBacked: boolean;
  createdAt: string;
  sealed: string;
}

/**
 * Returns the database key, creating it on first run.
 *
 * A new key is created only when neither the key file nor the database exists.
 * If the database exists without its key, this refuses to create a new key,
 * because that would make the existing data permanently unreadable.
 */
export function loadOrCreateDatabaseKey(options: {
  keyPath: string;
  databasePath: string;
  protector: SecretProtector;
}): string {
  const { keyPath, databasePath, protector } = options;

  if (existsSync(keyPath)) {
    let parsed: KeyFileContent;
    try {
      parsed = JSON.parse(readFileSync(keyPath, 'utf8')) as KeyFileContent;
      if (parsed.magic !== KEY_FILE_MAGIC || typeof parsed.sealed !== 'string') {
        throw new Error('Unrecognised key file format');
      }
      const key = protector.unprotect(Buffer.from(parsed.sealed, 'base64'));
      if (key.length !== KEY_BYTES) throw new Error('Key has an unexpected length');
      return key.toString('hex');
    } catch (error) {
      throw new KeyFileUnreadableError(keyPath, error);
    }
  }

  if (existsSync(databasePath)) {
    throw new KeyFileMissingError(keyPath);
  }

  const key = randomBytes(KEY_BYTES);
  const content: KeyFileContent = {
    magic: KEY_FILE_MAGIC,
    osBacked: protector.isOsBacked,
    createdAt: new Date().toISOString(),
    sealed: protector.protect(key).toString('base64'),
  };

  mkdirSync(dirname(keyPath), { recursive: true });
  const tempPath = `${keyPath}.tmp`;
  writeFileSync(tempPath, JSON.stringify(content, null, 2), { encoding: 'utf8', flag: 'w' });
  renameSync(tempPath, keyPath);
  return key.toString('hex');
}
