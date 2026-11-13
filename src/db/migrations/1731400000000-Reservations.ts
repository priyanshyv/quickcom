import { MigrationInterface, QueryRunner } from 'typeorm';

// Chapter 3: a "hold" on stock while it sits in someone's cart.
//
// One row per cart line (cart x store x sku). The row is reused when the
// customer changes the quantity, so "set qty to 2" twice is the same as once.
//
//   status   held      -> counted in store_inventory.reserved_qty
//            released  -> customer removed it (qty 0)
//            expired   -> nobody touched the cart for HOLD minutes; the sweeper gave the stock back
//            consumed  -> became an order (chapter 4)
export class Reservations1731400000000 implements MigrationInterface {
  name = 'Reservations1731400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE reservations (
        id          BIGSERIAL PRIMARY KEY,
        cart_id     VARCHAR(64) NOT NULL,
        store_id    INT NOT NULL REFERENCES stores(id),
        sku_id      INT NOT NULL REFERENCES skus(id),
        qty         INT NOT NULL CHECK (qty >= 0),
        status      VARCHAR(10) NOT NULL CHECK (status IN ('held', 'released', 'expired', 'consumed')),
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (cart_id, store_id, sku_id)
      )`);
    // The sweeper's question: "which holds have run out?" Only 'held' rows
    // matter, so a partial index keeps it tiny however many old rows pile up.
    await q.query(`CREATE INDEX idx_reservations_due ON reservations (expires_at) WHERE status = 'held'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS reservations`);
  }
}
