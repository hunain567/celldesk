import {
  CustomerInputSchema,
  formatRupees,
  SaleInputSchema,
  SaleReturnInputSchema,
  variantLabel,
  type CustomerInput,
  type CustomerSummary,
  type PosLookup,
  type ReturnLineInput,
  type SaleDetail,
  type SaleInput,
  type SaleReturnInput,
  type SaleReturnSummary,
  type SaleSummary,
} from '@nexodesk/shared';
import { AppError } from '../errors';
import { accountExists, localDate, nextNumber, notFound, nowOf, uniqueViolation, type BusinessContext } from './business';

function invalid(message: string, details?: string[]): AppError {
  return new AppError('VALIDATION_FAILED', message, details);
}

const DEVICE_COLUMNS = `d.id, d.imei1, d.imei2, d.variant_id, d.condition, d.pta_status, d.warranty_type, d.warranty_months, d.status, d.cost,
  v.sale_price, v.min_sale_price, v.ram_gb, v.storage_gb, v.colour, m.name AS model_name, b.name AS brand_name`;
const DEVICE_JOINS = 'JOIN variants v ON v.id = d.variant_id JOIN models m ON m.id = v.model_id JOIN brands b ON b.id = m.brand_id';

interface DeviceRow {
  id: number;
  imei1: string;
  imei2: string | null;
  variant_id: number;
  condition: 'new' | 'open_box' | 'used' | 'refurbished';
  pta_status: 'approved' | 'non_pta' | 'patched';
  warranty_type: 'official' | 'shop' | 'none';
  warranty_months: number;
  status: 'in_stock' | 'sold' | 'returned_to_supplier';
  cost: number;
  sale_price: number;
  min_sale_price: number;
  ram_gb: number | null;
  storage_gb: number | null;
  colour: string;
  model_name: string;
  brand_name: string;
}

const labelOf = (row: { brand_name: string; model_name: string; ram_gb: number | null; storage_gb: number | null; colour: string }) =>
  variantLabel({ brandName: row.brand_name, modelName: row.model_name, ramGb: row.ram_gb, storageGb: row.storage_gb, colour: row.colour });

interface PreparedReturn {
  sale: { id: number; number: string; customer_id: number | null };
  lines: Array<{ saleLineId: number; deviceId: number | null; itemId: number | null; quantity: number; unitPrice: number; unitCost: number }>;
  total: number;
}

export interface SaleOptions {
  /** True when the user may sell a handset below its minimum price. */
  canSellBelowMinimum: boolean;
}

/** Customers, point-of-sale sales, exchanges and sale returns. */
export class SalesService {
  constructor(private readonly context: BusinessContext) {}

  private get db() {
    return this.context.db;
  }

  // ---------- Customers ----------

