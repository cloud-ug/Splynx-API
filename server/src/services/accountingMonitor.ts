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

import fs from 'fs';
import path from 'path';
import { splynx } from '../lib/splynx';

const DATA_DIR = path.join(__dirname, '../../data');
const SERVICE_SIMS_FILE = path.join(DATA_DIR, 'service-sims.json');

// Pick a handful of customer IDs from the service-sims map to use as fallback probes
function getRecentCustomerIds(limit = 5): number[] {
  try {
    if (!fs.existsSync(SERVICE_SIMS_FILE)) return [];
    const map: Record<string, { sim_number: string; ip: string | null; last_seen: string }> =
      JSON.parse(fs.readFileSync(SERVICE_SIMS_FILE, 'utf8'));
    // Sort by last_seen descending, return unique customer IDs (service-sims is keyed by service_id,
    // but we don't store customer_id there — so just probe a few known-active ones from the daily files)
    const entries = Object.values(map).sort((a, b) => b.last_seen.localeCompare(a.last_seen));
    return entries.slice(0, limit).map((_, i) => i); // placeholder — see below
  } catch { return []; }
}

// Read last-seen customer IDs from the most recent daily session file
function getRecentCustomerIdsFromDailyFiles(limit = 5): number[] {
  try {
    if (!fs.existsSync(DATA_DIR)) return [];
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.startsWith('sessions-') && f.endsWith('.json'))
      .sort().reverse();
    const seen = new Set<number>();
    for (const file of files.slice(0, 3)) {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
      for (const entry of Object.values(raw) as any[]) {
        if (entry.customer_id) seen.add(Number(entry.customer_id));
        if (seen.size >= limit) break;
      }
      if (seen.size >= limit) break;
    }
    return Array.from(seen);
  } catch { return []; }
}

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

// Extract the most recent timestamp from a list of stat records
function findLatest(items: any[]): { latestMs: number; latestAt: string } {
  let latestMs = 0;
  let latestAt = '';
  for (const item of items) {
    const ts = item.end_date && item.end_time
      ? `${item.end_date}T${item.end_time}`
      : (item.end_session || item.stop_time || item.add_time || item.created_at);
    if (ts) {
      const ms = new Date(ts.replace(' ', 'T')).getTime();
      if (ms > latestMs) { latestMs = ms; latestAt = ts; }
    }
  }
  return { latestMs, latestAt };
}

async function fetchLatestStat(): Promise<{ latestMs: number; latestAt: string } | null> {
  // 1. Try the global endpoint first
  try {
    const data = await splynx('get', '/admin/customers/customer-statistics', undefined, {
      itemsPerPage: 10, page: 1, 'sort[id]': 'desc',
    }, 15_000);
    const items: any[] = Array.isArray(data) ? data : (data.items || data.data || []);
    if (items.length) return findLatest(items);
  } catch { /* global endpoint often 500/502 on large instances — fall through */ }

  // 2. Fall back to per-customer probes using recently-seen customers from daily files
  const customerIds = getRecentCustomerIdsFromDailyFiles(8);
  for (const cid of customerIds) {
    try {
      const data = await splynx('get', `/admin/customers/customer/${cid}/statistics`, undefined, {
        itemsPerPage: 5, page: 1, 'sort[id]': 'desc',
      }, 15_000);
      const items: any[] = Array.isArray(data) ? data : (data.items || data.data || []);
      if (items.length) {
        const result = findLatest(items);
        if (result.latestMs) return result;
      }
    } catch { /* try next */ }
  }

  return null;
}

async function checkAccounting(): Promise<HealthResult> {
  const now = new Date().toISOString();
  try {
    const latest = await fetchLatestStat();

    if (!latest || !latest.latestMs) {
      const result: HealthResult = {
        ok: false,
        checked_at: now,
        latest_stat_at: null,
        hours_since_last_stat: null,
        message: 'No statistics records found — accounting may be broken or all probes timed out',
      };
      lastCheckResult = result;
      return result;
    }

    const hoursSince = (Date.now() - latest.latestMs) / (1000 * 60 * 60);
    const ok = hoursSince < 24;

    const result: HealthResult = {
      ok,
      checked_at: now,
      latest_stat_at: latest.latestAt,
      hours_since_last_stat: Math.round(hoursSince * 10) / 10,
      message: ok
        ? `Accounting is healthy — last stat ${Math.round(hoursSince * 10) / 10}h ago`
        : `⚠️ Accounting appears stale — no new stats in ${Math.round(hoursSince * 10) / 10}h`,
    };

    lastCheckResult = result;

    if (!ok) {
      const cooldownPassed = !alertSentAt || Date.now() - alertSentAt > ALERT_COOLDOWN_MS;
      if (cooldownPassed) await sendSmsAlert(hoursSince, latest.latestAt);
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
