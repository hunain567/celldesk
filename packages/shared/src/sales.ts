import { z } from 'zod';
import { ConditionSchema, MoneySchema, PtaStatusSchema, WarrantyTypeSchema } from './inventory';

// ---------- Customers ----------

export const CustomerInputSchema = z.object({
  name: z.string().trim().min(1, 'Enter the customer name').max(120),
  phone: z.string().trim().max(40),
  city: z.string().trim().max(80),
  address: z.string().trim().max(300),
});
export type CustomerInput = z.infer<typeof CustomerInputSchema>;

export const CustomerSummarySchema = z.object({
  id: z.number(),
  name: z.string(),
  phone: z.string(),
  city: z.string(),
  address: z.string(),
  isActive: z.boolean(),
  /** Positive: the customer owes the shop. Negative: the shop owes the customer. */
  balance: z.number(),
  lastSaleDate: z.string().nullable(),
});
export type CustomerSummary = z.infer<typeof CustomerSummarySchema>;

// ---------- Point of sale lookups ----------

export const PosDeviceSchema = z.object({
  id: z.number(),
  imei1: z.string(),
  imei2: z.string().nullable(),
  variantId: z.number(),
  label: z.string(),
  condition: ConditionSchema,
  ptaStatus: PtaStatusSchema,
  warrantyType: WarrantyTypeSchema,
  warrantyMonths: z.number(),
  salePrice: z.number(),
  minSalePrice: z.number(),
});
export type PosDevice = z.infer<typeof PosDeviceSchema>;

export const PosItemSchema = z.object({
  id: z.number(),
  name: z.string(),
  barcode: z.string().nullable(),
  salePrice: z.number(),
  onHand: z.number(),
});
export type PosItem = z.infer<typeof PosItemSchema>;

/** What a scanned IMEI or barcode turned out to be. */
export const PosLookupSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('device'), device: PosDeviceSchema }),
  z.object({ kind: z.literal('item'), item: PosItemSchema }),
  z.object({ kind: z.literal('unavailable'), message: z.string() }),
  z.object({ kind: z.literal('sold'), message: z.string(), saleId: z.number(), saleNumber: z.string() }),
]);
export type PosLookup = z.infer<typeof PosLookupSchema>;

// ---------- Sales ----------

export const SaleLineInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('device'), deviceId: z.number().int().positive(), unitPrice: MoneySchema }),
  z.object({
    kind: z.literal('item'),
    itemId: z.number().int().positive(),
    quantity: z.number().int().min(1).max(100000),
    unitPrice: MoneySchema,
  }),
]);
export type SaleLineInput = z.infer<typeof SaleLineInputSchema>;

export const SalePaymentInputSchema = z.object({
  accountId: z.number().int().positive(),
  amount: MoneySchema.refine((value) => value > 0, 'Enter the amount'),
  reference: z.string().trim().max(80),
});
export type SalePaymentInput = z.infer<typeof SalePaymentInputSchema>;

export const ReturnLineInputSchema = z.object({
  saleLineId: z.number().int().positive(),
  quantity: z.number().int().min(1).max(100000),
});
export type ReturnLineInput = z.infer<typeof ReturnLineInputSchema>;

/** Money paid back to the customer when a return is worth more than what they take. */
export const RefundInputSchema = z.object({ accountId: z.number().int().positive(), amount: MoneySchema });

export const SaleInputSchema = z.object({
  customerId: z.number().int().positive().nullable(),
  /** Name and phone printed on the receipt for a walk-in customer. */
  customerName: z.string().trim().max(120),
  customerPhone: z.string().trim().max(40),
  lines: z.array(SaleLineInputSchema).min(1, 'Add at least one item').max(200),
  discount: MoneySchema,
  payments: z.array(SalePaymentInputSchema).max(10),
  /** Items from an earlier sale taken back in exchange; their value pays for this sale first. */
  exchange: z
    .object({
      saleId: z.number().int().positive(),
      lines: z.array(ReturnLineInputSchema).min(1).max(200),
      reason: z.string().trim().min(1, 'Enter the reason for the exchange').max(300),
    })
    .nullable(),
  /** Used when the exchanged items are worth more than this sale. */
  refund: RefundInputSchema.nullable(),
  notes: z.string().trim().max(500),
});
export type SaleInput = z.infer<typeof SaleInputSchema>;

export const SaleSummarySchema = z.object({
  id: z.number(),
  number: z.string(),
  saleDate: z.string(),
  createdAt: z.string(),
  customerId: z.number().nullable(),
  customerName: z.string(),
  customerPhone: z.string(),
  total: z.number(),
  exchangeCredit: z.number(),
  paid: z.number(),
  /** Left on the customer's account. */
  due: z.number(),
  units: z.number(),
  hasReturns: z.boolean(),
  createdBy: z.string(),
});
export type SaleSummary = z.infer<typeof SaleSummarySchema>;

export const SaleLineSchema = z.object({
  id: z.number(),
  lineNo: z.number(),
  kind: z.enum(['device', 'item']),
  description: z.string(),
  imei1: z.string().nullable(),
  imei2: z.string().nullable(),
  condition: ConditionSchema.nullable(),
  ptaStatus: PtaStatusSchema.nullable(),
  warrantyType: WarrantyTypeSchema.nullable(),
  warrantyMonths: z.number().nullable(),
  quantity: z.number(),
  returnedQuantity: z.number(),
  unitPrice: z.number(),
  /** Price after the bill discount, used for returns. */
  netUnitPrice: z.number(),
  lineTotal: z.number(),
  /** Null when the user may not see cost prices. */
  unitCost: z.number().nullable(),
});
export type SaleLine = z.infer<typeof SaleLineSchema>;

export const SaleDetailSchema = SaleSummarySchema.extend({
  subtotal: z.number(),
  discount: z.number(),
  exchangeReturnNumber: z.string().nullable(),
  /** Refund paid out when the exchanged items were worth more than this sale. */
  exchangeRefund: z.number(),
  notes: z.string(),
  lines: z.array(SaleLineSchema),
  payments: z.array(z.object({ accountName: z.string(), amount: z.number(), reference: z.string() })),
  returns: z.array(z.object({ id: z.number(), number: z.string(), returnDate: z.string(), total: z.number(), refunded: z.number() })),
  /** Null when the user may not see cost prices. */
  profit: z.number().nullable(),
});
export type SaleDetail = z.infer<typeof SaleDetailSchema>;

export const SaleReturnInputSchema = z.object({
  saleId: z.number().int().positive(),
  lines: z.array(ReturnLineInputSchema).min(1, 'Choose what is being returned').max(200),
  reason: z.string().trim().min(1, 'Enter the reason for the return').max(300),
  /** Money paid back. Whatever is not refunded is credited to the customer's account. */
  refund: RefundInputSchema.nullable(),
});
export type SaleReturnInput = z.infer<typeof SaleReturnInputSchema>;

export const SaleReturnSummarySchema = z.object({
  id: z.number(),
  number: z.string(),
  returnDate: z.string(),
  saleId: z.number(),
  saleNumber: z.string(),
  customerName: z.string(),
  total: z.number(),
  refunded: z.number(),
  /** Used to pay for an exchange sale. */
  exchangeSaleNumber: z.string().nullable(),
  units: z.number(),
  reason: z.string(),
  createdBy: z.string(),
});
export type SaleReturnSummary = z.infer<typeof SaleReturnSummarySchema>;

export const ReceiptPaperSchema = z.enum(['80mm', 'a4']);
export type ReceiptPaper = z.infer<typeof ReceiptPaperSchema>;
