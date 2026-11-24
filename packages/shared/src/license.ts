import { z } from 'zod';

export const LicenseStateSchema = z.enum([
  'unlicensed',
  'invalid',
  'clock-problem',
  'active',
  'expiring',
  'grace',
  'expired',
  'revoked',
]);
export type LicenseStateName = z.infer<typeof LicenseStateSchema>;

export const LicenseStatusSchema = z.object({
  state: LicenseStateSchema,
  canWrite: z.boolean(),
  reason: z.string().nullable(),
  daysLeft: z.number().int().nullable(),
  graceEndsAt: z.string().nullable(),
  licenseId: z.string().nullable(),
  shopName: z.string().nullable(),
  ownerName: z.string().nullable(),
  planLabel: z.string().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  issuedAt: z.string().nullable(),
  /** First 12 characters of this computer's device id, shown for support calls. */
  deviceIdShort: z.string(),
});
export type LicenseStatus = z.infer<typeof LicenseStatusSchema>;
