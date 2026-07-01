# PPU Tariff Setup — Splynx

The PPU webhook flips a service between internet tariffs. Sections 1–2 below cover the
original **two-tariff** model (IDLE + a single 50M ACTIVE). This has since been
**expanded to 6 base-speed ACTIVE tiers** — see **§5** and the per-tier FUP runbook.

> **Status (2026-06-30):** the tariffs are **created and live** — IDLE **83**, and ACTIVE
> **Nano 85 / Ultra-Lite 86 / Lite 87 / Standard 88 / Max 84 / Pro 89**. IDs are wired in
> `server/.env`. §1–2 remain as the conceptual baseline; §5 is the current shape.

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

## 5. Speed tiers + per-tier FUP (current model)
The single ACTIVE tariff is now **6 base-speed tiers** (single IDLE 83 for all):

| Tier | Tariff ID | Speed | env |
|---|---|---|---|
| Nano | 85 | 2M | `PPU_PLAN_ACTIVE_NANO_ID` |
| Ultra-Lite | 86 | 5M | `PPU_PLAN_ACTIVE_ULTRALITE_ID` |
| Lite | 87 | 10M | `PPU_PLAN_ACTIVE_LITE_ID` |
| Standard | 88 | 25M | `PPU_PLAN_ACTIVE_STANDARD_ID` |
| Max | 84 | 50M | `PPU_PLAN_ACTIVE_MAX_ID` |
| Pro | 89 | 100M | `PPU_PLAN_ACTIVE_PRO_ID` |

- `ppu.ts` resolves a tier via `target_tier:'ACTIVE-<Tier>'` or `target_tier:'ACTIVE' + speed_tier`.
- **Per-tier FUP setup (Splynx UI):** step-by-step per-tariff thresholds + reduce-to speeds in
  **`Cloud-Bulk-Data/docs/fup_setup_ui_steps.md`** (also **update tariff 84** from the old
  15 GB→10M to 11.5 GB→20M). Build spec: `Cloud-Bulk-Data/docs/bandwidth_tiers_tech.md`.
