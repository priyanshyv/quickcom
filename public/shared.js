// Helpers shared by customer.html and order.html.
window.QC = (() => {
  // One cart id per browser (it doubles as the "customer" until we add login).
  let cartId;
  try { cartId = localStorage.getItem('quickcom.cartId'); } catch (e) {}
  if (!cartId) {
    cartId = 'web-' + Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem('quickcom.cartId', cartId); } catch (e) {}
  }

  const rupees = (p) => '₹' + (p / 100).toFixed(p % 100 ? 2 : 0);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Every request goes through here, so the page can SHOW which API each tap uses.
  let logEl = null;
  const setLog = (el) => (logEl = el);
  async function api(method, path, body, headers = {}) {
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      log(`${method} ${path} → network error`, 5);
      throw e;
    }
    const ms = (performance.now() - t0).toFixed(0);
    const extra = headers['idempotency-key'] ? `  [Idempotency-Key: ${headers['idempotency-key']}]` : '';
    log(`${method} ${path}${body ? ' ' + JSON.stringify(body) : ''}${extra} → ${res.status} · ${ms} ms`, Math.floor(res.status / 100));
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  function log(text, cls) {
    if (!logEl) return;
    const row = document.createElement('div');
    row.className = 's' + cls;
    row.title = text;
    row.textContent = text;
    logEl.prepend(row);
    while (logEl.children.length > 30) logEl.lastChild.remove();
  }

  function toast(msg) {
    let t = document.getElementById('qc-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'qc-toast';
      t.className = 'toast';
      document.body.append(t);
    }
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.style.display = 'none'), 3200);
  }

  // ── The mock UPI sheet ───────────────────────────────────────────────────
  // 1. POST /orders/:id/payments           -> opens (or reuses) an attempt at the gateway
  // 2. POST /mock-gateway/payments/:ref/complete
  //        -> "you, in your UPI app" approve or decline; the GATEWAY then sends
  //           a signed webhook to /webhooks/payment (with the chaos you pick)
  const CHAOS = {
    none: 'Normal: one webhook, right away',
    duplicate: 'Duplicate: the same webhook 3 times at once',
    delay: 'Late: the webhook arrives after 5 seconds',
    lost: 'Lost: the webhook never arrives (the reconciler must find it)',
  };
  async function pay(orderId, onDone) {
    const r = await api('POST', `/orders/${orderId}/payments`);
    if (r.status === 409) return toast(r.body?.message || 'This order cannot be paid now');
    if (r.body?.alreadyPaid) { toast('Already paid: the gateway had your money; order updated.'); return onDone && onDone(); }
    if (r.status >= 300) return toast(r.body?.message || 'Could not start payment');
    const p = r.body;
    const scrim = document.createElement('div');
    scrim.className = 'scrim open';
    scrim.innerHTML = `
      <div class="sheet">
        <h2><span>Mock UPI · pay ${rupees(p.amountPaise)}</span><button class="x" data-x>×</button></h2>
        <div class="muted small">Pretend this is your UPI app. Payment ref <span class="mono">${esc(p.paymentRef)}</span>
          ${p.attempt === 'reused' ? ' <span class="pill blue">same attempt as before (double-tap safe)</span>' : ''}</div>
        <label class="small" style="display:block;margin:14px 0 4px;font-weight:600">How should the gateway's webhook behave?</label>
        <select data-chaos style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--line)">
          ${Object.entries(CHAOS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <div style="display:flex;gap:10px;margin-top:16px">
          <button class="btn primary block" data-ok>Approve ${rupees(p.amountPaise)}</button>
          <button class="btn danger block" data-fail>Decline</button>
        </div>
        <p class="muted small" style="margin:12px 0 0">After you choose, the gateway calls <span class="mono">POST /webhooks/payment</span> on our server, signed with a shared secret.</p>
      </div>`;
    document.body.append(scrim);
    const close = () => scrim.remove();
    scrim.querySelector('[data-x]').onclick = close;
    const finish = async (outcome) => {
      const chaos = scrim.querySelector('[data-chaos]').value;
      await api('POST', `/mock-gateway/payments/${p.paymentRef}/complete`, { outcome, chaos });
      close();
      toast(outcome === 'success' ? (chaos === 'lost' ? 'Paid. The webhook is lost; watch the reconciler fix it within ~30 s.' : 'Paid. Waiting for the gateway to tell our server…') : 'Payment declined. Your items are still held; you can retry.');
      onDone && onDone();
    };
    scrim.querySelector('[data-ok]').onclick = () => finish('success');
    scrim.querySelector('[data-fail]').onclick = () => finish('failure');
  }

  const STATUS = {
    PAYMENT_PENDING: ['amber', 'Waiting for payment'],
    RX_REVIEW: ['blue', 'Pharmacist checking'],
    CONFIRMED: ['green', 'Confirmed'],
    CANCELLED: ['red', 'Cancelled'],
  };
  const statusPill = (s) => `<span class="pill ${STATUS[s]?.[0] ?? 'grey'}">${STATUS[s]?.[1] ?? s}</span>`;

  return { cartId, rupees, esc, time, api, setLog, toast, pay, statusPill };
})();
