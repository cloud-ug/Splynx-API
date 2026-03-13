import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import sessionsRouter from './routes/sessions';
import customersRouter from './routes/customers';
import importRouter from './routes/import';
import { startAccountingMonitor, getLastHealthResult } from './services/accountingMonitor';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: process.env.DASHBOARD_URL || 'http://localhost:5173' }));
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

app.use('/api/sessions', sessionsRouter);
app.use('/api/customers', customersRouter);
app.use('/api/import', importRouter);

app.get('/', (_req, res) => res.json({
  name: 'Splynx API Wrapper',
  routes: [
    'GET /api/health',
    'GET /api/sessions/online',
    'GET /api/sessions/online/lte-sims',
    'GET /api/sessions/history',
    'GET /api/sessions/history/sim/:mac',
    'GET /api/customers',
    'GET /api/customers/:id',
    'GET /api/customers/:id/services',
    'GET /api/customers/:id/invoices',
  ],
}));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/health/accounting', (_req, res) => res.json(getLastHealthResult()));

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

// Temporary debug endpoint — remove after auth is working
app.get('/api/debug/auth', async (_req, res) => {
  const axios = require('axios');
  const crypto = require('crypto');
  const url = process.env.SPLYNX_URL;
  const apiKey = process.env.SPLYNX_API_KEY;
  const apiSecret = process.env.SPLYNX_API_SECRET;
  const login = process.env.SPLYNX_LOGIN;
  const password = process.env.SPLYNX_PASSWORD;

  const results: any[] = [];
  const nonce = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac('sha256', apiSecret).update(nonce + apiKey).digest('hex').toUpperCase();

  const withOrigin = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Origin': url,
    'Referer': `${url}/`,
  };
  const withoutOrigin = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  const post = async (label: string, path: string, body: any, headers = withOrigin) => {
    try {
      const r = await axios.post(`${url}${path}`, body, { headers });
      results.push({ label, success: true, status: r.status, data: r.data });
    } catch (err: any) {
      results.push({ label, success: false, status: err.response?.status, data: err.response?.data });
    }
  };

  const basicAuth = Buffer.from(`${login}:${password}`).toString('base64');
  const basicHeaders = { Authorization: `Basic ${basicAuth}`, Accept: 'application/json' };
  const apiKeyHeaders = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };

  const get = async (label: string, path: string, headers?: any, params?: any) => {
    try {
      const r = await axios.get(`${url}${path}`, { headers: headers || withOrigin, params });
      results.push({ label, success: true, status: r.status, data: r.data });
    } catch (err: any) {
      results.push({ label, success: false, status: err.response?.status, data: err.response?.data });
    }
  };

  // Basic Auth attempts
  await get('GET /api Basic Auth', '/api', basicHeaders);
  await get('GET /api Bearer apiKey', '/api', apiKeyHeaders);

  // Try Splynx swagger/docs endpoints
  await get('GET /api/docs', '/api/docs');
  await get('GET /swagger', '/swagger');
  await get('GET /api/v2/swagger', '/api/v2/swagger');

  // POST /api with credentials in body
  await post('POST /api admin login', '/api', { auth_type: 'admin', login, password });
  await post('POST /api api_key HMAC', '/api', { auth_type: 'api_key', key: apiKey, nonce, signature: sig });

  // Try /api/v2/auth/tokens with Basic Auth header
  try {
    const r = await axios.post(`${url}/api/v2/auth/tokens`,
      { auth_type: 'admin', login, password },
      { headers: { ...basicHeaders, 'Content-Type': 'application/json' } }
    );
    results.push({ label: 'POST /api/v2/auth/tokens + Basic header', success: true, data: r.data });
  } catch (err: any) {
    results.push({ label: 'POST /api/v2/auth/tokens + Basic header', success: false, status: err.response?.status, data: err.response?.data });
  }

  res.json(results);
});

app.listen(PORT, () => {
  console.log(`Splynx API server running on http://localhost:${PORT}`);
  startAccountingMonitor();
});
