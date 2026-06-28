# PPU Tariff Setup — Splynx

The PPU webhook flips a service between two internet tariffs. They don't exist yet
(the instance currently has only flat LTE tariffs 37 / 71). Create both, then put
their IDs in `server/.env` as `PPU_PLAN_IDLE_ID` and `PPU_PLAN_ACTIVE_ID`.

Path in Splynx: **Tariff Plans → Internet → Add**.

---

## 1. Zero-Rated Base  →  `PPU_PLAN_IDLE_ID`
The "off / idle" state — a unit between bookings/shifts must burn ~no MTN data.

| Setting | Value |
|---|---|
| Title | `Cloud-Fi PPU — Zero-Rated Base (IDLE)` |
| Speed download / upload | **128 kbit / 128 kbit** |
| Price | 0 (billing is per-pass via the webhook, not the tariff) |
| FUP | none |
| Available for services | yes |

Purpose: keep-alive / captive portal / POS heartbeat only. This is the precondition
that makes Airbnb/Events/Hybrid economics positive (idle months cost nothing).

---

## 2. Speed-Tiered Unlimited  →  `PPU_PLAN_ACTIVE_ID`
The "on" state — full speed, no volume cap, speed-managed by the canonical FUP.
All seven retail bundles share THIS one tariff; they differ only in pass length and
price (a billing concern handled by the webhook), not in tariff.

| Setting | Value |
|---|---|
| Title | `Cloud-Fi PPU — Speed-Tiered Unlimited (ACTIVE)` |
| Speed download / upload | **50 Mbit / 50 Mbit** |
| Price | 0 (per-pass billing via webhook) |
| FUP | **enabled** — policy `PPU_Unlimited_FUP` (below) |
| Available for services | yes |

### FUP policy `PPU_Unlimited_FUP` (canonical — no volume cap, speed steps only)
| Threshold (rolling/daily 24h, reset 00:00 EAT) | New speed |
|---|---|
| base | 50 / 50 Mbit |
| > 15 GB | 10 / 10 Mbit |
| > 30 GB | 4 / 4 Mbit |
| Data cap | **none** (never cut off) |
| Carry-over / compensation | off |

> The static 15/30 GB rule is the safe baseline. The **floating throttle**
> (`docs/floating_throttle_spec.md`) cost-indexes the 15 GB ceiling to the
> confirmed MTN rate and is what actually protects margin — Splynx FUP is the backstop.

---

## 3. Wire it up
```
# server/.env
PPU_PLAN_IDLE_ID=<id of tariff #1>
PPU_PLAN_ACTIVE_ID=<id of tariff #2>
```
Confirm the IDs: `GET /api/customers/:id/services` on a test customer shows `tariff_id`,
or read them from the Splynx tariff list URL.

## 4. Verify
- Move a test service to IDLE then ACTIVE via `POST /api/ppu/trigger` and confirm the
  tariff_id changes and the live session re-shapes.
- Run `scripts/validate-coa.sh` to decide `PPU_DISCONNECT_ON_SWITCH`.
- Run `scripts/verify-finance-fields.ts` before enabling `PPU_BILLING_ENABLED`.
