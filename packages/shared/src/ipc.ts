import { z } from 'zod';
import {
  BackupHistoryEntrySchema,
  BackupInspectionSchema,
  BackupRunResultSchema,
  BackupScheduleSchema,
  BackupStatusSchema,
  BackupVerificationSchema,
} from './backup';
import {
  NewUserSchema,
  PinSchema,
  PinUserSchema,
  RoleSchema,
  SessionUserSchema,
  SetupStateSchema,
  ShopProfileSchema,
  UserPasswordSchema,
  UserSummarySchema,
} from './auth';
import {
  AccountSummarySchema,
  BrandInputSchema,
  BrandSummarySchema,
  DeviceDetailSchema,
  ItemInputSchema,
  ItemSummarySchema,
  ItemUpdateSchema,
  ModelInputSchema,
  PurchaseDetailSchema,
  PurchaseInputSchema,
  PurchaseReturnInputSchema,
  PurchaseReturnSummarySchema,
  PurchaseSummarySchema,
  StockDeviceSchema,
  SupplierInputSchema,
  SupplierPaymentInputSchema,
  SupplierStatementSchema,
  SupplierSummarySchema,
  SupplierUpdateSchema,
  VariantInputSchema,
  VariantSummarySchema,
  VariantUpdateSchema,
} from './inventory';
import { LicenseStatusSchema } from './license';
import {
  CustomerInputSchema,
  CustomerSummarySchema,
  PosLookupSchema,
  ReceiptPaperSchema,
  SaleDetailSchema,
  SaleInputSchema,
  SaleReturnInputSchema,
  SaleReturnSummarySchema,
  SaleSummarySchema,
} from './sales';

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
  /** Minutes without activity before the screen locks (owner setting). */
  'security.autoLockMinutes': z.number().int().min(1).max(240),
  /** Paper the receipt printer uses. */
  'pos.receiptPaper': ReceiptPaperSchema,
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
const Created = z.object({ id: z.number() });
const ListQuery = z.object({ query: z.string().max(100).optional(), includeInactive: z.boolean().optional() });
const ChosenPathSchema = z.object({ path: z.string().nullable() });
const PathInput = z.object({ path: z.string().min(1).max(1024) });
const RecoveryPasswordInput = z.string().max(256);

export const RestoreOutcomeSchema = z
  .object({
    kind: z.enum(['completed', 'rolled-back']),
    backupCreatedAt: z.string(),
    reason: z.string().nullable(),
    at: z.string(),
  })
  .nullable();
