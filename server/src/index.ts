import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';

import sessionsRouter from './routes/sessions';
import customersRouter from './routes/customers';
import importRouter from './routes/import';
import ppuRouter from './routes/ppu';
import { startAccountingMonitor, getLastHealthResult } from './services/accountingMonitor';
import { startSimPoller } from './services/simPoller';
import { startBillingRetry, getBillingQueueStatus } from './services/billingRetry';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: process.env.DASHBOARD_URL || 'http://localhost:5173' }));
// Capture the raw body so the PPU webhook can verify its HMAC signature.
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

// Serve dashboard static build (must be before API routes so / serves index.html)
const dashboardDist = path.resolve(process.cwd(), 'apps/dashboard/dist');
if (fs.existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
}

app.use('/api/sessions', sessionsRouter);
app.use('/api/customers', customersRouter);
app.use('/api/import', importRouter);
app.use('/api/ppu', ppuRouter);

app.get('/', (_req, res) => res.json({
  name: 'Splynx API Wrapper',
  routes: [
    'GET  /api/health',
    'GET  /api/health/accounting',
    'POST /api/health/accounting/test-sms',
    'GET  /api/health/billing-queue',
    'GET  /api/sessions/online',
    'GET  /api/sessions/online/lte-sims',
    'POST /api/sessions/disconnect',
    'GET  /api/sessions/recent',
    'GET  /api/sessions/history',
    'GET  /api/sessions/history/sim/:mac',
    'GET  /api/sessions/report/dates',
    'GET  /api/sessions/report/day?date=YYYY-MM-DD',
    'GET  /api/customers',
    'GET  /api/customers/lte-summary',
    'GET  /api/customers/:id',
    'GET  /api/customers/:id/services',
    'GET  /api/customers/:id/invoices',
    'POST /api/ppu/trigger',
    'PUT  /api/customers/:id/services/:serviceId',
    'DELETE /api/customers/:id/services/:serviceId',
    'POST /api/import/rebuild-sims',
    'POST /api/import/fill-missing-sims',
    'GET  /api/import/debug-stats/:customerId',
  ],
}));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/health/accounting', (_req, res) => res.json(getLastHealthResult()));
app.get('/api/health/billing-queue', (_req, res) => res.json(getBillingQueueStatus()));

// POST /api/health/accounting/test-sms — sends a test alert SMS immediately
app.post('/api/health/accounting/test-sms', async (_req, res) => {
  const username = process.env.EGOSMS_USERNAME;
  const password = process.env.EGOSMS_PASSWORD;
  const senderId = process.env.EGOSMS_SENDER_ID || 'CloudCore';
  const apiUrl = process.env.EGOSMS_API_URL || 'https://www.egosms.co/api/v1/json/';
  const alertPhone = process.env.ALERT_PHONE;

  if (!username || !password || !alertPhone) {
    res.status(400).json({ error: 'EGOSMS_USERNAME, EGOSMS_PASSWORD or ALERT_PHONE not set in .env' });
    return;
  }

  const number = alertPhone.replace(/^\+/, '');
  const message = `CloudCore RADIUS Monitor: Test alert — SMS alerts are working correctly. Server time: ${new Date().toISOString()}`;

  try {
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'SendSms',
        userdata: { username, password },
        msgdata: [{ number, message, senderid: senderId, priority: '0' }],
      }),
    });
    const result = await r.json() as any;
    res.json({ ok: result.Status !== 'Failed', egosms: result, sent_to: alertPhone });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback — must be after all API routes
if (fs.existsSync(dashboardDist)) {
  app.get('*', (_req, res) => res.sendFile(path.join(dashboardDist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`Splynx API server running on http://localhost:${PORT}`);
  startAccountingMonitor();
  startSimPoller();
  startBillingRetry();
});
