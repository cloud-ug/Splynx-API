import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Settings, Upload, Play, Square, RefreshCw, CheckCircle, AlertCircle, Clock, FileText } from 'lucide-react';
import clsx from 'clsx';
import api from '../../api/client';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ImportProgress {
  status: 'idle' | 'running' | 'done' | 'error';
  started_at: string | null;
  finished_at: string | null;
  from_date: string;
  total_customers: number;
  processed_customers: number;
  skipped_customers: number[];
  sessions_imported: number;
  days_populated: number;
  current_customer_id: number | null;
  error: string | null;
}

interface AccountingHealth {
  ok: boolean;
  checked_at: string | null;
  latest_stat_at: string | null;
  hours_since_last_stat: number | null;
  message: string;
}

// ─── API calls ────────────────────────────────────────────────────────────────

async function getImportStatus(): Promise<ImportProgress> {
  const r = await api.get('/import/status');
  return r.data;
}

async function startImport(fromDate: string) {
  const r = await api.post('/import/start', { from_date: fromDate });
  return r.data;
}

async function stopImport() {
  const r = await api.post('/import/stop');
  return r.data;
}

async function getAccountingHealth(): Promise<AccountingHealth> {
  const r = await api.get('/health/accounting');
  return r.data;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [fromDate, setFromDate] = useState('2025-01-01');
  const [csvResult, setCsvResult] = useState<{ imported: number; days_populated: number; errors: string[] } | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const statusQuery = useQuery({
    queryKey: ['import-status'],
    queryFn: getImportStatus,
    refetchInterval: (q) => q.state.data?.status === 'running' ? 3000 : false,
  });

  const healthQuery = useQuery({
    queryKey: ['accounting-health'],
    queryFn: getAccountingHealth,
  });

  const startMut = useMutation({
    mutationFn: () => startImport(fromDate),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['import-status'] }),
  });

  const stopMut = useMutation({
    mutationFn: stopImport,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['import-status'] }),
  });

  const prog = statusQuery.data;
  const isRunning = prog?.status === 'running';
  const pct = prog && prog.total_customers > 0
    ? Math.round((prog.processed_customers / prog.total_customers) * 100)
    : 0;

  async function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvResult(null);
    setCsvError(null);
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await api.post('/import/csv', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setCsvResult(r.data);
      // Refresh the report dates so the new days show up
      qc.invalidateQueries({ queryKey: ['report-dates'] });
    } catch (err: any) {
      setCsvError(err.response?.data?.error || err.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold flex items-center gap-2 mb-6">
        <Settings className="text-blue-600" size={24} />
        Settings
      </h1>

      {/* ── RADIUS Health ─────────────────────────────────────────────────── */}
      <Section title="RADIUS Accounting Health">
        {healthQuery.isLoading ? (
          <p className="text-sm text-gray-400">Checking…</p>
        ) : healthQuery.data ? (
          <div className={clsx(
            'flex items-start gap-3 p-4 rounded-lg border',
            healthQuery.data.ok
              ? 'bg-green-50 border-green-200'
              : 'bg-red-50 border-red-200'
          )}>
            {healthQuery.data.ok
              ? <CheckCircle className="text-green-600 flex-shrink-0 mt-0.5" size={18} />
              : <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={18} />
            }
            <div className="text-sm">
              <p className={clsx('font-medium', healthQuery.data.ok ? 'text-green-800' : 'text-red-800')}>
                {healthQuery.data.message}
              </p>
              {healthQuery.data.checked_at && (
                <p className="text-gray-500 text-xs mt-1">
                  Last checked: {new Date(healthQuery.data.checked_at).toLocaleString()}
                  {healthQuery.data.latest_stat_at && ` · Last stat: ${healthQuery.data.latest_stat_at}`}
                </p>
              )}
            </div>
          </div>
        ) : null}
        <p className="text-xs text-gray-400 mt-2">
          Checked automatically every hour. Email alert sent to brian@cloudcoresystems.com if accounting stops.
        </p>
      </Section>

      {/* ── API-based History Import ───────────────────────────────────────── */}
      <Section title="Import Historical Sessions (from Splynx API)">
        <p className="text-sm text-gray-600 mb-4">
          Pulls completed LTE sessions from Splynx for all customers and populates the Reports page
          with historical data. Runs in the background — you can navigate away.
        </p>

        <div className="flex items-end gap-3 mb-4">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Import from date</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              disabled={isRunning}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            />
          </div>
          {!isRunning ? (
            <button
              onClick={() => startMut.mutate()}
              disabled={startMut.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              <Play size={14} />
              Start Import
            </button>
          ) : (
            <button
              onClick={() => stopMut.mutate()}
              className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700"
            >
              <Square size={14} />
              Stop
            </button>
          )}
          <button
            onClick={() => qc.invalidateQueries({ queryKey: ['import-status'] })}
            className="p-2 text-gray-400 hover:text-gray-600 border border-gray-200 rounded-lg"
          >
            <RefreshCw size={14} />
          </button>
        </div>

        {/* Progress */}
        {prog && prog.status !== 'idle' && (
          <div className="bg-gray-50 rounded-lg border border-gray-200 p-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 font-medium">
                <StatusDot status={prog.status} />
                {prog.status === 'running' ? 'Running…' :
                  prog.status === 'done' ? 'Complete' :
                  prog.status === 'error' ? 'Error' : prog.status}
              </span>
              {prog.status === 'running' && (
                <span className="text-gray-500 text-xs">
                  Customer {prog.processed_customers}/{prog.total_customers}
                  {prog.current_customer_id && ` (ID: ${prog.current_customer_id})`}
                </span>
              )}
            </div>

            {prog.status === 'running' && (
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}

            <div className="grid grid-cols-3 gap-3 text-center">
              <Stat label="Sessions imported" value={prog.sessions_imported.toLocaleString()} />
              <Stat label="Days populated" value={prog.days_populated.toLocaleString()} />
              <Stat label="Customers skipped" value={prog.skipped_customers.length.toString()}
                    note={prog.skipped_customers.length > 0 ? '(API timeout)' : undefined} />
            </div>

            {prog.status === 'error' && prog.error && (
              <p className="text-red-600 text-xs bg-red-50 rounded p-2">{prog.error}</p>
            )}
            {prog.status === 'done' && (
              <p className="text-green-700 text-xs">
                Finished at {prog.finished_at ? new Date(prog.finished_at).toLocaleString() : '—'}.
                {prog.skipped_customers.length > 0 && ` ${prog.skipped_customers.length} customers timed out — retry to get their data.`}
              </p>
            )}
          </div>
        )}

        {startMut.isError && (
          <p className="text-red-500 text-xs mt-2">{(startMut.error as any)?.response?.data?.error || 'Failed to start'}</p>
        )}
      </Section>

      {/* ── CSV Import ────────────────────────────────────────────────────── */}
      <Section title="Import from CSV (Splynx Export)">
        <p className="text-sm text-gray-600 mb-3">
          If the API import is unavailable, export session history from the Splynx admin panel
          and upload it here.
        </p>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800 mb-4">
          <p className="font-medium mb-1">How to export from Splynx:</p>
          <ol className="list-decimal list-inside space-y-0.5 text-blue-700">
            <li>Go to Splynx → Reports → Customer statistics (or Internet sessions)</li>
            <li>Filter by NAS: MTN-LTE-# and MTN-LTE-NEW</li>
            <li>Set date range (e.g. 2025-01-01 to today)</li>
            <li>Click Export → CSV</li>
            <li>Upload the CSV file here</li>
          </ol>
          <p className="mt-2">Required columns: <code>mac</code>, <code>end_date</code>, <code>end_time</code>, <code>start_date</code>, <code>start_time</code>, <code>in_bytes</code>, <code>out_bytes</code>, <code>customer_id</code>, <code>customer_name</code></p>
        </div>

        <div className="flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleCsvUpload}
            disabled={uploading}
            className="hidden"
          />
          <button
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            {uploading ? <RefreshCw size={14} className="animate-spin" /> : <Upload size={14} />}
            {uploading ? 'Uploading…' : 'Choose CSV file'}
          </button>
          <span className="text-xs text-gray-400">Max 50 MB</span>
        </div>

        {csvResult && (
          <div className="mt-3 bg-green-50 border border-green-200 rounded-lg p-3 text-sm">
            <p className="text-green-800 font-medium flex items-center gap-1">
              <CheckCircle size={14} /> Import complete
            </p>
            <p className="text-green-700 text-xs mt-1">
              {csvResult.imported.toLocaleString()} sessions imported across {csvResult.days_populated} days.
            </p>
            {csvResult.errors.length > 0 && (
              <p className="text-orange-600 text-xs mt-1">{csvResult.errors.length} row errors (first few: {csvResult.errors.slice(0, 3).join('; ')})</p>
            )}
          </div>
        )}
        {csvError && (
          <p className="mt-2 text-red-500 text-xs">{csvError}</p>
        )}
      </Section>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-3 flex items-center gap-2">
        <span className="w-4 h-px bg-gray-300 inline-block" />
        {title}
      </h2>
      {children}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-100 p-3">
      <p className="text-xl font-bold">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
      {note && <p className="text-xs text-orange-500">{note}</p>}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  return (
    <span className={clsx('w-2 h-2 rounded-full inline-block', {
      'bg-blue-500 animate-pulse': status === 'running',
      'bg-green-500': status === 'done',
      'bg-red-500': status === 'error',
      'bg-gray-400': status === 'idle',
    })} />
  );
}
