import { safeStorage } from 'electron';
import type { SecretProtector } from '../db/keystore';

/**
 * Electron safeStorage protector. On Windows this is DPAPI: the secret can only
 * be decrypted by the same Windows user on the same PC.
 *
 * When the OS facility is unavailable (only possible on some Linux development
 * setups) a development build may continue with an unprotected key; a packaged
 * build refuses to start.
 */
export function createSecretProtector(options: { allowUnprotected: boolean }): SecretProtector {
  if (safeStorage.isEncryptionAvailable()) {
    return {
      isOsBacked: true,
      protect: (plain) => safeStorage.encryptString(plain.toString('base64')),
      unprotect: (sealed) => Buffer.from(safeStorage.decryptString(sealed), 'base64'),
    };
  }
  if (!options.allowUnprotected) {
    throw new Error('Windows data protection is not available, so NexoDesk cannot store its keys securely.');
  }
  return {
    isOsBacked: false,
    protect: (plain) => Buffer.from(plain),
    unprotect: (sealed) => Buffer.from(sealed),
  };
}
