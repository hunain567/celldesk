import {
  decodeLicense,
  encodeActivationRequest,
  generateSigningKeyPair,
  privateKeyFromPem,
  publicKeyFromPem,
  publicKeyToText,
} from '@nexodesk/licensing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lmContract } from '../src/shared/contract';
import { LM_CHANNEL_NAMES } from '../src/shared/channels';
import { LicenseRegistry, RegistryError } from '../src/main/registry';
import { createVault, unlockVault, VaultError, vaultPaths } from '../src/main/vault';
import type { SqliteDatabase } from '@desktop-main/db/connection';

const FAST_KDF = { N: 2 ** 12, r: 8, p: 1 };
const PASSWORD = 'nexoerp master password';

function shopPc(name: string, deviceSeed: string) {
  const keys = generateSigningKeyPair();
  const privateKey = privateKeyFromPem(keys.privateKeyPem);
  const publicKeyText = publicKeyToText(publicKeyFromPem(keys.publicKeyPem));
  const deviceId = deviceSeed.padEnd(64, '0').slice(0, 64);
  return {
    deviceId,
    publicKeyText,
    request: (latestTimeSeen = '2026-11-24T05:00:00.000Z') =>
      encodeActivationRequest(
        {
          format: 1,
          kind: 'activation-request',
          deviceId,
          devicePublicKey: publicKeyText,
          installId: `install-${name}`,
          machineName: name,
          appVersion: '0.1.0',
          latestTimeSeen,
          createdAt: '2026-11-24T05:00:00.000Z',
        },
        privateKey,
      ),
  };
}

