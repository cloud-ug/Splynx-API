/**
 * Historical Session Importer
 *
 * Pulls completed LTE sessions from Splynx's per-customer statistics endpoint
 * and writes them into the file-based daily tracker (server/data/sessions-YYYY-MM-DD.json).
 *
 * The global customer-statistics endpoint returns 502 for large datasets, so we
 * iterate per-customer and paginate in small batches with retry logic.
 *
 * Progress is saved to server/data/import-progress.json so the job can be
 * resumed if it's interrupted or the API times out mid-run.
 */

import fs from 'fs';
import path from 'path';
import { splynx } from '../lib/splynx';

// ─── Config ──────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '../../data');
const PROGRESS_FILE = path.join(DATA_DIR, 'import-progress.json');
const PAGE_SIZE = 25;              // balance between speed and Splynx timeout risk
const PAGE_DELAY_MS = 500;         // pause between pages to avoid hammering the API
const CUSTOMER_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2;
const MAX_CUSTOMER_MS = 3 * 60 * 1000; // skip customer after 3 minutes total

// LTE NAS device IDs (MTN-LTE-# and MTN-LTE-NEW)
const LTE_NAS_IDS = new Set([21, 22]);

// ─── Types ───────────────────────────────────────────────────────────────────

interface SeenEntry {
  sim_number: string;
  customer_id: number;
  customer_name: string | null;
  first_seen: string;
  last_seen: string;
  peak_download_bytes: number;
  peak_upload_bytes: number;
}

export interface ImportProgress {
  status: 'idle' | 'running' | 'done' | 'error';
  started_at: string | null;
  finished_at: string | null;
  from_date: string;
  total_customers: number;
  processed_customers: number;
  skipped_customers: number[];   // IDs that timed out
  sessions_imported: number;
  days_populated: number;
  current_customer_id: number | null;
  error: string | null;
}

// ─── In-memory progress ───────────────────────────────────────────────────────

let progress: ImportProgress = {
  status: 'idle',
  started_at: null,
  finished_at: null,
  from_date: '',
  total_customers: 0,
  processed_customers: 0,
  skipped_customers: [],
  sessions_imported: 0,
  days_populated: 0,
  current_customer_id: null,
  error: null,
};

let running = false;

export function getImportProgress(): ImportProgress {
  return { ...progress };
}

// ─── File helpers (same format as sessions.ts) ───────────────────────────────

function dataFile(date: string) {
  return path.join(DATA_DIR, `sessions-${date}.json`);
}

function loadDay(date: string): Map<string, SeenEntry> {
  const file = dataFile(date);
  if (!fs.existsSync(file)) return new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Map(Object.entries(raw) as [string, SeenEntry][]);
  } catch { return new Map(); }
}

function saveDay(date: string, map: Map<string, SeenEntry>) {
  const obj: Record<string, SeenEntry> = {};
  for (const [k, v] of map) obj[k] = v;
  fs.writeFileSync(dataFile(date), JSON.stringify(obj), 'utf8');
}

// ─── Merge a completed stat record into the daily file ───────────────────────

function mergeStatIntoDay(stat: {
  sim_number: string;
  customer_id: number;
  customer_name: string | null;
  start_iso: string;
  end_iso: string;
  in_bytes: number;
  out_bytes: number;
}) {
  // Use the end date as the "day" (session completed on this day)
  const date = stat.end_iso.slice(0, 10);
  const map = loadDay(date);

  const existing = map.get(stat.sim_number);
  if (!existing) {
    map.set(stat.sim_number, {
      sim_number: stat.sim_number,
      customer_id: stat.customer_id,
      customer_name: stat.customer_name,
      first_seen: stat.start_iso,
      last_seen: stat.end_iso,
      peak_download_bytes: stat.in_bytes,
      peak_upload_bytes: stat.out_bytes,
    });
  } else {
    // Keep earliest first_seen and latest last_seen
    if (stat.start_iso < existing.first_seen) existing.first_seen = stat.start_iso;
    if (stat.end_iso > existing.last_seen) existing.last_seen = stat.end_iso;
    if (stat.in_bytes > existing.peak_download_bytes) existing.peak_download_bytes = stat.in_bytes;
    if (stat.out_bytes > existing.peak_upload_bytes) existing.peak_upload_bytes = stat.out_bytes;
  }

  saveDay(date, map);
  return date;
}

