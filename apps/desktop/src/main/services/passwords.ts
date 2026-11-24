import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password and PIN hashing with scrypt (memory-hard, built into Node.js).
 * Stored as "scrypt$N$r$p$salt$hash" so the cost can be raised later while
 * old hashes keep working.
 */

export interface HashCost {
  N: number;
  r: number;
  p: number;
}

/** About a quarter of a second on an ordinary shop PC. */
export const DEFAULT_HASH_COST: HashCost = { N: 2 ** 15, r: 8, p: 1 };

function derive(secret: string, salt: Buffer, cost: HashCost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret.normalize('NFKC'), salt, 32, { ...cost, maxmem: 128 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashSecret(secret: string, cost: HashCost = DEFAULT_HASH_COST): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(secret, salt, cost);
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !N || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(secret, Buffer.from(salt, 'base64'), { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
