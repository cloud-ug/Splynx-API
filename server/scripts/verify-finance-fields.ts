/**
 * verify-finance-fields.ts — confirm Splynx finance field names before billing.
 *
 * routes/ppu.ts writes transactions/payments using assumed v2.0 field names
 * (category_id, price, tax_percent, amount, comment, date). Splynx renames
 * these between releases, so RUN THIS against your live instance first and
 * reconcile any mismatches before setting PPU_BILLING_ENABLED=true.
 *
 * Read-only: it only GETs categories + one sample transaction/payment and
 * prints the keys actually present. It creates nothing.
 *
 * Run from server/:
 *   npx ts-node scripts/verify-finance-fields.ts
 */

import 'dotenv/config';
import { splynx } from '../src/lib/splynx';

const want = {
  transaction: ['customer_id', 'category_id', 'service_id', 'description', 'quantity', 'price', 'tax_percent', 'date'],
  payment: ['customer_id', 'amount', 'date', 'comment'],
};

function asArray(d: any): any[] {
  return Array.isArray(d) ? d : (d?.items || d?.data || []);
}

function report(label: string, sample: any, expected: string[]) {
  console.log(`\n── ${label} ──`);
  if (!sample) { console.log('  (no sample record found — create one in Splynx UI then re-run)'); return; }
  const keys = Object.keys(sample);
  console.log('  fields present:', keys.join(', '));
  for (const f of expected) {
    console.log(`   ${keys.includes(f) ? '✓' : '✗ MISSING'}  ${f}`);
  }
}

async function main() {
  console.log('Probing Splynx finance API (read-only)…');

  try {
    const cats = asArray(await splynx('get', '/admin/finance/transaction-categories'));
    console.log('\n── transaction categories (pick the id for PPU_TRANSACTION_CATEGORY_ID) ──');
    for (const c of cats) console.log(`   id=${c.id}  name=${c.name ?? c.title ?? '(unnamed)'}`);
  } catch (e: any) {
    console.log('\n!! could not list transaction-categories:', e.response?.status, e.message);
  }

  try {
    const tx = asArray(await splynx('get', '/admin/finance/transactions', undefined, { itemsPerPage: 1, 'sort[id]': 'desc' }));
    report('transaction sample (vs fields ppu.ts sends)', tx[0], want.transaction);
  } catch (e: any) {
    console.log('\n!! could not read transactions:', e.response?.status, e.message);
  }

  try {
    const pay = asArray(await splynx('get', '/admin/finance/payments', undefined, { itemsPerPage: 1, 'sort[id]': 'desc' }));
    report('payment sample (vs fields ppu.ts sends)', pay[0], want.payment);
  } catch (e: any) {
    console.log('\n!! could not read payments:', e.response?.status, e.message);
  }

  console.log('\nDone. Reconcile any ✗ MISSING fields in routes/ppu.ts + services/billingRetry.ts before enabling billing.');
}

main().catch((e) => { console.error(e); process.exit(1); });
