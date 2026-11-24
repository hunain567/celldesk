import { isValidImei, type SaleInput } from '@nexodesk/shared';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../src/main/db/connection';
import { migrations } from '../src/main/db/migrations';
import { migrate } from '../src/main/db/migrator';
import { AppError } from '../src/main/errors';
import { AuditLog } from '../src/main/services/audit';
import { CatalogService } from '../src/main/services/catalog';
import { PurchasingService } from '../src/main/services/purchasing';
import { SalesService } from '../src/main/services/sales';
import { tempDir, TEST_KEY } from './helpers';

function imei(body: string): string {
  for (let check = 0; check <= 9; check += 1) {
    if (isValidImei(body + check)) return body + check;
  }
  throw new Error('unreachable');
}

const CASH = 1;
const JAZZCASH = 2;
const owner = { canSellBelowMinimum: true };
const salesman = { canSellBelowMinimum: false };

describe('sales, returns and exchanges', () => {
  let dir: ReturnType<typeof tempDir>;
  let db: SqliteDatabase;
  let licensed: boolean;
  let catalog: CatalogService;
  let sales: SalesService;
  let a55: number;
  let hot50: number;
  let cover: number;
  const a55Imeis = [imei('35693803339563'), imei('35693803993908'), imei('35693803158176')];
  const hot50Imeis = [imei('35290611414002'), imei('35290611682554')];

  beforeEach(() => {
    dir = tempDir();
    db = openDatabase(join(dir.path, 'shop.db'), TEST_KEY);
    migrate(db, migrations, { appVersion: '0.1.0' });
    licensed = true;
    const context = {
      db,
      audit: new AuditLog(db),
      assertCanWrite: () => {
        if (!licensed) throw new AppError('LICENSE_RESTRICTED', 'Read-only');
      },
      now: () => new Date('2026-11-24T06:00:00Z'),
    };
    catalog = new CatalogService(context);
    const purchasing = new PurchasingService(context);
    sales = new SalesService(context);

    const samsung = catalog.createBrand({ name: 'Samsung' }, 'usman');
    const infinix = catalog.createBrand({ name: 'Infinix' }, 'usman');
    a55 = catalog.createVariant(
      { modelId: catalog.createModel({ brandId: samsung, name: 'Galaxy A55' }, 'usman'), ramGb: 8, storageGb: 256, colour: 'Navy', salePrice: 12199900, minSalePrice: 11800000 },
      'usman',
    );
    hot50 = catalog.createVariant(
      { modelId: catalog.createModel({ brandId: infinix, name: 'Hot 50' }, 'usman'), ramGb: 8, storageGb: 128, colour: 'Black', salePrice: 3699900, minSalePrice: 3450000 },
      'usman',
    );
    cover = catalog.createItem({ name: 'Silicone cover A55', category: 'Covers', barcode: '8964000123', salePrice: 120000, reorderLevel: 5 }, 'usman');
    const supplierId = purchasing.createSupplier({ name: 'Hall Road Traders', phone: '', city: 'Lahore', address: '', openingBalance: 0 }, 'usman');
    const newDevice = (value: string) => ({ imei1: value, imei2: null, condition: 'new' as const, ptaStatus: 'approved' as const, warrantyType: 'official' as const, warrantyMonths: 12 });
    purchasing.createPurchase(
      {
        supplierId,
        supplierInvoiceNo: '',
        purchaseDate: '2026-11-24',
        discount: 0,
        notes: '',
        payment: null,
        lines: [
          { kind: 'device', variantId: a55, unitCost: 11000000, devices: a55Imeis.map(newDevice) },
          { kind: 'device', variantId: hot50, unitCost: 3300000, devices: hot50Imeis.map(newDevice) },
          { kind: 'item', itemId: cover, quantity: 10, unitCost: 40000 },
        ],
      },
      'usman',
    );
  });
  afterEach(() => {
    db.close();
    dir.cleanup();
  });

  const deviceId = (value: string) => {
    const found = sales.lookup(value);
    if (found?.kind !== 'device') throw new Error(`${value} is not in stock`);
    return found.device.id;
  };
  const cash = (from: number) => (db.prepare('SELECT coalesce(sum(amount), 0) AS v FROM money_ledger WHERE account_id = ?').get(from) as { v: number }).v;
  const onHand = (itemId: number) => (db.prepare('SELECT coalesce(sum(quantity), 0) AS v FROM stock_ledger WHERE item_id = ?').get(itemId) as { v: number }).v;
  const sale = (overrides: Partial<SaleInput>): SaleInput => ({
    customerId: null,
    customerName: '',
    customerPhone: '',
    lines: [],
    discount: 0,
    payments: [],
    exchange: null,
    refund: null,
    notes: '',
    ...overrides,
  });

  it('sells a handset and an accessory for cash and takes them out of stock', () => {
    const id = deviceId(a55Imeis[0]!);
    const result = sales.createSale(
      sale({
        lines: [
          { kind: 'device', deviceId: id, unitPrice: 12199900 },
          { kind: 'item', itemId: cover, quantity: 2, unitPrice: 120000 },
        ],
        payments: [{ accountId: CASH, amount: 12439900, reference: '' }],
      }),
      'ali',
      salesman,
    );
    expect(result.number).toBe('SI-2026-000001');
    expect(sales.lookup(a55Imeis[0]!)).toMatchObject({ kind: 'sold', saleNumber: 'SI-2026-000001' });
    expect(onHand(cover)).toBe(8);
    expect(cash(CASH)).toBe(12439900);

    const detail = sales.sale(result.id, true);
    expect(detail.total).toBe(12439900);
    expect(detail.due).toBe(0);
    expect(detail.lines[0]).toMatchObject({ imei1: a55Imeis[0], warrantyMonths: 12, unitCost: 11000000 });
    expect(detail.profit).toBe(12199900 - 11000000 + 2 * (120000 - 40000));
    expect(sales.sale(result.id, false).profit).toBeNull();
    expect(catalog.lookupImei(a55Imeis[0]!, false)?.history.map((entry) => entry.docNumber)).toEqual(['PI-2026-000001', 'SI-2026-000001']);
  });

  it('finds accessories by barcode and refuses more than the stock on hand', () => {
    expect(sales.lookup('8964000123')).toMatchObject({ kind: 'item', item: { id: cover, onHand: 10 } });
    expect(sales.lookup('nothing')).toBeNull();
    expect(() =>
      sales.createSale(sale({ lines: [{ kind: 'item', itemId: cover, quantity: 11, unitPrice: 120000 }], payments: [{ accountId: CASH, amount: 1320000, reference: '' }] }), 'ali', salesman),
    ).toThrow(/Only 10 of Silicone cover A55/);
  });

  it('keeps a walk-in sale fully paid and lets a customer carry a balance', () => {
    const id = deviceId(a55Imeis[0]!);
    expect(() => sales.createSale(sale({ lines: [{ kind: 'device', deviceId: id, unitPrice: 12199900 }], payments: [{ accountId: CASH, amount: 5000000, reference: '' }] }), 'ali', salesman)).toThrow(
      /walk-in sale must be paid in full/,
    );
    const customerId = sales.createCustomer({ name: 'Bilal Ahmed', phone: '03001234567', city: 'Lahore', address: '' }, 'ali');
    const result = sales.createSale(
      sale({
        customerId,
        lines: [{ kind: 'device', deviceId: id, unitPrice: 12199900 }],
        payments: [
          { accountId: CASH, amount: 5000000, reference: '' },
          { accountId: JAZZCASH, amount: 2000000, reference: 'TID 8812' },
        ],
      }),
      'ali',
      salesman,
    );
    expect(sales.sale(result.id, false)).toMatchObject({ customerName: 'Bilal Ahmed', paid: 7000000, due: 5199900 });
    expect(sales.customers({ limit: 10 })[0]).toMatchObject({ name: 'Bilal Ahmed', balance: 5199900, lastSaleDate: '2026-11-24' });
    expect(cash(JAZZCASH)).toBe(2000000);
    expect(() => sales.createCustomer({ name: 'Someone else', phone: '03001234567', city: '', address: '' }, 'ali')).toThrow(/already exists/);
  });

  it('refuses a price below the minimum unless the user may allow it', () => {
    const id = deviceId(a55Imeis[0]!);
    // 121,999 list with a 5,000 bill discount is below the 118,000 minimum.
    const input = sale({ lines: [{ kind: 'device', deviceId: id, unitPrice: 12199900 }], discount: 500000, payments: [{ accountId: CASH, amount: 11699900, reference: '' }] });
    expect(() => sales.createSale(input, 'ali', salesman)).toThrow(/below their minimum price/);
    expect(sales.createSale(input, 'usman', owner).number).toBe('SI-2026-000001');
  });

  it('spreads the bill discount and refunds returns at the price actually paid', () => {
    const first = deviceId(hot50Imeis[0]!);
    const result = sales.createSale(
      sale({
        lines: [
          { kind: 'device', deviceId: first, unitPrice: 3699900 },
          { kind: 'item', itemId: cover, quantity: 1, unitPrice: 120000 },
        ],
        discount: 19900,
        payments: [{ accountId: CASH, amount: 3800000, reference: '' }],
      }),
      'ali',
      salesman,
    );
    const detail = sales.sale(result.id, true);
    const phoneLine = detail.lines.find((line) => line.kind === 'device')!;
    expect(phoneLine.netUnitPrice).toBe(Math.round(3699900 * (3800000 / 3819900)));

    const back = sales.createReturn({ saleId: result.id, lines: [{ saleLineId: phoneLine.id, quantity: 1 }], reason: 'Changed mind', refund: { accountId: CASH, amount: phoneLine.netUnitPrice } }, 'usman');
    expect(back.number).toBe('SR-2026-000001');
    expect(sales.lookup(hot50Imeis[0]!)).toMatchObject({ kind: 'device' });
    expect(cash(CASH)).toBe(3800000 - phoneLine.netUnitPrice);
    expect(() => sales.createReturn({ saleId: result.id, lines: [{ saleLineId: phoneLine.id, quantity: 1 }], reason: 'Again', refund: null }, 'usman')).toThrow(/already returned/);

    const coverLine = detail.lines.find((line) => line.kind === 'item')!;
    expect(() => sales.createReturn({ saleId: result.id, lines: [{ saleLineId: coverLine.id, quantity: 1 }], reason: 'Torn', refund: null }, 'usman')).toThrow(/no customer account/);
    expect(sales.sale(result.id, true)).toMatchObject({ hasReturns: true, profit: coverLine.netUnitPrice - 40000 });
    expect(sales.returns(10)[0]).toMatchObject({ saleNumber: result.number, units: 1, refunded: phoneLine.netUnitPrice });
  });

  it('exchanges a handset: the returned value pays for the new one', () => {
    const old = deviceId(hot50Imeis[0]!);
    const first = sales.createSale(sale({ lines: [{ kind: 'device', deviceId: old, unitPrice: 3699900 }], payments: [{ accountId: CASH, amount: 3699900, reference: '' }] }), 'ali', salesman);
    const oldLine = sales.sale(first.id, false).lines[0]!;

    const upgrade = sales.createSale(
      sale({
        lines: [{ kind: 'device', deviceId: deviceId(a55Imeis[0]!), unitPrice: 12199900 }],
        payments: [{ accountId: CASH, amount: 12199900 - 3699900, reference: '' }],
        exchange: { saleId: first.id, lines: [{ saleLineId: oldLine.id, quantity: 1 }], reason: 'Wants a better camera' },
      }),
      'ali',
      salesman,
    );
    const detail = sales.sale(upgrade.id, false);
    expect(detail).toMatchObject({ total: 12199900, exchangeCredit: 3699900, paid: 8500000, due: 0, exchangeReturnNumber: 'SR-2026-000001' });
    expect(sales.lookup(hot50Imeis[0]!)).toMatchObject({ kind: 'device' });
    expect(cash(CASH)).toBe(3699900 + 8500000);
    expect(sales.returns(10)[0]).toMatchObject({ exchangeSaleNumber: upgrade.number, refunded: 0 });
  });

  it('refunds the difference when the exchanged handset is worth more', () => {
    const old = deviceId(a55Imeis[0]!);
    const first = sales.createSale(sale({ lines: [{ kind: 'device', deviceId: old, unitPrice: 12199900 }], payments: [{ accountId: CASH, amount: 12199900, reference: '' }] }), 'ali', salesman);
    const oldLine = sales.sale(first.id, false).lines[0]!;
    const exchange = { saleId: first.id, lines: [{ saleLineId: oldLine.id, quantity: 1 }], reason: 'Too big' };
    const lines = [{ kind: 'device' as const, deviceId: deviceId(hot50Imeis[0]!), unitPrice: 3699900 }];

    expect(() => sales.createSale(sale({ lines, exchange }), 'ali', salesman)).toThrow(/Refund Rs 85,000/);
    const result = sales.createSale(sale({ lines, exchange, refund: { accountId: CASH, amount: 8500000 } }), 'ali', salesman);
    expect(sales.sale(result.id, false)).toMatchObject({ exchangeCredit: 3699900, exchangeRefund: 8500000, due: 0 });
    expect(cash(CASH)).toBe(12199900 - 8500000);
  });

  it('cannot sell a handset twice or change a posted sale', () => {
    const id = deviceId(a55Imeis[0]!);
    const input = sale({ lines: [{ kind: 'device', deviceId: id, unitPrice: 12199900 }], payments: [{ accountId: CASH, amount: 12199900, reference: '' }] });
    sales.createSale(input, 'ali', salesman);
    expect(() => sales.createSale(input, 'ali', salesman)).toThrow(/not in stock/);
    expect(() => db.prepare('UPDATE sales SET total = 1').run()).toThrow(/cannot be changed/);
    expect(() => db.prepare('DELETE FROM sale_lines').run()).toThrow(/cannot be deleted/);
  });

  it('stops new sales when the licence is read-only but still shows old ones', () => {
    const result = sales.createSale(
      sale({ lines: [{ kind: 'item', itemId: cover, quantity: 1, unitPrice: 120000 }], payments: [{ accountId: CASH, amount: 120000, reference: '' }] }),
      'ali',
      salesman,
    );
    licensed = false;
    expect(() =>
      sales.createSale(sale({ lines: [{ kind: 'item', itemId: cover, quantity: 1, unitPrice: 120000 }], payments: [{ accountId: CASH, amount: 120000, reference: '' }] }), 'ali', salesman),
    ).toThrow(/Read-only/);
    expect(() => sales.createCustomer({ name: 'X', phone: '', city: '', address: '' }, 'ali')).toThrow(/Read-only/);
    expect(sales.sales({ limit: 10 }).map((entry) => entry.id)).toEqual([result.id]);
  });
});
