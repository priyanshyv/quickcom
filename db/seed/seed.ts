/* eslint-disable no-console */
// Seeds a fake-but-realistic Bangalore: 8 dark stores, a pharmacy catalog,
// stock per store, and riders. Safe to re-run: it wipes and refills.
//
// Run:  npm run db:seed
import dataSource from '../../src/db/data-source';
import { credentials } from '../../src/config/credentials';

// Deterministic random numbers: every run produces the SAME stock levels, so
// numbers in docs/ are reproducible on your machine.
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Approximate centres of real BLR neighbourhoods. Notice the gaps between some
// of them (e.g. Hebbal <-> Whitefield): those are "not serviceable" zones,
// which phase 1 has to handle. Koramangala and HSR overlap: some customers can
// be served by two stores, and phase 1 has to pick one.
const STORES = [
  { code: 'BLR-KOR', name: 'Koramangala Dark Store', area: 'Koramangala', lat: 12.9352, lng: 77.6245, cap: 180 },
  { code: 'BLR-IND', name: 'Indiranagar Dark Store', area: 'Indiranagar', lat: 12.9719, lng: 77.6412, cap: 160 },
  { code: 'BLR-HSR', name: 'HSR Layout Dark Store', area: 'HSR Layout', lat: 12.9116, lng: 77.6474, cap: 150 },
  { code: 'BLR-WFD', name: 'Whitefield Dark Store', area: 'Whitefield', lat: 12.9698, lng: 77.75, cap: 140 },
  { code: 'BLR-JAY', name: 'Jayanagar Dark Store', area: 'Jayanagar', lat: 12.9299, lng: 77.5826, cap: 130 },
  { code: 'BLR-MAL', name: 'Malleshwaram Dark Store', area: 'Malleshwaram', lat: 13.0035, lng: 77.5709, cap: 110 },
  { code: 'BLR-HEB', name: 'Hebbal Dark Store', area: 'Hebbal', lat: 13.0358, lng: 77.597, cap: 100 },
  { code: 'BLR-ECY', name: 'Electronic City Dark Store', area: 'Electronic City', lat: 12.8452, lng: 77.6602, cap: 120 },
];

// [name, category, mrp in rupees, rx_required, cold_chain]
// Generic names only. Each base product is sold in a few pack sizes, which is
// how a real pharmacy catalog explodes into thousands of SKUs.
type Base = [string, string, number, boolean?, boolean?];
const BASE: Base[] = [
  ['Paracetamol 500mg Tablet', 'Fever & Pain', 20],
  ['Paracetamol 650mg Tablet', 'Fever & Pain', 30],
  ['Ibuprofen 400mg Tablet', 'Fever & Pain', 25],
  ['Diclofenac Gel 1%', 'Fever & Pain', 110],
  ['Pain Relief Balm', 'Fever & Pain', 45],
  ['Cetirizine 10mg Tablet', 'Cold & Cough', 18],
  ['Levocetirizine 5mg Tablet', 'Cold & Cough', 40],
  ['Cough Syrup (Dextromethorphan)', 'Cold & Cough', 95],
  ['Steam Inhalation Capsules', 'Cold & Cough', 60],
  ['Saline Nasal Spray', 'Cold & Cough', 120],
  ['Throat Lozenges Honey Lemon', 'Cold & Cough', 35],
  ['ORS Powder Orange', 'Digestive', 22],
  ['Antacid Liquid Mint', 'Digestive', 130],
  ['Pantoprazole 40mg Tablet', 'Digestive', 90, true],
  ['Probiotic Sachet', 'Digestive', 75],
  ['Isabgol Husk', 'Digestive', 140],
  ['Domperidone 10mg Tablet', 'Digestive', 38, true],
  ['Vitamin C 500mg Chewable', 'Vitamins', 99],
  ['Vitamin D3 60000 IU Capsule', 'Vitamins', 130],
  ['Multivitamin Tablet', 'Vitamins', 240],
  ['Zinc 50mg Tablet', 'Vitamins', 85],
  ['Calcium + D3 Tablet', 'Vitamins', 160],
  ['Omega-3 Fish Oil Capsule', 'Vitamins', 450],
  ['Metformin 500mg Tablet', 'Diabetes Care', 35, true],
  ['Glimepiride 1mg Tablet', 'Diabetes Care', 70, true],
  ['Insulin Glargine Pen', 'Diabetes Care', 780, true, true],
  ['Insulin Regular Vial', 'Diabetes Care', 170, true, true],
  ['Glucometer Test Strips', 'Diabetes Care', 650],
  ['Lancets', 'Diabetes Care', 180],
  ['Amlodipine 5mg Tablet', 'Heart & BP', 45, true],
  ['Telmisartan 40mg Tablet', 'Heart & BP', 95, true],
  ['Atorvastatin 10mg Tablet', 'Heart & BP', 110, true],
  ['Amoxicillin 500mg Capsule', 'Antibiotics', 85, true],
  ['Azithromycin 500mg Tablet', 'Antibiotics', 120, true],
  ['Antiseptic Liquid', 'First Aid', 90],
  ['Adhesive Bandages', 'First Aid', 50],
  ['Cotton Roll', 'First Aid', 40],
  ['Crepe Bandage 10cm', 'First Aid', 95],
  ['Povidone-Iodine Ointment', 'First Aid', 75],
  ['Hand Sanitizer', 'Personal Care', 60],
  ['Surgical Face Mask', 'Personal Care', 99],
  ['Moisturising Lotion', 'Personal Care', 220],
  ['Sunscreen SPF 50', 'Personal Care', 350],
  ['Baby Diapers Medium', 'Baby Care', 699],
  ['Baby Wipes', 'Baby Care', 199],
  ['Diaper Rash Cream', 'Baby Care', 160],
  ['Digital Thermometer', 'Devices', 250],
  ['Pulse Oximeter', 'Devices', 1200],
  ['BP Monitor', 'Devices', 1800],
  ['Hot Water Bag', 'Devices', 300],
];
const PACKS: [string, number][] = [
  ['Strip of 10', 1],
  ['Strip of 15', 1.4],
  ['Pack of 3', 2.7],
  ['Value pack', 4.5],
];

