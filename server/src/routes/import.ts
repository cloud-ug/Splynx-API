import { Router, Request, Response } from 'express';
import multer from 'multer';
import { startImport, stopImport, getImportProgress, importFromCsv } from '../services/historyImport';

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

export default router;
