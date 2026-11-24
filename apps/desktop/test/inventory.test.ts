import { isValidImei, type PurchaseInput } from '@nexodesk/shared';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../src/main/db/connection';
import { migrations } from '../src/main/db/migrations';
import { migrate } from '../src/main/db/migrator';
import { AppError } from '../src/main/errors';
import { AuditLog } from '../src/main/services/audit';
import { CatalogService } from '../src/main/services/catalog';
import { PurchasingService } from '../src/main/services/purchasing';
import { tempDir, TEST_KEY } from './helpers';

/** Makes a valid IMEI from a 14-digit body by adding the Luhn check digit. */
function imei(body: string): string {
  for (let check = 0; check <= 9; check += 1) {
    if (isValidImei(body + check)) return body + check;
  }
  throw new Error('unreachable');
}

const device = (value: string, imei2: string | null = null) => ({
  imei1: value,
  imei2,
  condition: 'new' as const,
  ptaStatus: 'approved' as const,
  warrantyType: 'official' as const,
  warrantyMonths: 12,
});

describe('IMEI validation', () => {
  it('accepts real IMEIs and rejects typos', () => {
    expect(isValidImei('490154203237518')).toBe(true);
    expect(isValidImei('490154203237519')).toBe(false);
    expect(isValidImei('49015420323751')).toBe(false);
    expect(isValidImei('49015420323751A')).toBe(false);
  });
});

