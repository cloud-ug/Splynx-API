/**
 * Pay-Per-Use (PPU) Automation
 *
 * Receives external webhooks (Airbnb check-in/out, event window start/end,
 * POS activation ping) and flips a customer's internet service between a
 * Zero-Rated Base tariff (IDLE) and a Speed-Tiered Unlimited tariff (ACTIVE).
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
 *   WEBHOOK_SECRET            HMAC secret shared with the webhook sender (required)
 *   PPU_PLAN_IDLE_ID          Splynx tariff_id for Zero-Rated Base
 *   PPU_PLAN_ACTIVE_ID        Splynx tariff_id for Speed-Tiered Unlimited
 *   PPU_DISCONNECT_ON_SWITCH  'true' (default) to disconnect the live session so
 *                             it re-auths onto the new tariff; 'false' to rely on
 *                             Splynx auto-CoA only.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { splynx } from '../lib/splynx';

const router = Router();

const PLAN_MAPPING: Record<string, number> = {
  IDLE: Number(process.env.PPU_PLAN_IDLE_ID || 0),
  ACTIVE: Number(process.env.PPU_PLAN_ACTIVE_ID || 0),
};
const DISCONNECT_ON_SWITCH = (process.env.PPU_DISCONNECT_ON_SWITCH ?? 'true') !== 'false';

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

// ─── POST /api/ppu/trigger ───────────────────────────────────────────────────
// Body: { customer_id: number, target_tier: 'ACTIVE' | 'IDLE' }
router.post('/trigger', async (req: Request, res: Response) => {
  // 1. Security guardrail
  if (!signatureValid(req)) {
    console.warn(`[ppu] rejected: invalid/missing signature from ${req.ip}`);
    res.status(403).json({ error: 'Invalid webhook signature' });
    return;
  }

  // 2. Validate payload
  const { customer_id, target_tier } = req.body || {};
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

    console.log(`[ppu] customer ${customer_id} -> ${target_tier}; sessions cycled: ${disconnected}`);
    res.json({
      success: true,
      changed: true,
      service_id: service.id,
      target_tier,
      tariff_id: targetTariffId,
      sessions_cycled: disconnected,
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
