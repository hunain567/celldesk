import {
  decodeActivationRequest,
  decodeLicense,
  encodeLicense,
  evaluateLicense,
  generateSigningKeyPair,
  LicenseCodeError,
  planEnd,
  privateKeyFromPem,
  publicKeyFromPem,
  type LicenseCertificate,
} from '@nexodesk/licensing';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../src/main/db/connection';
import { migrations } from '../src/main/db/migrations';
import { migrate } from '../src/main/db/migrator';
import { AppError } from '../src/main/errors';
import { ClockGuard, DatabaseTimeStore, SealedFileTimeStore } from '../src/main/licensing/clock';
import { computeDeviceId, loadOrCreateDeviceKey, type DeviceIdentity } from '../src/main/licensing/device';
import { LicenseService } from '../src/main/licensing/service';
import { AuditLog } from '../src/main/services/audit';
import { fakeProtector, tempDir, TEST_KEY } from './helpers';

const DAY = 24 * 60 * 60 * 1000;
const vendor = generateSigningKeyPair();
const vendorPrivate = privateKeyFromPem(vendor.privateKeyPem);
const vendorPublic = publicKeyFromPem(vendor.publicKeyPem);

function certificateFor(device: DeviceIdentity, overrides: Partial<LicenseCertificate> = {}): LicenseCertificate {
  return {
    format: 1,
    kind: 'license',
    licenseId: 'LIC-0001',
    serial: 1,
    shopName: 'Madina Mobile',
    ownerName: 'Usman',
    plan: 'monthly',
    issuedAt: '2026-11-24T05:00:00.000Z',
    validFrom: '2026-11-24T00:00:00.000Z',
    validUntil: '2026-12-23T18:59:59.999Z',
    graceDays: 3,
    deviceId: device.deviceId,
    devicePublicKey: device.publicKeyText,
    ...overrides,
  };
}

describe('licence codes', () => {
  it('rejects a licence that was changed or signed by someone else', () => {
    const dir = tempDir();
    try {
      const key = loadOrCreateDeviceKey({ keyPath: join(dir.path, 'device.key'), protector: fakeProtector() });
      const device = { deviceId: computeDeviceId(['pc-1']), machineName: 'PC-1', ...key };
      const text = encodeLicense(certificateFor(device), vendorPrivate);
      expect(decodeLicense(text, vendorPublic).shopName).toBe('Madina Mobile');

      // Change the expiry date inside the payload and keep the old signature.
      const envelope = JSON.parse(Buffer.from(text.slice(7), 'base64url').toString());
      const payload = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString());
      payload.validUntil = '2099-12-31T00:00:00.000Z';
      envelope.payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const forged = 'NDLIC1.' + Buffer.from(JSON.stringify(envelope)).toString('base64url');
      expect(() => decodeLicense(forged, vendorPublic)).toThrow(/not genuine/);

      const otherVendor = generateSigningKeyPair();
      const fake = encodeLicense(certificateFor(device), privateKeyFromPem(otherVendor.privateKeyPem));
      expect(() => decodeLicense(fake, vendorPublic)).toThrow(LicenseCodeError);
      expect(() => decodeLicense('hello', vendorPublic)).toThrow(/not a NexoDesk licence/);
    } finally {
      dir.cleanup();
    }
  });

  it('computes plan end dates by calendar month', () => {
    const local = (iso: string) => new Date(`${iso}+05:00`);
    expect(planEnd('monthly', local('2026-01-31T00:00:00'))).toEqual(local('2026-02-27T23:59:59.999'));
    expect(planEnd('monthly', local('2026-11-24T00:00:00'))).toEqual(local('2026-12-23T23:59:59.999'));
    expect(planEnd('six-months', local('2026-11-24T00:00:00'))).toEqual(local('2027-05-23T23:59:59.999'));
    expect(planEnd('yearly', local('2026-11-24T00:00:00'))).toEqual(local('2027-11-23T23:59:59.999'));
  });
});