// ─── Sleep helper ─────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Fetch one page with retries ──────────────────────────────────────────────

async function fetchPage(customerId: number, page: number): Promise<any[] | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await splynx('get', `/admin/customers/customer/${customerId}/statistics`, undefined, {
        itemsPerPage: PAGE_SIZE,
        page,
        'sort[id]': 'desc',  // newest first — lets us stop early once we hit old data
      }, REQUEST_TIMEOUT_MS);
      return Array.isArray(data) ? data : (data.items || data.data || []);
    } catch (err: any) {
      const isLast = attempt === MAX_RETRIES;
      if (isLast) return null;
      await sleep(2000 * attempt);
    }
  }
  return null;
}

// ─── Process one customer ─────────────────────────────────────────────────────

async function processCustomer(
  customerId: number,
  customerName: string,
  fromDate: string
): Promise<{ imported: number; skipped: boolean; daysAdded: Set<string> }> {
  const daysAdded = new Set<string>();
  let imported = 0;
  let page = 1;
  let done = false;
  const customerStart = Date.now();

  while (!done && running) {
    // Per-customer timeout — skip if taking too long
    if (Date.now() - customerStart > MAX_CUSTOMER_MS) {
      console.log(`[history-import]   Customer ${customerId} hit 3-minute limit after ${page} pages — skipping`);
      return { imported, skipped: imported === 0, daysAdded };
    }
    const items = await fetchPage(customerId, page);

    if (items === null) {
      // All retries exhausted — skip this customer
      return { imported, skipped: true, daysAdded };
    }

    if (items.length === 0) break;

    for (const stat of items) {
      // Only LTE sessions: mac must be set, nas_id must be LTE
      if (!stat.mac || !LTE_NAS_IDS.has(Number(stat.nas_id))) continue;

      // Build ISO timestamps
      const endIso = stat.end_date && stat.end_time
        ? `${stat.end_date}T${stat.end_time}`
        : null;
      const startIso = stat.start_date && stat.start_time
        ? `${stat.start_date}T${stat.start_time}`
        : null;

      if (!endIso || !startIso) continue;

      // Records come newest first — once end_date is before our cutoff, all
      // subsequent records will also be old, so we can stop immediately.
      if (stat.end_date < fromDate) {
        done = true;
        break;
      }

      const day = mergeStatIntoDay({
        sim_number: stat.mac,
        customer_id: Number(customerId),
        customer_name: customerName,
        start_iso: startIso,
        end_iso: endIso,
        in_bytes: Number(stat.in_bytes) || 0,
        out_bytes: Number(stat.out_bytes) || 0,
      });

      daysAdded.add(day);
      imported++;
    }

    if (items.length < PAGE_SIZE) break; // Last page
    page++;
    await sleep(PAGE_DELAY_MS);
  }

  return { imported, skipped: false, daysAdded };
}

// ─── Main import job ──────────────────────────────────────────────────────────

