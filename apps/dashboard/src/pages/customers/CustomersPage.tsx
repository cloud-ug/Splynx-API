import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, Search, RefreshCw, Wifi, WifiOff, Download } from 'lucide-react';
import clsx from 'clsx';
import api from '../../api/client';

interface CustomerSummary {
  customer_id: number;
  customer_name: string;
  sim_number: string | null;
  is_online: boolean;
  last_seen: string | null;
  download_bytes: number;
  upload_bytes: number;
  ip: string | null;
  router_name: string | null;
}

interface LteSummaryResponse {
  total: number;
  online: number;
  customers: CustomerSummary[];
}

async function getLteSummary(): Promise<LteSummaryResponse> {
  const r = await api.get('/customers/lte-summary');
  return r.data;
}

function formatBytes(bytes: number) {
  if (!bytes) return '—';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatLastSeen(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T'));
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (mins < 2) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function CustomersPage() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'offline' | 'no-sim'>('all');

  const query = useQuery({
    queryKey: ['lte-summary'],
    queryFn: getLteSummary,
    refetchInterval: 60_000,
  });

  const { data, isLoading, isError, refetch, isFetching } = query;

  const filtered = (data?.customers ?? []).filter(c => {
    if (filter === 'online' && !c.is_online) return false;
    if (filter === 'offline' && (c.is_online || !c.sim_number)) return false;
    if (filter === 'no-sim' && c.sim_number) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        c.customer_name.toLowerCase().includes(q) ||
        (c.sim_number?.toLowerCase().includes(q) ?? false) ||
        (c.ip?.toLowerCase().includes(q) ?? false)
      );
    }
    return true;
  });

  function exportCsv() {
    if (!data) return;
    const rows = [
      ['Customer', 'SIM Number', 'Status', 'Last Seen', 'IP', 'Router', 'Peak Download', 'Peak Upload'],
      ...filtered.map(c => [
        c.customer_name,
        c.sim_number ?? '',
        c.is_online ? 'Online' : 'Offline',
        c.last_seen ?? '',
        c.ip ?? '',
        c.router_name ?? '',
        formatBytes(c.download_bytes),
        formatBytes(c.upload_bytes),
      ]),
    ];
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lte-customers-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const onlineCount = data?.online ?? 0;
  const totalCount = data?.total ?? 0;
  const noSimCount = (data?.customers ?? []).filter(c => !c.sim_number).length;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="text-blue-600" size={24} />
            LTE Customers
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Each customer's most recent SIM and connection status
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-100 disabled:opacity-50"
          >
            <RefreshCw size={15} className={clsx(isFetching && 'animate-spin')} />
            Refresh
          </button>
          <button
            onClick={exportCsv}
            disabled={!data}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <Download size={15} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-4">
          <div className="p-3 rounded-lg bg-blue-50">
            <Users className="text-blue-600" size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? '…' : totalCount}</p>
            <p className="text-xs text-gray-500">Total customers</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-4">
          <div className="p-3 rounded-lg bg-green-50">
            <Wifi className="text-green-500" size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? '…' : onlineCount}</p>
            <p className="text-xs text-gray-500">Currently online</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-4">
          <div className="p-3 rounded-lg bg-orange-50">
            <WifiOff className="text-orange-500" size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? '…' : noSimCount}</p>
            <p className="text-xs text-gray-500">No SIM recorded</p>
          </div>
        </div>
      </div>

      {/* Filters + Search */}
      <div className="flex gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
          <input
            type="text"
            placeholder="Search by name, SIM number, or IP…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {(['all', 'online', 'offline', 'no-sim'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={clsx(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                filter === f
                  ? 'bg-white text-gray-800 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              )}
            >
              {f === 'no-sim' ? 'No SIM' : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="py-20 text-center text-gray-400">Loading customers…</div>
        ) : isError ? (
          <div className="py-20 text-center text-red-500">Failed to load customers.</div>
        ) : filtered.length === 0 ? (
          <div className="py-20 text-center text-gray-400">No customers match your filter.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">#</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">SIM Number</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Last Seen</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">IP</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">↓ Peak DL</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">↑ Peak UL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((c, i) => (
                <tr key={c.customer_id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 text-gray-400 text-xs">{i + 1}</td>
                  <td className="px-4 py-3 font-medium text-gray-800 text-sm">{c.customer_name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">
                    {c.sim_number ?? (
                      <span className="text-gray-400 italic">No SIM recorded</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {c.sim_number ? (
                      c.is_online ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                          Online
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
                          Offline
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{formatLastSeen(c.last_seen)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{c.ip ?? '—'}</td>
                  <td className="px-4 py-3 text-green-600 text-xs">{formatBytes(c.download_bytes)}</td>
                  <td className="px-4 py-3 text-blue-600 text-xs">{formatBytes(c.upload_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!isLoading && !isError && (
        <p className="text-xs text-gray-400 mt-3 text-right">
          Auto-refreshes every 60 seconds · Showing {filtered.length} of {totalCount} customers
        </p>
      )}
    </div>
  );
}
