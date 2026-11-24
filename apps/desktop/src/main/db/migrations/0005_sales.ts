import type { Migration } from '../migrator';

/**
 * Customers, sales, sale payments and sale returns (including exchanges).
 *
 * Posted sales and returns are never changed: triggers refuse UPDATE and DELETE.
 * An exchange is a return whose value pays for a new sale, saved together.
 */
export const migration0005: Migration = {
  version: 5,
  name: 'sales',
  up(db) {
    db.exec(`
      CREATE TABLE customers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT NOT NULL COLLATE NOCASE,
        phone       TEXT NOT NULL DEFAULT '',
        city        TEXT NOT NULL DEFAULT '',
        address     TEXT NOT NULL DEFAULT '',
        is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        created_at  TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_customers_phone ON customers (phone);
      CREATE UNIQUE INDEX idx_customers_phone_unique ON customers (phone) WHERE phone != '';

      CREATE TABLE sale_returns (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        number             TEXT NOT NULL UNIQUE,
        sale_id            INTEGER NOT NULL,
        return_date        TEXT NOT NULL,
        total              INTEGER NOT NULL CHECK (total >= 0),
        refund_account_id  INTEGER REFERENCES accounts (id),
        refund_amount      INTEGER NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
        exchange_amount    INTEGER NOT NULL DEFAULT 0 CHECK (exchange_amount >= 0),
        customer_credit    INTEGER NOT NULL DEFAULT 0 CHECK (customer_credit >= 0),
        reason             TEXT NOT NULL DEFAULT '',
        created_by         TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        CHECK (refund_amount + exchange_amount + customer_credit = total),
        CHECK (refund_amount = 0 OR refund_account_id IS NOT NULL)
      ) STRICT;

      CREATE TABLE sales (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        number              TEXT NOT NULL UNIQUE,
        sale_date           TEXT NOT NULL,
        customer_id         INTEGER REFERENCES customers (id),
        customer_name       TEXT NOT NULL DEFAULT '',
        customer_phone      TEXT NOT NULL DEFAULT '',
        subtotal            INTEGER NOT NULL CHECK (subtotal >= 0),
        discount            INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
        total               INTEGER NOT NULL CHECK (total >= 0),
        exchange_return_id  INTEGER UNIQUE REFERENCES sale_returns (id),
        exchange_credit     INTEGER NOT NULL DEFAULT 0 CHECK (exchange_credit >= 0 AND exchange_credit <= total),
        paid                INTEGER NOT NULL DEFAULT 0 CHECK (paid >= 0),
        notes               TEXT NOT NULL DEFAULT '',
        created_by          TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        CHECK (exchange_credit + paid <= total),
        CHECK (customer_id IS NOT NULL OR exchange_credit + paid = total)
      ) STRICT;
      CREATE INDEX idx_sales_customer ON sales (customer_id);
      CREATE INDEX idx_sales_date ON sales (sale_date);

      CREATE TABLE sale_lines (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id         INTEGER NOT NULL REFERENCES sales (id),
        line_no         INTEGER NOT NULL,
        device_id       INTEGER REFERENCES devices (id),
        item_id         INTEGER REFERENCES items (id),
        quantity        INTEGER NOT NULL CHECK (quantity > 0),
        unit_price      INTEGER NOT NULL CHECK (unit_price >= 0),
        net_unit_price  INTEGER NOT NULL CHECK (net_unit_price >= 0),
        unit_cost       INTEGER NOT NULL CHECK (unit_cost >= 0),
        line_total      INTEGER NOT NULL CHECK (line_total >= 0),
        CHECK ((device_id IS NULL) != (item_id IS NULL)),
        CHECK (device_id IS NULL OR quantity = 1)
      ) STRICT;
      CREATE INDEX idx_sale_lines_sale ON sale_lines (sale_id);
      CREATE INDEX idx_sale_lines_device ON sale_lines (device_id);

      CREATE TABLE sale_payments (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id     INTEGER NOT NULL REFERENCES sales (id),
        account_id  INTEGER NOT NULL REFERENCES accounts (id),
        amount      INTEGER NOT NULL CHECK (amount > 0),
        reference   TEXT NOT NULL DEFAULT ''
      ) STRICT;
      CREATE INDEX idx_sale_payments_sale ON sale_payments (sale_id);

      CREATE TABLE sale_return_lines (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id       INTEGER NOT NULL REFERENCES sale_returns (id),
        sale_line_id    INTEGER NOT NULL REFERENCES sale_lines (id),
        quantity        INTEGER NOT NULL CHECK (quantity > 0),
        unit_price      INTEGER NOT NULL CHECK (unit_price >= 0),
        unit_cost       INTEGER NOT NULL CHECK (unit_cost >= 0),
        line_total      INTEGER NOT NULL CHECK (line_total >= 0)
      ) STRICT;
      CREATE INDEX idx_sale_return_lines_line ON sale_return_lines (sale_line_id);
      CREATE INDEX idx_sale_return_lines_return ON sale_return_lines (return_id);
    `);

    for (const table of ['sales', 'sale_lines', 'sale_payments', 'sale_returns', 'sale_return_lines']) {
      db.exec(`
        CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT, 'Posted ${table.replace(/_/g, ' ')} cannot be changed'); END;
        CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT, 'Posted ${table.replace(/_/g, ' ')} cannot be deleted'); END;
      `);
    }
  },
};