describe('licence evaluation', () => {
  const certificate = {
    format: 1,
    kind: 'license',
    licenseId: 'LIC-1',
    serial: 1,
    shopName: 'Shop',
    ownerName: '',
    plan: 'monthly',
    issuedAt: '2026-11-01T00:00:00.000Z',
    validFrom: '2026-11-01T00:00:00.000Z',
    validUntil: '2026-11-30T23:59:59.999Z',
    graceDays: 3,
    deviceId: 'a'.repeat(64),
    devicePublicKey: 'x'.repeat(44),
  } as LicenseCertificate;
  const at = (iso: string) =>
    evaluateLicense({ certificate, now: new Date(iso), latestTimeSeen: null, revokedLicenseIds: [] });

  it('moves from active to expiring, grace and read-only', () => {
    expect(at('2026-11-10T00:00:00Z')).toMatchObject({ state: 'active', canWrite: true, daysLeft: 21 });
    expect(at('2026-11-26T00:00:00Z')).toMatchObject({ state: 'expiring', canWrite: true });
    expect(at('2026-12-02T00:00:00Z')).toMatchObject({ state: 'grace', canWrite: true });
    expect(at('2026-12-04T00:00:01Z')).toMatchObject({ state: 'expired', canWrite: false });
  });

  it('refuses writes for revoked licences and clocks set before the licence was issued', () => {
    expect(
      evaluateLicense({ certificate, now: new Date('2026-11-10T00:00:00Z'), latestTimeSeen: null, revokedLicenseIds: ['LIC-1'] }),
    ).toMatchObject({ state: 'revoked', canWrite: false });
    expect(at('2026-10-20T00:00:00Z')).toMatchObject({ state: 'clock-problem', canWrite: false });
  });
});

