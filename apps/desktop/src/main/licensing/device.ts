import { publicKeyToText } from '@nexodesk/licensing';
import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { SecretProtector } from '../db/keystore';

const run = promisify(execFile);

export interface DeviceIdentity {
  /** SHA-256 of stable hardware and Windows identifiers. Survives app reinstalls. */
  deviceId: string;
  privateKey: KeyObject;
  publicKeyText: string;
  machineName: string;
}

export function computeDeviceId(sources: string[]): string {
  return createHash('sha256').update('nexodesk-device-v1').update(sources.join('|')).digest('hex');
}

async function windowsSources(): Promise<string[]> {
  const { stdout: guid } = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
    windowsHide: true,
  });
  const machineGuid = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(guid)?.[1];
  if (!machineGuid) throw new Error('Windows machine id could not be read');
  let board = '';
  try {
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_BaseBoard).SerialNumber'],
      { windowsHide: true, timeout: 15000 },
    );
    board = stdout.trim();
  } catch {
    // Some PCs do not report a board serial; the Windows machine id alone is then used.
  }
  return [machineGuid.toLowerCase(), board];
}

/** Stable identifiers for this computer. The drive serial is left out so a new SSD keeps the licence. */
export async function readDeviceSources(): Promise<string[]> {
  if (process.platform === 'win32') return windowsSources();
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    if (existsSync(path)) return [readFileSync(path, 'utf8').trim()];
  }
  if (process.platform === 'darwin') {
    const { stdout } = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const uuid = /"IOPlatformUUID" = "([^"]+)"/.exec(stdout)?.[1];
    if (uuid) return [uuid];
  }
  throw new Error('This computer could not be identified.');
}

const DEVICE_KEY_MAGIC = 'NDDEVKEY1';

/**
 * The device key pair proves a licence is used on the computer it was issued
 * for. Its private key is sealed with Windows DPAPI, so copying the key file
 * to another computer does not work.
 */
export function loadOrCreateDeviceKey(options: {
  keyPath: string;
  protector: SecretProtector;
}): { privateKey: KeyObject; publicKeyText: string } {
  const { keyPath, protector } = options;
  if (existsSync(keyPath)) {
    const content = JSON.parse(readFileSync(keyPath, 'utf8')) as { magic: string; sealed: string };
    if (content.magic !== DEVICE_KEY_MAGIC) throw new Error('Unrecognised device key file');
    const pem = protector.unprotect(Buffer.from(content.sealed, 'base64')).toString('utf8');
    const privateKey = createPrivateKey(pem);
    return { privateKey, publicKeyText: publicKeyToText(createPublicKey(privateKey)) };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  mkdirSync(dirname(keyPath), { recursive: true });
  const temp = `${keyPath}.tmp`;
  writeFileSync(
    temp,
    JSON.stringify({ magic: DEVICE_KEY_MAGIC, sealed: protector.protect(Buffer.from(pem, 'utf8')).toString('base64') }),
  );
  renameSync(temp, keyPath);
  return { privateKey, publicKeyText: publicKeyToText(publicKey) };
}

export async function loadDeviceIdentity(options: { keyPath: string; protector: SecretProtector }): Promise<DeviceIdentity> {
  const sources = await readDeviceSources();
  let key: { privateKey: KeyObject; publicKeyText: string };
  try {
    key = loadOrCreateDeviceKey(options);
  } catch {
    // An unreadable key (copied from another PC or another Windows user) is replaced; any licence bound to it stops working.
    const backup = `${options.keyPath}.unreadable-${Date.now()}`;
    renameSync(options.keyPath, backup);
    key = loadOrCreateDeviceKey(options);
  }
  return { deviceId: computeDeviceId(sources), machineName: hostname(), ...key };
}
