import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { splynx } from '../lib/splynx';

const router = Router();

const DATA_DIR = path.join(__dirname, '../../data');

// ─── GET /api/customers/lte-summary ──────────────────────────────────────────
// Returns all Cloud-LTE services across all customers, each with its most
// recent SIM (MAC) pulled from the active session or daily tracker.
// One row per service — customers with multiple SIMs appear multiple times.
router.get('/lte-summary', async (_req: Request, res: Response) => {
  try {
    // 1. Fetch customers + active sessions in parallel
    const [customerData, sessionData] = await Promise.all([
      splynx('get', '/admin/customers/customer', undefined, { itemsPerPage: 500 }),
      splynx('get', '/admin/customers/customers-online', undefined, { itemsPerPage: 1000 }),
    ]);

    const customers: any[] = Array.isArray(customerData) ? customerData : (customerData.items || []);
    const sessions: any[] = Array.isArray(sessionData) ? sessionData : (sessionData.items || []);

    // 2. Index active LTE sessions by service_id and by login
    const sessionByServiceId = new Map<number, any>();
    const sessionByLogin = new Map<string, any>();
    for (const s of sessions) {
      if (s.type !== 'radius' || !s.mac) continue;
      const sid = Number(s.service_id);
      if (sid && !sessionByServiceId.has(sid)) sessionByServiceId.set(sid, s);
      if (s.login) sessionByLogin.set(String(s.login).toLowerCase(), s);
    }

    // 3. Build last-known SIM map from daily tracker files (keyed by sim_number)
    //    We'll use this to fill in offline services where we can match login→sim
    const lastKnownBySim = new Map<string, { last_seen: string; peak_dl: number; peak_ul: number }>();
    if (fs.existsSync(DATA_DIR)) {
      const files = fs.readdirSync(DATA_DIR)
        .filter(f => f.startsWith('sessions-') && f.endsWith('.json'))
        .sort().reverse();
      for (const file of files.slice(0, 30)) { // last 30 days is enough
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
          for (const entry of Object.values(raw) as any[]) {
            if (entry.sim_number && !lastKnownBySim.has(entry.sim_number)) {
              lastKnownBySim.set(entry.sim_number, {
                last_seen: entry.last_seen,
                peak_dl: entry.peak_download_bytes,
                peak_ul: entry.peak_upload_bytes,
              });
            }
          }
        } catch { /* skip */ }
      }
    }

    // 4. Fetch internet services for all customers in parallel (batched)
    const BATCH = 10;
    const allServices: any[] = [];
    for (let i = 0; i < customers.length; i += BATCH) {
      const batch = customers.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(c =>
          splynx('get', `/admin/customers/customer/${c.id}/internet-services`)
            .then((d: any) => ({ customerId: c.id, customerName: c.name, services: Array.isArray(d) ? d : [] }))
        )
      );
      for (const r of results) {
        if (r.status === 'fulfilled') allServices.push(r.value);
      }
    }

    // 5. Build rows — one per Cloud-LTE service
    const LTE_TARIFF_ID = 37;
    const rows: any[] = [];

    for (const { customerId, customerName, services } of allServices) {
      const lteServices = services.filter((s: any) => Number(s.tariff_id) === LTE_TARIFF_ID);
      for (const svc of lteServices) {
        const serviceId = Number(svc.id);
        const login = String(svc.login || '').toLowerCase();

        // Try to find active session
        const activeSession = sessionByServiceId.get(serviceId) || sessionByLogin.get(login);

        if (activeSession) {
          rows.push({
            customer_id: customerId,
            customer_name: customerName,
            service_id: serviceId,
            service_login: svc.login,
            description: svc.description || 'Cloud-LTE',
            status: 'online',
            sim_number: activeSession.mac,
            last_seen: activeSession.start_session,
            ip: activeSession.ipv4 || null,
            router_name: activeSession.nas_identifier || null,
            download_bytes: Number(activeSession.in_bytes) || 0,
            upload_bytes: Number(activeSession.out_bytes) || 0,
          });
        } else {
          // Offline — try to find last known SIM from tracker via login match
          // Sessions store login, tracker stores sim_number; bridge via sessionByLogin history
          // Best effort: check if tracker has an entry matching this service's MAC field
          const trackerSim = svc.mac || null; // service may have MAC pre-configured
          const tracker = trackerSim ? lastKnownBySim.get(trackerSim) : null;

          rows.push({
            customer_id: customerId,
            customer_name: customerName,
            service_id: serviceId,
            service_login: svc.login,
            description: svc.description || 'Cloud-LTE',
            status: svc.status === 'active' ? 'active' : 'offline',
            sim_number: trackerSim || null,
            last_seen: tracker?.last_seen || null,
            ip: svc.ipv4 || null,
            router_name: null,
            download_bytes: tracker?.peak_dl || 0,
            upload_bytes: tracker?.peak_ul || 0,
          });
        }
      }
    }

    // Sort: online first, then active, then by last_seen desc
    rows.sort((a, b) => {
      const order: Record<string, number> = { online: 0, active: 1, offline: 2 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      if (!a.last_seen && !b.last_seen) return 0;
      if (!a.last_seen) return 1;
      if (!b.last_seen) return -1;
      return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
    });

    res.json({
      total: rows.length,
      online: rows.filter(r => r.status === 'online').length,
      active: rows.filter(r => r.status === 'active').length,
      services: rows,
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
