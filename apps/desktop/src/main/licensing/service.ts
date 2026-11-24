import {
  decodeLicense,
  encodeActivationRequest,
  evaluateLicense,
  LicenseCodeError,
  PLAN_LABELS,
  publicKeyFromPem,
  type LicenseCertificate,
} from '@nexodesk/licensing';
import type { LicenseStatus } from '@nexodesk/shared';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../errors';
import type { AuditLog } from '../services/audit';
import type { ClockGuard } from './clock';
import type { DeviceIdentity } from './device';

/** A newly issued licence may reset the clock mark only if it was issued this recently. */
const FRESH_LICENSE_MS = 2 * 24 * 60 * 60 * 1000;

export interface LicenseServiceOptions {
  /** Username recorded in the audit log for actions taken by a person. */
  actor?: () => string;
  licenseDirectory: string;
  /** Embedded at build time; null means this build cannot verify licences. */
  vendorPublicKeyPem: string | null;
  device: DeviceIdentity;
  installId: string;
  appVersion: string;
  clock: ClockGuard;
  revokedLicenseIds: readonly string[];
  audit: AuditLog;
  now?: () => Date;
}

interface Loaded {
  certificate: LicenseCertificate | null;
  invalidReason: string | null;
}

/**
 * Licence state on the shop PC. The licence file is signed by NexoERP's
 * private key, bound to this computer's device key and id, and evaluated
 * against a clock that cannot be moved backwards.
 */
export class LicenseService {
  private readonly now: () => Date;
  private loaded: Loaded;

  constructor(private readonly options: LicenseServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.loaded = this.loadFromDisk();
  }

  private get licensePath(): string {
    return join(this.options.licenseDirectory, 'license.ndlic');
  }

  private vendorKey() {
    if (!this.options.vendorPublicKeyPem) return null;
    return publicKeyFromPem(this.options.vendorPublicKeyPem);
  }

  /** Checks a licence for this computer; returns why it cannot be used, or null. */
  private bindingProblem(certificate: LicenseCertificate): string | null {
    if (certificate.deviceId !== this.options.device.deviceId) {
      return 'This licence was issued for a different computer.';
    }
    if (certificate.devicePublicKey !== this.options.device.publicKeyText) {
      return 'This licence was issued before NexoDesk was reinstalled on this computer. Ask NexoERP for a new licence file.';
    }
    return null;
  }

  private loadFromDisk(): Loaded {
    if (!existsSync(this.licensePath)) return { certificate: null, invalidReason: null };
    const key = this.vendorKey();
    if (!key) {
      return { certificate: null, invalidReason: 'This copy of NexoDesk cannot verify licences. Install an official release.' };
    }
    try {
      const certificate = decodeLicense(readFileSync(this.licensePath, 'utf8'), key);
      const problem = this.bindingProblem(certificate);
      return problem ? { certificate: null, invalidReason: problem } : { certificate, invalidReason: null };
    } catch (error) {
      return {
        certificate: null,
        invalidReason: error instanceof LicenseCodeError ? error.message : 'The licence file could not be read.',
      };
    }
  }

  /** Re-reads the licence file (it is re-verified every time, so an edited file is caught). */
  reload(): void {
    this.loaded = this.loadFromDisk();
  }

  status(): LicenseStatus {
    const { certificate, invalidReason } = this.loaded;
    const evaluation = evaluateLicense({
      certificate,
      invalidReason,
      now: this.now(),
      latestTimeSeen: this.options.clock.latest(),
      revokedLicenseIds: this.options.revokedLicenseIds,
    });
    return {
      state: evaluation.state,
      canWrite: evaluation.canWrite,
      reason: evaluation.reason,
      daysLeft: evaluation.daysLeft,
      graceEndsAt: evaluation.graceEndsAt,
      licenseId: certificate?.licenseId ?? null,
      shopName: certificate?.shopName ?? null,
      ownerName: certificate?.ownerName ?? null,
      planLabel: certificate ? PLAN_LABELS[certificate.plan] : null,
      validFrom: certificate?.validFrom ?? null,
      validUntil: certificate?.validUntil ?? null,
      issuedAt: certificate?.issuedAt ?? null,
      deviceIdShort: this.options.device.deviceId.slice(0, 12).toUpperCase(),
    };
  }

  canWrite(): boolean {
    return this.status().canWrite;
  }

  /** Called by every service that creates business records (sales, purchases, payments...). */
  assertCanWrite(): void {
    const status = this.status();
    if (!status.canWrite) {
      throw new AppError(
        'LICENSE_RESTRICTED',
        status.reason ?? 'NexoDesk is in read-only mode. Your data is safe; renew the licence to continue.',
      );
    }
  }

  /** The text the shop sends to NexoERP (also saved as a .ndreq file). */
  createRequestCode(): string {
    return encodeActivationRequest(
      {
        format: 1,
        kind: 'activation-request',
        deviceId: this.options.device.deviceId,
        devicePublicKey: this.options.device.publicKeyText,
        installId: this.options.installId,
        machineName: this.options.device.machineName,
        appVersion: this.options.appVersion,
        latestTimeSeen: (this.options.clock.latest() ?? this.now()).toISOString(),
        createdAt: this.now().toISOString(),
      },
      this.options.device.privateKey,
    );
  }

  importLicense(text: string): LicenseStatus {
    const key = this.vendorKey();
    if (!key) throw new AppError('CONFLICT', 'This copy of NexoDesk cannot verify licences. Install an official release.');

    let certificate: LicenseCertificate;
    try {
      certificate = decodeLicense(text, key);
    } catch (error) {
      throw new AppError('VALIDATION_FAILED', error instanceof LicenseCodeError ? error.message : 'This is not a valid licence.');
    }
    const problem = this.bindingProblem(certificate);
    if (problem) throw new AppError('VALIDATION_FAILED', problem);

    const current = this.loaded.certificate;
    if (current && current.licenseId === certificate.licenseId && certificate.serial < current.serial) {
      throw new AppError('CONFLICT', 'This licence file is older than the one already installed.');
    }

    mkdirSync(this.options.licenseDirectory, { recursive: true });
    const temp = `${this.licensePath}.tmp`;
    writeFileSync(temp, text.replace(/\s+/g, ''), 'utf8');
    renameSync(temp, this.licensePath);
    this.loaded = { certificate, invalidReason: null };

    // A freshly issued licence carries trusted time: it clears a clock mark that was pushed too far ahead.
    const issuedAt = Date.parse(certificate.issuedAt);
    const latest = this.options.clock.latest()?.getTime() ?? 0;
    if (latest > issuedAt && this.now().getTime() - issuedAt < FRESH_LICENSE_MS) {
      this.options.clock.reset(Math.max(issuedAt, Math.min(latest, this.now().getTime())));
    }

    this.options.audit.append({
      actor: this.options.actor?.() ?? 'owner',
      action: 'license.import',
      entityType: 'license',
      entityId: certificate.licenseId,
      details: { serial: certificate.serial, plan: certificate.plan, validUntil: certificate.validUntil },
    });
    return this.status();
  }

  /** Moves the clock mark forward; skipped while the clock is behind it. */
  tick(): void {
    if (this.status().state === 'clock-problem') return;
    this.options.clock.record(this.now());
  }
}