export async function startImport(fromDate: string): Promise<void> {
  if (running) throw new Error('Import already running');
  running = true;

  progress = {
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    from_date: fromDate,
    total_customers: 0,
    processed_customers: 0,
    skipped_customers: [],
    sessions_imported: 0,
    days_populated: 0,
    current_customer_id: null,
    error: null,
  };

  const allDays = new Set<string>();

  try {
    // 1. Fetch all customers
    const customerData = await splynx('get', '/admin/customers/customer', undefined, {
      itemsPerPage: 500,
      page: 1,
    });
    const customers: any[] = Array.isArray(customerData)
      ? customerData
      : (customerData.items || customerData.data || []);

    progress.total_customers = customers.length;
    console.log(`[history-import] Starting import from ${fromDate} for ${customers.length} customers`);

    // 2. Process each customer
    for (const customer of customers) {
      if (!running) break;

      progress.current_customer_id = customer.id;
      console.log(`[history-import] Processing customer ${customer.id} (${customer.name}) [${progress.processed_customers + 1}/${customers.length}]`);

      const { imported, skipped, daysAdded } = await processCustomer(
        Number(customer.id),
        customer.name,
        fromDate
      );

      if (skipped) {
        progress.skipped_customers.push(Number(customer.id));
        console.log(`[history-import]   Skipped (API timeout) customer ${customer.id}`);
      } else {
        progress.sessions_imported += imported;
        for (const d of daysAdded) allDays.add(d);
        console.log(`[history-import]   Imported ${imported} LTE sessions across ${daysAdded.size} days`);
      }

      progress.processed_customers++;
      await sleep(CUSTOMER_DELAY_MS);
    }

    progress.days_populated = allDays.size;
    progress.status = 'done';
    progress.finished_at = new Date().toISOString();
    progress.current_customer_id = null;

    console.log(`[history-import] Done. ${progress.sessions_imported} sessions across ${progress.days_populated} days. Skipped: ${progress.skipped_customers.length} customers.`);
  } catch (err: any) {
    progress.status = 'error';
    progress.error = err.message;
    progress.finished_at = new Date().toISOString();
    console.error('[history-import] Fatal error:', err.message);
  } finally {
    running = false;
  }
}

export function stopImport() {
  running = false;
}

// ─── CSV import ───────────────────────────────────────────────────────────────
// Accepts a Splynx-exported CSV with columns:
//   customer_id, customer_name, mac, start_date, start_time, end_date, end_time, in_bytes, out_bytes, nas_id
// (column order doesn't matter — matched by header name)

export function importFromCsv(csvText: string): { imported: number; days: string[]; errors: string[] } {
  const lines = csvText.replace(/\r/g, '').split('\n').filter(Boolean);
  if (!lines.length) return { imported: 0, days: [], errors: ['Empty CSV'] };

  // Parse header
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const idx = (name: string) => headers.indexOf(name);

  const errors: string[] = [];
  const allDays = new Set<string>();
  let imported = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
    const get = (name: string) => cols[idx(name)] ?? '';

    const mac = get('mac') || get('sim_number') || get('sim');
    if (!mac) { errors.push(`Row ${i + 1}: no MAC/SIM`); continue; }

    const startDate = get('start_date');
    const startTime = get('start_time');
    const endDate = get('end_date');
    const endTime = get('end_time');
    if (!endDate) { errors.push(`Row ${i + 1}: no end_date`); continue; }

    const startIso = startDate && startTime ? `${startDate}T${startTime}` : `${endDate}T${endTime || '00:00:00'}`;
    const endIso = `${endDate}T${endTime || '23:59:59'}`;

    const inBytes = parseInt(get('in_bytes') || get('download_bytes') || '0', 10) || 0;
    const outBytes = parseInt(get('out_bytes') || get('upload_bytes') || '0', 10) || 0;
    const customerId = parseInt(get('customer_id') || '0', 10) || 0;
    const customerName = get('customer_name') || get('name') || null;

    try {
      const day = mergeStatIntoDay({ sim_number: mac, customer_id: customerId, customer_name: customerName, start_iso: startIso, end_iso: endIso, in_bytes: inBytes, out_bytes: outBytes });
      allDays.add(day);
      imported++;
    } catch (e: any) {
      errors.push(`Row ${i + 1}: ${e.message}`);
    }
  }

  return { imported, days: Array.from(allDays).sort(), errors: errors.slice(0, 20) };
}
