import {
  decodeActivationRequest,
  encodeLicense,
  LicenseCodeError,
  LICENSE_EXTENSION,
  planEnd,
  privateKeyFromPem,
  type LicenseCertificate,
  type Plan,
} from '@nexodesk/licensing';
import { randomBytes } from 'node:crypto';
import type { SqliteDatabase } from '@desktop-main/db/connection';
import type {
  CreateLicenseInput,
  Dashboard,
  Device,
  IssuedLicense,
  LicenseDetail,
  LicenseSummary,
  RequestPreview,
} from '../shared/contract';

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A shop clock more than this far ahead of the laptop is flagged in the request preview. */
const CLOCK_AHEAD_WARNING_MS = DAY_MS;

interface LicenseRow {
  id: string;
  customer_id: number;
  plan: Plan;
  status: 'active' | 'suspended' | 'revoked';
  valid_from: string;
  valid_until: string;
  grace_days: number;
  device_limit: number;
  notes: string;
  created_at: string;
  shop_name: string;
  owner_name: string;
  phone: string;
  city: string;
}

/** Start of a local calendar day given as YYYY-MM-DD. */
function startOfLocalDay(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year!, month! - 1, day!, 0, 0, 0, 0);
}

function endOfLocalDay(isoDate: string): Date {
  const date = startOfLocalDay(isoDate);
  date.setHours(23, 59, 59, 999);
  return date;
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function periodEnd(plan: Plan, start: Date, customUntil: string | undefined): Date {
  if (plan === 'custom') {
    if (!customUntil) throw new RegistryError('Choose the last day of the custom period.');
    const end = endOfLocalDay(customUntil);
    if (end <= start) throw new RegistryError('The end date must be after the start date.');
    return end;
  }
  return planEnd(plan, start);
}

function newLicenseId(now: Date): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  const suffix = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
  return `NDX-${now.getFullYear()}-${suffix}`;
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'shop';
}

/**
 * All licence administration. Every change is written to the events table so
 * the activation history of each shop can be reviewed later.
 */
export class LicenseRegistry {
  constructor(private readonly db: SqliteDatabase, private readonly now: () => Date = () => new Date()) {}

  private event(licenseId: string | null, kind: string, details: string): void {
    this.db.prepare('INSERT INTO events (at, license_id, kind, details) VALUES (?, ?, ?, ?)').run(
      this.now().toISOString(),
      licenseId,
      kind,
      details,
    );
  }

  publicKeyPem(): string {
    return (this.db.prepare('SELECT public_key_pem FROM vendor_key WHERE id = 1').get() as { public_key_pem: string })
      .public_key_pem;
  }

  private signingKey() {
    const row = this.db.prepare('SELECT private_key_pem FROM vendor_key WHERE id = 1').get() as { private_key_pem: string };
    return privateKeyFromPem(row.private_key_pem);
  }

  private row(id: string): LicenseRow {
    const row = this.db
      .prepare(
        `SELECT l.*, c.shop_name, c.owner_name, c.phone, c.city
         FROM licenses l JOIN customers c ON c.id = l.customer_id WHERE l.id = ?`,
      )
      .get(id) as LicenseRow | undefined;
    if (!row) throw new RegistryError('This licence does not exist.');
    return row;
  }

  private summary(row: LicenseRow): LicenseSummary {
    const devices = this.db
      .prepare(`SELECT count(*) AS n FROM devices WHERE license_id = ? AND status = 'active'`)
      .get(row.id) as { n: number };
    const issued = this.db.prepare('SELECT max(issued_at) AS at FROM issued_licenses WHERE license_id = ?').get(row.id) as {
      at: string | null;
    };
    return {
      id: row.id,
      shopName: row.shop_name,
      ownerName: row.owner_name,
      phone: row.phone,
      city: row.city,
      plan: row.plan,
      status: row.status,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      graceDays: row.grace_days,
      deviceLimit: row.device_limit,
      activeDevices: devices.n,
      lastIssuedAt: issued.at,
      createdAt: row.created_at,
    };
  }

