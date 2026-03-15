import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { startImport, stopImport, getImportProgress, importFromCsv } from '../services/historyImport';
import { splynx } from '../lib/splynx';

const DATA_DIR = path.join(__dirname, '../../data');
const SERVICE_SIMS_FILE = path.join(DATA_DIR, 'service-sims.json');
const LTE_NAS_IDS = new Set([6, 7, 21, 22]); // MTN-LTE-1, MTN-LTE-2, MTN-LTE-#, MTN-LTE-NEW

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// GET /api/import/status
router.get('/status', (_req: Request, res: Response) => {
  res.json(getImportProgress());
});

// POST /api/import/start  { from_date: "2025-01-01" }
router.post('/start', async (req: Request, res: Response) => {
  const fromDate = (req.body.from_date as string) || '2025-01-01';

  // Basic date validation
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    res.status(400).json({ error: 'from_date must be YYYY-MM-DD' });
    return;
  }

  try {
    // Fire and forget — runs in background
    startImport(fromDate).catch((err) => console.error('[import] background error:', err.message));
    res.json({ ok: true, message: `Import started from ${fromDate}` });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

// POST /api/import/stop
router.post('/stop', (_req: Request, res: Response) => {
  stopImport();
  res.json({ ok: true });
});

// POST /api/import/csv  (multipart file upload)
router.post('/csv', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded. Send as multipart field "file".' });
    return;
  }

  const csvText = req.file.buffer.toString('utf8');
  const result = importFromCsv(csvText);

  res.json({
    ok: true,
    imported: result.imported,
    days_populated: result.days.length,
    days: result.days,
    errors: result.errors,
  });
});

// POST /api/import/rebuild-sims
// Two-pass rebuild of service-sims.json:
//   Pass 1 — scrape customers-online (live sessions) for immediate service_id→SIM entries.
//             This catches sessions that are currently active and won't appear in statistics yet.
//   Pass 2 — for each customer's services still missing a SIM, paginate their statistics
//             history (newest first) until the SIM is found or we pass 90 days back.
// Writes service_id → last known SIM to service-sims.json.
router.post('/rebuild-sims', async (_req: Request, res: Response) => {
  res.json({ ok: true, message: 'Rebuilding service-sims in background…' });

  (async () => {
    try {
      let map: Record<string, { sim_number: string; ip: string | null; last_seen: string }> = {};
      try { if (fs.existsSync(SERVICE_SIMS_FILE)) map = JSON.parse(fs.readFileSync(SERVICE_SIMS_FILE, 'utf8')); } catch {}

      // ── Pass 1: live sessions from customers-online ──────────────────────────
      // Active sessions have service_id + mac and are the most up-to-date source.
      try {
        const sessionData = await splynx('get', '/admin/customers/customers-online', undefined, { itemsPerPage: 1000 }, 20_000);
        const sessions: any[] = Array.isArray(sessionData) ? sessionData : (sessionData.items || sessionData.data || []);
        const now = new Date().toISOString();
        let liveUpdated = 0;
        for (const s of sessions) {
          if (!s.mac || !s.service_id) continue;
          if (!LTE_NAS_IDS.has(Number(s.nas_id))) continue;
          const key = String(s.service_id);
          if (!map[key] || now > map[key].last_seen) {
            map[key] = { sim_number: s.mac, ip: s.ipv4 || null, last_seen: now };
            liveUpdated++;
          }
        }
        fs.writeFileSync(SERVICE_SIMS_FILE, JSON.stringify(map), 'utf8');
        console.log(`[rebuild-sims] Pass 1 (live sessions): ${liveUpdated} entries from ${sessions.filter((s: any) => s.mac && s.service_id).length} online SIM sessions`);
      } catch (err: any) {
        console.warn('[rebuild-sims] Pass 1 failed:', err.message);
      }

      // ── Pass 2: statistics history per customer ───────────────────────────────
      // The Splynx statistics endpoint ignores itemsPerPage and returns all records
      // in ascending date order. We fetch once per customer and scan everything,
      // keeping the most recent mac per service_id across all history (no date cutoff).
      const customerData = await splynx('get', '/admin/customers/customer', undefined, { itemsPerPage: 500 });
      const allCustomers: any[] = Array.isArray(customerData) ? customerData : (customerData.items || []);
      const customers = allCustomers.filter((c: any) => c.status === 'active');
      let updated = 0;

      for (const customer of customers) {
        try {
          const svcData = await splynx('get', `/admin/customers/customer/${customer.id}/internet-services`, undefined, undefined, 15_000);
          const services: any[] = Array.isArray(svcData) ? svcData : [];
          const serviceIdSet = new Set(services.map((s: any) => String(s.id)));

          // Only process customers that have at least one service still missing a SIM
          const needsSim = services.some((s: any) => !map[String(s.id)]);
          if (!needsSim) continue;

          // Fetch all statistics in one call — endpoint ignores itemsPerPage
          const data = await splynx('get', `/admin/customers/customer/${customer.id}/statistics`, undefined, {}, 120_000);
          const items: any[] = Array.isArray(data) ? data : (data.items || data.data || []);

          for (const stat of items) {
            if (!stat.mac || !stat.service_id) continue;
            if (!serviceIdSet.has(String(stat.service_id))) continue;

            const key = String(stat.service_id);
            const endIso = stat.end_date && stat.end_time ? `${stat.end_date}T${stat.end_time}` : null;
            if (!endIso) continue;
            // Keep the most recent session for each service
            if (!map[key] || endIso > map[key].last_seen) {
              map[key] = { sim_number: stat.mac, ip: null, last_seen: endIso };
              if (!map[key]) updated++;
              updated++;
            }
          }
        } catch (err: any) {
          console.warn(`[rebuild-sims] Customer ${customer.id} failed: ${err.message}`);
        }

        fs.writeFileSync(SERVICE_SIMS_FILE, JSON.stringify(map), 'utf8');
        await new Promise(r => setTimeout(r, 200));
      }

      console.log(`[rebuild-sims] Done. Pass 2 added ${updated} entries. Total: ${Object.keys(map).length} services mapped.`);
    } catch (err: any) {
      console.error('[rebuild-sims] Error:', err.message);
    }
  })();
});

// GET /api/import/debug-stats/:customerId?pages=3&service_id=XXXX&start_page=1
// Shows statistics pages for a customer, with optional service_id filter and start page
router.get('/debug-stats/:customerId', async (req: Request, res: Response) => {
  const cid = req.params.customerId;
  const pages = Math.min(Number(req.query.pages) || 2, 5);
  const startPage = Number(req.query.start_page) || 1;
  const serviceId = req.query.service_id ? Number(req.query.service_id) : null;
  const results: any[] = [];
  for (let page = startPage; page < startPage + pages; page++) {
    try {
      const params: Record<string, any> = { itemsPerPage: 25, page, 'sort[id]': 'desc' };
      if (serviceId) params['filter[service_id]'] = serviceId;
      const data = await splynx('get', `/admin/customers/customer/${cid}/statistics`, undefined, params, 120_000);
      const items: any[] = Array.isArray(data) ? data : (data.items || data.data || []);
      results.push({ page, count: items.length, records: items.map((r: any) => ({
        id: r.id, service_id: r.service_id, mac: r.mac, nas_id: r.nas_id,
        end_date: r.end_date, end_time: r.end_time,
      }))});
      if (items.length < 25) break;
    } catch (err: any) {
      results.push({ page, error: err.message });
      break;
    }
  }
  res.json({ customer_id: cid, results });
});

export default router;
