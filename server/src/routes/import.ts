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
// Fast scan: fetches only the most recent page of statistics per customer to
// get the last known MAC per service_id. Completes in ~2–5 minutes vs 2 hours.
router.post('/rebuild-sims', async (_req: Request, res: Response) => {
  res.json({ ok: true, message: 'Rebuilding service-sims in background…' });

  (async () => {
    try {
      const customerData = await splynx('get', '/admin/customers/customer', undefined, { itemsPerPage: 500 });
      const customers: any[] = Array.isArray(customerData) ? customerData : (customerData.items || []);

      // Load existing map so we don't lose entries already there
      let map: Record<string, { sim_number: string; ip: string | null; last_seen: string }> = {};
      try { if (fs.existsSync(SERVICE_SIMS_FILE)) map = JSON.parse(fs.readFileSync(SERVICE_SIMS_FILE, 'utf8')); } catch {}

      let updated = 0;
      for (const customer of customers) {
        try {
          // Fetch only the first page (newest records)
          const data = await splynx('get', `/admin/customers/customer/${customer.id}/statistics`, undefined, {
            itemsPerPage: 50, page: 1, 'sort[id]': 'desc',
          }, 20_000);
          const items: any[] = Array.isArray(data) ? data : (data.items || data.data || []);

          for (const stat of items) {
            if (!stat.mac || !stat.service_id || !LTE_NAS_IDS.has(Number(stat.nas_id))) continue;
            const key = String(stat.service_id);
            const endIso = stat.end_date && stat.end_time ? `${stat.end_date}T${stat.end_time}` : null;
            if (!endIso) continue;
            if (!map[key] || endIso > map[key].last_seen) {
              map[key] = { sim_number: stat.mac, ip: null, last_seen: endIso };
              updated++;
            }
          }
        } catch { /* skip customer on timeout */ }

        fs.writeFileSync(SERVICE_SIMS_FILE, JSON.stringify(map), 'utf8');
        await new Promise(r => setTimeout(r, 200)); // gentle pacing
      }

      console.log(`[rebuild-sims] Done. ${updated} service→SIM entries written.`);
    } catch (err: any) {
      console.error('[rebuild-sims] Error:', err.message);
    }
  })();
});

export default router;
