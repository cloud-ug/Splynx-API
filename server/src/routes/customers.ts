import { Router, Request, Response } from 'express';
import { splynx } from '../lib/splynx';

const router = Router();

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
