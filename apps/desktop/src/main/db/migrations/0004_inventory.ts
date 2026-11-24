import type { Migration } from '../migrator';

/**
 * Catalogue, handsets, stock, suppliers, purchases and the money/party ledgers.
 *
 * Rules:
 * - Amounts are integer paisa.
 * - Posted documents are never edited; mistakes are corrected with returns.
 * - stock_ledger, party_ledger and money_ledger are append-only; balances are sums.
 */
export const migration0004: Migration = {
  version: 4,
  name: 'inventory',
  up(db) {
    db.exec(`
      CREATE TABLE number_series (
        prefix     TEXT NOT NULL,
        year       INTEGER NOT NULL,
        next_value INTEGER NOT NULL,
        PRIMARY KEY (prefix, year)
      ) STRICT;

      -- ---------- Catalogue ----------
      CREATE TABLE brands (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at  TEXT NOT NULL
      ) STRICT;

      CREATE TABLE models (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        brand_id    INTEGER NOT NULL REFERENCES brands (id),
        name        TEXT NOT NULL COLLATE NOCASE,
        is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at  TEXT NOT NULL,
        UNIQUE (brand_id, name)
      ) STRICT;

      -- A sellable handset definition, e.g. Galaxy A55 8/256 Navy.
      CREATE TABLE variants (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id        INTEGER NOT NULL REFERENCES models (id),
        ram_gb          INTEGER,
        storage_gb      INTEGER,
        colour          TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
        sale_price      INTEGER NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
        min_sale_price  INTEGER NOT NULL DEFAULT 0 CHECK (min_sale_price >= 0),
        is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at      TEXT NOT NULL,
        UNIQUE (model_id, ram_gb, storage_gb, colour)
      ) STRICT;

      -- Accessories and other items counted by quantity.
      CREATE TABLE items (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
        category       TEXT NOT NULL DEFAULT '',
        barcode        TEXT UNIQUE,
        sale_price     INTEGER NOT NULL DEFAULT 0 CHECK (sale_price >= 0),
        average_cost   INTEGER NOT NULL DEFAULT 0 CHECK (average_cost >= 0),
        reorder_level  INTEGER NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
        is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at     TEXT NOT NULL
      ) STRICT;

      -- ---------- Parties and money accounts ----------
      CREATE TABLE suppliers (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
        phone            TEXT NOT NULL DEFAULT '',
        city             TEXT NOT NULL DEFAULT '',
        address          TEXT NOT NULL DEFAULT '',
        is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at       TEXT NOT NULL
      ) STRICT;

      CREATE TABLE accounts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
        kind        TEXT NOT NULL CHECK (kind IN ('cash', 'wallet', 'bank')),
        is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at  TEXT NOT NULL
      ) STRICT;

      -- ---------- Purchases ----------
      CREATE TABLE purchases (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        number               TEXT NOT NULL UNIQUE,
        supplier_id          INTEGER NOT NULL REFERENCES suppliers (id),
        supplier_invoice_no  TEXT NOT NULL DEFAULT '',
        purchase_date        TEXT NOT NULL,
        subtotal             INTEGER NOT NULL CHECK (subtotal >= 0),
        discount             INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
        total                INTEGER NOT NULL CHECK (total >= 0),
        notes                TEXT NOT NULL DEFAULT '',
        created_by           TEXT NOT NULL,
        created_at           TEXT NOT NULL
      ) STRICT;

      CREATE TABLE purchase_lines (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_id  INTEGER NOT NULL REFERENCES purchases (id),
        line_no      INTEGER NOT NULL,
        variant_id   INTEGER REFERENCES variants (id),
        item_id      INTEGER REFERENCES items (id),
        quantity     INTEGER NOT NULL CHECK (quantity > 0),
        unit_cost    INTEGER NOT NULL CHECK (unit_cost >= 0),
        line_total   INTEGER NOT NULL CHECK (line_total >= 0),
        CHECK ((variant_id IS NULL) != (item_id IS NULL))
      ) STRICT;

      -- One row per physical handset, from purchase to sale.
      CREATE TABLE devices (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        variant_id        INTEGER NOT NULL REFERENCES variants (id),
        imei1             TEXT NOT NULL UNIQUE,
        imei2             TEXT UNIQUE,
        condition         TEXT NOT NULL CHECK (condition IN ('new', 'open_box', 'used', 'refurbished')),
        pta_status        TEXT NOT NULL CHECK (pta_status IN ('approved', 'non_pta', 'patched')),
        warranty_type     TEXT NOT NULL CHECK (warranty_type IN ('official', 'shop', 'none')),
        warranty_months   INTEGER NOT NULL DEFAULT 0 CHECK (warranty_months >= 0),
        cost              INTEGER NOT NULL CHECK (cost >= 0),
        status            TEXT NOT NULL CHECK (status IN ('in_stock', 'sold', 'returned_to_supplier')),
        purchase_line_id  INTEGER REFERENCES purchase_lines (id),
        supplier_id       INTEGER REFERENCES suppliers (id),
        created_at        TEXT NOT NULL,
        CHECK (imei2 IS NULL OR imei2 != imei1)
      ) STRICT;
      CREATE INDEX idx_devices_variant_status ON devices (variant_id, status);

      CREATE TABLE purchase_returns (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        number        TEXT NOT NULL UNIQUE,
        supplier_id   INTEGER NOT NULL REFERENCES suppliers (id),
        return_date   TEXT NOT NULL,
        total         INTEGER NOT NULL CHECK (total >= 0),
        reason        TEXT NOT NULL DEFAULT '',
        created_by    TEXT NOT NULL,
        created_at    TEXT NOT NULL
      ) STRICT;

      CREATE TABLE purchase_return_lines (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id   INTEGER NOT NULL REFERENCES purchase_returns (id),
        device_id   INTEGER REFERENCES devices (id),
        item_id     INTEGER REFERENCES items (id),
        quantity    INTEGER NOT NULL CHECK (quantity > 0),
        unit_cost   INTEGER NOT NULL CHECK (unit_cost >= 0),
        line_total  INTEGER NOT NULL CHECK (line_total >= 0),
        CHECK ((device_id IS NULL) != (item_id IS NULL))
      ) STRICT;

      CREATE TABLE payments (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        number        TEXT NOT NULL UNIQUE,
        payment_date  TEXT NOT NULL,
        direction     TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        party_type    TEXT NOT NULL CHECK (party_type IN ('supplier', 'customer')),
        party_id      INTEGER NOT NULL,
        account_id    INTEGER NOT NULL REFERENCES accounts (id),
        amount        INTEGER NOT NULL CHECK (amount > 0),
        reference     TEXT NOT NULL DEFAULT '',
        notes         TEXT NOT NULL DEFAULT '',
        doc_type      TEXT,
        doc_id        INTEGER,
        created_by    TEXT NOT NULL,
        created_at    TEXT NOT NULL
      ) STRICT;

      -- ---------- Append-only ledgers ----------
      -- quantity: + in, - out. unit_cost: cost of the movement.
      CREATE TABLE stock_ledger (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at          TEXT NOT NULL,
        device_id   INTEGER REFERENCES devices (id),
        item_id     INTEGER REFERENCES items (id),
        quantity    INTEGER NOT NULL CHECK (quantity != 0),
        unit_cost   INTEGER NOT NULL CHECK (unit_cost >= 0),
        doc_type    TEXT NOT NULL,
        doc_id      INTEGER NOT NULL,
        created_by  TEXT NOT NULL,
        CHECK ((device_id IS NULL) != (item_id IS NULL))
      ) STRICT;
      CREATE INDEX idx_stock_ledger_item ON stock_ledger (item_id);
      CREATE INDEX idx_stock_ledger_device ON stock_ledger (device_id);

      -- Party balances. For suppliers: credit = we owe more, debit = we owe less.
      CREATE TABLE party_ledger (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at          TEXT NOT NULL,
        entry_date  TEXT NOT NULL,
        party_type  TEXT NOT NULL CHECK (party_type IN ('supplier', 'customer')),
        party_id    INTEGER NOT NULL,
        debit       INTEGER NOT NULL DEFAULT 0 CHECK (debit >= 0),
        credit      INTEGER NOT NULL DEFAULT 0 CHECK (credit >= 0),
        doc_type    TEXT NOT NULL,
        doc_id      INTEGER,
        memo        TEXT NOT NULL DEFAULT '',
        created_by  TEXT NOT NULL,
        CHECK (debit > 0 OR credit > 0)
      ) STRICT;
      CREATE INDEX idx_party_ledger_party ON party_ledger (party_type, party_id, id);

      -- Money in (+) and out (-) of each cash, wallet or bank account.
      CREATE TABLE money_ledger (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at          TEXT NOT NULL,
        entry_date  TEXT NOT NULL,
        account_id  INTEGER NOT NULL REFERENCES accounts (id),
        amount      INTEGER NOT NULL CHECK (amount != 0),
        doc_type    TEXT NOT NULL,
        doc_id      INTEGER,
        memo        TEXT NOT NULL DEFAULT '',
        created_by  TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_money_ledger_account ON money_ledger (account_id, id);
    `);

    for (const table of ['stock_ledger', 'party_ledger', 'money_ledger']) {
      db.exec(`
        CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
        CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
      `);
    }

    const now = new Date().toISOString();
    const insert = db.prepare('INSERT INTO accounts (name, kind, created_at) VALUES (?, ?, ?)');
    insert.run('Cash', 'cash', now);
    insert.run('JazzCash', 'wallet', now);
    insert.run('Easypaisa', 'wallet', now);
    insert.run('Bank', 'bank', now);
  },
};
