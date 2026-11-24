import {
  isValidImei,
  PurchaseInputSchema,
  PurchaseReturnInputSchema,
  SupplierInputSchema,
  SupplierPaymentInputSchema,
  SupplierUpdateSchema,
  variantLabel,
  type AccountSummary,
  type LedgerEntry,
  type PurchaseDetail,
  type PurchaseInput,
  type PurchaseReturnInput,
  type PurchaseReturnSummary,
  type PurchaseSummary,
  type SupplierStatement,
  type SupplierSummary,
} from '@nexodesk/shared';
import type { z } from 'zod';
import { AppError } from '../errors';
import { accountExists, localDate, nextNumber, notFound, nowOf, uniqueViolation, type BusinessContext } from './business';

const DOC_LABELS: Record<string, string> = {
  opening: 'Opening balance',
  purchase: 'Purchase',
  purchase_return: 'Purchase return',
  payment: 'Payment',
  refund: 'Refund received',
};

function invalid(message: string, details?: string[]): AppError {
  return new AppError('VALIDATION_FAILED', message, details);
}

/** Suppliers, purchase invoices, supplier payments and purchase returns. */
export class PurchasingService {
  constructor(private readonly context: BusinessContext) {}

  private get db() {
    return this.context.db;
  }

  // ---------- Accounts ----------

  accounts(): AccountSummary[] {
    return (
      this.db.prepare('SELECT id, name, kind, is_active FROM accounts ORDER BY id').all() as Array<{
        id: number;
        name: string;
        kind: AccountSummary['kind'];
        is_active: number;
      }>
    ).map((row) => ({ id: row.id, name: row.name, kind: row.kind, isActive: row.is_active === 1 }));
  }

  // ---------- Suppliers ----------

  private balanceOf(supplierId: number): number {
    const row = this.db
      .prepare(`SELECT coalesce(sum(credit - debit), 0) AS balance FROM party_ledger WHERE party_type = 'supplier' AND party_id = ?`)
      .get(supplierId) as { balance: number };
    return row.balance;
  }

