// Runs before every e2e file. The background hold sweeper is switched off so
// tests can run it by hand and know exactly what it did.
process.env.CART_SWEEP_MS = '0';