describe('purchasing and stock', () => {
  let dir: ReturnType<typeof tempDir>;
  let db: SqliteDatabase;
  let licensed: boolean;
  let catalog: CatalogService;
  let purchasing: PurchasingService;
  let variantId: number;
  let itemId: number;
  let supplierId: number;

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
    purchasing = new PurchasingService(context);
    const brand = catalog.createBrand({ name: 'Samsung' }, 'usman');
    const model = catalog.createModel({ brandId: brand, name: 'Galaxy A55' }, 'usman');
    variantId = catalog.createVariant({ modelId: model, ramGb: 8, storageGb: 256, colour: 'Navy', salePrice: 12199900, minSalePrice: 11800000 }, 'usman');
    itemId = catalog.createItem({ name: 'Silicone cover A55', category: 'Covers', barcode: '8964000123', salePrice: 120000, reorderLevel: 5 }, 'usman');
    supplierId = purchasing.createSupplier({ name: 'Hall Road Traders', phone: '', city: 'Lahore', address: '', openingBalance: 5000000 }, 'usman');
  });
  afterEach(() => {
    db.close();
    dir.cleanup();
  });

  const purchase = (overrides: Partial<PurchaseInput> = {}): PurchaseInput => ({
    supplierId,
    supplierInvoiceNo: 'HR-551',
    purchaseDate: '2026-11-24',
    discount: 0,
    notes: '',
    lines: [
      { kind: 'device', variantId, unitCost: 11000000, devices: [device(imei('35123456789012'), imei('35123456789013')), device(imei('35123456789020'))] },
      { kind: 'item', itemId, quantity: 10, unitCost: 40000 },
    ],
    payment: null,
    ...overrides,
  });

  it('receives handsets by IMEI and accessories by quantity', () => {
    const { number } = purchasing.createPurchase(purchase(), 'usman');
    expect(number).toBe('PI-2026-000001');
    const [variant] = catalog.variants({ showCost: true });
    expect(variant).toMatchObject({ label: 'Samsung Galaxy A55 8/256 Navy', inStock: 2, stockValue: 22000000, lastCost: 11000000 });
    expect(catalog.items({ showCost: true })[0]).toMatchObject({ onHand: 10, averageCost: 40000 });
    expect(catalog.items({ showCost: false })[0]!.averageCost).toBeNull();
    expect(catalog.variants({ showCost: false })[0]!.stockValue).toBeNull();
  });

  it('finds a handset by either IMEI with its history', () => {
    purchasing.createPurchase(purchase(), 'usman');
    const found = catalog.lookupImei(imei('35123456789013'), true)!;
    expect(found).toMatchObject({ status: 'in_stock', supplierName: 'Hall Road Traders', purchaseNumber: 'PI-2026-000001', cost: 11000000 });
    expect(found.history).toEqual([expect.objectContaining({ docType: 'purchase', docNumber: 'PI-2026-000001', quantity: 1 })]);
    expect(catalog.lookupImei('000000000000000', true)).toBeNull();
  });

  it('refuses invalid, repeated and already-received IMEIs, and saves nothing', () => {
    const bad = imei('35123456789012').slice(0, 14) + '0';
    const typo = isValidImei(bad) ? imei('35123456789012').slice(0, 14) + '1' : bad;
    expect(() => purchasing.createPurchase(purchase({ lines: [{ kind: 'device', variantId, unitCost: 1, devices: [device(typo)] }] }), 'usman')).toThrow();

    const one = imei('35999999999990');
    expect(() =>
      purchasing.createPurchase(purchase({ lines: [{ kind: 'device', variantId, unitCost: 1, devices: [device(one), device(one)] }] }), 'usman'),
    ).toThrow(/cannot be received/);

    purchasing.createPurchase(purchase(), 'usman');
    try {
      purchasing.createPurchase(purchase(), 'usman');
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).details?.[0]).toMatch(/Already in the system/);
    }
    // Only the first purchase exists, and numbering did not skip.
    expect(purchasing.purchases({ limit: 10 }).map((row) => row.number)).toEqual(['PI-2026-000001']);
    expect(purchasing.createPurchase(purchase({ lines: [{ kind: 'item', itemId, quantity: 1, unitCost: 1 }] }), 'usman').number).toBe('PI-2026-000002');
  });

  it('keeps the supplier balance: opening + purchase - payment', () => {
    purchasing.createPurchase(purchase({ payment: { accountId: 1, amount: 10000000, reference: 'cash' } }), 'usman');
    const supplier = purchasing.suppliers()[0]!;
    // 50,000 opening + 220,000 handsets + 4,000 covers - 100,000 paid
    expect(supplier.balance).toBe(5000000 + 22000000 + 400000 - 10000000);
    purchasing.paySupplier({ supplierId, accountId: 2, amount: 2000000, paymentDate: '2026-11-25', reference: 'JC-1', notes: '' }, 'usman');
    const statement = purchasing.statement(supplierId);
    expect(statement.entries.map((entry) => entry.docType)).toEqual(['Opening balance', 'Purchase', 'Payment', 'Payment']);
    expect(statement.entries.at(-1)!.balance).toBe(supplier.balance - 2000000);
  });

  it('spreads a purchase discount over unit costs', () => {
    purchasing.createPurchase(purchase({ discount: 2240000 }), 'usman'); // 10% of 22,400,000
    expect(catalog.lookupImei(imei('35123456789020'), true)!.cost).toBe(9900000);
    expect(catalog.items({ showCost: true })[0]!.averageCost).toBe(36000);
  });

  it('returns handsets and items to the supplier', () => {
    purchasing.createPurchase(purchase(), 'usman');
    const handset = catalog.lookupImei(imei('35123456789020'), true)!;
    const before = purchasing.suppliers()[0]!.balance;
    const { number } = purchasing.createReturn(
      { supplierId, returnDate: '2026-11-26', reason: 'Dead on arrival', deviceIds: [handset.id], items: [{ itemId, quantity: 4 }], refund: null },
      'usman',
    );
    expect(number).toBe('PR-2026-000001');
    expect(catalog.lookupImei(handset.imei1, true)!.status).toBe('returned_to_supplier');
    expect(catalog.variants({ showCost: true })[0]!.inStock).toBe(1);
    expect(catalog.items({ showCost: true })[0]!.onHand).toBe(6);
    expect(purchasing.suppliers()[0]!.balance).toBe(before - 11000000 - 160000);

    expect(() =>
      purchasing.createReturn({ supplierId, returnDate: '2026-11-26', reason: '', deviceIds: [handset.id], items: [], refund: null }, 'usman'),
    ).toThrow(/not in stock/);
    expect(() =>
      purchasing.createReturn({ supplierId, returnDate: '2026-11-26', reason: '', deviceIds: [], items: [{ itemId, quantity: 7 }], refund: null }, 'usman'),
    ).toThrow(/Only 6/);
  });

  it('a cash refund leaves the balance unchanged and adds to the account', () => {
    purchasing.createPurchase(purchase({ payment: { accountId: 1, amount: 22400000, reference: '' } }), 'usman');
    const handset = catalog.lookupImei(imei('35123456789020'), true)!;
    const before = purchasing.suppliers()[0]!.balance;
    purchasing.createReturn(
      { supplierId, returnDate: '2026-11-26', reason: 'Faulty', deviceIds: [handset.id], items: [], refund: { accountId: 1, amount: 11000000, reference: '' } },
      'usman',
    );
    expect(purchasing.suppliers()[0]!.balance).toBe(before);
    const cash = db.prepare('SELECT sum(amount) AS total FROM money_ledger WHERE account_id = 1').get() as { total: number };
    expect(cash.total).toBe(-22400000 + 11000000);
  });

  it('blocks purchases, payments and returns when the licence is read-only, but not lookups', () => {
    licensed = false;
    expect(() => purchasing.createPurchase(purchase(), 'usman')).toThrow(/Read-only/);
    expect(() => purchasing.paySupplier({ supplierId, accountId: 1, amount: 100, paymentDate: '2026-11-24', reference: '', notes: '' }, 'usman')).toThrow(/Read-only/);
    expect(catalog.variants({ showCost: true })).toHaveLength(1);
    expect(purchasing.statement(supplierId).entries).toHaveLength(1);
  });

  it('protects the stock and money ledgers from edits', () => {
    purchasing.createPurchase(purchase({ payment: { accountId: 1, amount: 100, reference: '' } }), 'usman');
    expect(() => db.prepare('DELETE FROM stock_ledger').run()).toThrow(/append-only/);
    expect(() => db.prepare('UPDATE money_ledger SET amount = 1').run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM party_ledger').run()).toThrow(/append-only/);
  });

  it('refuses duplicate catalogue entries', () => {
    expect(() => catalog.createBrand({ name: 'samsung' }, 'usman')).toThrow(/already exists/);
    const model = catalog.brands()[0]!.models[0]!.id;
    expect(() => catalog.createVariant({ modelId: model, ramGb: 8, storageGb: 256, colour: 'navy', salePrice: 1, minSalePrice: 0 }, 'usman')).toThrow(/already exists/);
    expect(() => catalog.createVariant({ modelId: model, ramGb: 8, storageGb: 128, colour: 'Navy', salePrice: 100, minSalePrice: 200 }, 'usman')).toThrow(/minimum sale price/);
    expect(() => catalog.createItem({ name: 'Other', category: '', barcode: '8964000123', salePrice: 0, reorderLevel: 0 }, 'usman')).toThrow(/already exists/);
  });
});