describe('License Manager', () => {
  let dir: string;
  let db: SqliteDatabase;
  let registry: LicenseRegistry;
  let clock: { now: Date };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexodesk-lm-'));
    clock = { now: new Date('2026-11-24T06:00:00Z') };
    db = createVault(vaultPaths(join(dir, 'vault')), PASSWORD, { appVersion: '0.1.0', kdf: FAST_KDF, now: clock.now });
    registry = new LicenseRegistry(db, () => clock.now);
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      // Already closed in a test.
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const newLicense = (overrides: Partial<Parameters<LicenseRegistry['createLicense']>[0]> = {}) =>
    registry.createLicense({
      shopName: 'Madina Mobile',
      ownerName: 'Usman',
      phone: '0300-0000000',
      city: 'Lahore',
      plan: 'monthly',
      validFrom: '2026-11-24',
      deviceLimit: 1,
      graceDays: 3,
      notes: '',
      ...overrides,
    });

  it('preload channel list matches the contract', () => {
    expect([...LM_CHANNEL_NAMES].sort()).toEqual(Object.keys(lmContract).sort());
  });

  it('opens only with the right master password and keeps the same signing key', () => {
    const publicKey = registry.publicKeyPem();
    db.close();
    const paths = vaultPaths(join(dir, 'vault'));
    expect(() => unlockVault(paths, 'wrong password!!', { appVersion: '0.1.0' })).toThrow(VaultError);
    db = unlockVault(paths, PASSWORD, { appVersion: '0.1.0' });
    expect(new LicenseRegistry(db).publicKeyPem()).toBe(publicKey);
  });

  it('refuses a short master password', () => {
    expect(() => createVault(vaultPaths(join(dir, 'other')), 'short', { appVersion: '0.1.0', kdf: FAST_KDF })).toThrow(/at least 12/);
  });

  it('issues a licence that NexoDesk accepts, bound to the requesting computer', () => {
    const id = newLicense();
    const pc = shopPc('SHOP-PC', 'aa');
    const preview = registry.previewRequest(pc.request());
    expect(preview).toMatchObject({ machineName: 'SHOP-PC', knownLicenseId: null, clockAhead: false });

    const issued = registry.issueForRequest(id, pc.request());
    expect(issued.fileName.endsWith('.ndlic')).toBe(true);
    const certificate = decodeLicense(issued.code, publicKeyFromPem(registry.publicKeyPem()));
    expect(certificate).toMatchObject({ licenseId: id, serial: 1, deviceId: pc.deviceId, devicePublicKey: pc.publicKeyText });
    // Monthly from 24 Nov ends at the end of 23 Dec, local time.
    expect(new Date(certificate.validUntil)).toEqual(new Date('2026-12-23T23:59:59.999+05:00'));
    expect(registry.previewRequest(pc.request()).knownLicenseId).toBe(id);
  });

  it('enforces the device limit and frees a slot when a computer is removed', () => {
    const id = newLicense({ deviceLimit: 1 });
    registry.issueForRequest(id, shopPc('PC-1', 'aa').request());
    expect(() => registry.issueForRequest(id, shopPc('PC-2', 'bb').request())).toThrow(/allows 1 computer/);
    const deviceRow = registry.detail(id).devices[0]!.id;
    registry.removeDevice(deviceRow);
    expect(() => registry.issueForRequest(id, shopPc('PC-2', 'bb').request())).not.toThrow();
  });

  it('keeps the slot when the same computer is activated again after a reinstall', () => {
    const id = newLicense({ deviceLimit: 1 });
    registry.issueForRequest(id, shopPc('PC-1', 'aa').request());
    const reinstalled = shopPc('PC-1', 'aa'); // same device id, new device key
    const issued = registry.issueForRequest(id, reinstalled.request());
    const certificate = decodeLicense(issued.code, publicKeyFromPem(registry.publicKeyPem()));
    expect(certificate.devicePublicKey).toBe(reinstalled.publicKeyText);
    expect(certificate.serial).toBe(2);
    expect(registry.detail(id).devices).toHaveLength(1);
  });

  it('extends from the current end date and issues renewal files without a new request', () => {
    const id = newLicense({ plan: 'monthly' });
    registry.issueForRequest(id, shopPc('PC-1', 'aa').request());
    registry.extend(id, 'six-months');
    const detail = registry.detail(id);
    expect(new Date(detail.validUntil)).toEqual(new Date('2027-06-23T23:59:59.999+05:00'));
    const renewal = registry.issueForDevice(id, detail.devices[0]!.id);
    expect(decodeLicense(renewal.code, publicKeyFromPem(registry.publicKeyPem())).serial).toBe(2);
    expect(detail.events.map((event) => event.kind)).toEqual(['extended', 'activated', 'created']);
  });

  it('extends an expired licence from today', () => {
    const id = newLicense({ plan: 'monthly', validFrom: '2026-01-01' });
    registry.extend(id, 'monthly');
    expect(new Date(registry.detail(id).validUntil)).toEqual(new Date('2026-12-23T23:59:59.999+05:00'));
  });

  it('will not issue files for suspended, revoked or expired licences', () => {
    const suspended = newLicense();
    registry.setStatus(suspended, 'suspended');
    expect(() => registry.issueForRequest(suspended, shopPc('PC', 'aa').request())).toThrow(/suspended/);
    registry.setStatus(suspended, 'active');
    expect(() => registry.issueForRequest(suspended, shopPc('PC', 'aa').request())).not.toThrow();

    const revoked = newLicense();
    registry.setStatus(revoked, 'revoked');
    expect(() => registry.setStatus(revoked, 'active')).toThrow(RegistryError);
    expect(registry.revokedIds()).toEqual([revoked]);

    const expired = newLicense({ validFrom: '2026-01-01' });
    expect(() => registry.issueForRequest(expired, shopPc('PC', 'cc').request())).toThrow(/expired/);
  });

  it('flags a shop computer whose clock is far ahead', () => {
    expect(registry.previewRequest(shopPc('PC', 'aa').request('2031-01-01T00:00:00.000Z')).clockAhead).toBe(true);
  });

  it('rejects a request that was edited', () => {
    const code = shopPc('PC', 'aa').request();
    const tampered = code.slice(0, 30) + (code[30] === 'A' ? 'B' : 'A') + code.slice(31);
    expect(() => registry.previewRequest(tampered)).toThrow(RegistryError);
  });

  it('supports a custom period', () => {
    const id = newLicense({ plan: 'custom', customUntil: '2027-03-31' });
    expect(new Date(registry.detail(id).validUntil)).toEqual(new Date('2027-03-31T23:59:59.999+05:00'));
    expect(() => newLicense({ plan: 'custom' })).toThrow(/last day/);
  });

  it('summarises licences for the dashboard', () => {
    newLicense();
    newLicense({ validFrom: '2026-01-01' });
    clock.now = new Date('2026-12-20T06:00:00Z');
    expect(registry.dashboard()).toMatchObject({ activeLicenses: 1, expiringSoon: 1, expired: 1 });
  });
});