  suppliers(options: { includeInactive?: boolean } = {}): SupplierSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.*,
           coalesce((SELECT sum(credit - debit) FROM party_ledger p WHERE p.party_type = 'supplier' AND p.party_id = s.id), 0) AS balance,
           (SELECT max(purchase_date) FROM purchases WHERE supplier_id = s.id) AS last_purchase_date
         FROM suppliers s WHERE (? = 1 OR s.is_active = 1) ORDER BY s.name`,
      )
      .all(options.includeInactive ? 1 : 0) as Array<{
      id: number;
      name: string;
      phone: string;
      city: string;
      address: string;
      is_active: number;
      balance: number;
      last_purchase_date: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      city: row.city,
      address: row.address,
      isActive: row.is_active === 1,
      balance: row.balance,
      lastPurchaseDate: row.last_purchase_date,
    }));
  }

  createSupplier(input: z.infer<typeof SupplierInputSchema>, actor: string): number {
    const supplier = SupplierInputSchema.parse(input);
    if (supplier.openingBalance > 0) this.context.assertCanWrite();
    const now = nowOf(this.context);
    const create = this.db.transaction(() => {
      const id = Number(
        this.db
          .prepare('INSERT INTO suppliers (name, phone, city, address, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(supplier.name, supplier.phone, supplier.city, supplier.address, now.toISOString()).lastInsertRowid,
      );
      if (supplier.openingBalance > 0) {
        this.db
          .prepare(
            `INSERT INTO party_ledger (at, entry_date, party_type, party_id, credit, doc_type, memo, created_by)
             VALUES (?, ?, 'supplier', ?, ?, 'opening', 'Opening balance', ?)`,
          )
          .run(now.toISOString(), localDate(now), id, supplier.openingBalance, actor);
      }
      this.context.audit.append({ actor, action: 'supplier.create', entityType: 'supplier', entityId: String(id), details: { name: supplier.name, opening: supplier.openingBalance } });
      return id;
    });
    try {
      return create();
    } catch (error) {
      return uniqueViolation(error, `A supplier named "${supplier.name}" already exists.`);
    }
  }

  updateSupplier(input: z.infer<typeof SupplierUpdateSchema>, actor: string): void {
    const supplier = SupplierUpdateSchema.parse(input);
    try {
      const result = this.db
        .prepare('UPDATE suppliers SET name = ?, phone = ?, city = ?, address = ?, is_active = ? WHERE id = ?')
        .run(supplier.name, supplier.phone, supplier.city, supplier.address, supplier.isActive ? 1 : 0, supplier.id);
      if (result.changes === 0) throw notFound('The supplier');
    } catch (error) {
      uniqueViolation(error, `A supplier named "${supplier.name}" already exists.`);
    }
    this.context.audit.append({ actor, action: 'supplier.update', entityType: 'supplier', entityId: String(supplier.id) });
  }

  statement(supplierId: number): SupplierStatement {
    const supplier = this.suppliers({ includeInactive: true }).find((row) => row.id === supplierId);
    if (!supplier) throw notFound('The supplier');
    const rows = this.db
      .prepare(
        `SELECT p.id, p.entry_date, p.doc_type, p.doc_id, p.memo, p.debit, p.credit,
           CASE p.doc_type
             WHEN 'purchase' THEN (SELECT number FROM purchases WHERE id = p.doc_id)
             WHEN 'purchase_return' THEN (SELECT number FROM purchase_returns WHERE id = p.doc_id)
             WHEN 'payment' THEN (SELECT number FROM payments WHERE id = p.doc_id)
             WHEN 'refund' THEN (SELECT number FROM payments WHERE id = p.doc_id)
           END AS doc_number
         FROM party_ledger p WHERE p.party_type = 'supplier' AND p.party_id = ? ORDER BY p.entry_date, p.id`,
      )
      .all(supplierId) as Array<{
      id: number;
      entry_date: string;
      doc_type: string;
      memo: string;
      debit: number;
      credit: number;
      doc_number: string | null;
    }>;
    let running = 0;
    const entries: LedgerEntry[] = rows.map((row) => {
      running += row.credit - row.debit;
      return {
        id: row.id,
        date: row.entry_date,
        docType: DOC_LABELS[row.doc_type] ?? row.doc_type,
        docNumber: row.doc_number,
        memo: row.memo,
        debit: row.debit,
        credit: row.credit,
        balance: running,
      };
    });
    return { supplier, entries };
  }

  /** Writes a payment to a supplier: money leaves an account and the amount owed goes down. */
  private writePayment(options: {
    supplierId: number;
    accountId: number;
    amount: number;
    date: string;
    reference: string;
    notes: string;
    docType: 'purchase' | null;
    docId: number | null;
    actor: string;
  }): { id: number; number: string } {
    accountExists(this.db, options.accountId);
    const now = nowOf(this.context);
    const number = nextNumber(this.db, 'PAY', now);
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO payments (number, payment_date, direction, party_type, party_id, account_id, amount, reference, notes, doc_type, doc_id, created_by, created_at)
           VALUES (?, ?, 'out', 'supplier', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(number, options.date, options.supplierId, options.accountId, options.amount, options.reference, options.notes, options.docType, options.docId, options.actor, now.toISOString())
        .lastInsertRowid,
    );
    const memo = options.reference ? `Ref ${options.reference}` : options.notes;
    this.db
      .prepare(
        `INSERT INTO party_ledger (at, entry_date, party_type, party_id, debit, doc_type, doc_id, memo, created_by)
         VALUES (?, ?, 'supplier', ?, ?, 'payment', ?, ?, ?)`,
      )
      .run(now.toISOString(), options.date, options.supplierId, options.amount, id, memo, options.actor);
    this.db
      .prepare(
        `INSERT INTO money_ledger (at, entry_date, account_id, amount, doc_type, doc_id, memo, created_by)
         VALUES (?, ?, ?, ?, 'payment', ?, ?, ?)`,
      )
      .run(now.toISOString(), options.date, options.accountId, -options.amount, id, `Paid supplier ${number}`, options.actor);
    return { id, number };
  }

  paySupplier(input: z.infer<typeof SupplierPaymentInputSchema>, actor: string): { number: string } {
    this.context.assertCanWrite();
    const payment = SupplierPaymentInputSchema.parse(input);
    if (!this.db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(payment.supplierId)) throw notFound('The supplier');
    const run = this.db.transaction(() => {
      const written = this.writePayment({ ...payment, date: payment.paymentDate, docType: null, docId: null, actor });
      this.context.audit.append({
        actor,
        action: 'supplier.payment',
        entityType: 'payment',
        entityId: written.number,
        details: { supplierId: payment.supplierId, amount: payment.amount, accountId: payment.accountId },
      });
      return { number: written.number };
    });
    return run();
  }

  // ---------- Purchases ----------

  /** Returns a message for every IMEI that cannot be received (invalid, repeated, or already known). */
  checkImeis(imeis: string[]): Array<{ imei: string; message: string }> {
    const problems: Array<{ imei: string; message: string }> = [];
    const seen = new Set<string>();
    const existing = this.db.prepare(
      `SELECT d.imei1, d.status, p.number FROM devices d
       LEFT JOIN purchase_lines pl ON pl.id = d.purchase_line_id LEFT JOIN purchases p ON p.id = pl.purchase_id
       WHERE d.imei1 = ? OR d.imei2 = ?`,
    );
    for (const raw of imeis) {
      const imei = raw.trim();
      if (!isValidImei(imei)) {
        problems.push({ imei, message: 'Not a valid IMEI (15 digits with a correct check digit).' });
        continue;
      }
      if (seen.has(imei)) {
        problems.push({ imei, message: 'Scanned twice in this purchase.' });
        continue;
      }
      seen.add(imei);
      const found = existing.get(imei, imei) as { imei1: string; status: string; number: string | null } | undefined;
      if (found) {
        problems.push({
          imei,
          message: `Already in the system (${found.status.replace(/_/g, ' ')}${found.number ? `, ${found.number}` : ''}).`,
        });
      }
    }
    return problems;
  }

  createPurchase(input: PurchaseInput, actor: string): { id: number; number: string } {
    this.context.assertCanWrite();
    const purchase = PurchaseInputSchema.parse(input);
    if (!this.db.prepare('SELECT 1 FROM suppliers WHERE id = ? AND is_active = 1').get(purchase.supplierId)) {
      throw invalid('Choose an active supplier.');
    }

    const imeis = purchase.lines.flatMap((line) => (line.kind === 'device' ? line.devices.flatMap((device) => [device.imei1, ...(device.imei2 ? [device.imei2] : [])]) : []));
    const problems = this.checkImeis(imeis);
    if (problems.length > 0) {
      throw invalid(
        `${problems.length} IMEI${problems.length === 1 ? '' : 's'} cannot be received.`,
        problems.map((problem) => `${problem.imei}: ${problem.message}`),
      );
    }

    const lineTotals = purchase.lines.map((line) => (line.kind === 'device' ? line.unitCost * line.devices.length : line.unitCost * line.quantity));
    const subtotal = lineTotals.reduce((sum, value) => sum + value, 0);
    if (purchase.discount > subtotal) throw invalid('The discount cannot be more than the purchase amount.');
    const total = subtotal - purchase.discount;
    if (purchase.payment && purchase.payment.amount > total) throw invalid('The payment cannot be more than the purchase total.');

    // Discount is spread over the units so each handset's cost is what was really paid.
    const discountRatio = subtotal > 0 ? purchase.discount / subtotal : 0;
    const netUnitCost = (unitCost: number) => Math.round(unitCost * (1 - discountRatio));

    const now = nowOf(this.context);
    const run = this.db.transaction(() => {
      const number = nextNumber(this.db, 'PI', now);
      const purchaseId = Number(
        this.db
          .prepare(
            `INSERT INTO purchases (number, supplier_id, supplier_invoice_no, purchase_date, subtotal, discount, total, notes, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(number, purchase.supplierId, purchase.supplierInvoiceNo, purchase.purchaseDate, subtotal, purchase.discount, total, purchase.notes, actor, now.toISOString())
          .lastInsertRowid,
      );

