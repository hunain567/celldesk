import { z } from 'zod';

/** IPC contract of the License Manager (separate from NexoDesk's). */

export const PlanSchema = z.enum(['monthly', 'six-months', 'yearly', 'custom']);
export const LicenseStatusSchema = z.enum(['active', 'suspended', 'revoked']);

const Text = (max: number) => z.string().trim().max(max);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-24');

export const CreateLicenseInputSchema = z.object({
  shopName: Text(200).min(1, 'Enter the shop name'),
  ownerName: Text(200),
  phone: Text(40),
  city: Text(100),
  plan: PlanSchema,
  /** Local date the subscription starts. */
  validFrom: IsoDate,
  /** Required for the custom plan only: last day of the subscription. */
  customUntil: IsoDate.optional(),
  deviceLimit: z.number().int().min(1).max(20),
  graceDays: z.number().int().min(0).max(30),
  notes: Text(1000),
});
export type CreateLicenseInput = z.infer<typeof CreateLicenseInputSchema>;

export const LicenseSummarySchema = z.object({
  id: z.string(),
  shopName: z.string(),
  ownerName: z.string(),
  phone: z.string(),
  city: z.string(),
  plan: PlanSchema,
  status: LicenseStatusSchema,
  validFrom: z.string(),
  validUntil: z.string(),
  graceDays: z.number(),
  deviceLimit: z.number(),
  activeDevices: z.number(),
  lastIssuedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type LicenseSummary = z.infer<typeof LicenseSummarySchema>;

export const DeviceSchema = z.object({
  id: z.number(),
  deviceId: z.string(),
  machineName: z.string(),
  appVersion: z.string(),
  status: z.enum(['active', 'removed']),
  firstActivatedAt: z.string(),
  lastIssuedAt: z.string(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const EventSchema = z.object({
  id: z.number(),
  at: z.string(),
  kind: z.string(),
  details: z.string(),
});
export type LicenseEvent = z.infer<typeof EventSchema>;

export const LicenseDetailSchema = LicenseSummarySchema.extend({
  notes: z.string(),
  devices: z.array(DeviceSchema),
  events: z.array(EventSchema),
});
export type LicenseDetail = z.infer<typeof LicenseDetailSchema>;

export const RequestPreviewSchema = z.object({
  deviceId: z.string(),
  machineName: z.string(),
  appVersion: z.string(),
  createdAt: z.string(),
  latestTimeSeen: z.string(),
  /** The shop PC's clock is far ahead of this laptop: its date is probably wrong. */
  clockAhead: z.boolean(),
  /** Licence this computer is already registered to, if any. */
  knownLicenseId: z.string().nullable(),
  knownShopName: z.string().nullable(),
});
export type RequestPreview = z.infer<typeof RequestPreviewSchema>;

export const IssuedLicenseSchema = z.object({ code: z.string(), fileName: z.string(), validUntil: z.string() });
export type IssuedLicense = z.infer<typeof IssuedLicenseSchema>;

export const DashboardSchema = z.object({
  activeLicenses: z.number(),
  expiringSoon: z.number(),
  expired: z.number(),
  suspendedOrRevoked: z.number(),
  devices: z.number(),
});
export type Dashboard = z.infer<typeof DashboardSchema>;

export const SettingsInfoSchema = z.object({
  publicKeyPem: z.string(),
  revokedLicenseIds: z.array(z.string()),
  lastBackupAt: z.string().nullable(),
  dataDirectory: z.string(),
});
export type SettingsInfo = z.infer<typeof SettingsInfoSchema>;

const NoInput = z.undefined();
const Password = z.string().max(256);

export const lmContract = {
  'vault:state': { input: NoInput, output: z.object({ exists: z.boolean(), unlocked: z.boolean() }) },
  'vault:create': { input: z.object({ password: Password }), output: z.null() },
  'vault:unlock': { input: z.object({ password: Password }), output: z.null() },
  'vault:lock': { input: NoInput, output: z.null() },

  'lm:dashboard': { input: NoInput, output: DashboardSchema },
  'lm:licenses': { input: NoInput, output: z.array(LicenseSummarySchema) },
  'lm:license': { input: z.object({ id: z.string() }), output: LicenseDetailSchema },
  'lm:createLicense': { input: CreateLicenseInputSchema, output: z.object({ id: z.string() }) },
  'lm:extend': {
    input: z.object({ id: z.string(), plan: PlanSchema, customUntil: IsoDate.optional() }),
    output: z.null(),
  },
  'lm:setStatus': { input: z.object({ id: z.string(), status: LicenseStatusSchema }), output: z.null() },
  'lm:openRequestFile': { input: NoInput, output: z.object({ code: z.string() }).nullable() },
  'lm:previewRequest': { input: z.object({ code: z.string().max(20000) }), output: RequestPreviewSchema },
  'lm:issueForRequest': { input: z.object({ licenseId: z.string(), code: z.string().max(20000) }), output: IssuedLicenseSchema },
  'lm:issueForDevice': { input: z.object({ licenseId: z.string(), deviceRowId: z.number().int() }), output: IssuedLicenseSchema },
  'lm:removeDevice': { input: z.object({ deviceRowId: z.number().int() }), output: z.null() },
  'lm:saveLicenseFile': {
    input: z.object({ code: z.string().startsWith('NDLIC1.').max(20000), fileName: z.string().max(200) }),
    output: z.object({ path: z.string().nullable() }),
  },
  'lm:settings': { input: NoInput, output: SettingsInfoSchema },
  'lm:backup': { input: NoInput, output: z.object({ path: z.string().nullable() }) },
} as const;

export type LmContract = typeof lmContract;
export type LmChannel = keyof LmContract;
export type LmInput<C extends LmChannel> = z.input<LmContract[C]['input']>;
export type LmOutput<C extends LmChannel> = z.output<LmContract[C]['output']>;
export type LmResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: string[] } };

export const LM_CHANNELS = Object.keys(lmContract) as LmChannel[];
export const LM_INVOKE_CHANNEL = 'license-manager:invoke';
