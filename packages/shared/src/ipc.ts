import { z } from 'zod';

/**
 * IPC contract shared by the renderer, the preload bridge and the main process.
 *
 * Every channel the renderer may call is listed here with a zod schema for its
 * input and output. The preload bridge refuses any channel not in this list, and
 * the main process validates every payload against `input` before a handler runs.
 */

export const ThemeSchema = z.enum(['light', 'dark', 'system']);
export type Theme = z.infer<typeof ThemeSchema>;

/** Settings the renderer is allowed to read and write, with their value schema. */
export const settingSchemas = {
  'ui.theme': ThemeSchema,
  'ui.sidebarCollapsed': z.boolean(),
} as const;
export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingSchemas)[K]>;
export const SettingKeySchema = z.enum(Object.keys(settingSchemas) as [SettingKey, ...SettingKey[]]);

export const SystemInfoSchema = z.object({
  appName: z.string(),
  appVersion: z.string(),
  electronVersion: z.string(),
  platform: z.string(),
  schemaVersion: z.number().int(),
  latestSchemaVersion: z.number().int(),
  databaseEncrypted: z.boolean(),
  dataDirectory: z.string(),
  databaseSizeBytes: z.number().int().nonnegative(),
  installId: z.string(),
  startedAt: z.string(),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;

export const AuditVerifyResultSchema = z.object({
  valid: z.boolean(),
  entriesChecked: z.number().int().nonnegative(),
  firstBrokenId: z.number().int().nullable(),
});
export type AuditVerifyResult = z.infer<typeof AuditVerifyResultSchema>;

export const IntegrityResultSchema = z.object({
  ok: z.boolean(),
  messages: z.array(z.string()),
  checkedAt: z.string(),
});
export type IntegrityResult = z.infer<typeof IntegrityResultSchema>;

const NoInput = z.undefined();

export const ipcContract = {
  'system:info': { input: NoInput, output: SystemInfoSchema },
  'system:integrityCheck': { input: NoInput, output: IntegrityResultSchema },
  'settings:get': {
    input: z.object({ key: SettingKeySchema }),
    output: z.unknown(),
  },
  'settings:set': {
    input: z.object({ key: SettingKeySchema, value: z.unknown() }),
    output: z.null(),
  },
  'audit:verify': { input: NoInput, output: AuditVerifyResultSchema },
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.output<IpcContract[C]['output']>;

export const ipcChannels = Object.keys(ipcContract) as IpcChannel[];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ipcContract, value);
}

export const IpcErrorCodeSchema = z.enum([
  'VALIDATION_FAILED',
  'UNKNOWN_CHANNEL',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'LICENSE_RESTRICTED',
  'INTERNAL_ERROR',
]);
export type IpcErrorCode = z.infer<typeof IpcErrorCodeSchema>;

export interface IpcError {
  code: IpcErrorCode;
  message: string;
  details?: string[];
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

/** The single function the preload bridge exposes on `window.nexodesk`. */
export interface NexoDeskBridge {
  invoke<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<IpcResult<IpcOutput<C>>>;
}
