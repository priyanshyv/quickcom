import { MigrationInterface, QueryRunner } from 'typeorm';

// Phase 0 schema. Written as plain SQL on purpose so you can read exactly what
// Postgres stores. Four tables:
//
//   stores           the dark stores (a small warehouse 1-3 km from customers)
//   skus             the catalog — same for every store
//   store_inventory  how many of each SKU each store has (store x sku)
//   riders           delivery partners, each attached to a home store
export class Foundation1731300000000 implements MigrationInterface {
  name = 'Foundation1731300000000';

  public async up(q: QueryRunner): Promise<void> {
    // PostGIS teaches Postgres about maps: points, polygons, distances.
    await q.query(`CREATE EXTENSION IF NOT EXISTS postgis`);

    // geography(...,4326) = real lat/lng on the round earth, distances in METRES.
    // (geometry would be flat x/y — fine for small areas, wrong across a city.)
    await q.query(`
      CREATE TABLE stores (
        id                   SERIAL PRIMARY KEY,
        code                 VARCHAR(16)  NOT NULL UNIQUE,     -- e.g. BLR-KOR
        name                 VARCHAR(100) NOT NULL,
        area                 VARCHAR(100) NOT NULL,
        location             geography(Point, 4326)   NOT NULL,  -- where the store is
        service_area         geography(Polygon, 4326) NOT NULL,  -- where it delivers
        is_active            BOOLEAN NOT NULL DEFAULT true,
        max_orders_per_hour  INT     NOT NULL DEFAULT 120,  -- capacity (orders the store can handle per hour)
        opens_at             TIME    NOT NULL DEFAULT '06:00',
        closes_at            TIME    NOT NULL DEFAULT '02:00',
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    // GIST = the spatial index. Without it "which polygon contains this point?"
    // checks every store; with it Postgres jumps straight to the candidates.
    await q.query(`CREATE INDEX idx_stores_service_area ON stores USING GIST (service_area)`);
    await q.query(`CREATE INDEX idx_stores_location ON stores USING GIST (location)`);

    await q.query(`
      CREATE TABLE skus (
        id            SERIAL PRIMARY KEY,
        code          VARCHAR(32)  NOT NULL UNIQUE,
        name          VARCHAR(200) NOT NULL,
        category      VARCHAR(50)  NOT NULL,
        pack_size     VARCHAR(50)  NOT NULL,
        mrp_paise     INT     NOT NULL CHECK (mrp_paise > 0),  -- money as integer paise, never float
        rx_required   BOOLEAN NOT NULL DEFAULT false,          -- needs a prescription check
        cold_chain    BOOLEAN NOT NULL DEFAULT false,          -- must stay 2-8 °C (insulin etc.)
        is_active     BOOLEAN NOT NULL DEFAULT true
      )`);
    await q.query(`CREATE INDEX idx_skus_category ON skus (category)`);

    // on_hand  = physically on the shelf
    // reserved = promised to carts/orders that haven't been picked yet
    // available to sell = on_hand - reserved   (phase 3 is all about this line)
    await q.query(`
      CREATE TABLE store_inventory (
        store_id     INT NOT NULL REFERENCES stores(id),
        sku_id       INT NOT NULL REFERENCES skus(id),
        on_hand_qty  INT NOT NULL DEFAULT 0 CHECK (on_hand_qty >= 0),
        reserved_qty INT NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (store_id, sku_id)   -- store_id FIRST: every query is "for this store"
      )`);

    await q.query(`
      CREATE TABLE riders (
        id             SERIAL PRIMARY KEY,
        name           VARCHAR(100) NOT NULL,
        phone          VARCHAR(20)  NOT NULL UNIQUE,
        home_store_id  INT NOT NULL REFERENCES stores(id),
        vehicle        VARCHAR(10)  NOT NULL CHECK (vehicle IN ('bike', 'ev', 'cycle')),
        is_active      BOOLEAN NOT NULL DEFAULT true
      )`);
    await q.query(`CREATE INDEX idx_riders_home_store ON riders (home_store_id)`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS riders`);
    await q.query(`DROP TABLE IF EXISTS store_inventory`);
    await q.query(`DROP TABLE IF EXISTS skus`);
    await q.query(`DROP TABLE IF EXISTS stores`);
  }
}