describe('licence on the shop PC', () => {
  let dir: ReturnType<typeof tempDir>;
  let db: SqliteDatabase;
  let clock: { now: Date };
  let device: DeviceIdentity;
  const protector = fakeProtector(0x31);

  const makeService = (options: { device?: DeviceIdentity; vendorKey?: string | null } = {}) =>
    new LicenseService({
      licenseDirectory: join(dir.path, 'license'),
      vendorPublicKeyPem: options.vendorKey === undefined ? vendor.publicKeyPem : options.vendorKey,
      device: options.device ?? device,
      installId: 'install-1',
      appVersion: '0.1.0',
      clock: new ClockGuard([new DatabaseTimeStore(db), new SealedFileTimeStore(join(dir.path, 'keys', 'session.dat'), protector)]),
      revokedLicenseIds: [],
      audit: new AuditLog(db, () => clock.now),
      now: () => clock.now,
    });

  beforeEach(() => {
    dir = tempDir();
    db = openDatabase(join(dir.path, 'shop.db'), TEST_KEY);
    migrate(db, migrations, { appVersion: '0.1.0' });
    clock = { now: new Date('2026-11-24T06:00:00Z') };
    const key = loadOrCreateDeviceKey({ keyPath: join(dir.path, 'keys', 'device.key'), protector });
    device = { deviceId: computeDeviceId(['shop-pc']), machineName: 'SHOP-PC', ...key };
  });
  afterEach(() => {
    db.close();
    dir.cleanup();
  });

  it('starts unlicensed and produces a request the License Manager can verify', () => {
    const service = makeService();
    expect(service.status()).toMatchObject({ state: 'unlicensed', canWrite: false });
    const request = decodeActivationRequest(service.createRequestCode());
    expect(request.deviceId).toBe(device.deviceId);
    expect(request.devicePublicKey).toBe(device.publicKeyText);
  });

  it('activates with a licence issued for this computer', () => {
    const service = makeService();
    const status = service.importLicense(encodeLicense(certificateFor(device), vendorPrivate));
    expect(status).toMatchObject({ state: 'active', canWrite: true, shopName: 'Madina Mobile', planLabel: 'Monthly' });
    expect(() => service.assertCanWrite()).not.toThrow();
    // Survives a restart.
    expect(makeService().status().state).toBe('active');
  });

  it('refuses a licence issued for another computer', () => {
    const other = { ...device, deviceId: computeDeviceId(['other-pc']) };
    expect(() => makeService().importLicense(encodeLicense(certificateFor(other), vendorPrivate))).toThrow(/different computer/);
  });

  it('does not work when the licence and key files are copied to another computer', () => {
    makeService().importLicense(encodeLicense(certificateFor(device), vendorPrivate));
    // On another PC the DPAPI-sealed device key cannot be opened.
    expect(() =>
      loadOrCreateDeviceKey({ keyPath: join(dir.path, 'keys', 'device.key'), protector: fakeProtector(0x77) }),
    ).toThrow();
    // And that PC gets its own key and id, which the copied licence does not match.
    const otherKey = loadOrCreateDeviceKey({ keyPath: join(dir.path, 'other', 'device.key'), protector: fakeProtector(0x77) });
    const otherPc = { deviceId: computeDeviceId(['other-pc']), machineName: 'OTHER', ...otherKey };
    expect(makeService({ device: otherPc }).status()).toMatchObject({ state: 'invalid', canWrite: false });
  });

  it('asks for a new licence after a reinstall that removed the device key', () => {
    makeService().importLicense(encodeLicense(certificateFor(device), vendorPrivate));
    rmSync(join(dir.path, 'keys', 'device.key'));
    const newKey = loadOrCreateDeviceKey({ keyPath: join(dir.path, 'keys', 'device.key'), protector });
    const status = makeService({ device: { ...device, ...newKey } }).status();
    expect(status.state).toBe('invalid');
    expect(status.reason).toMatch(/reinstalled/);
  });

  it('detects a licence file edited on disk', () => {
    makeService().importLicense(encodeLicense(certificateFor(device), vendorPrivate));
    const path = join(dir.path, 'license', 'license.ndlic');
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.slice(0, 40) + (text[40] === 'A' ? 'B' : 'A') + text.slice(41));
    expect(makeService().status()).toMatchObject({ state: 'invalid', canWrite: false });
  });

  it('keeps the newer licence when an older file is imported', () => {
    const service = makeService();
    service.importLicense(encodeLicense(certificateFor(device, { serial: 2, validUntil: '2027-01-23T18:59:59.999Z' }), vendorPrivate));
    expect(() => service.importLicense(encodeLicense(certificateFor(device, { serial: 1 }), vendorPrivate))).toThrow(/older/);
  });

  it('becomes read-only after the grace period, without touching data', () => {
    const service = makeService();
    service.importLicense(encodeLicense(certificateFor(device), vendorPrivate));
    clock.now = new Date('2026-12-25T06:00:00Z');
    expect(service.status()).toMatchObject({ state: 'grace', canWrite: true });
    clock.now = new Date('2026-12-28T06:00:00Z');
    expect(service.status()).toMatchObject({ state: 'expired', canWrite: false });
    expect(() => service.assertCanWrite()).toThrow(AppError);
    expect(db.prepare('SELECT count(*) AS n FROM audit_log').get()).toEqual({ n: 1 });
  });

  it('is not fooled by moving the Windows clock back', () => {
    const service = makeService();
    service.importLicense(encodeLicense(certificateFor(device), vendorPrivate));
    clock.now = new Date('2026-12-20T06:00:00Z');
    service.tick();

    // Owner moves the clock back a month to "extend" the subscription.
    clock.now = new Date('2026-11-25T06:00:00Z');
    expect(service.status()).toMatchObject({ state: 'clock-problem', canWrite: false });
    service.tick(); // must not lower the mark
    // Deleting one of the stores does not help: the others still remember.
    rmSync(join(dir.path, 'keys', 'session.dat'));
    expect(makeService().status().state).toBe('clock-problem');

    clock.now = new Date('2026-12-20T07:00:00Z');
    expect(service.status()).toMatchObject({ state: 'expiring', canWrite: true });
  });

  it('a fresh licence clears a clock mark that was set far in the future by mistake', () => {
    const service = makeService();
    service.importLicense(encodeLicense(certificateFor(device), vendorPrivate));
    clock.now = new Date('2030-01-01T00:00:00Z');
    service.tick();
    clock.now = new Date('2026-11-26T06:00:00Z');
    expect(service.status().state).toBe('clock-problem');

    service.importLicense(
      encodeLicense(certificateFor(device, { serial: 2, issuedAt: '2026-11-26T05:55:00.000Z' }), vendorPrivate),
    );
    expect(service.status()).toMatchObject({ state: 'active', canWrite: true });
  });

  it('cannot activate a build without the verification key', () => {
    const service = makeService({ vendorKey: null });
    expect(() => service.importLicense(encodeLicense(certificateFor(device), vendorPrivate))).toThrow(/cannot verify/);
  });
});
