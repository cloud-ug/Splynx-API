import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getActiveLteSims, getRecentLteSims, SimSession } from '../../api/sessions';
import { Radio, RefreshCw, Download, Search, Wifi, WifiOff, Clock } from 'lucide-react';
import clsx from 'clsx';

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDuration(started: string) {
  // Splynx returns "YYYY-MM-DD HH:MM:SS" — replace space with T for reliable parsing
  const diff = Date.now() - new Date(started.replace(' ', 'T')).getTime();
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

type Tab = 'live' | 'recent';

export default function LteSessionsPage() {
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Tab>('live');

  const liveQuery = useQuery({
    queryKey: ['lte-sims'],
    queryFn: getActiveLteSims,
    refetchInterval: 60_000,
  });

  const recentQuery = useQuery({
    queryKey: ['lte-sims-recent'],
    queryFn: getRecentLteSims,
    refetchInterval: 60_000,
    enabled: tab === 'recent',
  });

  const { data, isLoading, isError, refetch, isFetching } =
    tab === 'live' ? liveQuery : recentQuery;

  const filtered = (data?.sims ?? []).filter((s) => {
    const q = search.toLowerCase();
    return (
      s.sim_number.toLowerCase().includes(q) ||
      (s.customer_name?.toLowerCase().includes(q) ?? false) ||
      (s.ip?.toLowerCase().includes(q) ?? false)
    );
  });

  function exportCsv() {
    const rows = [
      ['SIM Number', 'Customer', 'IP Address', 'Router', 'Session Started', 'Download', 'Upload'],
      ...filtered.map((s) => [
        s.sim_number,
        s.customer_name ?? '',
        s.ip,
        s.router_name ?? s.router_id,
        s.started,
        formatBytes(s.download_bytes),
        formatBytes(s.upload_bytes),
      ]),
    ];
    const csv = rows.map((r) => r.map((v) => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `active-lte-sims-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Radio className="text-blue-600" size={24} />
            Active LTE Sessions
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Live view of all currently connected SIM numbers
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
            className="flex items-center gap-2 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Download size={15} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-gray-200">
        <button
          onClick={() => setTab('live')}
          className={clsx(
            'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            tab === 'live'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          )}
        >
          <Wifi size={15} />
          Live Sessions
        </button>
        <button
          onClick={() => setTab('recent')}
          className={clsx(
            'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            tab === 'recent'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          )}
        >
          <Clock size={15} />
          Last 24 Hours
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard
          label="Active SIMs"
          value={isLoading ? '…' : String(data?.total ?? 0)}
          icon={<Wifi className="text-green-500" size={20} />}
          color="green"
        />
        <StatCard
          label="With Customer"
          value={
            isLoading
              ? '…'
              : String((data?.sims ?? []).filter((s) => s.customer_name).length)
          }
          icon={<Wifi className="text-blue-500" size={20} />}
          color="blue"
        />
        <StatCard
          label="Unidentified"
          value={
            isLoading
              ? '…'
              : String((data?.sims ?? []).filter((s) => !s.customer_name).length)
          }
          icon={<WifiOff className="text-orange-500" size={20} />}
          color="orange"
        />
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
        <input
          type="text"
          placeholder="Search by SIM number, customer name, or IP…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="py-20 text-center text-gray-400">Loading sessions…</div>
        ) : isError ? (
          <div className="py-20 text-center text-red-500">
            Failed to load sessions. Check your Splynx credentials.
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-20 text-center text-gray-400">
            {search ? 'No results match your search.' : 'No active sessions found.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">#</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">SIM / MAC</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">IP Address</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Router</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Duration</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">↓ Download</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">↑ Upload</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((sim, i) => (
                <SimRow key={sim.sim_number} sim={sim} index={i + 1} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!isLoading && !isError && (
        <p className="text-xs text-gray-400 mt-3 text-right">
          Auto-refreshes every 60 seconds ·{' '}
          {tab === 'recent' ? 'Sessions started in the last 24h · ' : ''}
          Showing {filtered.length} of {data?.total ?? 0} SIMs
        </p>
      )}
    </div>
  );
}

function SimRow({ sim, index }: { sim: SimSession; index: number }) {
  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3 text-gray-400 text-xs">{index}</td>
      <td className="px-4 py-3 font-mono text-xs text-gray-800 font-medium">
        {sim.sim_number}
      </td>
      <td className="px-4 py-3">
        {sim.customer_name ? (
          <span className="text-gray-800">{sim.customer_name}</span>
        ) : (
          <span className="text-orange-500 text-xs bg-orange-50 px-2 py-0.5 rounded-full">
            Unlinked
          </span>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-gray-600">{sim.ip || '—'}</td>
      <td className="px-4 py-3 text-gray-600 text-xs">{sim.router_name || sim.router_id || '—'}</td>
      <td className="px-4 py-3 text-gray-600 text-xs">{formatDuration(sim.started)}</td>
      <td className="px-4 py-3 text-green-600 text-xs">{formatBytes(sim.download_bytes)}</td>
      <td className="px-4 py-3 text-blue-600 text-xs">{formatBytes(sim.upload_bytes)}</td>
    </tr>
  );
}

function StatCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  color: 'green' | 'blue' | 'orange';
}) {
  const bg = { green: 'bg-green-50', blue: 'bg-blue-50', orange: 'bg-orange-50' }[color];
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-4">
      <div className={clsx('p-3 rounded-lg', bg)}>{icon}</div>
      <div>
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  );
}
