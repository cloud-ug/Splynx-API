import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { startImport, stopImport, getImportProgress, importFromCsv } from '../services/historyImport';
import { splynx } from '../lib/splynx';

const DATA_DIR = path.join(__dirname, '../../data');
const SERVICE_SIMS_FILE = path.join(DATA_DIR, 'service-sims.json');
const LTE_NAS_IDS = new Set([21, 22]);

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
// For each customer: get their LTE service IDs, then paginate their statistics
// (newest first) until every service has a MAC or we pass 90 days back.
// Writes service_id → last known SIM to service-sims.json.
router.post('/rebuild-sims', async (_req: Request, res: Response) => {
  res.json({ ok: true, message: 'Rebuilding service-sims in background…' });

  (async () => {
    try {
      const customerData = await splynx('get', '/admin/customers/customer', undefined, { itemsPerPage: 500 });
      const customers: any[] = Array.isArray(customerData) ? customerData : (customerData.items || []);

      let map: Record<string, { sim_number: string; ip: string | null; last_seen: string }> = {};
      try { if (fs.existsSync(SERVICE_SIMS_FILE)) map = JSON.parse(fs.readFileSync(SERVICE_SIMS_FILE, 'utf8')); } catch {}

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 90); // only look back 90 days
      const cutoffDate = cutoff.toISOString().slice(0, 10);

      let updated = 0;

      for (const customer of customers) {
        try {
          // Get this customer's internet service IDs
          const svcData = await splynx('get', `/admin/customers/customer/${customer.id}/internet-services`, undefined, undefined, 15_000);
          const services: any[] = Array.isArray(svcData) ? svcData : [];
          const serviceIds = new Set(services.map((s: any) => String(s.id)));

          // Track which services still need a SIM found
          const pending = new Set(serviceIds);

          let page = 1;
          while (pending.size > 0) {
            const data = await splynx('get', `/admin/customers/customer/${customer.id}/statistics`, undefined, {
              itemsPerPage: 50, page, 'sort[id]': 'desc',
              'filter[end_date]': cutoffDate,  // only sessions newer than cutoff
            }, 20_000);
            const items: any[] = Array.isArray(data) ? data : (data.items || data.data || []);
            if (!items.length) break;

            let pastCutoff = false;
            for (const stat of items) {
              // Stop if we've gone past the 90-day cutoff
              if (stat.end_date && stat.end_date < cutoffDate) { pastCutoff = true; break; }
              if (!stat.mac || !stat.service_id) continue; // any session with a MAC is SIM-based (misprovision can put SIM on any NAS)

              const key = String(stat.service_id);
              if (!pending.has(key)) continue; // already found or not our service

              const endIso = stat.end_date && stat.end_time ? `${stat.end_date}T${stat.end_time}` : null;
              if (!endIso) continue;
              if (!map[key] || endIso > map[key].last_seen) {
                map[key] = { sim_number: stat.mac, ip: null, last_seen: endIso };
                updated++;
              }
              pending.delete(key); // found this service's SIM
            }

            if (pastCutoff || items.length < 50) break;
            page++;
            await new Promise(r => setTimeout(r, 300));
          }
        } catch { /* skip customer on timeout */ }

        fs.writeFileSync(SERVICE_SIMS_FILE, JSON.stringify(map), 'utf8');
        await new Promise(r => setTimeout(r, 300));
      }

      console.log(`[rebuild-sims] Done. ${updated} service→SIM entries written across ${Object.keys(map).length} services.`);
    } catch (err: any) {
      console.error('[rebuild-sims] Error:', err.message);
    }
  })();
});

export default router;