      const insertLine = this.db.prepare(
        `INSERT INTO purchase_lines (purchase_id, line_no, variant_id, item_id, quantity, unit_cost, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertDevice = this.db.prepare(
        `INSERT INTO devices (variant_id, imei1, imei2, condition, pta_status, warranty_type, warranty_months, cost, status, purchase_line_id, supplier_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_stock', ?, ?, ?)`,
      );
      const insertStock = this.db.prepare(
        `INSERT INTO stock_ledger (at, device_id, item_id, quantity, unit_cost, doc_type, doc_id, created_by)
         VALUES (?, ?, ?, ?, ?, 'purchase', ?, ?)`,
      );

      purchase.lines.forEach((line, index) => {
        if (line.kind === 'device') {
          if (!this.db.prepare('SELECT 1 FROM variants WHERE id = ?').get(line.variantId)) throw invalid(`Line ${index + 1}: the handset variant no longer exists.`);
          const lineId = Number(insertLine.run(purchaseId, index + 1, line.variantId, null, line.devices.length, line.unitCost, lineTotals[index]).lastInsertRowid);
          const cost = netUnitCost(line.unitCost);
          for (const device of line.devices) {
            const deviceId = Number(
              insertDevice.run(
                line.variantId,
                device.imei1,
                device.imei2,
                device.condition,
                device.ptaStatus,
                device.warrantyType,
                device.warrantyType === 'none' ? 0 : device.warrantyMonths,
                cost,
                lineId,
                purchase.supplierId,
                now.toISOString(),
              ).lastInsertRowid,
            );
            insertStock.run(now.toISOString(), deviceId, null, 1, cost, purchaseId, actor);
          }
        } else {
          const item = this.db.prepare('SELECT average_cost FROM items WHERE id = ?').get(line.itemId) as { average_cost: number } | undefined;
          if (!item) throw invalid(`Line ${index + 1}: the item no longer exists.`);
          insertLine.run(purchaseId, index + 1, null, line.itemId, line.quantity, line.unitCost, lineTotals[index]);
          const cost = netUnitCost(line.unitCost);
          // Moving average cost, based on the quantity on hand before this purchase.
          const onHand = (this.db.prepare('SELECT coalesce(sum(quantity), 0) AS q FROM stock_ledger WHERE item_id = ?').get(line.itemId) as { q: number }).q;
          const base = Math.max(onHand, 0);
          const average = Math.round((item.average_cost * base + cost * line.quantity) / (base + line.quantity));
          this.db.prepare('UPDATE items SET average_cost = ? WHERE id = ?').run(average, line.itemId);
          insertStock.run(now.toISOString(), null, line.itemId, line.quantity, cost, purchaseId, actor);
        }
      });

      if (total > 0) {
        this.db
          .prepare(
            `INSERT INTO party_ledger (at, entry_date, party_type, party_id, credit, doc_type, doc_id, memo, created_by)
             VALUES (?, ?, 'supplier', ?, ?, 'purchase', ?, ?, ?)`,
          )
          .run(now.toISOString(), purchase.purchaseDate, purchase.supplierId, total, purchaseId, purchase.supplierInvoiceNo ? `Invoice ${purchase.supplierInvoiceNo}` : '', actor);
      }
      if (purchase.payment) {
        this.writePayment({
          supplierId: purchase.supplierId,
          accountId: purchase.payment.accountId,
          amount: purchase.payment.amount,
          date: purchase.purchaseDate,
          reference: purchase.payment.reference,
          notes: `Paid with ${number}`,
          docType: 'purchase',
          docId: purchaseId,
          actor,
        });
      }

      this.context.audit.append({
        actor,
        action: 'purchase.create',
        entityType: 'purchase',
        entityId: number,
        details: { supplierId: purchase.supplierId, total, units: imeis.length, paid: purchase.payment?.amount ?? 0 },
      });
      return { id: purchaseId, number };
    });

    try {
      return run();
    } catch (error) {
      return uniqueViolation(error, 'One of the IMEIs was received by another purchase at the same time. Check the IMEIs and try again.');
    }
  }

  purchases(options: { query?: string; limit: number }): PurchaseSummary[] {
    const query = `%${(options.query ?? '').trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT p.id, p.number, p.purchase_date, p.supplier_id, s.name AS supplier_name, p.supplier_invoice_no, p.total, p.created_by,
           coalesce((SELECT sum(amount) FROM payments WHERE doc_type = 'purchase' AND doc_id = p.id), 0) AS paid,
           coalesce((SELECT sum(quantity) FROM purchase_lines WHERE purchase_id = p.id), 0) AS units
         FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
         WHERE p.number LIKE ? OR s.name LIKE ? OR p.supplier_invoice_no LIKE ?
            OR p.id IN (SELECT pl.purchase_id FROM purchase_lines pl JOIN devices d ON d.purchase_line_id = pl.id WHERE d.imei1 = ? OR d.imei2 = ?)
         ORDER BY p.id DESC LIMIT ?`,
      )
      .all(query, query, query, options.query?.trim() ?? '', options.query?.trim() ?? '', options.limit) as Array<{
      id: number;
      number: string;
      purchase_date: string;
      supplier_id: number;
      supplier_name: string;
      supplier_invoice_no: string;
      total: number;
      paid: number;
      units: number;
      created_by: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      purchaseDate: row.purchase_date,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      supplierInvoiceNo: row.supplier_invoice_no,
      total: row.total,
      paid: row.paid,
      units: row.units,
      createdBy: row.created_by,
    }));
  }

  purchase(id: number): PurchaseDetail {
    const summary = this.db
      .prepare(
        `SELECT p.*, s.name AS supplier_name,
           coalesce((SELECT sum(amount) FROM payments WHERE doc_type = 'purchase' AND doc_id = p.id), 0) AS paid
         FROM purchases p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?`,
      )
      .get(id) as
      | {
          id: number;
          number: string;
          purchase_date: string;
          supplier_id: number;
          supplier_name: string;
          supplier_invoice_no: string;
          subtotal: number;
          discount: number;
          total: number;
          paid: number;
          notes: string;
          created_by: string;
          created_at: string;
        }
      | undefined;
    if (!summary) throw notFound('The purchase');
    const lines = this.db
      .prepare(
        `SELECT pl.*, i.name AS item_name, v.ram_gb, v.storage_gb, v.colour, m.name AS model_name, b.name AS brand_name
         FROM purchase_lines pl
         LEFT JOIN items i ON i.id = pl.item_id
         LEFT JOIN variants v ON v.id = pl.variant_id LEFT JOIN models m ON m.id = v.model_id LEFT JOIN brands b ON b.id = m.brand_id
         WHERE pl.purchase_id = ? ORDER BY pl.line_no`,
      )
      .all(id) as Array<{
      id: number;
      line_no: number;
      item_name: string | null;
      ram_gb: number | null;
      storage_gb: number | null;
      colour: string | null;
      model_name: string | null;
      brand_name: string | null;
      quantity: number;
      unit_cost: number;
      line_total: number;
    }>;
    const devices = this.db.prepare('SELECT id, imei1, imei2, status FROM devices WHERE purchase_line_id = ? ORDER BY id');
    return {
      id: summary.id,
      number: summary.number,
      purchaseDate: summary.purchase_date,
      supplierId: summary.supplier_id,
      supplierName: summary.supplier_name,
      supplierInvoiceNo: summary.supplier_invoice_no,
      total: summary.total,
      paid: summary.paid,
      units: lines.reduce((sum, line) => sum + line.quantity, 0),
      createdBy: summary.created_by,
      subtotal: summary.subtotal,
      discount: summary.discount,
      notes: summary.notes,
      createdAt: summary.created_at,
      lines: lines.map((line) => ({
        lineNo: line.line_no,
        description:
          line.item_name ??
          variantLabel({ brandName: line.brand_name ?? '', modelName: line.model_name ?? '', ramGb: line.ram_gb, storageGb: line.storage_gb, colour: line.colour ?? '' }),
        quantity: line.quantity,
        unitCost: line.unit_cost,
        lineTotal: line.line_total,
        devices: (devices.all(line.id) as Array<{ id: number; imei1: string; imei2: string | null; status: PurchaseDetail['lines'][number]['devices'][number]['status'] }>).map(
          (device) => ({ id: device.id, imei1: device.imei1, imei2: device.imei2, status: device.status }),
        ),
      })),
    };
  }

  // ---------- Purchase returns ----------

  createReturn(input: PurchaseReturnInput, actor: string): { id: number; number: string } {
    this.context.assertCanWrite();
    const request = PurchaseReturnInputSchema.parse(input);
    if (request.deviceIds.length === 0 && request.items.length === 0) throw invalid('Add at least one handset or item to return.');
    if (!this.db.prepare('SELECT 1 FROM suppliers WHERE id = ?').get(request.supplierId)) throw notFound('The supplier');
    if (new Set(request.deviceIds).size !== request.deviceIds.length) throw invalid('A handset was added twice.');

    const now = nowOf(this.context);
    const run = this.db.transaction(() => {
      const lines: Array<{ deviceId: number | null; itemId: number | null; quantity: number; unitCost: number }> = [];
      for (const deviceId of request.deviceIds) {
        const device = this.db.prepare('SELECT id, imei1, status, cost, supplier_id FROM devices WHERE id = ?').get(deviceId) as
          | { id: number; imei1: string; status: string; cost: number; supplier_id: number | null }
          | undefined;
        if (!device) throw notFound('A handset');
        if (device.status !== 'in_stock') throw invalid(`IMEI ${device.imei1} is not in stock, so it cannot be returned.`);
        if (device.supplier_id !== request.supplierId) throw invalid(`IMEI ${device.imei1} was bought from a different supplier.`);
        lines.push({ deviceId: device.id, itemId: null, quantity: 1, unitCost: device.cost });
      }
      for (const entry of request.items) {
        const item = this.db
          .prepare(`SELECT i.name, i.average_cost, coalesce((SELECT sum(quantity) FROM stock_ledger WHERE item_id = i.id), 0) AS on_hand FROM items i WHERE i.id = ?`)
          .get(entry.itemId) as { name: string; average_cost: number; on_hand: number } | undefined;
        if (!item) throw notFound('An item');
        if (entry.quantity > item.on_hand) throw invalid(`Only ${item.on_hand} of ${item.name} in stock; cannot return ${entry.quantity}.`);
        lines.push({ deviceId: null, itemId: entry.itemId, quantity: entry.quantity, unitCost: item.average_cost });
      }
      const total = lines.reduce((sum, line) => sum + line.unitCost * line.quantity, 0);
      if (request.refund && request.refund.amount > total) throw invalid('The refund cannot be more than the value of the returned stock.');

      const number = nextNumber(this.db, 'PR', now);
      const returnId = Number(
        this.db
          .prepare('INSERT INTO purchase_returns (number, supplier_id, return_date, total, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(number, request.supplierId, request.returnDate, total, request.reason, actor, now.toISOString()).lastInsertRowid,
      );
      for (const line of lines) {
        this.db
          .prepare('INSERT INTO purchase_return_lines (return_id, device_id, item_id, quantity, unit_cost, line_total) VALUES (?, ?, ?, ?, ?, ?)')
          .run(returnId, line.deviceId, line.itemId, line.quantity, line.unitCost, line.unitCost * line.quantity);
        this.db
          .prepare(
            `INSERT INTO stock_ledger (at, device_id, item_id, quantity, unit_cost, doc_type, doc_id, created_by)
             VALUES (?, ?, ?, ?, ?, 'purchase_return', ?, ?)`,
          )
          .run(now.toISOString(), line.deviceId, line.itemId, -line.quantity, line.unitCost, returnId, actor);
        if (line.deviceId) this.db.prepare(`UPDATE devices SET status = 'returned_to_supplier' WHERE id = ?`).run(line.deviceId);
      }
      if (total > 0) {
        // The returned stock reduces what the shop owes...
        this.db
          .prepare(
            `INSERT INTO party_ledger (at, entry_date, party_type, party_id, debit, doc_type, doc_id, memo, created_by)
             VALUES (?, ?, 'supplier', ?, ?, 'purchase_return', ?, ?, ?)`,
          )
          .run(now.toISOString(), request.returnDate, request.supplierId, total, returnId, request.reason, actor);
      }
      if (request.refund) {
        // ...and money received back offsets that again, while the account goes up.
        accountExists(this.db, request.refund.accountId);
        const paymentNumber = nextNumber(this.db, 'REC', now);
        const paymentId = Number(
          this.db
            .prepare(
              `INSERT INTO payments (number, payment_date, direction, party_type, party_id, account_id, amount, reference, notes, doc_type, doc_id, created_by, created_at)
               VALUES (?, ?, 'in', 'supplier', ?, ?, ?, ?, ?, 'purchase_return', ?, ?, ?)`,
            )
            .run(paymentNumber, request.returnDate, request.supplierId, request.refund.accountId, request.refund.amount, request.refund.reference, `Refund for ${number}`, returnId, actor, now.toISOString())
            .lastInsertRowid,
        );
        this.db
          .prepare(
            `INSERT INTO party_ledger (at, entry_date, party_type, party_id, credit, doc_type, doc_id, memo, created_by)
             VALUES (?, ?, 'supplier', ?, ?, 'refund', ?, ?, ?)`,
          )
          .run(now.toISOString(), request.returnDate, request.supplierId, request.refund.amount, paymentId, `Refund for ${number}`, actor);
        this.db
          .prepare(
            `INSERT INTO money_ledger (at, entry_date, account_id, amount, doc_type, doc_id, memo, created_by)
             VALUES (?, ?, ?, ?, 'refund', ?, ?, ?)`,
          )
          .run(now.toISOString(), request.returnDate, request.refund.accountId, request.refund.amount, paymentId, `Refund for ${number}`, actor);
      }
      this.context.audit.append({
        actor,
        action: 'purchase.return',
        entityType: 'purchase_return',
        entityId: number,
        details: { supplierId: request.supplierId, total, units: lines.reduce((sum, line) => sum + line.quantity, 0), refund: request.refund?.amount ?? 0 },
      });
      return { id: returnId, number };
    });
    return run();
  }

  returns(limit: number): PurchaseReturnSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.number, r.return_date, s.name AS supplier_name, r.total, r.reason, r.created_by,
           coalesce((SELECT sum(quantity) FROM purchase_return_lines WHERE return_id = r.id), 0) AS units
         FROM purchase_returns r JOIN suppliers s ON s.id = r.supplier_id ORDER BY r.id DESC LIMIT ?`,
      )
      .all(limit) as Array<{ id: number; number: string; return_date: string; supplier_name: string; total: number; reason: string; created_by: string; units: number }>;
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      returnDate: row.return_date,
      supplierName: row.supplier_name,
      total: row.total,
      units: row.units,
      reason: row.reason,
      createdBy: row.created_by,
    }));
  }
}
