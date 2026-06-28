/**
 * Pay-Per-Use (PPU) Automation
 *
 * Receives external webhooks (Airbnb check-in/out, event window start/end,
 * POS activation ping) and flips a customer's internet service between a
 * Zero-Rated Base tariff (IDLE) and a Speed-Tiered Unlimited tariff (ACTIVE).
 *
 * On an ACTIVE activation it also creates a Splynx finance record (transaction,
 * optionally a payment) so every data-burning window has a matching revenue line
 * and collections reconcile against bundle burn. Billing is gated behind
 * PPU_BILLING_ENABLED and is best-effort: a billing failure is logged and
 * surfaced but never rolls back or blocks the tariff switch.
 *
 * Uses the same proven Splynx paths as the rest of this server:
 *   - service update: PUT /admin/customers/customer/{id}/internet-services--{sid}
 *   - live apply:     DELETE /admin/customers/customers-online/{sessionId}
 *                     (Disconnect-Request; the SIM re-auths onto the new tariff)
 *
 * Adds the one thing the other routes don't need: HMAC verification of the
 * inbound webhook (raw body), since this endpoint is triggered by 3rd parties.
 *
 * Env:
 *   WEBHOOK_SECRET             HMAC secret shared with the webhook sender (required)
 *   PPU_PLAN_IDLE_ID           Splynx tariff_id for Zero-Rated Base
 *   PPU_PLAN_ACTIVE_ID         Splynx tariff_id for Speed-Tiered Unlimited
 *   PPU_DISCONNECT_ON_SWITCH   'true' (default) to disconnect the live session so
 *                              it re-auths onto the new tariff; 'false' to rely on
 *                              Splynx auto-CoA only.
 *   PPU_BILLING_ENABLED        'true' to write Splynx finance records on ACTIVE. Default false.
 *   PPU_TRANSACTION_CATEGORY_ID Splynx finance transaction category id for PPU passes.
 *   PPU_VAT_RATE               VAT fraction for inclusive->net split. Default 0.18 (Uganda 18%).
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { splynx } from '../lib/splynx';
import { enqueueBillingIntent } from '../services/billingRetry';

const router = Router();

const PLAN_MAPPING: Record<string, number> = {
  IDLE: Number(process.env.PPU_PLAN_IDLE_ID || 0),
  ACTIVE: Number(process.env.PPU_PLAN_ACTIVE_ID || 0),
};
const DISCONNECT_ON_SWITCH = (process.env.PPU_DISCONNECT_ON_SWITCH ?? 'true') !== 'false';

// ─── Billing config ──────────────────────────────────────────────────────────
const BILLING_ENABLED = process.env.PPU_BILLING_ENABLED === 'true';
const TX_CATEGORY_ID = Number(process.env.PPU_TRANSACTION_CATEGORY_ID || 0);
const VAT_RATE = Number(process.env.PPU_VAT_RATE || '0.18');

// Canonical customer-facing ladder (UGX, VAT-inclusive). Keep in sync with
// mtn_project_context.md. The webhook may pass an explicit `amount` to override.
const BUNDLE_PRICING: Record<string, number> = {
  light_day: 3_500,
  day: 5_000,
  weekend: 12_000,
  '3day': 13_000,
  week: 30_000,
  '2week': 55_000,
  month: 90_000,
};

// ─── Verify the inbound webhook HMAC over the RAW body ───────────────────────
function signatureValid(req: Request): boolean {
  const secret = process.env.WEBHOOK_SECRET;
  const provided = req.header('x-ppu-signature');
  // Raw body captured by express.json({ verify }) in index.ts
  const raw: Buffer | undefined = (req as any).rawBody;
  if (!secret || !provided || !raw) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── Find the customer's active internet service ─────────────────────────────
async function getActiveService(customerId: number | string) {
  const data = await splynx('get', `/admin/customers/customer/${customerId}/internet-services`);
  const services: any[] = Array.isArray(data) ? data : (data?.items || []);
  return services.find((s) => s.status === 'active') || null;
}

// ─── Disconnect any live session for a service so it re-auths on the new tariff ──
async function disconnectLiveSession(serviceId: number, login?: string) {
  const data = await splynx('get', '/admin/customers/customers-online', undefined, { itemsPerPage: 1000 });
  const sessions: any[] = Array.isArray(data) ? data : (data?.items || data?.data || []);
  const targets = sessions.filter((s) =>
    (s.service_id && Number(s.service_id) === Number(serviceId)) ||
    (login && s.login && String(s.login).toLowerCase() === login.toLowerCase())
  );
  let disconnected = 0;
  for (const s of targets) {
    try {
      await splynx('delete', `/admin/customers/customers-online/${s.id}`);
      disconnected++;
    } catch (err: any) {
      console.warn(`[ppu] disconnect failed for session ${s.id}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return disconnected;
}

// ─── Resolve the gross (VAT-inclusive) charge for an ACTIVE window ────────────
function resolveAmount(bundle?: string, amount?: number): number | null {
  if (typeof amount === 'number' && amount > 0) return amount;
  if (bundle && BUNDLE_PRICING[bundle] != null) return BUNDLE_PRICING[bundle];
  return null;
}

// ─── Create a Splynx finance record for a PPU pass (best-effort) ─────────────
// Records the bundle charge as a transaction so revenue reconciles against the
// data the ACTIVE window will burn. Optionally records the MoMo payment too.
//
// NOTE: Splynx finance field names vary by release (we run v2.0). Verify
// `category_id`, `price`, `tax_percent`, and the payment fields against your
// instance's API docs before relying on this in production.
async function createBillingRecord(opts: {
  customerId: number | string;
  serviceId: number;
  gross: number;
  bundle?: string;
  paymentRef?: string;
  recordPayment?: boolean;
}): Promise<{ ok: boolean; transaction_id?: number; payment_id?: number; error?: string }> {
  const { customerId, serviceId, gross, bundle, paymentRef, recordPayment } = opts;
  if (!TX_CATEGORY_ID) {
    return { ok: false, error: 'PPU_TRANSACTION_CATEGORY_ID not configured' };
  }
  // Published prices are VAT-inclusive; split into net + tax for clean reporting.
  const net = Math.round(gross / (1 + VAT_RATE));
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const label = bundle ? `PPU ${bundle} pass` : 'PPU activation';

  try {
    const tx: any = await splynx('post', '/admin/finance/transactions', {
      customer_id: Number(customerId),
      category: TX_CATEGORY_ID,         // Splynx field is `category` (1 = Service)
      service_id: serviceId,
      description: `${label} (service ${serviceId})`,
      quantity: 1,
      price: net,                       // net unit price
      tax_percent: Math.round(VAT_RATE * 100),
      total: gross,                     // VAT-inclusive total
      date: today,
    });
    const transactionId = tx?.id || tx?.transaction_id;

    let paymentId: number | undefined;
    if (recordPayment) {
      const pay: any = await splynx('post', '/admin/finance/payments', {
        customer_id: Number(customerId),
        payment_type: Number(process.env.PPU_PAYMENT_METHOD_ID || 5), // 5 = Other (no MoMo method defined)
        amount: gross,                  // gross collected via MoMo
        date: today,
        comment: paymentRef ? `MoMo ${paymentRef}` : `PPU ${label}`,
      });
      paymentId = pay?.id || pay?.payment_id;
    }

    return { ok: true, transaction_id: transactionId, payment_id: paymentId };
  } catch (err: any) {
    return { ok: false, error: err.response?.data ? JSON.stringify(err.response.data) : err.message };
  }
}

// ─── POST /api/ppu/trigger ───────────────────────────────────────────────────
// Body: {
//   customer_id: number,
//   target_tier: 'ACTIVE' | 'IDLE',
//   bundle?: string,         // e.g. 'weekend' (drives the charge amount on ACTIVE)
//   amount?: number,         // explicit gross UGX, overrides bundle lookup
//   payment_ref?: string,    // MoMo reference for reconciliation
//   record_payment?: boolean // also POST a Splynx payment (default false)
// }
router.post('/trigger', async (req: Request, res: Response) => {
  // 1. Security guardrail
  if (!signatureValid(req)) {
    console.warn(`[ppu] rejected: invalid/missing signature from ${req.ip}`);
    res.status(403).json({ error: 'Invalid webhook signature' });
    return;
  }

  // 2. Validate payload
  const { customer_id, target_tier, bundle, amount, payment_ref, record_payment } = req.body || {};
  const targetTariffId = PLAN_MAPPING[String(target_tier)];
  if (!customer_id || !targetTariffId) {
    res.status(400).json({ error: 'Missing customer_id or invalid target_tier (expected ACTIVE|IDLE, with plan IDs configured)' });
    return;
  }

  try {
    console.log(`[ppu] switch customer ${customer_id} -> ${target_tier} (tariff ${targetTariffId})`);

    // 3. Find the active service
    const service = await getActiveService(customer_id);
    if (!service) {
      res.status(404).json({ error: 'No active internet service for this customer' });
      return;
    }

    // 4. Idempotency: no-op if already on the target tariff
    if (Number(service.tariff_id) === targetTariffId) {
      console.log(`[ppu] no-op: customer ${customer_id} already on ${target_tier}`);
      res.json({ success: true, changed: false, message: `Already on ${target_tier}` });
      return;
    }

    // 5. Switch the tariff on the existing service (double-dash sub-resource)
    await splynx(
      'put',
      `/admin/customers/customer/${customer_id}/internet-services--${service.id}`,
      { tariff_id: targetTariffId }
    );

    // 6. Apply to the live session (disconnect -> re-auth onto new tariff)
    let disconnected = 0;
    if (DISCONNECT_ON_SWITCH) {
      disconnected = await disconnectLiveSession(Number(service.id), service.login);
    }

    // 7. Billing: an ACTIVE window costs us MTN data -> record the revenue line.
    //    Best-effort: never roll back / block the switch on a billing failure.
    let billing: any = { skipped: true };
    if (String(target_tier) === 'ACTIVE' && BILLING_ENABLED) {
      const gross = resolveAmount(bundle, amount);
      if (gross == null) {
        billing = { ok: false, error: 'no bundle/amount provided; cannot create revenue line' };
        console.error(`[ppu] BILLING GAP: ACTIVE switch for customer ${customer_id} with no amount — data will burn with no revenue line`);
      } else {
        billing = await createBillingRecord({
          customerId: customer_id,
          serviceId: Number(service.id),
          gross,
          bundle,
          paymentRef: payment_ref,
          recordPayment: record_payment === true,
        });
        if (!billing.ok) {
          console.error(`[ppu] BILLING FAILED for customer ${customer_id} (${gross} UGX): ${billing.error}`);
          // Durably queue for retry so the revenue line is not lost.
          enqueueBillingIntent({
            id: crypto.randomUUID(),
            customer_id: Number(customer_id),
            service_id: Number(service.id),
            gross,
            bundle,
            payment_ref,
            record_payment: record_payment === true,
          });
          billing.queued = true;
        } else {
          console.log(`[ppu] billed customer ${customer_id} ${gross} UGX (tx ${billing.transaction_id})`);
        }
      }
    }

    console.log(`[ppu] customer ${customer_id} -> ${target_tier}; sessions cycled: ${disconnected}`);
    res.json({
      success: true,
      changed: true,
      service_id: service.id,
      target_tier,
      tariff_id: targetTariffId,
      sessions_cycled: disconnected,
      billing,
      message: `Migrated customer ${customer_id} to ${target_tier}.`,
    });
  } catch (err: any) {
    const status = err.response?.status;
    console.error(`[ppu] error switching customer ${customer_id}:`, status, err.message);
    res.status(502).json({
      error: 'Splynx update failed',
      splynx_status: status,
      splynx_data: err.response?.data,
    });
  }
});

export default router;
