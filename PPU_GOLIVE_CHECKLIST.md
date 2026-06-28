# PPU Go-Live Checklist

End-to-end steps to take Pay-Per-Use from merged code to live, billing operation.
Ordered by dependency. ✅ = already done during build; ☐ = your action.

---

## 0. Already done (no action)
- ✅ Code merged to `main` (PR #1 route/billing/retry/CoA harness, #3 N8N workflows)
- ✅ Splynx tariffs created & verified: **IDLE = 83** (128k), **ACTIVE = 84** (50M)
- ✅ Tariff 84 FUP backstop: **15 GB/24h → decrease to 20% (10M)**
- ✅ MTN bulk rate band confirmed: **1.0–1.5M UGX/TB**
- ✅ Finance fields verified against live Splynx (`category`, `tax_percent`, `total`)

---

## 1. Splynx (UI — can't be done via API)
- ☐ Add the **second FUP tier** to tariff 84 if wanted: 30 GB/24h → 4M (native FUP is single-tier; this 2nd step otherwise lives in the edge floating throttle). `server/scripts/SETUP_TARIFFS.md`
- ☐ Confirm tariff 84 has **"Available for services" = yes** and is selectable
- ☐ (Optional) Create a dedicated **"Mobile Money"** payment method; note its id for `PPU_PAYMENT_METHOD_ID` (currently 5 = Other)

## 2. Server deployment
- ☐ Pull `main` on the production server (`git pull`), `npm install`, `npm run build`
- ☐ Set production `.env` (the repo `.env` I edited is the local checkout only):
  ```
  PPU_PLAN_IDLE_ID=83
  PPU_PLAN_ACTIVE_ID=84
  PPU_TRANSACTION_CATEGORY_ID=1
  PPU_VAT_RATE=0.18
  PPU_PAYMENT_METHOD_ID=5
  PPU_DISCONNECT_ON_SWITCH=true
  PPU_BILLING_ENABLED=true
  WEBHOOK_SECRET=edb5ba12c51bb0c505b003f86b277f538946c0ba0d3f060a374ccf19b8c58548
  ```
- ☐ Restart the service; confirm boot log shows `[billing-retry] Started` and the server is up
- ☐ `GET /` lists `POST /api/ppu/trigger` and `GET /api/health/billing-queue`

## 3. CoA decision (on-box)
- ☐ Run `./server/scripts/validate-coa.sh --nas <ip> --secret <coa_secret> --user <login> --session <id>` on a **test SIM**
- ☐ Set `PPU_DISCONNECT_ON_SWITCH` per the verdict (expect **true** for MTN-LTE — keep as-is unless CoA ACKs *and* changes speed)

## 4. N8N
- ☐ Set N8N env: `WEBHOOK_SECRET` (same as server) and `SPLYNX_API_BASE` (e.g. `https://api.cloud-fi.ug`)
- ☐ Import `integrations/n8n/ppu-webhook-adapter.json` and/or `ppu-airbnb-ical-sync.json`
- ☐ iCal: edit the **`Listings`** node — one row per listing (iCal URL + `customer_id` + bundle)
- ☐ Adapter: point your POS / channel-manager at the webhook URL; ensure it sends `{ customer_id, target_tier, bundle? }`
- ☐ Decide **push (adapter) vs pull (iCal)** per segment — iCal lags ~15 min; push is minute-accurate
- ☐ Activate the workflow(s)

## 5. End-to-end verification (use a TEST customer)
- ☐ Pick/confirm a test customer with an active internet service
- ☐ Fire an **ACTIVE** trigger (via N8N or direct curl with HMAC — see `integrations/n8n/README.md`)
- ☐ Verify: service tariff flips to **84**, live session re-auths, speed = 50M
- ☐ Verify billing: a **transaction appears on the customer's ledger** (category Service, VAT 18%)
- ☐ `GET /api/health/billing-queue` → `pending: 0, dead: 0` (no failed billing)
- ☐ Fire an **IDLE** trigger → tariff flips to **83**, speed drops to 128k, no charge
- ☐ Confirm FUP: simulate/observe >15 GB in 24h → speed steps to 10M (or trust the backstop + edge throttle)

## 6. Go-live
- ☐ Onboard the first real cohort (e.g. a few Airbnb listings) in the `Listings` mapping
- ☐ Watch `[ppu]` + `[billing-retry]` server logs and `/api/health/billing-queue` for the first 24–48h
- ☐ Reconcile day-1: collected revenue (MoMo) vs transactions created vs MTN data burn

## 7. Rollback (if needed)
- ☐ Set `PPU_BILLING_ENABLED=false` to stop finance writes (tariff switching keeps working)
- ☐ Deactivate the N8N workflow to stop triggers
- ☐ Any failed billing is retained in `server/data/billing-retry.jsonl` (replayed automatically when re-enabled)

---

### Decisions still open (not blockers to the mechanics)
- Pricing sign-off on the revised ladder (Light Day 3,500 … Month 90,000)
- Per-segment push-vs-pull trigger choice
- Whether to set the live cost-band config to each period's actual invoiced MTN rate (feeds the floating throttle)