export type RestoreOutcome = z.infer<typeof RestoreOutcomeSchema>;

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

  'backup:status': { input: NoInput, output: BackupStatusSchema },
  'backup:chooseFolder': { input: NoInput, output: ChosenPathSchema },
  'backup:setup': {
    input: z.object({ destinationPath: z.string().min(1).max(1024), recoveryPassword: RecoveryPasswordInput }),
    output: z.null(),
  },
  'backup:addDestination': { input: PathInput, output: z.null() },
  'backup:removeDestination': { input: z.object({ id: z.number().int().positive() }), output: z.null() },
  'backup:setSchedule': { input: BackupScheduleSchema, output: z.null() },
  'backup:runNow': { input: NoInput, output: BackupRunResultSchema },
  'backup:history': {
    input: z.object({ limit: z.number().int().min(1).max(500) }),
    output: z.array(BackupHistoryEntrySchema),
  },

  'restore:chooseFile': { input: NoInput, output: ChosenPathSchema },
  'restore:inspect': { input: PathInput, output: BackupInspectionSchema },
  'restore:verify': {
    input: PathInput.extend({ recoveryPassword: RecoveryPasswordInput.optional() }),
    output: BackupVerificationSchema,
  },
  'restore:start': {
    input: PathInput.extend({
      recoveryPassword: RecoveryPasswordInput.optional(),
      confirmation: z.literal('RESTORE'),
    }),
    output: z.null(),
  },
  'restore:lastOutcome': { input: NoInput, output: RestoreOutcomeSchema },

  'license:status': { input: NoInput, output: LicenseStatusSchema },
  'license:requestCode': { input: NoInput, output: z.object({ code: z.string() }) },
  'license:saveRequestFile': { input: NoInput, output: ChosenPathSchema },
  'license:importFile': { input: NoInput, output: LicenseStatusSchema.nullable() },
  'license:importCode': { input: z.object({ code: z.string().min(10).max(20000) }), output: LicenseStatusSchema },

  'setup:state': { input: NoInput, output: SetupStateSchema },
  'setup:createShop': {
    input: z.object({ shop: ShopProfileSchema, owner: NewUserSchema.omit({ role: true }) }),
    output: SessionUserSchema,
  },

  'auth:session': { input: NoInput, output: SessionUserSchema.nullable() },
  'auth:loginPassword': {
    input: z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) }),
    output: SessionUserSchema,
  },
  'auth:loginPin': { input: z.object({ userId: z.string().min(1), pin: z.string().min(1).max(12) }), output: SessionUserSchema },
  'auth:pinUsers': { input: NoInput, output: z.array(PinUserSchema) },
  'auth:lock': { input: NoInput, output: z.null() },
  'auth:changePassword': {
    input: z.object({ currentPassword: z.string().min(1).max(256), newPassword: UserPasswordSchema }),
    output: SessionUserSchema,
  },

  'users:list': { input: NoInput, output: z.array(UserSummarySchema) },
  'users:create': { input: NewUserSchema, output: z.null() },
  'users:update': {
    input: z.object({ id: z.string(), fullName: z.string().trim().min(1).max(100), role: RoleSchema, isActive: z.boolean() }),
    output: z.null(),
  },
  'users:resetPassword': { input: z.object({ id: z.string(), newPassword: UserPasswordSchema }), output: z.null() },
  'users:setPin': { input: z.object({ id: z.string(), pin: PinSchema.nullable() }), output: z.null() },

  'shop:get': { input: NoInput, output: ShopProfileSchema.nullable() },
  'shop:update': { input: ShopProfileSchema, output: z.null() },

  'catalog:brands': { input: NoInput, output: z.array(BrandSummarySchema) },
  'catalog:createBrand': { input: BrandInputSchema, output: Created },
  'catalog:createModel': { input: ModelInputSchema, output: Created },
  'catalog:variants': { input: ListQuery, output: z.array(VariantSummarySchema) },
  'catalog:createVariant': { input: VariantInputSchema, output: Created },
  'catalog:updateVariant': { input: VariantUpdateSchema, output: z.null() },
  'catalog:items': { input: ListQuery, output: z.array(ItemSummarySchema) },
  'catalog:createItem': { input: ItemInputSchema, output: Created },
  'catalog:updateItem': { input: ItemUpdateSchema, output: z.null() },

  'stock:devices': { input: z.object({ variantId: z.number().int().positive() }), output: z.array(StockDeviceSchema) },
  'stock:lookupImei': { input: z.object({ imei: z.string().trim().min(1).max(20) }), output: DeviceDetailSchema.nullable() },

  'accounts:list': { input: NoInput, output: z.array(AccountSummarySchema) },

  'suppliers:list': { input: z.object({ includeInactive: z.boolean().optional() }), output: z.array(SupplierSummarySchema) },
  'suppliers:create': { input: SupplierInputSchema, output: Created },
  'suppliers:update': { input: SupplierUpdateSchema, output: z.null() },
  'suppliers:statement': { input: z.object({ supplierId: z.number().int().positive() }), output: SupplierStatementSchema },
  'suppliers:pay': { input: SupplierPaymentInputSchema, output: z.object({ number: z.string() }) },

  'purchases:list': { input: z.object({ query: z.string().max(100).optional(), limit: z.number().int().min(1).max(500) }), output: z.array(PurchaseSummarySchema) },
  'purchases:get': { input: z.object({ id: z.number().int().positive() }), output: PurchaseDetailSchema },
  'purchases:checkImeis': {
    input: z.object({ imeis: z.array(z.string().max(20)).max(1000) }),
    output: z.array(z.object({ imei: z.string(), message: z.string() })),
  },
  'purchases:create': { input: PurchaseInputSchema, output: z.object({ id: z.number(), number: z.string() }) },
  'purchaseReturns:list': { input: z.object({ limit: z.number().int().min(1).max(500) }), output: z.array(PurchaseReturnSummarySchema) },
  'purchaseReturns:create': { input: PurchaseReturnInputSchema, output: z.object({ id: z.number(), number: z.string() }) },

  'customers:list': { input: z.object({ query: z.string().max(100).optional(), limit: z.number().int().min(1).max(500) }), output: z.array(CustomerSummarySchema) },
  'customers:create': { input: CustomerInputSchema, output: Created },

  'pos:lookup': { input: z.object({ code: z.string().trim().min(1).max(64) }), output: PosLookupSchema.nullable() },
  'sales:list': { input: z.object({ query: z.string().max(100).optional(), limit: z.number().int().min(1).max(500) }), output: z.array(SaleSummarySchema) },
  'sales:get': { input: z.object({ id: z.number().int().positive() }), output: SaleDetailSchema },
  'sales:create': { input: SaleInputSchema, output: z.object({ id: z.number(), number: z.string() }) },
  'saleReturns:list': { input: z.object({ limit: z.number().int().min(1).max(500) }), output: z.array(SaleReturnSummarySchema) },
  'saleReturns:create': { input: SaleReturnInputSchema, output: z.object({ id: z.number(), number: z.string() }) },
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
  'UNAUTHENTICATED',
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

/** Events pushed from the main process to the screen. */
export type AppEvent =
  | { type: 'backup.started'; kind: string }
  | { type: 'backup.finished'; kind: string; status: 'success' | 'partial' | 'failed'; error: string | null }
  | { type: 'license.changed' }
  | { type: 'session.ended' };

/** The API the preload bridge exposes on `window.nexodesk`. */
export interface NexoDeskBridge {
  invoke<C extends IpcChannel>(channel: C, input?: IpcInput<C>): Promise<IpcResult<IpcOutput<C>>>;
  /** Subscribes to app events; returns a function that unsubscribes. */
  onEvent(listener: (event: AppEvent) => void): () => void;
}
