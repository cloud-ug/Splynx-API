import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, Search, RefreshCw, Wifi, WifiOff, Download } from 'lucide-react';
import clsx from 'clsx';
import api from '../../api/client';

interface ServiceRow {
  customer_id: number;
  customer_name: string;
  service_id: number;
  service_login: string;
  description: string;
  status: 'online' | 'active' | 'offline';
  sim_number: string | null;
  last_seen: string | null;
  ip: string | null;
  router_name: string | null;
  download_bytes: number;
  upload_bytes: number;
}

interface LteSummaryResponse {
  total: number;
  online: number;
  active: number;
  services: ServiceRow[];
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
  const diff = Date.now() - d.getTime();
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
  const [filter, setFilter] = useState<'all' | 'online' | 'active' | 'offline'>('all');

  const query = useQuery({
    queryKey: ['lte-summary'],
    queryFn: getLteSummary,
    refetchInterval: 60_000,
  });

  const { data, isLoading, isError, refetch, isFetching } = query;

  const filtered = (data?.services ?? []).filter(s => {
    if (filter !== 'all' && s.status !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        s.customer_name.toLowerCase().includes(q) ||
        s.service_login.toLowerCase().includes(q) ||
        (s.sim_number?.toLowerCase().includes(q) ?? false) ||
        (s.ip?.toLowerCase().includes(q) ?? false) ||
        (s.description?.toLowerCase().includes(q) ?? false)
      );
    }
    return true;
  });

  function exportCsv() {
    if (!data) return;
    const rows = [
      ['Customer', 'Service ID', 'Login', 'Description', 'SIM Number', 'Status', 'Last Seen', 'IP', 'Peak Download', 'Peak Upload'],
      ...filtered.map(s => [
        s.customer_name, String(s.service_id), s.service_login, s.description,
        s.sim_number ?? '', s.status, s.last_seen ?? '',
        s.ip ?? '', formatBytes(s.download_bytes), formatBytes(s.upload_bytes),
      ]),
    ];
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lte-services-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="text-blue-600" size={24} />
            LTE Services
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Each Cloud-LTE service with its most recent SIM and session status
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => refetch()} disabled={isFetching}
            className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-100 disabled:opacity-50">
            <RefreshCw size={15} className={clsx(isFetching && 'animate-spin')} />
            Refresh
          </button>
          <button onClick={exportCsv} disabled={!data}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            <Download size={15} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Total services" value={isLoading ? '…' : String(data?.total ?? 0)} color="blue" icon={<Users size={20} className="text-blue-600" />} />
        <StatCard label="Online now" value={isLoading ? '…' : String(data?.online ?? 0)} color="green" icon={<Wifi size={20} className="text-green-500" />} />
        <StatCard label="Active (not connected)" value={isLoading ? '…' : String(data?.active ?? 0)} color="yellow" icon={<Wifi size={20} className="text-yellow-500" />} />
        <StatCard label="Offline" value={isLoading ? '…' : String((data?.total ?? 0) - (data?.online ?? 0) - (data?.active ?? 0))} color="gray" icon={<WifiOff size={20} className="text-gray-400" />} />
      </div>

      {/* Filters + Search */}
      <div className="flex gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
          <input type="text" placeholder="Search by customer, login, SIM, or IP…"
            value={search} onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
          {(['all', 'online', 'active', 'offline'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={clsx('px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                filter === f ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500 hover:text-gray-700')}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="py-20 text-center text-gray-400">Loading services…</div>
        ) : isError ? (
          <div className="py-20 text-center text-red-500">Failed to load. Check server.</div>
        ) : filtered.length === 0 ? (
          <div className="py-20 text-center text-gray-400">No services match your filter.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Login</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">SIM Number</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Last Seen</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">IP</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">↓ Peak DL</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">↑ Peak UL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map(s => (
                <tr key={s.service_id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-800 text-sm">{s.customer_name}</p>
                    <p className="text-gray-400 text-xs">{s.description}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{s.service_login}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">
                    {s.sim_number ?? <span className="text-gray-400 italic">No SIM</span>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{formatLastSeen(s.last_seen)}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{s.ip ?? '—'}</td>
                  <td className="px-4 py-3 text-green-600 text-xs">{formatBytes(s.download_bytes)}</td>
                  <td className="px-4 py-3 text-blue-600 text-xs">{formatBytes(s.upload_bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!isLoading && !isError && (
        <p className="text-xs text-gray-400 mt-3 text-right">
          Auto-refreshes every 60 seconds · Showing {filtered.length} of {data?.total ?? 0} services
        </p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: 'online' | 'active' | 'offline' }) {
  if (status === 'online') return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
      Online
    </span>
  );
  if (status === 'active') return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-yellow-700 bg-yellow-50 px-2 py-0.5 rounded-full">
      <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
      Active
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
      <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
      Offline
    </span>
  );
}

function StatCard({ label, value, color, icon }: { label: string; value: string; color: string; icon: React.ReactNode }) {
  const bg: Record<string, string> = { blue: 'bg-blue-50', green: 'bg-green-50', yellow: 'bg-yellow-50', gray: 'bg-gray-50' };
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-4">
      <div className={clsx('p-3 rounded-lg', bg[color])}>{icon}</div>
      <div>
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  );
}
