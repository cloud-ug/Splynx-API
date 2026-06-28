/**
 * Billing Retry Queue
 *
 * When a PPU ACTIVE activation fails to write its Splynx finance record
 * (createBillingRecord in routes/ppu.ts), the activation still succeeds — we
 * never block the tariff switch on a billing hiccup. But that would leave an
 * ACTIVE window burning MTN data with NO revenue line.
 *
 * This module captures those failures in a durable file-backed queue
 * (server/data/billing-retry.jsonl) and retries them on a timer until they
 * succeed or hit max attempts (then they sit as a dead letter for ops review).
 *
 * Mirrors the existing file-based pattern used by simPoller / accountingMonitor.
 */

import fs from 'fs';
import path from 'path';
import { splynx } from '../lib/splynx';

const DATA_DIR = path.join(__dirname, '../../data');
const QUEUE_FILE = path.join(DATA_DIR, 'billing-retry.jsonl');

const MAX_ATTEMPTS = Number(process.env.PPU_BILLING_MAX_ATTEMPTS || 8);
const RETRY_INTERVAL_MS = Number(process.env.PPU_BILLING_RETRY_INTERVAL_MS || 5 * 60 * 1000); // 5 min
const TX_CATEGORY_ID = Number(process.env.PPU_TRANSACTION_CATEGORY_ID || 0);
const VAT_RATE = Number(process.env.PPU_VAT_RATE || '0.18');

export interface BillingIntent {
  id: string;                 // unique id for dedupe/idempotency
  customer_id: number;
  service_id: number;
  gross: number;
  bundle?: string;
  payment_ref?: string;
  record_payment?: boolean;
  created_at: string;
  attempts: number;
  last_error?: string;
  status: 'pending' | 'done' | 'dead';
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readAll(): BillingIntent[] {
  ensureDir();
  if (!fs.existsSync(QUEUE_FILE)) return [];
  return fs.readFileSync(QUEUE_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean) as BillingIntent[];
}

function writeAll(items: BillingIntent[]) {
  ensureDir();
  fs.writeFileSync(QUEUE_FILE, items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''), 'utf8');
}

/** Append a failed billing intent to the queue (called from ppu.ts). */
export function enqueueBillingIntent(intent: Omit<BillingIntent, 'attempts' | 'status' | 'created_at'> & { created_at?: string }) {
  const items = readAll();
  if (items.some((i) => i.id === intent.id && i.status !== 'dead')) return; // idempotent
  items.push({
    ...intent,
    created_at: intent.created_at || new Date().toISOString(),
    attempts: 0,
    status: 'pending',
  });
  writeAll(items);
  console.warn(`[billing-retry] queued failed billing for customer ${intent.customer_id} (${intent.gross} UGX), id=${intent.id}`);
}

/** Attempt the actual Splynx finance write for one intent. */
async function attempt(intent: BillingIntent): Promise<boolean> {
  if (!TX_CATEGORY_ID) throw new Error('PPU_TRANSACTION_CATEGORY_ID not configured');
  const net = Math.round(intent.gross / (1 + VAT_RATE));
  const today = new Date().toISOString().slice(0, 10);
  const label = intent.bundle ? `PPU ${intent.bundle} pass` : 'PPU activation';

  await splynx('post', '/admin/finance/transactions', {
    customer_id: intent.customer_id,
    category: TX_CATEGORY_ID,           // Splynx field is `category` (1 = Service)
    service_id: intent.service_id,
    description: `${label} (service ${intent.service_id}) [retry]`,
    quantity: 1,
    price: net,
    tax_percent: Math.round(VAT_RATE * 100),
    total: intent.gross,
    date: today,
  });

  if (intent.record_payment) {
    await splynx('post', '/admin/finance/payments', {
      customer_id: intent.customer_id,
      payment_type: Number(process.env.PPU_PAYMENT_METHOD_ID || 5),
      amount: intent.gross,
      date: today,
      comment: intent.payment_ref ? `MoMo ${intent.payment_ref}` : `PPU ${label}`,
    });
  }
  return true;
}

async function processQueue() {
  const items = readAll();
  const pending = items.filter((i) => i.status === 'pending');
  if (!pending.length) return;

  let changed = false;
  for (const intent of pending) {
    try {
      await attempt(intent);
      intent.status = 'done';
      changed = true;
      console.log(`[billing-retry] recovered billing for customer ${intent.customer_id}, id=${intent.id}`);
    } catch (err: any) {
      intent.attempts += 1;
      intent.last_error = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      if (intent.attempts >= MAX_ATTEMPTS) {
        intent.status = 'dead';
        console.error(`[billing-retry] DEAD LETTER after ${intent.attempts} attempts — customer ${intent.customer_id} (${intent.gross} UGX), id=${intent.id}: ${intent.last_error}`);
      } else {
        console.warn(`[billing-retry] retry ${intent.attempts}/${MAX_ATTEMPTS} failed for id=${intent.id}: ${intent.last_error}`);
      }
      changed = true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  // Keep dead letters + recent done for audit; drop nothing automatically.
  if (changed) writeAll(items);
}

/** Snapshot for a health/inspection endpoint. */
export function getBillingQueueStatus() {
  const items = readAll();
  return {
    pending: items.filter((i) => i.status === 'pending').length,
    dead: items.filter((i) => i.status === 'dead').length,
    done: items.filter((i) => i.status === 'done').length,
    dead_letters: items.filter((i) => i.status === 'dead'),
  };
}

export function startBillingRetry() {
  processQueue().catch((e) => console.error('[billing-retry] initial run failed:', e.message));
  setInterval(() => {
    processQueue().catch((e) => console.error('[billing-retry] run failed:', e.message));
  }, RETRY_INTERVAL_MS);
  console.log(`[billing-retry] Started — retrying failed PPU billing every ${Math.round(RETRY_INTERVAL_MS / 60000)} min`);
}
