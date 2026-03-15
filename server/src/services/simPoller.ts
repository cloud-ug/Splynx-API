/**
 * SIM Poller
 *
 * Polls customers-online every 5 minutes and writes service_id→SIM mappings
 * to service-sims.json. This keeps the Customers page showing current SIM
 * numbers for all active services without requiring the dashboard to be open.
 */

import fs from 'fs';
import path from 'path';
import { splynx } from '../lib/splynx';

const DATA_DIR = path.join(__dirname, '../../data');
const SERVICE_SIMS_FILE = path.join(DATA_DIR, 'service-sims.json');

function loadServiceSims(): Record<string, { sim_number: string; ip: string | null; last_seen: string }> {
  try {
    if (fs.existsSync(SERVICE_SIMS_FILE)) return JSON.parse(fs.readFileSync(SERVICE_SIMS_FILE, 'utf8'));
  } catch { /* ignore */ }
  return {};
}

async function pollLiveSims() {
  try {
    const sessionData = await splynx('get', '/admin/customers/customers-online', undefined, { itemsPerPage: 1000 }, 20_000);
    const sessions: any[] = Array.isArray(sessionData) ? sessionData : (sessionData.items || sessionData.data || []);

    const map = loadServiceSims();
    const now = new Date().toISOString();
    let updated = 0;

    for (const s of sessions) {
      if (!s.mac || !s.service_id) continue;
      const key = String(s.service_id);
      if (!map[key] || now > map[key].last_seen) {
        map[key] = { sim_number: s.mac, ip: s.ipv4 || null, last_seen: now };
        updated++;
      }
    }

    if (updated > 0) {
      fs.writeFileSync(SERVICE_SIMS_FILE, JSON.stringify(map), 'utf8');
      console.log(`[sim-poller] Updated ${updated} service→SIM entries`);
    }
  } catch (err: any) {
    console.warn('[sim-poller] Poll failed:', err.message);
  }
}

export function startSimPoller() {
  const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  // Run immediately on startup
  pollLiveSims().then(() => {
    console.log('[sim-poller] Initial poll complete');
  });

  setInterval(pollLiveSims, INTERVAL_MS);
  console.log('[sim-poller] Started — polling every 5 minutes');
}