  createLicense(input: CreateLicenseInput): string {
    const start = startOfLocalDay(input.validFrom);
    const end = periodEnd(input.plan, start, input.customUntil);
    const now = this.now();
    const id = newLicenseId(now);
    const create = this.db.transaction(() => {
      const customerId = Number(
        this.db
          .prepare('INSERT INTO customers (shop_name, owner_name, phone, city, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(input.shopName, input.ownerName, input.phone, input.city, now.toISOString()).lastInsertRowid,
      );
      this.db
        .prepare(
          `INSERT INTO licenses (id, customer_id, plan, status, valid_from, valid_until, grace_days, device_limit, notes, created_at)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, customerId, input.plan, start.toISOString(), end.toISOString(), input.graceDays, input.deviceLimit, input.notes, now.toISOString());
      this.event(id, 'created', `${input.shopName}: ${input.plan}, ${localDate(start)} to ${localDate(end)}`);
    });
    create();
    return id;
  }

  list(): LicenseSummary[] {
    const rows = this.db
      .prepare(
        `SELECT l.*, c.shop_name, c.owner_name, c.phone, c.city
         FROM licenses l JOIN customers c ON c.id = l.customer_id ORDER BY l.valid_until ASC`,
      )
      .all() as LicenseRow[];
    return rows.map((row) => this.summary(row));
  }

  detail(id: string): LicenseDetail {
    const row = this.row(id);
    const devices = this.db
      .prepare('SELECT * FROM devices WHERE license_id = ? ORDER BY id')
      .all(id) as Array<{
      id: number;
      device_id: string;
      machine_name: string;
      app_version: string;
      status: 'active' | 'removed';
      first_activated_at: string;
      last_issued_at: string;
    }>;
    const events = this.db
      .prepare('SELECT id, at, kind, details FROM events WHERE license_id = ? ORDER BY id DESC LIMIT 200')
      .all(id) as LicenseDetail['events'];
    return {
      ...this.summary(row),
      notes: row.notes,
      devices: devices.map(
        (device): Device => ({
          id: device.id,
          deviceId: device.device_id,
          machineName: device.machine_name,
          appVersion: device.app_version,
          status: device.status,
          firstActivatedAt: device.first_activated_at,
          lastIssuedAt: device.last_issued_at,
        }),
      ),
      events,
    };
  }

  dashboard(): Dashboard {
    const now = this.now().getTime();
    const licenses = this.list();
    const active = licenses.filter((license) => license.status === 'active');
    return {
      activeLicenses: active.filter((license) => Date.parse(license.validUntil) >= now).length,
      expiringSoon: active.filter((license) => {
        const end = Date.parse(license.validUntil);
        return end >= now && end - now <= 7 * DAY_MS;
      }).length,
      expired: active.filter((license) => Date.parse(license.validUntil) < now).length,
      suspendedOrRevoked: licenses.length - active.length,
      devices: licenses.reduce((sum, license) => sum + license.activeDevices, 0),
    };
  }

  /**
   * Extends a subscription by one period. The new period starts the day after
   * the current end, or today if the licence has already expired.
   */
  extend(id: string, plan: Plan, customUntil?: string): void {
    const row = this.row(id);
    if (row.status === 'revoked') throw new RegistryError('A revoked licence cannot be extended.');
    const currentEnd = new Date(row.valid_until);
    const today = startOfLocalDay(localDate(this.now()));
    const start = currentEnd.getTime() >= today.getTime() ? new Date(currentEnd.getTime() + 1) : today;
    const end = periodEnd(plan, start, customUntil);
    this.db.prepare('UPDATE licenses SET plan = ?, valid_until = ? WHERE id = ?').run(plan, end.toISOString(), id);
    this.event(id, 'extended', `${plan}: now valid until ${localDate(end)}. Issue renewal files for its computers.`);
  }

  setStatus(id: string, status: 'active' | 'suspended' | 'revoked'): void {
    const row = this.row(id);
    if (row.status === 'revoked' && status !== 'revoked') {
      throw new RegistryError('A revoked licence cannot be reactivated. Create a new licence instead.');
    }
    this.db.prepare('UPDATE licenses SET status = ? WHERE id = ?').run(status, id);
    this.event(id, status === 'active' ? 'reactivated' : status, `Status changed from ${row.status} to ${status}`);
  }

  revokedIds(): string[] {
    return (this.db.prepare(`SELECT id FROM licenses WHERE status = 'revoked' ORDER BY id`).all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
  }

  previewRequest(code: string): RequestPreview {
    let request;
    try {
      request = decodeActivationRequest(code);
    } catch (error) {
      throw new RegistryError(error instanceof LicenseCodeError ? error.message : 'This is not a valid activation request.');
    }
    const known = this.db
      .prepare(
        `SELECT d.license_id, c.shop_name FROM devices d
         JOIN licenses l ON l.id = d.license_id JOIN customers c ON c.id = l.customer_id
         WHERE d.device_id = ? AND d.status = 'active' ORDER BY d.id DESC LIMIT 1`,
      )
      .get(request.deviceId) as { license_id: string; shop_name: string } | undefined;
    return {
      deviceId: request.deviceId,
      machineName: request.machineName,
      appVersion: request.appVersion,
      createdAt: request.createdAt,
      latestTimeSeen: request.latestTimeSeen,
      clockAhead: Date.parse(request.latestTimeSeen) - this.now().getTime() > CLOCK_AHEAD_WARNING_MS,
      knownLicenseId: known?.license_id ?? null,
      knownShopName: known?.shop_name ?? null,
    };
  }

  private issue(row: LicenseRow, deviceRowId: number, deviceId: string, devicePublicKey: string): IssuedLicense {
    if (row.status !== 'active') throw new RegistryError(`This licence is ${row.status}. Reactivate it before issuing files.`);
    const now = this.now();
    if (Date.parse(row.valid_until) < now.getTime()) {
      throw new RegistryError('This licence has expired. Extend it first, then issue the file.');
    }
    const serialRow = this.db.prepare('SELECT max(serial) AS s FROM issued_licenses WHERE license_id = ?').get(row.id) as {
      s: number | null;
    };
    const certificate: LicenseCertificate = {
      format: 1,
      kind: 'license',
      licenseId: row.id,
      serial: (serialRow.s ?? 0) + 1,
      shopName: row.shop_name,
      ownerName: row.owner_name,
      plan: row.plan,
      issuedAt: now.toISOString(),
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      graceDays: row.grace_days,
      deviceId,
      devicePublicKey,
    };
    const code = encodeLicense(certificate, this.signingKey());
    this.db
      .prepare('INSERT INTO issued_licenses (license_id, device_row, serial, valid_until, issued_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, deviceRowId, certificate.serial, certificate.validUntil, certificate.issuedAt);
    this.db.prepare('UPDATE devices SET last_issued_at = ? WHERE id = ?').run(certificate.issuedAt, deviceRowId);
    return {
      code,
      fileName: `${slug(row.shop_name)}-${row.id}-${localDate(now)}${LICENSE_EXTENSION}`,
      validUntil: row.valid_until,
    };
  }

  /** Activates a computer from its request (new install, or reinstall on the same computer). */
  issueForRequest(licenseId: string, code: string): IssuedLicense {
    const row = this.row(licenseId);
    let request;
    try {
      request = decodeActivationRequest(code);
    } catch (error) {
      throw new RegistryError(error instanceof LicenseCodeError ? error.message : 'This is not a valid activation request.');
    }
    const run = this.db.transaction((): IssuedLicense => {
      const existing = this.db
        .prepare('SELECT id, status FROM devices WHERE license_id = ? AND device_id = ?')
        .get(licenseId, request.deviceId) as { id: number; status: string } | undefined;
      const activeOthers = (
        this.db
          .prepare(`SELECT count(*) AS n FROM devices WHERE license_id = ? AND status = 'active' AND device_id != ?`)
          .get(licenseId, request.deviceId) as { n: number }
      ).n;
      if (activeOthers >= row.device_limit) {
        throw new RegistryError(
          `This licence allows ${row.device_limit} computer${row.device_limit === 1 ? '' : 's'}. Remove an old computer first.`,
        );
      }
      const now = this.now().toISOString();
      let deviceRowId: number;
      if (existing) {
        // Same computer again (for example after a reinstall): replace its key, keep its slot.
        this.db
          .prepare(
            `UPDATE devices SET device_public_key = ?, machine_name = ?, app_version = ?, status = 'active' WHERE id = ?`,
          )
          .run(request.devicePublicKey, request.machineName, request.appVersion, existing.id);
        deviceRowId = existing.id;
        this.event(licenseId, 'reactivated-device', `${request.machineName} (${request.deviceId.slice(0, 12)})`);
      } else {
        deviceRowId = Number(
          this.db
            .prepare(
              `INSERT INTO devices (license_id, device_id, device_public_key, machine_name, app_version, status, first_activated_at, last_issued_at)
               VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
            )
            .run(licenseId, request.deviceId, request.devicePublicKey, request.machineName, request.appVersion, now, now)
            .lastInsertRowid,
        );
        this.event(licenseId, 'activated', `${request.machineName} (${request.deviceId.slice(0, 12)})`);
      }
      return this.issue(row, deviceRowId, request.deviceId, request.devicePublicKey);
    });
    return run();
  }

  /** Renewal file for a computer that is already registered (no new request needed). */
  issueForDevice(licenseId: string, deviceRowId: number): IssuedLicense {
    const row = this.row(licenseId);
    const device = this.db
      .prepare('SELECT device_id, device_public_key, machine_name, status FROM devices WHERE id = ? AND license_id = ?')
      .get(deviceRowId, licenseId) as
      | { device_id: string; device_public_key: string; machine_name: string; status: string }
      | undefined;
    if (!device) throw new RegistryError('This computer is not registered to the licence.');
    if (device.status !== 'active') throw new RegistryError('This computer was removed. Activate it again from its request.');
    const run = this.db.transaction(() => {
      const issued = this.issue(row, deviceRowId, device.device_id, device.device_public_key);
      this.event(licenseId, 'renewal-issued', `${device.machine_name}: valid until ${localDate(new Date(issued.validUntil))}`);
      return issued;
    });
    return run();
  }

  removeDevice(deviceRowId: number): void {
    const device = this.db.prepare('SELECT license_id, machine_name FROM devices WHERE id = ?').get(deviceRowId) as
      | { license_id: string; machine_name: string }
      | undefined;
    if (!device) throw new RegistryError('This computer is not registered.');
    this.db.prepare(`UPDATE devices SET status = 'removed' WHERE id = ?`).run(deviceRowId);
    this.event(device.license_id, 'device-removed', `${device.machine_name}: slot freed. Its current licence file still works until it expires.`);
  }

  lastBackupAt(): string | null {
    const row = this.db.prepare(`SELECT value FROM app_meta WHERE key = 'last_backup_at'`).get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  recordBackup(at: Date): void {
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES ('last_backup_at', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(at.toISOString(), at.toISOString());
    this.event(null, 'backup', 'License Manager backup saved');
  }
}
