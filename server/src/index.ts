import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import sessionsRouter from './routes/sessions';
import customersRouter from './routes/customers';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: process.env.DASHBOARD_URL || 'http://localhost:5173' }));
app.use(express.json());
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

app.use('/api/sessions', sessionsRouter);
app.use('/api/customers', customersRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Splynx API server running on http://localhost:${PORT}`);
});
