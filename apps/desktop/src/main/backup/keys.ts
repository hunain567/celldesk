import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { z } from 'zod';

/**
 * Key handling for backups.
 *
 * Every backup is encrypted with a random 256-bit backup key. A copy of that
 * key, encrypted with the owner's recovery password, travels inside every
 * backup file so the backup can be restored on another computer.
 */

export const WrappedKeySchema = z.object({
  kdf: z.literal('scrypt'),
  N: z.number().int().positive(),
  r: z.number().int().positive(),
  p: z.number().int().positive(),
  salt: z.string(),
  nonce: z.string(),
  ciphertext: z.string(),
  tag: z.string(),
});
export type WrappedKey = z.infer<typeof WrappedKeySchema>;

export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

/** Production cost: about half a second on an ordinary shop PC. */
export const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 };

export const MIN_RECOVERY_PASSWORD_LENGTH = 8;

export class WrongRecoveryPasswordError extends Error {
  constructor() {
    super('The recovery password is not correct.');
    this.name = 'WrongRecoveryPasswordError';
  }
}

export function generateBackupKey(): Buffer {
  return randomBytes(32);
}

/** Short public fingerprint of a key, used to tell whether this PC can open a backup without the password. */
export function keyId(key: Buffer): string {
  return createHash('sha256').update('nexodesk-backup-key').update(key).digest('hex').slice(0, 16);
}

function deriveKek(password: string, salt: Buffer, params: KdfParams): Buffer {
  return scryptSync(password.normalize('NFKC'), salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  });
}

export function validateRecoveryPassword(password: string): string | null {
  if (password.length < MIN_RECOVERY_PASSWORD_LENGTH) {
    return `The recovery password must have at least ${MIN_RECOVERY_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

export function wrapKey(key: Buffer, password: string, params: KdfParams = DEFAULT_KDF): WrappedKey {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKek(password, salt, params), nonce);
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  return {
    kdf: 'scrypt',
    ...params,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function unwrapKey(wrapped: WrappedKey, password: string): Buffer {
  try {
    const kek = deriveKek(password, Buffer.from(wrapped.salt, 'base64'), wrapped);
    const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(wrapped.nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
    const key = Buffer.concat([decipher.update(Buffer.from(wrapped.ciphertext, 'base64')), decipher.final()]);
    if (key.length !== 32) throw new Error('unexpected key length');
    return key;
  } catch {
    throw new WrongRecoveryPasswordError();
  }
}