  customers(options: { query?: string; limit: number }): CustomerSummary[] {
    const query = `%${(options.query ?? '').trim()}%`;
    const rows = this.db
      .prepare(
        `SELECT c.*,
           coalesce((SELECT sum(debit - credit) FROM party_ledger p WHERE p.party_type = 'customer' AND p.party_id = c.id), 0) AS balance,
           (SELECT max(sale_date) FROM sales WHERE customer_id = c.id) AS last_sale_date
         FROM customers c WHERE c.is_active = 1 AND (c.name LIKE ? OR c.phone LIKE ?) ORDER BY c.name LIMIT ?`,
      )
      .all(query, query, options.limit) as Array<{
      id: number;
      name: string;
      phone: string;
      city: string;
      address: string;
      is_active: number;
      balance: number;
      last_sale_date: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      city: row.city,
      address: row.address,
      isActive: row.is_active === 1,
      balance: row.balance,
      lastSaleDate: row.last_sale_date,
    }));
  }

  createCustomer(input: CustomerInput, actor: string): number {
    this.context.assertCanWrite();
    const customer = CustomerInputSchema.parse(input);
    const now = nowOf(this.context);
    try {
      const id = Number(
        this.db
          .prepare('INSERT INTO customers (name, phone, city, address, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(customer.name, customer.phone, customer.city, customer.address, now.toISOString()).lastInsertRowid,
      );
      this.context.audit.append({ actor, action: 'customer.create', entityType: 'customer', entityId: String(id), details: { name: customer.name } });
      return id;
    } catch (error) {
      return uniqueViolation(error, `A customer with phone ${customer.phone} already exists. Search for it instead.`);
    }
  }

  // ---------- Point of sale ----------

  /** Finds what a scanned code is: a handset by IMEI or an accessory by barcode. */
  lookup(code: string): PosLookup | null {
    const value = code.trim();
    if (!value) return null;
    const device = this.db.prepare(`SELECT ${DEVICE_COLUMNS} FROM devices d ${DEVICE_JOINS} WHERE d.imei1 = ? OR d.imei2 = ?`).get(value, value) as
      | DeviceRow
      | undefined;
    if (device) {
      if (device.status === 'in_stock') {
        return {
          kind: 'device',
          device: {
            id: device.id,
            imei1: device.imei1,
            imei2: device.imei2,
            variantId: device.variant_id,
            label: labelOf(device),
            condition: device.condition,
            ptaStatus: device.pta_status,
            warrantyType: device.warranty_type,
            warrantyMonths: device.warranty_months,
            salePrice: device.sale_price,
            minSalePrice: device.min_sale_price,
          },
        };
      }
      if (device.status === 'sold') {
        const sale = this.db
          .prepare('SELECT s.id, s.number FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id WHERE sl.device_id = ? ORDER BY sl.id DESC LIMIT 1')
          .get(device.id) as { id: number; number: string } | undefined;
        if (sale) {
          return { kind: 'sold', saleId: sale.id, saleNumber: sale.number, message: `${labelOf(device)} was sold on ${sale.number}.` };
        }
      }
      return { kind: 'unavailable', message: `${labelOf(device)} is not in stock (${device.status.replace(/_/g, ' ')}).` };
    }
    const item = this.db
      .prepare(`SELECT i.id, i.name, i.barcode, i.sale_price, coalesce((SELECT sum(quantity) FROM stock_ledger WHERE item_id = i.id), 0) AS on_hand FROM items i WHERE i.barcode = ? AND i.is_active = 1`)
      .get(value) as { id: number; name: string; barcode: string | null; sale_price: number; on_hand: number } | undefined;
    if (item) return { kind: 'item', item: { id: item.id, name: item.name, barcode: item.barcode, salePrice: item.sale_price, onHand: item.on_hand } };
    return null;
  }

  // ---------- Sales ----------

  createSale(input: SaleInput, actor: string, options: SaleOptions): { id: number; number: string } {
    this.context.assertCanWrite();
    const sale = SaleInputSchema.parse(input);
    const deviceIds = sale.lines.flatMap((line) => (line.kind === 'device' ? [line.deviceId] : []));
    if (new Set(deviceIds).size !== deviceIds.length) throw invalid('A handset was added twice.');

    type Customer = { id: number; name: string; phone: string };
    const customer: Customer | null =
      sale.customerId === null ? null : ((this.db.prepare('SELECT id, name, phone FROM customers WHERE id = ? AND is_active = 1').get(sale.customerId) as Customer | undefined) ?? null);
    if (sale.customerId !== null && !customer) throw invalid('Choose an active customer.');

    const now = nowOf(this.context);
    const saleDate = localDate(now);
    const run = this.db.transaction(() => {
      // Resolve every line against current stock.
      const itemNeeds = new Map<number, number>();
      const resolved = sale.lines.map((line, index) => {
        if (line.kind === 'device') {
          const device = this.db.prepare(`SELECT ${DEVICE_COLUMNS} FROM devices d ${DEVICE_JOINS} WHERE d.id = ?`).get(line.deviceId) as DeviceRow | undefined;
          if (!device) throw notFound(`The handset on line ${index + 1}`);
          if (device.status !== 'in_stock') throw invalid(`IMEI ${device.imei1} is not in stock.`);
          return { line, label: labelOf(device), imei: device.imei1, quantity: 1, unitCost: device.cost, minPrice: device.min_sale_price };
        }
        const item = this.db.prepare('SELECT name, average_cost, is_active FROM items WHERE id = ?').get(line.itemId) as
          | { name: string; average_cost: number; is_active: number }
          | undefined;
        if (!item || item.is_active !== 1) throw invalid(`Line ${index + 1}: the item is not available.`);
        itemNeeds.set(line.itemId, (itemNeeds.get(line.itemId) ?? 0) + line.quantity);
        return { line, label: item.name, imei: null, quantity: line.quantity, unitCost: item.average_cost, minPrice: 0 };
      });
      for (const [itemId, needed] of itemNeeds) {
        const row = this.db.prepare('SELECT i.name, coalesce((SELECT sum(quantity) FROM stock_ledger WHERE item_id = i.id), 0) AS on_hand FROM items i WHERE i.id = ?').get(itemId) as {
          name: string;
          on_hand: number;
        };
        if (needed > row.on_hand) throw invalid(`Only ${row.on_hand} of ${row.name} in stock.`);
      }

      const subtotal = resolved.reduce((sum, entry) => sum + entry.line.unitPrice * entry.quantity, 0);
      if (sale.discount > subtotal) throw invalid('The discount cannot be more than the bill.');
      const total = subtotal - sale.discount;
      const ratio = subtotal > 0 ? total / subtotal : 0;
      const priced = resolved.map((entry) => ({ ...entry, netUnitPrice: Math.round(entry.line.unitPrice * ratio) }));

      const belowMinimum = priced.filter((entry) => entry.imei && entry.netUnitPrice < entry.minPrice);
      if (belowMinimum.length > 0 && !options.canSellBelowMinimum) {
        throw invalid(
          'Some handsets are below their minimum price. Ask the owner or a manager.',
          belowMinimum.map((entry) => `${entry.label} (${entry.imei}): ${formatRupees(entry.netUnitPrice)}, minimum ${formatRupees(entry.minPrice)}`),
        );
      }

      // Exchange: the returned items pay for this sale first.
      let exchange: { prepared: PreparedReturn; applied: number; refund: number; credit: number } | null = null;
      if (sale.exchange) {
        const prepared = this.prepareReturn(sale.exchange.saleId, sale.exchange.lines);
        const applied = Math.min(prepared.total, total);
        const excess = prepared.total - applied;
        const refund = sale.refund?.amount ?? 0;
        if (refund > excess) throw invalid('The refund cannot be more than what the returned items are worth beyond this sale.');
        const credit = excess - refund;
        if (credit > 0 && !customer) throw invalid(`Refund ${formatRupees(excess)} to the customer, or choose a customer to keep it on their account.`);
        exchange = { prepared, applied, refund, credit };
      } else if (sale.refund && sale.refund.amount > 0) {
        throw invalid('A refund is only possible in an exchange.');
      }

      const due = total - (exchange?.applied ?? 0);
      const paid = sale.payments.reduce((sum, payment) => sum + payment.amount, 0);
      if (paid > due) throw invalid(`Payments (${formatRupees(paid)}) are more than the amount due (${formatRupees(due)}).`);
      if (!customer && paid !== due) throw invalid('A walk-in sale must be paid in full. Choose a customer to leave a balance on their account.');
      for (const payment of sale.payments) accountExists(this.db, payment.accountId);

      let exchangeReturnId: number | null = null;
      if (exchange) {
        exchangeReturnId = this.writeReturn({
          prepared: exchange.prepared,
          reason: `Exchange: ${sale.exchange!.reason}`,
          refundAccountId: exchange.refund > 0 ? sale.refund!.accountId : null,
          refundAmount: exchange.refund,
          exchangeAmount: exchange.applied,
          customerCredit: exchange.credit,
          creditCustomerId: customer?.id ?? null,
          actor,
          now,
        }).id;
      }

      const number = nextNumber(this.db, 'SI', now);
      const saleId = Number(
        this.db
          .prepare(
            `INSERT INTO sales (number, sale_date, customer_id, customer_name, customer_phone, subtotal, discount, total, exchange_return_id, exchange_credit, paid, notes, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            number,
            saleDate,
            customer?.id ?? null,
            customer?.name ?? sale.customerName,
            customer?.phone ?? sale.customerPhone,
            subtotal,
            sale.discount,
            total,
            exchangeReturnId,
            exchange?.applied ?? 0,
            paid,
            sale.notes,
            actor,
            now.toISOString(),
          ).lastInsertRowid,
      );

      const insertLine = this.db.prepare(
        `INSERT INTO sale_lines (sale_id, line_no, device_id, item_id, quantity, unit_price, net_unit_price, unit_cost, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertStock = this.db.prepare(
        `INSERT INTO stock_ledger (at, device_id, item_id, quantity, unit_cost, doc_type, doc_id, created_by)
         VALUES (?, ?, ?, ?, ?, 'sale', ?, ?)`,
      );
      priced.forEach((entry, index) => {
        const deviceId = entry.line.kind === 'device' ? entry.line.deviceId : null;
        const itemId = entry.line.kind === 'item' ? entry.line.itemId : null;
        insertLine.run(saleId, index + 1, deviceId, itemId, entry.quantity, entry.line.unitPrice, entry.netUnitPrice, entry.unitCost, entry.line.unitPrice * entry.quantity);
        insertStock.run(now.toISOString(), deviceId, itemId, -entry.quantity, entry.unitCost, saleId, actor);
        if (deviceId) this.db.prepare(`UPDATE devices SET status = 'sold' WHERE id = ?`).run(deviceId);
      });

      for (const payment of sale.payments) {
        this.db.prepare('INSERT INTO sale_payments (sale_id, account_id, amount, reference) VALUES (?, ?, ?, ?)').run(saleId, payment.accountId, payment.amount, payment.reference);
        this.db
          .prepare(
            `INSERT INTO money_ledger (at, entry_date, account_id, amount, doc_type, doc_id, memo, created_by)
             VALUES (?, ?, ?, ?, 'sale', ?, ?, ?)`,
          )
          .run(now.toISOString(), saleDate, payment.accountId, payment.amount, saleId, `Sale ${number}`, actor);
      }

      if (customer) {
        // The customer's account only records what changes their balance.
        if (due > 0) {
          this.db
            .prepare(
              `INSERT INTO party_ledger (at, entry_date, party_type, party_id, debit, doc_type, doc_id, memo, created_by)
               VALUES (?, ?, 'customer', ?, ?, 'sale', ?, ?, ?)`,
            )
            .run(now.toISOString(), saleDate, customer.id, due, saleId, `Sale ${number}`, actor);
        }
        if (paid > 0) {
          this.db
            .prepare(
              `INSERT INTO party_ledger (at, entry_date, party_type, party_id, credit, doc_type, doc_id, memo, created_by)
               VALUES (?, ?, 'customer', ?, ?, 'sale_payment', ?, ?, ?)`,
            )
            .run(now.toISOString(), saleDate, customer.id, paid, saleId, `Paid with ${number}`, actor);
        }
      }

      this.context.audit.append({
        actor,
        action: 'sale.create',
        entityType: 'sale',
        entityId: number,
        details: {
          total,
          discount: sale.discount,
          paid,
          due: due - paid,
          units: priced.reduce((sum, entry) => sum + entry.quantity, 0),
          customerId: customer?.id ?? null,
          exchangeCredit: exchange?.applied ?? 0,
          belowMinimum: belowMinimum.length,
        },
      });
      return { id: saleId, number };
    });
    return run();
  }

  /** Checks what is being taken back from a sale and values it at the price the customer paid. */
  private prepareReturn(saleId: number, requested: ReturnLineInput[]): PreparedReturn {
    const sale = this.db.prepare('SELECT id, number, customer_id FROM sales WHERE id = ?').get(saleId) as PreparedReturn['sale'] | undefined;
    if (!sale) throw notFound('The sale');
    const quantities = new Map<number, number>();
    for (const line of requested) quantities.set(line.saleLineId, (quantities.get(line.saleLineId) ?? 0) + line.quantity);

    const lines: PreparedReturn['lines'] = [];
    for (const [saleLineId, quantity] of quantities) {
      const line = this.db
        .prepare(
          `SELECT sl.id, sl.device_id, sl.item_id, sl.quantity, sl.net_unit_price, sl.unit_cost,
             coalesce((SELECT sum(quantity) FROM sale_return_lines WHERE sale_line_id = sl.id), 0) AS returned,
             d.imei1, d.status, i.name AS item_name
           FROM sale_lines sl LEFT JOIN devices d ON d.id = sl.device_id LEFT JOIN items i ON i.id = sl.item_id
           WHERE sl.id = ? AND sl.sale_id = ?`,
        )
        .get(saleLineId, saleId) as
        | {
            id: number;
            device_id: number | null;
            item_id: number | null;
            quantity: number;
            net_unit_price: number;
            unit_cost: number;
            returned: number;
            imei1: string | null;
            status: string | null;
            item_name: string | null;
          }
        | undefined;
      if (!line) throw invalid(`A returned line is not part of ${sale.number}.`);
      const remaining = line.quantity - line.returned;
      if (quantity > remaining) {
        throw invalid(line.device_id ? `IMEI ${line.imei1} was already returned.` : `Only ${remaining} of ${line.item_name} can still be returned from ${sale.number}.`);
      }
      if (line.device_id) {
        const latest = this.db.prepare('SELECT max(id) AS id FROM sale_lines WHERE device_id = ?').get(line.device_id) as { id: number };
        if (line.status !== 'sold' || latest.id !== line.id) throw invalid(`IMEI ${line.imei1} is no longer with this customer.`);
      }
      lines.push({ saleLineId: line.id, deviceId: line.device_id, itemId: line.item_id, quantity, unitPrice: line.net_unit_price, unitCost: line.unit_cost });
    }
    return { sale, lines, total: lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0) };
  }

  /** Puts returned stock back and settles its value. Must run inside a transaction. */
  private writeReturn(options: {
    prepared: PreparedReturn;
    reason: string;
    refundAccountId: number | null;
    refundAmount: number;
    exchangeAmount: number;
    customerCredit: number;
    creditCustomerId: number | null;
    actor: string;
    now: Date;
  }): { id: number; number: string } {
    const { prepared, now, actor } = options;
    const date = localDate(now);
    if (options.refundAmount > 0) accountExists(this.db, options.refundAccountId!);
    const number = nextNumber(this.db, 'SR', now);
    const returnId = Number(
      this.db
        .prepare(
          `INSERT INTO sale_returns (number, sale_id, return_date, total, refund_account_id, refund_amount, exchange_amount, customer_credit, reason, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          number,
          prepared.sale.id,
          date,
          prepared.total,
          options.refundAmount > 0 ? options.refundAccountId : null,
          options.refundAmount,
          options.exchangeAmount,
          options.customerCredit,
          options.reason,
          actor,
          now.toISOString(),
        ).lastInsertRowid,
    );

    for (const line of prepared.lines) {
      this.db
        .prepare('INSERT INTO sale_return_lines (return_id, sale_line_id, quantity, unit_price, unit_cost, line_total) VALUES (?, ?, ?, ?, ?, ?)')
        .run(returnId, line.saleLineId, line.quantity, line.unitPrice, line.unitCost, line.unitPrice * line.quantity);
      if (line.itemId) {
        // Back into stock at the cost it left with; the moving average follows.
        const item = this.db
          .prepare('SELECT average_cost, coalesce((SELECT sum(quantity) FROM stock_ledger WHERE item_id = items.id), 0) AS on_hand FROM items WHERE id = ?')
          .get(line.itemId) as { average_cost: number; on_hand: number };
        const base = Math.max(item.on_hand, 0);
        const average = Math.round((item.average_cost * base + line.unitCost * line.quantity) / (base + line.quantity));
        this.db.prepare('UPDATE items SET average_cost = ? WHERE id = ?').run(average, line.itemId);
      }
      this.db
        .prepare(
          `INSERT INTO stock_ledger (at, device_id, item_id, quantity, unit_cost, doc_type, doc_id, created_by)
           VALUES (?, ?, ?, ?, ?, 'sale_return', ?, ?)`,
        )
        .run(now.toISOString(), line.deviceId, line.itemId, line.quantity, line.unitCost, returnId, actor);
      if (line.deviceId) this.db.prepare(`UPDATE devices SET status = 'in_stock' WHERE id = ?`).run(line.deviceId);
    }

    if (options.refundAmount > 0) {
      this.db
        .prepare(
          `INSERT INTO money_ledger (at, entry_date, account_id, amount, doc_type, doc_id, memo, created_by)
           VALUES (?, ?, ?, ?, 'sale_refund', ?, ?, ?)`,
        )
        .run(now.toISOString(), date, options.refundAccountId, -options.refundAmount, returnId, `Refund for ${number}`, actor);
    }
    if (options.customerCredit > 0) {
      this.db
        .prepare(
          `INSERT INTO party_ledger (at, entry_date, party_type, party_id, credit, doc_type, doc_id, memo, created_by)
           VALUES (?, ?, 'customer', ?, ?, 'sale_return', ?, ?, ?)`,
        )
        .run(now.toISOString(), date, options.creditCustomerId, options.customerCredit, returnId, `Return ${number}`, actor);
    }

    this.context.audit.append({
      actor,
      action: 'sale.return',
      entityType: 'sale_return',
      entityId: number,
      details: {
        saleNumber: prepared.sale.number,
        total: prepared.total,
        refund: options.refundAmount,
        exchange: options.exchangeAmount,
        credit: options.customerCredit,
        units: prepared.lines.reduce((sum, line) => sum + line.quantity, 0),
      },
    });
    return { id: returnId, number };
  }

  createReturn(input: SaleReturnInput, actor: string): { id: number; number: string } {
    this.context.assertCanWrite();
    const request = SaleReturnInputSchema.parse(input);
    const run = this.db.transaction(() => {
      const prepared = this.prepareReturn(request.saleId, request.lines);
      const refund = request.refund?.amount ?? 0;
      if (refund > prepared.total) throw invalid(`The refund cannot be more than ${formatRupees(prepared.total)}.`);
      const credit = prepared.total - refund;
      if (credit > 0 && prepared.sale.customer_id === null) {
        throw invalid(`${prepared.sale.number} has no customer account, so refund the full ${formatRupees(prepared.total)}.`);
      }
      return this.writeReturn({
        prepared,
        reason: request.reason,
        refundAccountId: refund > 0 ? request.refund!.accountId : null,
        refundAmount: refund,
        exchangeAmount: 0,
        customerCredit: credit,
        creditCustomerId: prepared.sale.customer_id,
        actor,
        now: nowOf(this.context),
      });
    });
    return run();
  }

  sales(options: { query?: string; limit: number }): SaleSummary[] {
    const text = (options.query ?? '').trim();
    const like = `%${text}%`;
    const rows = this.db
      .prepare(
        `SELECT s.*,
           coalesce((SELECT sum(quantity) FROM sale_lines WHERE sale_id = s.id), 0) AS units,
           EXISTS (SELECT 1 FROM sale_returns WHERE sale_id = s.id) AS has_returns
         FROM sales s
         WHERE s.number LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ?
            OR s.id IN (SELECT sl.sale_id FROM sale_lines sl JOIN devices d ON d.id = sl.device_id WHERE d.imei1 = ? OR d.imei2 = ?)
         ORDER BY s.id DESC LIMIT ?`,
      )
      .all(like, like, like, text, text, options.limit) as SaleRow[];
    return rows.map(toSummary);
  }

  sale(id: number, showCost: boolean): SaleDetail {
    const row = this.db
      .prepare(
        `SELECT s.*, r.number AS exchange_return_number, coalesce(r.refund_amount, 0) AS exchange_refund,
           coalesce((SELECT sum(quantity) FROM sale_lines WHERE sale_id = s.id), 0) AS units,
           EXISTS (SELECT 1 FROM sale_returns WHERE sale_id = s.id) AS has_returns
         FROM sales s LEFT JOIN sale_returns r ON r.id = s.exchange_return_id WHERE s.id = ?`,
      )
      .get(id) as (SaleRow & { subtotal: number; discount: number; notes: string; exchange_return_number: string | null; exchange_refund: number }) | undefined;
    if (!row) throw notFound('The sale');

    const lines = this.db
      .prepare(
        `SELECT sl.*, coalesce((SELECT sum(quantity) FROM sale_return_lines WHERE sale_line_id = sl.id), 0) AS returned,
           i.name AS item_name, d.imei1, d.imei2, d.condition, d.pta_status, d.warranty_type, d.warranty_months,
           v.ram_gb, v.storage_gb, v.colour, m.name AS model_name, b.name AS brand_name
         FROM sale_lines sl
         LEFT JOIN items i ON i.id = sl.item_id
         LEFT JOIN devices d ON d.id = sl.device_id
         LEFT JOIN variants v ON v.id = d.variant_id LEFT JOIN models m ON m.id = v.model_id LEFT JOIN brands b ON b.id = m.brand_id
         WHERE sl.sale_id = ? ORDER BY sl.line_no`,
      )
      .all(id) as Array<{
      id: number;
      line_no: number;
      device_id: number | null;
      quantity: number;
      unit_price: number;
      net_unit_price: number;
      unit_cost: number;
      line_total: number;
      returned: number;
      item_name: string | null;
      imei1: string | null;
      imei2: string | null;
      condition: SaleDetail['lines'][number]['condition'];
      pta_status: SaleDetail['lines'][number]['ptaStatus'];
      warranty_type: SaleDetail['lines'][number]['warrantyType'];
      warranty_months: number | null;
      ram_gb: number | null;
      storage_gb: number | null;
      colour: string | null;
      model_name: string | null;
      brand_name: string | null;
    }>;
    const payments = this.db
      .prepare('SELECT a.name AS account_name, p.amount, p.reference FROM sale_payments p JOIN accounts a ON a.id = p.account_id WHERE p.sale_id = ? ORDER BY p.id')
      .all(id) as Array<{ account_name: string; amount: number; reference: string }>;
    const returns = this.db
      .prepare('SELECT id, number, return_date, total, refund_amount FROM sale_returns WHERE sale_id = ? ORDER BY id')
      .all(id) as Array<{ id: number; number: string; return_date: string; total: number; refund_amount: number }>;

    const profit = lines.reduce((sum, line) => sum + (line.net_unit_price - line.unit_cost) * (line.quantity - line.returned), 0);
    return {
      ...toSummary(row),
      subtotal: row.subtotal,
      discount: row.discount,
      exchangeReturnNumber: row.exchange_return_number,
      exchangeRefund: row.exchange_refund,
      notes: row.notes,
      lines: lines.map((line) => ({
        id: line.id,
        lineNo: line.line_no,
        kind: line.device_id ? ('device' as const) : ('item' as const),
        description: line.device_id
          ? labelOf({ brand_name: line.brand_name ?? '', model_name: line.model_name ?? '', ram_gb: line.ram_gb, storage_gb: line.storage_gb, colour: line.colour ?? '' })
          : (line.item_name ?? ''),
        imei1: line.imei1,
        imei2: line.imei2,
        condition: line.condition,
        ptaStatus: line.pta_status,
        warrantyType: line.warranty_type,
        warrantyMonths: line.warranty_months,
        quantity: line.quantity,
        returnedQuantity: line.returned,
        unitPrice: line.unit_price,
        netUnitPrice: line.net_unit_price,
        lineTotal: line.line_total,
        unitCost: showCost ? line.unit_cost : null,
      })),
      payments: payments.map((payment) => ({ accountName: payment.account_name, amount: payment.amount, reference: payment.reference })),
      returns: returns.map((entry) => ({ id: entry.id, number: entry.number, returnDate: entry.return_date, total: entry.total, refunded: entry.refund_amount })),
      profit: showCost ? profit : null,
    };
  }

  returns(limit: number): SaleReturnSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, s.number AS sale_number, s.customer_name, x.number AS exchange_sale_number,
           coalesce((SELECT sum(quantity) FROM sale_return_lines WHERE return_id = r.id), 0) AS units
         FROM sale_returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN sales x ON x.exchange_return_id = r.id
         ORDER BY r.id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      number: string;
      return_date: string;
      sale_id: number;
      sale_number: string;
      customer_name: string;
      total: number;
      refund_amount: number;
      exchange_sale_number: string | null;
      units: number;
      reason: string;
      created_by: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      returnDate: row.return_date,
      saleId: row.sale_id,
      saleNumber: row.sale_number,
      customerName: row.customer_name,
      total: row.total,
      refunded: row.refund_amount,
      exchangeSaleNumber: row.exchange_sale_number,
      units: row.units,
      reason: row.reason,
      createdBy: row.created_by,
    }));
  }
}

interface SaleRow {
  id: number;
  number: string;
  sale_date: string;
  created_at: string;
  customer_id: number | null;
  customer_name: string;
  customer_phone: string;
  total: number;
  exchange_credit: number;
  paid: number;
  units: number;
  has_returns: number;
  created_by: string;
}

function toSummary(row: SaleRow): SaleSummary {
  return {
    id: row.id,
    number: row.number,
    saleDate: row.sale_date,
    createdAt: row.created_at,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    total: row.total,
    exchangeCredit: row.exchange_credit,
    paid: row.paid,
    due: row.total - row.exchange_credit - row.paid,
    units: row.units,
    hasReturns: row.has_returns === 1,
    createdBy: row.created_by,
  };
}
