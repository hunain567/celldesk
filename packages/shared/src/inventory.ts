import { z } from 'zod';

/** Amount in paisa (integer, never negative here). */
export const MoneySchema = z.number().int().min(0).max(1_000_000_000_00);
export const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-11-24');
const Name = (label: string, max = 100) => z.string().trim().min(1, `Enter the ${label}`).max(max);

export const ConditionSchema = z.enum(['new', 'open_box', 'used', 'refurbished']);
export const PtaStatusSchema = z.enum(['approved', 'non_pta', 'patched']);
export const WarrantyTypeSchema = z.enum(['official', 'shop', 'none']);
export const DeviceStatusSchema = z.enum(['in_stock', 'sold', 'returned_to_supplier']);
export type Condition = z.infer<typeof ConditionSchema>;
export type PtaStatus = z.infer<typeof PtaStatusSchema>;
export type WarrantyType = z.infer<typeof WarrantyTypeSchema>;
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

export const CONDITION_LABELS: Record<Condition, string> = {
  new: 'New (box pack)',
  open_box: 'Open box',
  used: 'Used',
  refurbished: 'Refurbished',
};
export const PTA_LABELS: Record<PtaStatus, string> = { approved: 'PTA approved', non_pta: 'Non-PTA', patched: 'Patched' };
export const WARRANTY_LABELS: Record<WarrantyType, string> = { official: 'Official', shop: 'Shop', none: 'No warranty' };
export const DEVICE_STATUS_LABELS: Record<DeviceStatus, string> = {
  in_stock: 'In stock',
  sold: 'Sold',
  returned_to_supplier: 'Returned to supplier',
};

/** IMEI: 15 digits with a valid Luhn check digit. */
export function isValidImei(value: string): boolean {
  if (!/^\d{15}$/.test(value)) return false;
  let sum = 0;
  for (let index = 0; index < 15; index += 1) {
    let digit = Number(value[index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

export const ImeiSchema = z
  .string()
  .trim()
  .refine(isValidImei, 'An IMEI has 15 digits and a valid check digit. Scan it again.');

// ---------- Catalogue ----------

export const BrandInputSchema = z.object({ name: Name('brand name', 60) });
export const ModelInputSchema = z.object({ brandId: z.number().int().positive(), name: Name('model name', 80) });
export const VariantInputSchema = z.object({
  modelId: z.number().int().positive(),
  ramGb: z.number().int().min(1).max(64).nullable(),
  storageGb: z.number().int().min(1).max(4096).nullable(),
  colour: z.string().trim().max(40),
  salePrice: MoneySchema,
  minSalePrice: MoneySchema,
});
export const VariantUpdateSchema = z.object({
  id: z.number().int().positive(),
  salePrice: MoneySchema,
  minSalePrice: MoneySchema,
  isActive: z.boolean(),
});
export const ItemInputSchema = z.object({
  name: Name('item name', 120),
  category: z.string().trim().max(60),
  barcode: z.string().trim().max(64).nullable(),
  salePrice: MoneySchema,
  reorderLevel: z.number().int().min(0).max(100000),
});
export const ItemUpdateSchema = ItemInputSchema.extend({ id: z.number().int().positive(), isActive: z.boolean() });

export const VariantSummarySchema = z.object({
  id: z.number(),
  modelId: z.number(),
  brandId: z.number(),
  brandName: z.string(),
  modelName: z.string(),
  ramGb: z.number().nullable(),
  storageGb: z.number().nullable(),
  colour: z.string(),
  label: z.string(),
  salePrice: z.number(),
  minSalePrice: z.number(),
  isActive: z.boolean(),
  inStock: z.number(),
  /** Null when the user may not see cost prices. */
  stockValue: z.number().nullable(),
  lastCost: z.number().nullable(),
});
export type VariantSummary = z.infer<typeof VariantSummarySchema>;

export const ModelSummarySchema = z.object({ id: z.number(), brandId: z.number(), name: z.string(), isActive: z.boolean() });
export const BrandSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  isActive: z.boolean(),
  models: z.array(ModelSummarySchema),
});
export type BrandSummary = z.infer<typeof BrandSummarySchema>;

export const ItemSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  category: z.string(),
  barcode: z.string().nullable(),
  salePrice: z.number(),
  averageCost: z.number().nullable(),
  reorderLevel: z.number(),
  onHand: z.number(),
  isActive: z.boolean(),
});
export type ItemSummary = z.infer<typeof ItemSummarySchema>;

// ---------- Suppliers and money accounts ----------

export const SupplierInputSchema = z.object({
  name: Name('supplier name', 120),
  phone: z.string().trim().max(40),
  city: z.string().trim().max(80),
  address: z.string().trim().max(300),
  /** Amount already owed to this supplier when it is added. */
  openingBalance: MoneySchema,
});
export const SupplierUpdateSchema = SupplierInputSchema.omit({ openingBalance: true }).extend({
  id: z.number().int().positive(),
  isActive: z.boolean(),
});

export const SupplierSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  phone: z.string(),
  city: z.string(),
  address: z.string(),
  isActive: z.boolean(),
  /** Positive: the shop owes the supplier. */
  balance: z.number(),
  lastPurchaseDate: z.string().nullable(),
});
export type SupplierSummary = z.infer<typeof SupplierSummarySchema>;

