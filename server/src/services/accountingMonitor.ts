/**
 * RADIUS Accounting Health Monitor
 *
 * Checks every hour whether Splynx customer-statistics (completed sessions)
 * are still being written. If no new stats in > 24h, sends an SMS alert
 * via EgoSMS to the configured phone number.
 *
 * This guards against the Nov 2025 incident where the wrong nas_type caused
 * RADIUS Accounting-Stop packets to be silently dropped.
 */

import { splynx } from '../lib/splynx';

// ─── State ───────────────────────────────────────────────────────────────────

let lastCheckResult: HealthResult = {
  ok: true,
  checked_at: null,
  latest_stat_at: null,
  hours_since_last_stat: null,
  message: 'Not yet checked',
};

let alertSentAt: number | null = null;
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // don't re-alert within 6 hours

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HealthResult {
  ok: boolean;
  checked_at: string | null;
  latest_stat_at: string | null;
  hours_since_last_stat: number | null;
  message: string;
}

// ─── SMS via EgoSMS ───────────────────────────────────────────────────────────

async function sendSmsAlert(hoursSince: number, latestAt: string | null) {
  const username = process.env.EGOSMS_USERNAME;
  const password = process.env.EGOSMS_PASSWORD;
  const senderId = process.env.EGOSMS_SENDER_ID || 'CloudCore';
  const apiUrl = process.env.EGOSMS_API_URL || 'https://www.egosms.co/api/v1/json/';
  const alertPhone = process.env.ALERT_PHONE || process.env.ALERT_SMS_PHONE;

  if (!username || !password || !alertPhone) {
    console.warn('[accounting-monitor] EgoSMS not configured (EGOSMS_USERNAME / EGOSMS_PASSWORD / ALERT_PHONE missing) — skipping SMS');
    return;
  }

  const number = alertPhone.replace(/^\+/, '');
  const message = `RADIUS ALERT: No new accounting stats for ${Math.round(hoursSince)}h. Last: ${latestAt ?? 'unknown'}. Go to Splynx > Config > Networking > Radius > Restart FreeRADIUS.`;

  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'SendSms',
        userdata: { username, password },
        msgdata: [{ number, message, senderid: senderId, priority: '0' }],
      }),
    });
    const result = await res.json() as { Status: string; Message: string; Cost?: number };
    if (result.Status === 'Failed') {
      console.warn('[accounting-monitor] SMS failed:', result.Message);
    } else {
      console.log(`[accounting-monitor] SMS alert sent to ${alertPhone} (cost: ${result.Cost ?? '?'})`);
      alertSentAt = Date.now();
    }
  } catch (err: any) {
    console.error('[accounting-monitor] Failed to send SMS:', err.message);
  }
}

// ─── Check ───────────────────────────────────────────────────────────────────

async function checkAccounting(): Promise<HealthResult> {
  const now = new Date().toISOString();
  try {
    const data = await splynx('get', '/admin/customers/customer-statistics', undefined, {
      itemsPerPage: 10,
      page: 1,
      'sort[id]': 'desc',
    });

    const items: any[] = Array.isArray(data) ? data : (data.items || data.data || []);

    if (!items.length) {
      const result: HealthResult = {
        ok: false,
        checked_at: now,
        latest_stat_at: null,
        hours_since_last_stat: null,
        message: 'No records found in customer-statistics — accounting may be completely broken',
      };
      lastCheckResult = result;
      return result;
    }

    // Find the most recent timestamp
    let latestMs = 0;
    let latestAt = '';
    for (const item of items) {
      const ts = item.end_session || item.stop_time || item.add_time || item.created_at;
      if (ts) {
        const ms = new Date(ts.replace(' ', 'T')).getTime();
        if (ms > latestMs) { latestMs = ms; latestAt = ts; }
      }
    }

    if (!latestMs) {
      const result: HealthResult = {
        ok: false,
        checked_at: now,
        latest_stat_at: null,
        hours_since_last_stat: null,
        message: 'customer-statistics records have no timestamps — cannot determine freshness',
      };
      lastCheckResult = result;
      return result;
    }

    const hoursSince = (Date.now() - latestMs) / (1000 * 60 * 60);
    const ok = hoursSince < 24;

    const result: HealthResult = {
      ok,
      checked_at: now,
      latest_stat_at: latestAt,
      hours_since_last_stat: Math.round(hoursSince * 10) / 10,
      message: ok
        ? `Accounting is healthy — last stat ${Math.round(hoursSince * 10) / 10}h ago`
        : `⚠️ Accounting appears stale — no new stats in ${Math.round(hoursSince * 10) / 10}h`,
    };

    lastCheckResult = result;

    if (!ok) {
      const cooldownPassed = !alertSentAt || Date.now() - alertSentAt > ALERT_COOLDOWN_MS;
      if (cooldownPassed) {
        await sendSmsAlert(hoursSince, latestAt);
      }
    }

    return result;
  } catch (err: any) {
    const result: HealthResult = {
      ok: false,
      checked_at: now,
      latest_stat_at: null,
      hours_since_last_stat: null,
      message: `Check failed: ${err.message}`,
    };
    lastCheckResult = result;
    return result;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function getLastHealthResult(): HealthResult {
  return lastCheckResult;
}

export function startAccountingMonitor() {
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  checkAccounting().then((r) => {
    console.log(`[accounting-monitor] Initial check: ${r.message}`);
  });

  setInterval(() => {
    checkAccounting().then((r) => {
      console.log(`[accounting-monitor] Hourly check: ${r.message}`);
    });
  }, INTERVAL_MS);

  console.log('[accounting-monitor] Started — checking every hour');
}
