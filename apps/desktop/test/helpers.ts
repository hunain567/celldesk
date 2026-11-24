import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SecretProtector } from '../src/main/db/keystore';

/** Reversible stand-in for DPAPI: XOR with a per-"machine" byte. */
export function fakeProtector(machineByte = 0x5a): SecretProtector {
  const flip = (input: Buffer) => Buffer.from(input.map((byte) => byte ^ machineByte));
  return {
    isOsBacked: true,
    protect: (plain) => Buffer.concat([Buffer.from([machineByte]), flip(plain)]),
    unprotect: (sealed) => {
      if (sealed[0] !== machineByte) throw new Error('Sealed on a different machine');
      return flip(sealed.subarray(1));
    },
  };
}

export function tempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'celldesk-test-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export const TEST_KEY = 'a'.repeat(64);
