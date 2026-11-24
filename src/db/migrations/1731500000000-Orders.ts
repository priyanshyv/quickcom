import { MigrationInterface, QueryRunner } from 'typeorm';

// Chapter 4: checkout, payments, the order state machine, and the outbox.
//
//   orders                    one row per order; status is a column, changed ONLY through allowed transitions
//   order_items               what was bought, with the price AT THAT MOMENT (a snapshot, never a live lookup)
//   order_statuses            the list of states            ┐ the rules live in the database, not in
//   order_status_transitions  which state may follow which  ┘ if/else spread across the code
//   order_status_log          every change: from, to, why, who. The order's history.
//   payments                  one row per payment ATTEMPT (a customer may fail, then retry)
//   webhook_events            every webhook we accepted, keyed by the gateway's event id ("inbox": dedupe)
//   outbox                    events to publish, written in the SAME transaction as the change they describe
//   notifications             what the consumer "sent" (SMS), keyed by outbox id (idempotent consumer)
export class Orders1731500000000 implements MigrationInterface {
  name = 'Orders1731500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE order_statuses (
        code         VARCHAR(20) PRIMARY KEY,
        description  VARCHAR(200) NOT NULL,
        is_terminal  BOOLEAN NOT NULL DEFAULT false
      )`);
    await q.query(`
      INSERT INTO order_statuses (code, description, is_terminal) VALUES
        ('PAYMENT_PENDING', 'Order placed, stock held, waiting for payment', false),
        ('RX_REVIEW',       'Paid; a pharmacist must check the prescription first', false),
        ('CONFIRMED',       'Paid (and Rx approved if needed); the store can pack it', false),
        ('CANCELLED',       'Will not be delivered; stock released, money refunded if taken', true)`);

    await q.query(`
      CREATE TABLE order_status_transitions (
        from_status  VARCHAR(20) NOT NULL REFERENCES order_statuses(code),
        to_status    VARCHAR(20) NOT NULL REFERENCES order_statuses(code),
        PRIMARY KEY (from_status, to_status)
      )`);
    // Chapter 5 adds PACKING, PACKED, ... by inserting rows here. No code change
    // is needed to ALLOW a new move; the transition function reads this table.
    await q.query(`
      INSERT INTO order_status_transitions (from_status, to_status) VALUES
        ('PAYMENT_PENDING', 'CONFIRMED'),
        ('PAYMENT_PENDING', 'RX_REVIEW'),
        ('PAYMENT_PENDING', 'CANCELLED'),
        ('RX_REVIEW',       'CONFIRMED'),
        ('RX_REVIEW',       'CANCELLED'),
        ('CONFIRMED',       'CANCELLED')`);

    await q.query(`
      CREATE TABLE orders (
        id                  BIGSERIAL PRIMARY KEY,
        customer_ref        VARCHAR(64) NOT NULL,       -- the cart id (we have no login yet)
        store_id            INT NOT NULL REFERENCES stores(id),
        status              VARCHAR(20) NOT NULL REFERENCES order_statuses(code),
        idempotency_key     VARCHAR(80) NOT NULL UNIQUE, -- sent by the app; same key = same order
        request_fingerprint VARCHAR(64) NOT NULL,        -- what the key was used for (catches key reuse)
        items_total_paise   INT NOT NULL CHECK (items_total_paise > 0),
        delivery_fee_paise  INT NOT NULL CHECK (delivery_fee_paise >= 0),
        total_paise         INT NOT NULL CHECK (total_paise > 0),
        has_rx              BOOLEAN NOT NULL,
        payment_due_at      TIMESTAMPTZ NOT NULL,        -- pay by then, or the order is cancelled and stock released
        cancel_reason       VARCHAR(40),
        version             INT NOT NULL DEFAULT 0,      -- +1 on every status change
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_orders_customer ON orders (customer_ref, created_at DESC)`);
    await q.query(`CREATE INDEX idx_orders_payment_due ON orders (payment_due_at) WHERE status = 'PAYMENT_PENDING'`);
    await q.query(`CREATE INDEX idx_orders_rx_review ON orders (created_at) WHERE status = 'RX_REVIEW'`);

    await q.query(`
      CREATE TABLE order_items (
        order_id     BIGINT NOT NULL REFERENCES orders(id),
        sku_id       INT NOT NULL REFERENCES skus(id),
        name         VARCHAR(200) NOT NULL,   -- snapshot: renaming a SKU later must not rewrite old bills
        qty          INT NOT NULL CHECK (qty > 0),
        price_paise  INT NOT NULL CHECK (price_paise > 0),
        rx_required  BOOLEAN NOT NULL,
        PRIMARY KEY (order_id, sku_id)
      )`);

    await q.query(`
      CREATE TABLE order_status_log (
        id           BIGSERIAL PRIMARY KEY,
        order_id     BIGINT NOT NULL REFERENCES orders(id),
        from_status  VARCHAR(20),
        to_status    VARCHAR(20) NOT NULL,
        reason       VARCHAR(60) NOT NULL,
        actor        VARCHAR(30) NOT NULL,    -- customer / webhook / reconciler / pharmacist / timeout ...
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_order_status_log_order ON order_status_log (order_id, id)`);

    await q.query(`
      CREATE TABLE payments (
        id            BIGSERIAL PRIMARY KEY,
        order_id      BIGINT NOT NULL REFERENCES orders(id),
        gateway_ref   VARCHAR(40) NOT NULL UNIQUE,
        amount_paise  INT NOT NULL CHECK (amount_paise > 0),
        status        VARCHAR(12) NOT NULL CHECK (status IN ('created', 'captured', 'failed', 'refunded')),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    // At most ONE open attempt per order. A double tap on "Pay" can't open two.
    await q.query(`CREATE UNIQUE INDEX uq_payments_one_open ON payments (order_id) WHERE status = 'created'`);

    await q.query(`
      CREATE TABLE webhook_events (
        event_id     VARCHAR(60) PRIMARY KEY,   -- the gateway's id: a redelivery has the SAME id
        gateway_ref  VARCHAR(40) NOT NULL,
        type         VARCHAR(40) NOT NULL,
        outcome      VARCHAR(20) NOT NULL,      -- applied / ignored (already handled, or stale)
        payload      JSONB NOT NULL,
        received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_webhook_events_ref ON webhook_events (gateway_ref)`);

    await q.query(`
      CREATE TABLE outbox (
        id            BIGSERIAL PRIMARY KEY,
        order_id      BIGINT,
        event_type    VARCHAR(40) NOT NULL,
        payload       JSONB NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at  TIMESTAMPTZ,
        attempts      INT NOT NULL DEFAULT 0,
        last_error    TEXT
      )`);
    await q.query(`CREATE INDEX idx_outbox_unpublished ON outbox (id) WHERE published_at IS NULL`);
    await q.query(`CREATE INDEX idx_outbox_order ON outbox (order_id, id)`);

    await q.query(`
      CREATE TABLE notifications (
        event_id    BIGINT PRIMARY KEY,         -- the outbox id: a redelivered event can't send a 2nd SMS
        order_id    BIGINT,
        channel     VARCHAR(10) NOT NULL,
        body        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_notifications_order ON notifications (order_id, created_at)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    for (const t of ['notifications', 'outbox', 'webhook_events', 'payments', 'order_status_log', 'order_items', 'orders', 'order_status_transitions', 'order_statuses']) {
      await q.query(`DROP TABLE IF EXISTS ${t}`);
    }
  }
}
