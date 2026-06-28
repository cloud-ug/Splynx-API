#!/usr/bin/env bash
#
# validate-coa.sh — Does our NAS accept in-place RADIUS CoA, or only Disconnect?
#
# This answers the open question in docs/tech_splynx_integration.md §6:
# can we re-shape a LIVE session's speed without dropping it (CoA), or must we
# disconnect->re-auth (current PPU default)? Run it against a REAL live session.
#
# It fires:
#   1. a CoA-Request that changes the rate-limit  -> expect CoA-ACK
#   2. (optional, --with-disconnect) a Disconnect-Request -> expect Disconnect-ACK
# and reports which the NAS honours, with a recommendation.
#
# Requires: radclient (FreeRADIUS utils).  Debian/Ubuntu: apt install freeradius-utils
#
# Usage:
#   ./validate-coa.sh --nas <ip> --secret <coa_secret> \
#       --user <login> [--session <acct_session_id>] \
#       [--rate "10M/10M"] [--port 3799] [--with-disconnect]
#
# Identify a live session first via:
#   GET /api/sessions/online/lte-sims   (login = service login, session id if exposed)
#
set -euo pipefail

NAS=""; SECRET=""; USER_NAME=""; SESSION=""; RATE="10M/10M"; PORT="3799"; DO_DISCONNECT="no"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nas) NAS="$2"; shift 2;;
    --secret) SECRET="$2"; shift 2;;
    --user) USER_NAME="$2"; shift 2;;
    --session) SESSION="$2"; shift 2;;
    --rate) RATE="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --with-disconnect) DO_DISCONNECT="yes"; shift;;
    *) echo "Unknown arg: $1" >&2; exit 2;;
  esac
done

if ! command -v radclient >/dev/null 2>&1; then
  echo "ERROR: radclient not found. Install freeradius-utils." >&2
  exit 3
fi
if [[ -z "$NAS" || -z "$SECRET" || -z "$USER_NAME" ]]; then
  echo "ERROR: --nas, --secret and --user are required." >&2
  exit 2
fi

# Build the attribute set. Acct-Session-Id pins the exact session when known
# (strongly preferred); otherwise the NAS matches on User-Name alone.
attrs="User-Name=${USER_NAME}"
[[ -n "$SESSION" ]] && attrs="${attrs},Acct-Session-Id=${SESSION}"

echo "──────────────────────────────────────────────────────────────"
echo "Target NAS   : ${NAS}:${PORT}"
echo "Session      : User-Name=${USER_NAME}${SESSION:+, Acct-Session-Id=${SESSION}}"
echo "Test rate    : ${RATE}  (Mikrotik-Rate-Limit)"
echo "──────────────────────────────────────────────────────────────"

# ── Test 1: CoA-Request (in-place re-shape) ───────────────────────────────────
echo; echo "[1] Sending CoA-Request ..."
coa_attrs="${attrs},Mikrotik-Rate-Limit=${RATE}"
set +e
coa_out="$(printf '%s' "$coa_attrs" | radclient -x -t 5 -r 2 "${NAS}:${PORT}" coa "$SECRET" 2>&1)"
coa_rc=$?
set -e
echo "$coa_out"

if echo "$coa_out" | grep -q "CoA-ACK"; then
  COA_RESULT="ACK"
elif echo "$coa_out" | grep -q "CoA-NAK"; then
  COA_RESULT="NAK"
else
  COA_RESULT="TIMEOUT"
fi
echo ">> CoA result: ${COA_RESULT} (radclient rc=${coa_rc})"

# ── Test 2 (optional): Disconnect-Request ─────────────────────────────────────
DISC_RESULT="skipped"
if [[ "$DO_DISCONNECT" == "yes" ]]; then
  echo; echo "[2] Sending Disconnect-Request ... (this WILL drop the session)"
  set +e
  disc_out="$(printf '%s' "$attrs" | radclient -x -t 5 -r 2 "${NAS}:${PORT}" disconnect "$SECRET" 2>&1)"
  set -e
  echo "$disc_out"
  if echo "$disc_out" | grep -q "Disconnect-ACK"; then DISC_RESULT="ACK"
  elif echo "$disc_out" | grep -q "Disconnect-NAK"; then DISC_RESULT="NAK"
  else DISC_RESULT="TIMEOUT"; fi
  echo ">> Disconnect result: ${DISC_RESULT}"
fi

# ── Verdict ───────────────────────────────────────────────────────────────────
echo; echo "════════════════════════ VERDICT ════════════════════════"
case "$COA_RESULT" in
  ACK)
    echo "CoA-ACK received. The NAS ACCEPTS in-place re-shape at the protocol level."
    echo "NEXT: confirm the speed ACTUALLY changed on the live session (run a speed"
    echo "test or watch session throughput) — an ACK alone does not prove the VSA"
    echo "was applied. If speed changed: set PPU_DISCONNECT_ON_SWITCH=false and move"
    echo "tier switches + FUP step-downs to CoA (no user drop)."
    ;;
  NAK)
    echo "CoA-NAK. The NAS rejected the CoA (bad secret, unknown session, or CoA"
    echo "disabled). Re-check the shared secret and Acct-Session-Id, then retry."
    echo "If it persists, the NAS will not do in-place re-shape -> keep disconnect."
    ;;
  TIMEOUT)
    echo "No response (timeout). Port ${PORT} unreachable, wrong NAS IP, or the NAS"
    echo "does not listen for CoA. For MTN-LTE sessions this likely means MTN's core"
    echo "does not accept CoA from us -> KEEP PPU_DISCONNECT_ON_SWITCH=true."
    ;;
esac
echo "──────────────────────────────────────────────────────────────"
echo "Cross-check on the Splynx box:"
echo "  grep -E 'CoA|Disconnect' /var/www/splynx/logs/radius/short.log | tail"
echo "════════════════════════════════════════════════════════════"

# Exit non-zero if CoA did not ACK, so CI/automation can branch on it.
[[ "$COA_RESULT" == "ACK" ]]