export const LedgerEntrySchema = z.object({
  id: z.number(),
  date: z.string(),
  docType: z.string(),
  docNumber: z.string().nullable(),
  memo: z.string(),
  debit: z.number(),
  credit: z.number(),
  balance: z.number(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const SupplierStatementSchema = z.object({ supplier: SupplierSummarySchema, entries: z.array(LedgerEntrySchema) });
export type SupplierStatement = z.infer<typeof SupplierStatementSchema>;

export const AccountSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  kind: z.enum(['cash', 'wallet', 'bank']),
  isActive: z.boolean(),
});
export type AccountSummary = z.infer<typeof AccountSummarySchema>;

export const PaymentInputSchema = z.object({ accountId: z.number().int().positive(), amount: MoneySchema.refine((v) => v > 0, 'Enter the amount'), reference: z.string().trim().max(80) });

export const SupplierPaymentInputSchema = PaymentInputSchema.extend({
  supplierId: z.number().int().positive(),
  paymentDate: LocalDateSchema,
  notes: z.string().trim().max(300),
});

// ---------- Purchases ----------

export const NewDeviceSchema = z.object({
  imei1: ImeiSchema,
  imei2: ImeiSchema.nullable(),
  condition: ConditionSchema,
  ptaStatus: PtaStatusSchema,
  warrantyType: WarrantyTypeSchema,
  warrantyMonths: z.number().int().min(0).max(60),
});
export type NewDevice = z.infer<typeof NewDeviceSchema>;

export const PurchaseLineInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('device'),
    variantId: z.number().int().positive(),
    unitCost: MoneySchema,
    devices: z.array(NewDeviceSchema).min(1, 'Scan at least one IMEI').max(500),
  }),
  z.object({
    kind: z.literal('item'),
    itemId: z.number().int().positive(),
    quantity: z.number().int().min(1).max(100000),
    unitCost: MoneySchema,
  }),
]);
export type PurchaseLineInput = z.infer<typeof PurchaseLineInputSchema>;

export const PurchaseInputSchema = z.object({
  supplierId: z.number().int().positive(),
  supplierInvoiceNo: z.string().trim().max(60),
  purchaseDate: LocalDateSchema,
  discount: MoneySchema,
  notes: z.string().trim().max(500),
  lines: z.array(PurchaseLineInputSchema).min(1, 'Add at least one item').max(200),
  payment: PaymentInputSchema.nullable(),
});
export type PurchaseInput = z.infer<typeof PurchaseInputSchema>;

export const PurchaseSummarySchema = z.object({
  id: z.number(),
  number: z.string(),
  purchaseDate: z.string(),
  supplierId: z.number(),
  supplierName: z.string(),
  supplierInvoiceNo: z.string(),
  total: z.number(),
  paid: z.number(),
  units: z.number(),
  createdBy: z.string(),
});
export type PurchaseSummary = z.infer<typeof PurchaseSummarySchema>;

export const PurchaseDetailSchema = PurchaseSummarySchema.extend({
  subtotal: z.number(),
  discount: z.number(),
  notes: z.string(),
  createdAt: z.string(),
  lines: z.array(
    z.object({
      lineNo: z.number(),
      description: z.string(),
      quantity: z.number(),
      unitCost: z.number(),
      lineTotal: z.number(),
      devices: z.array(z.object({ id: z.number(), imei1: z.string(), imei2: z.string().nullable(), status: DeviceStatusSchema })),
    }),
  ),
});
export type PurchaseDetail = z.infer<typeof PurchaseDetailSchema>;

export const PurchaseReturnInputSchema = z.object({
  supplierId: z.number().int().positive(),
  returnDate: LocalDateSchema,
  reason: z.string().trim().max(300),
  deviceIds: z.array(z.number().int().positive()).max(500),
  items: z.array(z.object({ itemId: z.number().int().positive(), quantity: z.number().int().min(1) })).max(200),
  /** Money received back from the supplier. Without it, the return reduces what the shop owes. */
  refund: PaymentInputSchema.nullable(),
});
export type PurchaseReturnInput = z.infer<typeof PurchaseReturnInputSchema>;

export const PurchaseReturnSummarySchema = z.object({
  id: z.number(),
  number: z.string(),
  returnDate: z.string(),
  supplierName: z.string(),
  total: z.number(),
  units: z.number(),
  reason: z.string(),
  createdBy: z.string(),
});
export type PurchaseReturnSummary = z.infer<typeof PurchaseReturnSummarySchema>;

// ---------- Stock lookups ----------

export const DeviceDetailSchema = z.object({
  id: z.number(),
  imei1: z.string(),
  imei2: z.string().nullable(),
  variantId: z.number(),
  label: z.string(),
  condition: ConditionSchema,
  ptaStatus: PtaStatusSchema,
  warrantyType: WarrantyTypeSchema,
  warrantyMonths: z.number(),
  status: DeviceStatusSchema,
  cost: z.number().nullable(),
  salePrice: z.number(),
  supplierId: z.number().nullable(),
  supplierName: z.string().nullable(),
  purchaseNumber: z.string().nullable(),
  purchaseDate: z.string().nullable(),
  history: z.array(z.object({ at: z.string(), docType: z.string(), docNumber: z.string().nullable(), quantity: z.number(), createdBy: z.string() })),
});
export type DeviceDetail = z.infer<typeof DeviceDetailSchema>;

export const StockDeviceSchema = z.object({
  id: z.number(),
  imei1: z.string(),
  imei2: z.string().nullable(),
  condition: ConditionSchema,
  ptaStatus: PtaStatusSchema,
  cost: z.number().nullable(),
  supplierName: z.string().nullable(),
  receivedAt: z.string(),
});
export type StockDevice = z.infer<typeof StockDeviceSchema>;

export function variantLabel(parts: { brandName: string; modelName: string; ramGb: number | null; storageGb: number | null; colour: string }): string {
  const memory = parts.ramGb && parts.storageGb ? `${parts.ramGb}/${parts.storageGb}` : parts.storageGb ? `${parts.storageGb}GB` : '';
  return [parts.brandName, parts.modelName, memory, parts.colour].filter(Boolean).join(' ');
}
