import type { LicenseCertificate, Plan } from './codes';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long the "expiring soon" warning shows before the expiry date. */
export const EXPIRING_WARNING_DAYS = 7;
/** Clock differences smaller than this (time sync, time zone changes) are tolerated. */
export const CLOCK_TOLERANCE_MS = 10 * 60 * 1000;
export const DEFAULT_GRACE_DAYS = 3;

export type LicenseState =
  | 'unlicensed'
  | 'invalid'
  | 'clock-problem'
  | 'active'
  | 'expiring'
  | 'grace'
  | 'expired'
  | 'revoked';

export interface LicenseEvaluation {
  state: LicenseState;
  /** True only when new business transactions are allowed. */
  canWrite: boolean;
  reason: string | null;
  daysLeft: number | null;
  graceEndsAt: string | null;
}

/** Adds whole calendar months, keeping the day where possible (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getDate();
  result.setDate(1);
  result.setMonth(result.getMonth() + months);
  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));
  return result;
}

/** End of a subscription that starts on `validFrom`: the end of the day before the same date next period. */
export function planEnd(plan: Exclude<Plan, 'custom'>, validFrom: Date): Date {
  const months = plan === 'monthly' ? 1 : plan === 'six-months' ? 6 : 12;
  const end = addMonths(validFrom, months);
  end.setHours(23, 59, 59, 999);
  end.setDate(end.getDate() - 1);
  return end;
}

export const PLAN_LABELS: Record<Plan, string> = {
  monthly: 'Monthly',
  'six-months': '6 months',
  yearly: 'Yearly',
  custom: 'Custom period',
};

/**
 * Decides what the shop may do right now. Pure: every input is passed in.
 * Business data is never deleted in any state; the worst outcome is read-only.
 */
export function evaluateLicense(input: {
  certificate: LicenseCertificate | null;
  /** Set when a licence file exists but failed its checks (signature, device). */
  invalidReason?: string | null;
  now: Date;
  /** The newest time ever seen on this installation (from several independent places). */
  latestTimeSeen: Date | null;
  revokedLicenseIds: readonly string[];
}): LicenseEvaluation {
  const { certificate, now } = input;
  if (input.invalidReason) {
    return { state: 'invalid', canWrite: false, reason: input.invalidReason, daysLeft: null, graceEndsAt: null };
  }
  if (!certificate) {
    return {
      state: 'unlicensed',
      canWrite: false,
      reason: 'NexoDesk has not been activated on this computer.',
      daysLeft: null,
      graceEndsAt: null,
    };
  }
  if (input.revokedLicenseIds.includes(certificate.licenseId)) {
    return {
      state: 'revoked',
      canWrite: false,
      reason: 'This licence has been cancelled. Contact NexoERP.',
      daysLeft: null,
      graceEndsAt: null,
    };
  }

  // A clock behind the newest time ever seen (or behind the licence's own issue time) means it was moved back.
  const floor = Math.max(input.latestTimeSeen?.getTime() ?? 0, new Date(certificate.issuedAt).getTime());
  if (now.getTime() < floor - CLOCK_TOLERANCE_MS) {
    return {
      state: 'clock-problem',
      canWrite: false,
      reason: `The computer's date and time are behind ${new Date(floor).toLocaleString('en-PK')}. Correct the date and time in Windows settings.`,
      daysLeft: null,
      graceEndsAt: null,
    };
  }

  const validUntil = new Date(certificate.validUntil).getTime();
  const graceEnd = validUntil + certificate.graceDays * DAY_MS;
  const daysLeft = Math.max(0, Math.ceil((validUntil - now.getTime()) / DAY_MS));
  const graceEndsAt = new Date(graceEnd).toISOString();

  if (now.getTime() < new Date(certificate.validFrom).getTime() - CLOCK_TOLERANCE_MS) {
    return {
      state: 'clock-problem',
      canWrite: false,
      reason: `This licence starts on ${new Date(certificate.validFrom).toLocaleDateString('en-PK')}. Check the computer's date.`,
      daysLeft,
      graceEndsAt,
    };
  }
  if (now.getTime() <= validUntil) {
    const expiring = validUntil - now.getTime() <= EXPIRING_WARNING_DAYS * DAY_MS;
    return { state: expiring ? 'expiring' : 'active', canWrite: true, reason: null, daysLeft, graceEndsAt };
  }
  if (now.getTime() <= graceEnd) {
    return {
      state: 'grace',
      canWrite: true,
      reason: 'The subscription has ended. Renew now: new sales will stop when the grace period ends.',
      daysLeft: 0,
      graceEndsAt,
    };
  }
  return {
    state: 'expired',
    canWrite: false,
    reason: 'The subscription has ended. Your data is safe and can be viewed, exported and backed up. Renew to continue billing.',
    daysLeft: 0,
    graceEndsAt,
  };
}
