# Cloud-Fi PPU — N8N Integration

Two importable N8N workflows that drive PPU tariff switching by calling the
server's `POST /api/ppu/trigger`. N8N is the adapter that does the three things
the trigger sources can't: **map an identifier → Splynx `customer_id`**, **HMAC-sign
the request**, and (for Airbnb) **poll the iCal feed**.

## Files
| File | Trigger | Use for |
|---|---|---|
| `ppu-webhook-adapter.json` | Webhook (push) | POS gateways, channel managers (Hospitable/Smoobu/Guesty), or anything that can POST. The reusable signer/forwarder. |
| `ppu-airbnb-ical-sync.json` | Schedule (pull) | Raw Airbnb listings via their iCal export, when there's no push integration. |

## How signing works (the important bit)
The server verifies an HMAC-SHA256 over the **raw request body**. So both workflows:
1. **Build the body as a string** (`Build Signed Body` Code node) — this exact string is what gets signed *and* sent.
2. **Sign it** with the `Crypto` node (HMAC-SHA256, hex) using `$env.WEBHOOK_SECRET` — sandbox-safe, no `require('crypto')`.
3. **POST it raw** (`Content-Type: application/json`, body = the same string) with header `x-ppu-signature: <hex>`.

> ⚠️ Never let the HTTP node re-serialize an object — re-serialization changes bytes and the signature fails. Always send the pre-built string raw.

## Setup
1. **Env vars** (N8N → Settings → Environment, or container env):
   - `WEBHOOK_SECRET` = the same value as the server's `.env` (`edb5ba12…` in this deployment)
   - `SPLYNX_API_BASE` = base URL of the Splynx-API server, e.g. `http://localhost:4000` or `https://api.cloud-fi.ug`
2. **Import** the JSON (N8N → Workflows → Import from File). Verify node versions on import; adjust if your N8N is older.
3. Configure per workflow (below), then **activate**.

### Adapter (`ppu-webhook-adapter.json`)
- After import, the Webhook node gives you a URL like `…/webhook/ppu-trigger`. Point your POS/channel-manager at it.
- **Payload it expects** (JSON):
  ```json
  { "customer_id": 101, "target_tier": "ACTIVE", "bundle": "weekend" }
  ```
  - `target_tier`: `ACTIVE` (turn on) or `IDLE` (turn off)
  - `bundle` (optional, ACTIVE only): `light_day | day | weekend | 3day | week | 2week | month` — drives the billing amount
  - `amount`, `payment_ref`, `record_payment` (optional) are passed through too
- **Mapping to customer_id:** if your source only knows a name/SIM, add an HTTP Request node before `Build Signed Body` calling `GET {{$env.SPLYNX_API_BASE}}/api/customers?search=<name>` and use the returned id.

### Airbnb iCal sync (`ppu-airbnb-ical-sync.json`)
- Edit the **`Listings`** Code node — one row per listing:
  ```js
  { listing: 'Kololo Apt 1', ical_url: 'https://www.airbnb.com/calendar/ical/XXXX.ics?s=AAAA', customer_id: 101, bundle: 'weekend' }
  ```
  Get each `ical_url` from Airbnb → Listing → Availability → **Export Calendar**.
- Logic: every 15 min it fetches each calendar, and for events whose **DTSTART = today (EAT)** fires `ACTIVE`, whose **DTEND = today** fires `IDLE`.
- **Dedupe:** processed `customer|UID|tier` keys are stored in workflow static data, so each check-in/checkout fires once even though the poll repeats.
- **Caveats:** iCal is all-day dates (no time) — activation lands within the 15-min poll window, not the exact check-in minute. Airbnb refreshes iCal on its own cadence (can lag ~hours). For minute-accurate switching, use a push integration via the adapter instead.

## Test the adapter without a real source
```bash
SECRET='<WEBHOOK_SECRET>'
BODY='{"customer_id":101,"target_tier":"ACTIVE","bundle":"weekend"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')
curl -s -X POST "<n8n-webhook-url>" -H 'Content-Type: application/json' \
  -H "x-ppu-signature: $SIG" -d "$BODY"
# Or hit the server directly (same signing) to test end-to-end:
curl -s -X POST "$SPLYNX_API_BASE/api/ppu/trigger" -H 'Content-Type: application/json' \
  -H "x-ppu-signature: $SIG" -d "$BODY"
```

## Security notes
- Keep `WEBHOOK_SECRET` only in N8N + server env — never in the workflow JSON.
- The adapter's webhook URL is public; the HMAC is what authenticates callers. Rotate the secret on both sides if leaked.
- Prefer HTTPS for `SPLYNX_API_BASE` in production.
