import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { splynx } from '../lib/splynx';

const router = Router();

const DATA_DIR = path.join(__dirname, '../../data');

// ─── GET /api/customers/lte-summary ──────────────────────────────────────────
// Returns every customer with their most recent LTE SIM and online status.
// Online customers come from live sessions; offline from the daily tracker files.
router.get('/lte-summary', async (_req: Request, res: Response) => {
  try {
    // 1. Fetch all customers + active LTE sessions in parallel
    const [customerData, sessionData] = await Promise.all([
      splynx('get', '/admin/customers/customer', undefined, { itemsPerPage: 500 }),
      splynx('get', '/admin/customers/customers-online', undefined, { itemsPerPage: 1000 }),
    ]);

    const customers: any[] = Array.isArray(customerData) ? customerData : (customerData.items || []);
    const sessions: any[] = Array.isArray(sessionData) ? sessionData : (sessionData.items || []);

    // 2. Build map of currently online LTE sessions keyed by customer_id
    const onlineMap = new Map<number, any>();
    for (const s of sessions) {
      if (s.type !== 'radius' || !s.mac) continue;
      const cid = Number(s.customer_id);
      const existing = onlineMap.get(cid);
      if (!existing || new Date(s.start_session) > new Date(existing.start_session)) {
        onlineMap.set(cid, s);
      }
    }

    // 3. Build map of last known SIM per customer from daily tracker files (newest first)
    const lastKnownMap = new Map<number, { sim_number: string; last_seen: string; peak_download_bytes: number; peak_upload_bytes: number }>();
    if (fs.existsSync(DATA_DIR)) {
      const files = fs.readdirSync(DATA_DIR)
        .filter(f => f.startsWith('sessions-') && f.endsWith('.json'))
        .sort().reverse(); // newest first

      for (const file of files) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
          for (const entry of Object.values(raw) as any[]) {
            const cid = Number(entry.customer_id);
            if (cid && !lastKnownMap.has(cid)) {
              lastKnownMap.set(cid, {
                sim_number: entry.sim_number,
                last_seen: entry.last_seen,
                peak_download_bytes: entry.peak_download_bytes,
                peak_upload_bytes: entry.peak_upload_bytes,
              });
            }
          }
        } catch { /* skip corrupt files */ }

        // Stop once we have a last-known entry for every customer
        if (lastKnownMap.size >= customers.length) break;
      }
    }

    // 4. Merge into customer summary
    const summary = customers.map(c => {
      const cid = Number(c.id);
      const online = onlineMap.get(cid);
      const lastKnown = lastKnownMap.get(cid);

      if (online) {
        return {
          customer_id: cid,
          customer_name: c.name,
          sim_number: online.mac,
          is_online: true,
          last_seen: online.start_session,
          download_bytes: Number(online.in_bytes) || 0,
          upload_bytes: Number(online.out_bytes) || 0,
          ip: online.ipv4 || null,
          router_name: online.nas_identifier || null,
        };
      }

      if (lastKnown) {
        return {
          customer_id: cid,
          customer_name: c.name,
          sim_number: lastKnown.sim_number,
          is_online: false,
          last_seen: lastKnown.last_seen,
          download_bytes: lastKnown.peak_download_bytes,
          upload_bytes: lastKnown.peak_upload_bytes,
          ip: null,
          router_name: null,
        };
      }

      // No LTE session ever recorded
      return {
        customer_id: cid,
        customer_name: c.name,
        sim_number: null,
        is_online: false,
        last_seen: null,
        download_bytes: 0,
        upload_bytes: 0,
        ip: null,
        router_name: null,
      };
    });

    // Sort: online first, then by last_seen desc
    summary.sort((a, b) => {
      if (a.is_online !== b.is_online) return a.is_online ? -1 : 1;
      if (!a.last_seen && !b.last_seen) return 0;
      if (!a.last_seen) return 1;
      if (!b.last_seen) return -1;
      return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
    });

    res.json({
      total: summary.length,
      online: summary.filter(s => s.is_online).length,
      customers: summary,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customers
router.get('/', async (req: Request, res: Response) => {
  try {
    const data = await splynx('get', '/admin/customers/customer', undefined, {
      page: req.query.page || 1,
      itemsPerPage: req.query.limit || 50,
      ...(req.query.search ? { 'filter[name]': req.query.search } : {}),
      ...(req.query.status ? { 'filter[status]': req.query.status } : {}),
    });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customers/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const data = await splynx('get', `/admin/customers/customer/${req.params.id}`);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customers/:id/services
router.get('/:id/services', async (req: Request, res: Response) => {
  try {
    const data = await splynx('get', `/admin/customers/customer/${req.params.id}/internet-services`);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customers/:id/invoices
router.get('/:id/invoices', async (req: Request, res: Response) => {
  try {
    const data = await splynx('get', `/admin/finance/invoices`, undefined, {
      'filter[customer_id]': req.params.id,
      itemsPerPage: 50,
    });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
