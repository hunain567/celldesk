import { generateSigningKeyPair } from '@nexodesk/licensing';
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DatabaseOpenError, openDatabase, type SqliteDatabase } from '@desktop-main/db/connection';
import { migrate } from '@desktop-main/db/migrator';
import { lmMigrations } from './migrations';

/**
 * The License Manager's data is encrypted with a key derived from the master
 * password. Nothing about the password is stored: a wrong password simply
 * fails to decrypt the database. The salt lives in vault.json next to it.
 */

export const MIN_MASTER_PASSWORD = 12;
const KDF = { N: 2 ** 17, r: 8, p: 1 };

const VaultFileSchema = z.object({
  format: z.literal(1),
  salt: z.string(),
  N: z.number(),
  r: z.number(),
  p: z.number(),
  createdAt: z.string(),
});

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export interface VaultPaths {
  directory: string;
  vaultFile: string;
  databaseFile: string;
}

export function vaultPaths(directory: string): VaultPaths {
  return { directory, vaultFile: join(directory, 'vault.json'), databaseFile: join(directory, 'license-manager.db') };
}

export function vaultExists(paths: VaultPaths): boolean {
  return existsSync(paths.vaultFile) && existsSync(paths.databaseFile);
}

function deriveKey(password: string, vault: z.infer<typeof VaultFileSchema>): string {
  return scryptSync(password.normalize('NFKC'), Buffer.from(vault.salt, 'base64'), 32, {
    N: vault.N,
    r: vault.r,
    p: vault.p,
    maxmem: 256 * 1024 * 1024,
  }).toString('hex');
}

/** First run: creates the encrypted database and the NexoERP signing key. */
export function createVault(
  paths: VaultPaths,
  password: string,
  options: { appVersion: string; kdf?: { N: number; r: number; p: number }; now?: Date },
): SqliteDatabase {
  if (password.length < MIN_MASTER_PASSWORD) {
    throw new VaultError(`The master password must have at least ${MIN_MASTER_PASSWORD} characters.`);
  }
  if (existsSync(paths.vaultFile) || existsSync(paths.databaseFile)) {
    throw new VaultError('A License Manager database already exists in this folder.');
  }
  mkdirSync(paths.directory, { recursive: true });
  const now = options.now ?? new Date();
  const vault = { format: 1 as const, salt: randomBytes(16).toString('base64'), ...(options.kdf ?? KDF), createdAt: now.toISOString() };

  const db = openDatabase(paths.databaseFile, deriveKey(password, vault));
  try {
    migrate(db, lmMigrations, { appVersion: options.appVersion });
    const keys = generateSigningKeyPair();
    db.prepare('INSERT INTO vendor_key (id, private_key_pem, public_key_pem, created_at) VALUES (1, ?, ?, ?)').run(
      keys.privateKeyPem,
      keys.publicKeyPem,
      now.toISOString(),
    );
  } catch (error) {
    db.close();
    throw error;
  }
  const temp = `${paths.vaultFile}.tmp`;
  writeFileSync(temp, JSON.stringify(vault, null, 2), 'utf8');
  renameSync(temp, paths.vaultFile);
  return db;
}

export function unlockVault(paths: VaultPaths, password: string, options: { appVersion: string }): SqliteDatabase {
  if (!vaultExists(paths)) throw new VaultError('No License Manager database was found.');
  const vault = VaultFileSchema.parse(JSON.parse(readFileSync(paths.vaultFile, 'utf8')));
  let db: SqliteDatabase;
  try {
    db = openDatabase(paths.databaseFile, deriveKey(password, vault));
  } catch (error) {
    if (error instanceof DatabaseOpenError) throw new VaultError('The master password is not correct.');
    throw error;
  }
  migrate(db, lmMigrations, { appVersion: options.appVersion });
  return db;
}
