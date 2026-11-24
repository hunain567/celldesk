import {
  BrandInputSchema,
  ItemInputSchema,
  ItemUpdateSchema,
  ModelInputSchema,
  VariantInputSchema,
  VariantUpdateSchema,
  variantLabel,
  type BrandSummary,
  type DeviceDetail,
  type ItemSummary,
  type StockDevice,
  type VariantSummary,
} from '@nexodesk/shared';
import type { z } from 'zod';
import { AppError } from '../errors';
import { notFound, nowOf, uniqueViolation, type BusinessContext } from './business';

interface VariantRow {
  id: number;
  model_id: number;
  brand_id: number;
  brand_name: string;
  model_name: string;
  ram_gb: number | null;
  storage_gb: number | null;
  colour: string;
  sale_price: number;
  min_sale_price: number;
  is_active: number;
  in_stock: number;
  stock_value: number | null;
  last_cost: number | null;
}

/** Brands, models, variants, accessories and stock lookups. */
export class CatalogService {
  constructor(private readonly context: BusinessContext) {}

  private get db() {
    return this.context.db;
  }

  brands(): BrandSummary[] {
    const brands = this.db.prepare('SELECT id, name, is_active FROM brands ORDER BY name').all() as Array<{ id: number; name: string; is_active: number }>;
    const models = this.db.prepare('SELECT id, brand_id, name, is_active FROM models ORDER BY name').all() as Array<{
      id: number;
      brand_id: number;
      name: string;
      is_active: number;
    }>;
    return brands.map((brand) => ({
      id: brand.id,
      name: brand.name,
      isActive: brand.is_active === 1,
      models: models
        .filter((model) => model.brand_id === brand.id)
        .map((model) => ({ id: model.id, brandId: model.brand_id, name: model.name, isActive: model.is_active === 1 })),
    }));
  }

  createBrand(input: z.infer<typeof BrandInputSchema>, actor: string): number {
    const { name } = BrandInputSchema.parse(input);
    try {
      const id = Number(this.db.prepare('INSERT INTO brands (name, created_at) VALUES (?, ?)').run(name, nowOf(this.context).toISOString()).lastInsertRowid);
      this.context.audit.append({ actor, action: 'catalog.brand.create', entityType: 'brand', entityId: String(id), details: { name } });
      return id;
    } catch (error) {
      return uniqueViolation(error, `The brand "${name}" already exists.`);
    }
  }

  createModel(input: z.infer<typeof ModelInputSchema>, actor: string): number {
    const { brandId, name } = ModelInputSchema.parse(input);
    if (!this.db.prepare('SELECT 1 FROM brands WHERE id = ?').get(brandId)) throw notFound('The brand');
    try {
      const id = Number(
        this.db.prepare('INSERT INTO models (brand_id, name, created_at) VALUES (?, ?, ?)').run(brandId, name, nowOf(this.context).toISOString()).lastInsertRowid,
      );
      this.context.audit.append({ actor, action: 'catalog.model.create', entityType: 'model', entityId: String(id), details: { name } });
      return id;
    } catch (error) {
      return uniqueViolation(error, `The model "${name}" already exists for this brand.`);
    }
  }

  createVariant(input: z.infer<typeof VariantInputSchema>, actor: string): number {
    const variant = VariantInputSchema.parse(input);
    if (variant.minSalePrice > variant.salePrice) {
      throw new AppError('VALIDATION_FAILED', 'The minimum sale price cannot be higher than the sale price.');
    }
    if (!this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(variant.modelId)) throw notFound('The model');
    // SQLite treats NULLs as distinct in UNIQUE, so check the combination explicitly.
    const duplicate = this.db
      .prepare('SELECT 1 FROM variants WHERE model_id = ? AND ram_gb IS ? AND storage_gb IS ? AND colour = ? COLLATE NOCASE')
      .get(variant.modelId, variant.ramGb, variant.storageGb, variant.colour);
    if (duplicate) throw new AppError('CONFLICT', 'This variant already exists.');
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO variants (model_id, ram_gb, storage_gb, colour, sale_price, min_sale_price, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(variant.modelId, variant.ramGb, variant.storageGb, variant.colour, variant.salePrice, variant.minSalePrice, nowOf(this.context).toISOString())
        .lastInsertRowid,
    );
    this.context.audit.append({ actor, action: 'catalog.variant.create', entityType: 'variant', entityId: String(id) });
    return id;
  }

