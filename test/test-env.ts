// Runs before every e2e file. The background hold sweeper is switched off so
// tests can run it by hand and know exactly what it did.
process.env.CART_SWEEP_MS = '0';
// Chapter 4: no background workers in tests (no outbox relay, no queue
// consumer, no order sweeper). Tests call relay/consumer/sweeper by hand.
process.env.ROLE = 'api';
process.env.ORDER_SWEEP_MS = '0';
process.env.OUTBOX_RELAY_MS = '0';
