import { Router, Request, Response } from 'express';
import { splynx } from '../lib/splynx';
import fs from 'fs';
import path from 'path';

const router = Router();

// ─── Persistent daily session tracker ──────────────────────────────────────
// One JSON file per day in server/data/sessions-YYYY-MM-DD.json
// Survives server restarts. Accumulates as live sessions are polled.

const DATA_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

interface SeenEntry {
  sim_number: string;
  customer_id: number;
  customer_name: string | null;
  first_seen: string;
  last_seen: string;
  peak_download_bytes: number;
  peak_upload_bytes: number;
}

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function dataFile(date: string) {
  return path.join(DATA_DIR, `sessions-${date}.json`);
}

function loadDay(date: string): Map<string, SeenEntry> {
  const file = dataFile(date);
  if (!fs.existsSync(file)) return new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Map(Object.entries(raw));
  } catch { return new Map(); }
}

function saveDay(date: string, map: Map<string, SeenEntry>) {
  const obj: Record<string, SeenEntry> = {};
  for (const [k, v] of map) obj[k] = v;
  fs.writeFileSync(dataFile(date), JSON.stringify(obj), 'utf8');
}

// ─── Persistent service→SIM map ──────────────────────────────────────────────
// Maps service_id → { sim_number, ip, last_seen } so offline services can
// still show their last known SIM on the Customers page.

const SERVICE_SIMS_FILE = path.join(DATA_DIR, 'service-sims.json');

function loadServiceSims(): Record<string, { sim_number: string; ip: string | null; last_seen: string }> {
  try {
    if (fs.existsSync(SERVICE_SIMS_FILE)) return JSON.parse(fs.readFileSync(SERVICE_SIMS_FILE, 'utf8'));
  } catch { /* ignore */ }
  return {};
}

function recordServiceSims(sessions: Array<{
  service_id: number; sim_number: string; ip: string | null;
}>) {
  const map = loadServiceSims();
  const now = new Date().toISOString();
  for (const s of sessions) {
    if (!s.service_id || !s.sim_number) continue;
    map[String(s.service_id)] = { sim_number: s.sim_number, ip: s.ip, last_seen: now };
  }
  fs.writeFileSync(SERVICE_SIMS_FILE, JSON.stringify(map), 'utf8');
}

export function getServiceSims() {
  return loadServiceSims();
}

function recordSims(sims: Array<{
  sim_number: string; customer_id: number; customer_name: string | null;
  download_bytes: number; upload_bytes: number;
}>) {
  const today = dateKey();
  const map = loadDay(today);
  const now = new Date().toISOString();
  for (const s of sims) {
    const existing = map.get(s.sim_number);
    if (!existing) {
      map.set(s.sim_number, {
        sim_number: s.sim_number,
        customer_id: s.customer_id,
        customer_name: s.customer_name,
        first_seen: now,
        last_seen: now,
        peak_download_bytes: s.download_bytes,
        peak_upload_bytes: s.upload_bytes,
      });
    } else {
      existing.last_seen = now;
      if (s.download_bytes > existing.peak_download_bytes) existing.peak_download_bytes = s.download_bytes;
      if (s.upload_bytes > existing.peak_upload_bytes) existing.peak_upload_bytes = s.upload_bytes;
    }
  }
  saveDay(today, map);
}

function listAvailableDates(): string[] {
  return fs.readdirSync(DATA_DIR)
    .filter((f) => f.startsWith('sessions-') && f.endsWith('.json'))
    .map((f) => f.replace('sessions-', '').replace('.json', ''))
    .sort()
    .reverse(); // newest first
}

// GET /api/sessions/online
router.get('/online', async (req: Request, res: Response) => {
  try {
    const data = await splynx('get', '/admin/customers/customers-online', undefined, {
      page: req.query.page || 1,
      itemsPerPage: req.query.limit || 500,
      ...( req.query.nas_id ? { 'filter[nas_id]': req.query.nas_id } : {} ),
      ...( req.query.customer_id ? { 'filter[customer_id]': req.query.customer_id } : {} ),
    });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({
      error: err.message,
      splynx_status: err.response?.status,
      splynx_data: err.response?.data,
    });
  }
});