  updateVariant(input: z.infer<typeof VariantUpdateSchema>, actor: string): void {
    const update = VariantUpdateSchema.parse(input);
    if (update.minSalePrice > update.salePrice) {
      throw new AppError('VALIDATION_FAILED', 'The minimum sale price cannot be higher than the sale price.');
    }
    const result = this.db
      .prepare('UPDATE variants SET sale_price = ?, min_sale_price = ?, is_active = ? WHERE id = ?')
      .run(update.salePrice, update.minSalePrice, update.isActive ? 1 : 0, update.id);
    if (result.changes === 0) throw notFound('The variant');
    this.context.audit.append({
      actor,
      action: 'catalog.variant.update',
      entityType: 'variant',
      entityId: String(update.id),
      details: { salePrice: update.salePrice, minSalePrice: update.minSalePrice, active: update.isActive },
    });
  }

  variants(options: { query?: string; includeInactive?: boolean; showCost: boolean }): VariantSummary[] {
    const rows = this.db
      .prepare(
        `SELECT v.*, m.name AS model_name, b.id AS brand_id, b.name AS brand_name,
           (SELECT count(*) FROM devices d WHERE d.variant_id = v.id AND d.status = 'in_stock') AS in_stock,
           (SELECT sum(d.cost) FROM devices d WHERE d.variant_id = v.id AND d.status = 'in_stock') AS stock_value,
           (SELECT d.cost FROM devices d WHERE d.variant_id = v.id ORDER BY d.id DESC LIMIT 1) AS last_cost
         FROM variants v JOIN models m ON m.id = v.model_id JOIN brands b ON b.id = m.brand_id
         WHERE (? = 1 OR v.is_active = 1)
         ORDER BY b.name, m.name, v.storage_gb, v.ram_gb, v.colour`,
      )
      .all(options.includeInactive ? 1 : 0) as VariantRow[];
    const terms = (options.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return rows
      .map((row) => {
        const label = variantLabel({ brandName: row.brand_name, modelName: row.model_name, ramGb: row.ram_gb, storageGb: row.storage_gb, colour: row.colour });
        return {
          id: row.id,
          modelId: row.model_id,
          brandId: row.brand_id,
          brandName: row.brand_name,
          modelName: row.model_name,
          ramGb: row.ram_gb,
          storageGb: row.storage_gb,
          colour: row.colour,
          label,
          salePrice: row.sale_price,
          minSalePrice: row.min_sale_price,
          isActive: row.is_active === 1,
          inStock: row.in_stock,
          stockValue: options.showCost ? (row.stock_value ?? 0) : null,
          lastCost: options.showCost ? row.last_cost : null,
        };
      })
      .filter((variant) => terms.every((term) => variant.label.toLowerCase().includes(term)));
  }

  createItem(input: z.infer<typeof ItemInputSchema>, actor: string): number {
    const item = ItemInputSchema.parse(input);
    try {
      const id = Number(
        this.db
          .prepare('INSERT INTO items (name, category, barcode, sale_price, reorder_level, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(item.name, item.category, item.barcode || null, item.salePrice, item.reorderLevel, nowOf(this.context).toISOString()).lastInsertRowid,
      );
      this.context.audit.append({ actor, action: 'catalog.item.create', entityType: 'item', entityId: String(id), details: { name: item.name } });
      return id;
    } catch (error) {
      return uniqueViolation(error, 'An item with this name or barcode already exists.');
    }
  }

  updateItem(input: z.infer<typeof ItemUpdateSchema>, actor: string): void {
    const item = ItemUpdateSchema.parse(input);
    try {
      const result = this.db
        .prepare('UPDATE items SET name = ?, category = ?, barcode = ?, sale_price = ?, reorder_level = ?, is_active = ? WHERE id = ?')
        .run(item.name, item.category, item.barcode || null, item.salePrice, item.reorderLevel, item.isActive ? 1 : 0, item.id);
      if (result.changes === 0) throw notFound('The item');
    } catch (error) {
      uniqueViolation(error, 'An item with this name or barcode already exists.');
    }
    this.context.audit.append({ actor, action: 'catalog.item.update', entityType: 'item', entityId: String(item.id) });
  }

  items(options: { query?: string; includeInactive?: boolean; showCost: boolean }): ItemSummary[] {
    const rows = this.db
      .prepare(
        `SELECT i.*, coalesce((SELECT sum(quantity) FROM stock_ledger s WHERE s.item_id = i.id), 0) AS on_hand
         FROM items i WHERE (? = 1 OR i.is_active = 1) ORDER BY i.category, i.name`,
      )
      .all(options.includeInactive ? 1 : 0) as Array<{
      id: number;
      name: string;
      category: string;
      barcode: string | null;
      sale_price: number;
      average_cost: number;
      reorder_level: number;
      is_active: number;
      on_hand: number;
    }>;
    const query = (options.query ?? '').trim().toLowerCase();
    return rows
      .filter((row) => !query || row.barcode === query || `${row.name} ${row.category}`.toLowerCase().includes(query))
      .map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        barcode: row.barcode,
        salePrice: row.sale_price,
        averageCost: options.showCost ? row.average_cost : null,
        reorderLevel: row.reorder_level,
        onHand: row.on_hand,
        isActive: row.is_active === 1,
      }));
  }

  devicesInStock(variantId: number, showCost: boolean): StockDevice[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.imei1, d.imei2, d.condition, d.pta_status, d.cost, d.created_at, s.name AS supplier_name
         FROM devices d LEFT JOIN suppliers s ON s.id = d.supplier_id
         WHERE d.variant_id = ? AND d.status = 'in_stock' ORDER BY d.id`,
      )
      .all(variantId) as Array<{
      id: number;
      imei1: string;
      imei2: string | null;
      condition: StockDevice['condition'];
      pta_status: StockDevice['ptaStatus'];
      cost: number;
      created_at: string;
      supplier_name: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      imei1: row.imei1,
      imei2: row.imei2,
      condition: row.condition,
      ptaStatus: row.pta_status,
      cost: showCost ? row.cost : null,
      supplierName: row.supplier_name,
      receivedAt: row.created_at,
    }));
  }

  /** Full story of one handset, found by either IMEI. */
  lookupImei(imei: string, showCost: boolean): DeviceDetail | null {
    const row = this.db
      .prepare(
        `SELECT d.*, v.sale_price, v.ram_gb, v.storage_gb, v.colour, m.name AS model_name, b.name AS brand_name,
           s.name AS supplier_name, p.number AS purchase_number, p.purchase_date
         FROM devices d
         JOIN variants v ON v.id = d.variant_id JOIN models m ON m.id = v.model_id JOIN brands b ON b.id = m.brand_id
         LEFT JOIN suppliers s ON s.id = d.supplier_id
         LEFT JOIN purchase_lines pl ON pl.id = d.purchase_line_id
         LEFT JOIN purchases p ON p.id = pl.purchase_id
         WHERE d.imei1 = ? OR d.imei2 = ?`,
      )
      .get(imei.trim(), imei.trim()) as
      | {
          id: number;
          imei1: string;
          imei2: string | null;
          variant_id: number;
          condition: DeviceDetail['condition'];
          pta_status: DeviceDetail['ptaStatus'];
          warranty_type: DeviceDetail['warrantyType'];
          warranty_months: number;
          status: DeviceDetail['status'];
          cost: number;
          sale_price: number;
          ram_gb: number | null;
          storage_gb: number | null;
          colour: string;
          model_name: string;
          brand_name: string;
          supplier_id: number | null;
          supplier_name: string | null;
          purchase_number: string | null;
          purchase_date: string | null;
        }
      | undefined;
    if (!row) return null;
    const history = this.db
      .prepare(
        `SELECT s.at, s.doc_type, s.quantity, s.created_by,
           CASE s.doc_type
             WHEN 'purchase' THEN (SELECT number FROM purchases WHERE id = s.doc_id)
             WHEN 'purchase_return' THEN (SELECT number FROM purchase_returns WHERE id = s.doc_id)
             WHEN 'sale' THEN (SELECT number FROM sales WHERE id = s.doc_id)
             WHEN 'sale_return' THEN (SELECT number FROM sale_returns WHERE id = s.doc_id)
           END AS doc_number
         FROM stock_ledger s WHERE s.device_id = ? ORDER BY s.id`,
      )
      .all(row.id) as Array<{ at: string; doc_type: string; quantity: number; created_by: string; doc_number: string | null }>;
    return {
      id: row.id,
      imei1: row.imei1,
      imei2: row.imei2,
      variantId: row.variant_id,
      label: variantLabel({ brandName: row.brand_name, modelName: row.model_name, ramGb: row.ram_gb, storageGb: row.storage_gb, colour: row.colour }),
      condition: row.condition,
      ptaStatus: row.pta_status,
      warrantyType: row.warranty_type,
      warrantyMonths: row.warranty_months,
      status: row.status,
      cost: showCost ? row.cost : null,
      salePrice: row.sale_price,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      purchaseNumber: row.purchase_number,
      purchaseDate: row.purchase_date,
      history: history.map((entry) => ({
        at: entry.at,
        docType: entry.doc_type,
        docNumber: entry.doc_number,
        quantity: entry.quantity,
        createdBy: entry.created_by,
      })),
    };
  }
}
