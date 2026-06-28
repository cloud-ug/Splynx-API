# CoA vs Disconnect — Validation Runbook

**Goal:** decide whether Cloud-Fi can re-shape a *live* session's speed in place via
RADIUS **Change-of-Authorization (CoA)** — or whether we must keep the current
**Disconnect → re-auth** approach. This is the open risk in
`docs/tech_splynx_integration.md §6` and gates the floating-throttle and the
Care helpdesk templates (which assume in-place speed changes).

Outcome sets one config flag: **`PPU_DISCONNECT_ON_SWITCH`** in `server/.env`.

---

## Why this matters
- **Tariff switch** (IDLE↔ACTIVE) works today via Disconnect (a sub-second blip on LTE).
- **FUP step-downs** (50→10→4 Mbps at 15/30 GB) and the **floating throttle** must
  change speed *mid-session without dropping the user* — that requires CoA.
- If our NAS won't honour CoA, the throttle has to be redesigned (e.g. Splynx-native
  FUP applied at re-auth, or accept brief disconnects on step-down).

## Important: two different NAS types
| Session type | NAS | Who must accept CoA |
|---|---|---|
| **Custom WiFi routers** (venues) | our hardware | us — fully in our control |
| **MTN-LTE SIMs** (NAS ids 6/7/21/22) | **MTN's core** | **MTN** — they must permit CoA from our RADIUS to their PGW on 3799 |

Test **both** if you run both. For LTE, a timeout most likely means MTN's core does
not accept CoA from us — that is a commercial/wholesale question for MTN, not a bug.

---

## Procedure

### 1. Pick a real, live test session
Prefer a low-stakes service (a test SIM / staff router), because a failed CoA test
or the `--with-disconnect` step can drop it.
```bash
curl -s localhost:4000/api/sessions/online/lte-sims | jq '.sims[] | {login, sim_number, router_name, router_id}'
```
Note the **login**, the **NAS/router IP**, and the **Acct-Session-Id** if available
(pinning the session id makes the test far more reliable than User-Name alone).

### 2. Get the CoA shared secret
From Splynx: **Config → Networking → Routers/NAS → [your NAS] → secret** (the CoA/
Disconnect secret must match what the NAS expects on port **3799**).

### 3. Run the harness (from `server/`)
CoA-only (safe — should not drop the session if the NAS behaves):
```bash
./scripts/validate-coa.sh \
  --nas <nas_ip> --secret <coa_secret> \
  --user <login> --session <acct_session_id> \
  --rate "10M/10M"
```
Add `--with-disconnect` only when you also want to confirm the Disconnect path
(this WILL drop the session):
```bash
./scripts/validate-coa.sh --nas <nas_ip> --secret <coa_secret> --user <login> --with-disconnect
```

### 4. Confirm the ACK is *real* (critical)
A `CoA-ACK` only means the NAS accepted the packet — not that it applied the rate.
Verify the speed actually changed:
- watch the session's throughput / run a quick speed test on the device, **or**
- on the Splynx box: `grep -E 'CoA|Disconnect' /var/www/splynx/logs/radius/short.log | tail`

---

## Decision matrix → what to set

| Result | Meaning | Action |
|---|---|---|
| **CoA-ACK + speed actually changes** | true in-place re-shape works | `PPU_DISCONNECT_ON_SWITCH=false`; route tier switches **and** FUP step-downs through CoA. Floating throttle is viable as designed. |
| **CoA-ACK but speed unchanged** | NAS acks, ignores the VSA | Treat as no-CoA. Keep `=true`. Check the router parses `Mikrotik-Rate-Limit` / use the custom VSA. |
| **CoA-NAK** | rejected (secret / session / disabled) | Fix secret + Acct-Session-Id and retry. If persistent, CoA unusable → keep `=true`. |
| **Timeout** | port/NAS unreachable or CoA not supported | Keep `=true`. For **LTE**, raise CoA support with MTN wholesale — it's their core that must accept it. |

---

## If CoA is NOT available (likely for LTE)
Keep `PPU_DISCONNECT_ON_SWITCH=true`. Then:
- **Tariff switches**: fine — disconnect→re-auth is a brief blip.
- **FUP step-downs / floating throttle**: cannot be in-place. Options:
  1. Apply the new speed at the next re-auth (accept that heavy users keep full speed
     until their session cycles), or
  2. Trigger a short disconnect at the 15/30 GB threshold (a deliberate blip to force
     re-auth onto the lower speed), or
  3. Push step-downs to our **own custom routers** where we *do* control CoA, and only
     use the looser re-auth model on MTN-LTE.
- Record the chosen option back in `docs/tech_splynx_integration.md §6` and
  `mtn_project_context.md` (open-risks section).