// GET /api/sessions/online/lte-sims
// Returns deduplicated LTE SIMs (type=radius, mac = SIM number) with customer names
router.get('/online/lte-sims', async (_req: Request, res: Response) => {
  try {
    // Fetch sessions and customers in parallel
    const [sessionData, customerData] = await Promise.all([
      splynx('get', '/admin/customers/customers-online', undefined, { itemsPerPage: 1000 }),
      splynx('get', '/admin/customers/customer', undefined, { itemsPerPage: 1000 }),
    ]);

    const sessions: any[] = Array.isArray(sessionData) ? sessionData : (sessionData.items || sessionData.data || []);
    const customers: any[] = Array.isArray(customerData) ? customerData : (customerData.items || customerData.data || []);

    // Build customer ID → name map
    const customerMap = new Map<number, string>();
    for (const c of customers) {
      customerMap.set(Number(c.id), c.name);
    }

    // Filter for LTE sessions (type=radius, mac is a SIM number)
    const lteSessions = sessions.filter((s) => s.type === 'radius' && s.mac);

    // Deduplicate by MAC (SIM number) — keep latest session
    const simMap = new Map<string, any>();
    for (const session of lteSessions) {
      const mac = session.mac;
      const existing = simMap.get(mac);
      if (!existing || new Date(session.start_session) > new Date(existing.start_session)) {
        simMap.set(mac, {
          sim_number: mac,
          service_id: session.service_id ? Number(session.service_id) : null,
          customer_id: session.customer_id,
          customer_name: customerMap.get(Number(session.customer_id)) || null,
          ip: session.ipv4 || null,
          router_id: session.nas_id,
          router_name: session.nas_identifier || null,
          started: session.start_session,
          time_on: session.time_on,           // seconds online
          download_bytes: session.in_bytes,
          upload_bytes: session.out_bytes,
          online: true,
        });
      }
    }

    const sims = Array.from(simMap.values()).sort((a, b) =>
      (a.customer_name || '').localeCompare(b.customer_name || '')
    );

    // Record for daily tracker
    recordSims(sims.map((s) => ({
      sim_number: s.sim_number,
      customer_id: Number(s.customer_id),
      customer_name: s.customer_name,
      download_bytes: s.download_bytes,
      upload_bytes: s.upload_bytes,
    })));

    // Persist service_id → SIM mapping so offline services retain last known SIM
    recordServiceSims(
      sims
        .filter((s) => s.service_id)
        .map((s) => ({ service_id: s.service_id, sim_number: s.sim_number, ip: s.ip }))
    );

    res.json({ total: sims.length, sims });
  } catch (err: any) {
    res.status(500).json({
      error: err.message,
      splynx_status: err.response?.status,
      splynx_data: err.response?.data,
    });
  }
});

// GET /api/sessions/report/dates — list all days with recorded data
router.get('/report/dates', (_req: Request, res: Response) => {
  res.json({ dates: listAvailableDates() });
});

// GET /api/sessions/report/day?date=YYYY-MM-DD (defaults to today)
router.get('/report/day', (req: Request, res: Response) => {
  const date = (req.query.date as string) || dateKey();
  const map = loadDay(date);
  const sims = Array.from(map.values())
    .sort((a, b) => (a.customer_name || '').localeCompare(b.customer_name || ''));
  const today = dateKey();
  const currently_online = date === today
    ? sims.filter((s) => Date.now() - new Date(s.last_seen).getTime() < 90_000).length
    : 0;
  res.json({ date, total: sims.length, currently_online, sims });
});

// Keep /report/today as an alias
router.get('/report/today', (_req: Request, res: Response) => {
  const date = dateKey();
  const map = loadDay(date);
  const sims = Array.from(map.values())
    .sort((a, b) => (a.customer_name || '').localeCompare(b.customer_name || ''));
  res.json({
    date,
    total: sims.length,
    currently_online: sims.filter((s) => Date.now() - new Date(s.last_seen).getTime() < 90_000).length,
    sims,
  });
});

// GET /api/sessions/recent
// LTE sessions that started within the last 24 hours (from currently online sessions)
router.get('/recent', async (_req: Request, res: Response) => {
  try {
    const [sessionData, customerData] = await Promise.all([
      splynx('get', '/admin/customers/customers-online', undefined, { itemsPerPage: 1000 }),
      splynx('get', '/admin/customers/customer', undefined, { itemsPerPage: 1000 }),
    ]);

    const sessions: any[] = Array.isArray(sessionData) ? sessionData : (sessionData.items || sessionData.data || []);
    const customers: any[] = Array.isArray(customerData) ? customerData : (customerData.items || customerData.data || []);

    const customerMap = new Map<number, string>();
    for (const c of customers) customerMap.set(Number(c.id), c.name);

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const recent = sessions
      .filter((s) => {
        if (s.type !== 'radius' || !s.mac) return false;
        const started = new Date(s.start_session.replace(' ', 'T'));
        return started >= cutoff;
      })
      .map((s) => ({
        sim_number: s.mac,
        customer_id: s.customer_id,
        customer_name: customerMap.get(Number(s.customer_id)) || null,
        ip: s.ipv4 || null,
        router_id: s.nas_id,
        router_name: s.nas_identifier || null,
        started: s.start_session,
        time_on: s.time_on,
        download_bytes: s.in_bytes,
        upload_bytes: s.out_bytes,
        online: true,
      }))
      .sort((a, b) => new Date(b.started).getTime() - new Date(a.started).getTime());

    res.json({ total: recent.length, sims: recent });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/history
router.get('/history', async (req: Request, res: Response) => {
  try {
    const params: Record<string, unknown> = {
      page: req.query.page || 1,
      itemsPerPage: req.query.limit || 100,
    };
    if (req.query.mac) params['filter[mac]'] = req.query.mac;
    if (req.query.customer_id) params['filter[customer_id]'] = req.query.customer_id;
    if (req.query.date_from) params['filter[start_session]'] = req.query.date_from;

    const data = await splynx('get', '/admin/customers/customers-online', undefined, params);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/history/sim/:mac
router.get('/history/sim/:mac', async (req: Request, res: Response) => {
  try {
    const data = await splynx('get', '/admin/customers/customers-online', undefined, {
      'filter[mac]': req.params.mac,
      itemsPerPage: 200,
      page: req.query.page || 1,
    });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