async function main() {
  const ds = await dataSource.initialize();
  console.log(JSON.stringify({ code: 'SEED_STARTED', db: credentials.db.port }));

  await ds.transaction(async (m) => {
    await m.query(`TRUNCATE riders, store_inventory, skus, stores RESTART IDENTITY CASCADE`);

    // --- stores: point + a 3 km circle as the delivery polygon ----------------
    for (const s of STORES) {
      await m.query(
        `INSERT INTO stores (code, name, area, location, service_area, max_orders_per_hour)
         VALUES ($1, $2, $3,
                 ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography,   -- NOTE: lng first!
                 ST_Buffer(ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography, $6),
                 $7)`,
        [s.code, s.name, s.area, s.lat, s.lng, credentials.city.defaultServiceRadiusMeters, s.cap],
      );
    }

    // --- skus: base products x pack sizes (devices/liquids get one pack) ------
    let n = 0;
    for (const [name, category, mrp, rx = false, cold = false] of BASE) {
      const isSingle = ['Devices', 'Baby Care', 'Personal Care', 'First Aid'].includes(category) || cold;
      const packs = isSingle ? PACKS.slice(0, 1).map((): [string, number] => ['1 unit', 1]) : PACKS;
      for (const [pack, mult] of packs) {
        n += 1;
        await m.query(
          `INSERT INTO skus (code, name, category, pack_size, mrp_paise, rx_required, cold_chain)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [`SKU${String(n).padStart(4, '0')}`, name, category, pack, Math.round(mrp * mult * 100), rx, cold],
        );
      }
    }

    // --- inventory: each store stocks ~85% of the catalog ---------------------
    // A few items get 0 on purpose so "out of stock" exists from day one.
    const skuIds: { id: number }[] = await m.query(`SELECT id FROM skus ORDER BY id`);
    const storeIds: { id: number }[] = await m.query(`SELECT id FROM stores ORDER BY id`);
    for (const { id: storeId } of storeIds) {
      const rand = rng(storeId * 7919);
      const rows: string[] = [];
      for (const { id: skuId } of skuIds) {
        if (rand() > 0.85) continue; // store doesn't carry it
        const qty = rand() < 0.05 ? 0 : Math.floor(rand() * 60) + 1;
        rows.push(`(${storeId}, ${skuId}, ${qty})`);
      }
      // One multi-row INSERT instead of ~150 single inserts: one round trip.
      await m.query(`INSERT INTO store_inventory (store_id, sku_id, on_hand_qty) VALUES ${rows.join(',')}`);
    }

    // --- riders: ~60, spread across stores by capacity -----------------------
    const totalCap = STORES.reduce((a, s) => a + s.cap, 0);
    let riderNo = 0;
    for (const [i, s] of STORES.entries()) {
      const count = Math.round((s.cap / totalCap) * 60);
      for (let k = 0; k < count; k++) {
        riderNo += 1;
        const vehicle = riderNo % 5 === 0 ? 'cycle' : riderNo % 2 === 0 ? 'ev' : 'bike';
        await m.query(`INSERT INTO riders (name, phone, home_store_id, vehicle) VALUES ($1, $2, $3, $4)`, [
          `Rider ${String(riderNo).padStart(2, '0')}`,
          `+91-90000-${String(riderNo).padStart(5, '0')}`,
          storeIds[i].id,
          vehicle,
        ]);
      }
    }
  });

  const [counts] = await ds.query(`
    SELECT (SELECT count(*) FROM stores)::int          AS stores,
           (SELECT count(*) FROM skus)::int            AS skus,
           (SELECT count(*) FROM store_inventory)::int AS inventory_rows,
           (SELECT count(*) FROM riders)::int          AS riders`);
  console.log(JSON.stringify({ code: 'SEED_DONE', ...counts }));
  await ds.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
