import { z } from 'zod';

export const BackupFrequencySchema = z.enum(['off', 'daily', 'weekly', 'monthly']);
export type BackupFrequency = z.infer<typeof BackupFrequencySchema>;

export const BackupScheduleSchema = z.object({
  frequency: BackupFrequencySchema,
  /** Local time, 24-hour "HH:MM". */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 21:30'),
  /** 0 = Sunday ... 6 = Saturday, used when frequency is weekly. */
  weekday: z.number().int().min(0).max(6),
  /** 1-28 so the day exists in every month, used when frequency is monthly. */
  dayOfMonth: z.number().int().min(1).max(28),
});
export type BackupSchedule = z.infer<typeof BackupScheduleSchema>;

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = {
  frequency: 'daily',
  time: '21:00',
  weekday: 0,
  dayOfMonth: 1,
};

export const RetentionPolicySchema = z.object({
  keepDaily: z.number().int().min(1).max(365),
  keepWeekly: z.number().int().min(0).max(104),
  keepMonthly: z.number().int().min(0).max(120),
  keepSafetyDays: z.number().int().min(1).max(3650),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const DEFAULT_RETENTION: RetentionPolicy = {
  keepDaily: 14,
  keepWeekly: 8,
  keepMonthly: 12,
  keepSafetyDays: 90,
};

export const BackupKindNameSchema = z.enum(['manual', 'scheduled', 'pre-restore', 'pre-update']);

export const BackupDestinationInfoSchema = z.object({
  id: z.number().int(),
  path: z.string(),
  enabled: z.boolean(),
  reachable: z.boolean(),
  freeBytes: z.number().nullable(),
  lastVerifiedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type BackupDestinationInfo = z.infer<typeof BackupDestinationInfoSchema>;

export const BackupStatusSchema = z.object({
  configured: z.boolean(),
  running: z.boolean(),
  destinations: z.array(BackupDestinationInfoSchema),
  schedule: BackupScheduleSchema,
  retention: RetentionPolicySchema,
  lastVerifiedAt: z.string().nullable(),
  lastRun: z
    .object({
      kind: z.string(),
      status: z.enum(['running', 'success', 'partial', 'failed']),
      startedAt: z.string(),
      error: z.string().nullable(),
    })
    .nullable(),
  nextScheduledAt: z.string().nullable(),
  /** True when the last verified backup is older than 48 hours, or none exists. */
  overdue: z.boolean(),
});
export type BackupStatus = z.infer<typeof BackupStatusSchema>;

export const BackupHistoryEntrySchema = z.object({
  id: z.number().int(),
  createdAt: z.string(),
  kind: z.string(),
  destination: z.string(),
  filePath: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  status: z.enum(['verified', 'failed', 'deleted']),
  error: z.string().nullable(),
});
export type BackupHistoryEntry = z.infer<typeof BackupHistoryEntrySchema>;

export const BackupRunResultSchema = z.object({
  status: z.enum(['success', 'partial', 'failed']),
  results: z.array(
    z.object({
      destination: z.string(),
      ok: z.boolean(),
      filePath: z.string().nullable(),
      sizeBytes: z.number().nullable(),
      error: z.string().nullable(),
    }),
  ),
  error: z.string().nullable(),
});
export type BackupRunResult = z.infer<typeof BackupRunResultSchema>;

export const BackupInspectionSchema = z.object({
  filePath: z.string(),
  fileSizeBytes: z.number(),
  createdAt: z.string(),
  appVersion: z.string(),
  schemaVersion: z.number().int(),
  kind: z.string(),
  sameInstallation: z.boolean(),
  needsPassword: z.boolean(),
  compatible: z.boolean(),
  compatibilityMessage: z.string().nullable(),
});
export type BackupInspection = z.infer<typeof BackupInspectionSchema>;

export const BackupVerificationSchema = z.object({
  ok: z.literal(true),
  tableCounts: z.record(z.string(), z.number()),
  databaseSizeBytes: z.number(),
});
export type BackupVerification = z.infer<typeof BackupVerificationSchema>;
