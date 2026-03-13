import { Router, Request, Response } from 'express';
import { splynx } from '../lib/splynx';

const router = Router();

// GET /api/sessions/online
// Returns all currently online sessions — for LTE the "mac" field = SIM number
router.get('/online', async (req: Request, res: Response) => {
  try {
    const data = await splynx('get', '/networking/online-sessions', undefined, {
      page: req.query.page || 1,
      itemsPerPage: req.query.limit || 500,
      ...( req.query.router_id ? { 'filter[router_id]': req.query.router_id } : {} ),
      ...( req.query.customer_id ? { 'filter[customer_id]': req.query.customer_id } : {} ),
    });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/online/lte-sims
// Returns deduplicated list of active LTE SIM numbers (MAC field) with customer info
router.get('/online/lte-sims', async (_req: Request, res: Response) => {
  try {
    const data = await splynx('get', '/networking/online-sessions', undefined, {
      itemsPerPage: 1000,
    });

    const sessions: any[] = Array.isArray(data) ? data : (data.items || data.data || []);

    // Deduplicate by MAC — keep the latest session per SIM
    const simMap = new Map<string, any>();
    for (const session of sessions) {
      const mac = session.mac || session.Mac || session.username;
      if (!mac) continue;
      const existing = simMap.get(mac);
      if (!existing || new Date(session.started) > new Date(existing.started)) {
        simMap.set(mac, {
          sim_number: mac,
          customer_id: session.customer_id,
          customer_name: session.customer_name || null,
          ip: session.ip,
          router_id: session.router_id,
          router_name: session.router_name || null,
          started: session.started,
          download_bytes: session.download,
          upload_bytes: session.upload,
          online: true,
        });
      }
    }

    res.json({
      total: simMap.size,
      sims: Array.from(simMap.values()).sort((a, b) =>
        (a.customer_name || '').localeCompare(b.customer_name || '')
      ),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/history
// Session history with optional filters: mac, customer_id, date_from, date_to
router.get('/history', async (req: Request, res: Response) => {
  try {
    const params: Record<string, unknown> = {
      page: req.query.page || 1,
      itemsPerPage: req.query.limit || 100,
    };
    if (req.query.mac) params['filter[mac]'] = req.query.mac;
    if (req.query.customer_id) params['filter[customer_id]'] = req.query.customer_id;
    if (req.query.date_from) params['filter[start_date]'] = req.query.date_from;
    if (req.query.date_to) params['filter[end_date]'] = req.query.date_to;

    const data = await splynx('get', '/networking/sessions', undefined, params);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/history/sim/:mac
// Full session history for a specific SIM number
router.get('/history/sim/:mac', async (req: Request, res: Response) => {
  try {
    const data = await splynx('get', '/networking/sessions', undefined, {
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
