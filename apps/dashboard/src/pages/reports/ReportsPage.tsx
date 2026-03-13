import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getDayReport, getReportDates, DailySimEntry } from '../../api/sessions';
import { BarChart3, Wifi, WifiOff, RefreshCw, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import clsx from 'clsx';

function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function friendlyDate(dateStr: string) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-UG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export default function ReportsPage() {
  const [selectedDate, setSelectedDate] = useState(todayKey());

  const datesQuery = useQuery({
    queryKey: ['report-dates'],
    queryFn: getReportDates,
  });

  const reportQuery = useQuery({
    queryKey: ['day-report', selectedDate],
    queryFn: () => getDayReport(selectedDate),
    refetchInterval: selectedDate === todayKey() ? 60_000 : false,
  });

  const { data, isLoading, isError, refetch, isFetching } = reportQuery;
  const availableDates: string[] = datesQuery.data?.dates ?? [];
  const isToday = selectedDate === todayKey();

  const currentIdx = availableDates.indexOf(selectedDate);
  const canGoPrev = currentIdx < availableDates.length - 1;
  const canGoNext = currentIdx > 0;

  function exportCsv() {
    if (!data) return;
    const rows = [
      ['SIM Number', 'Customer', 'First Seen', 'Last Seen', 'Status', 'Peak Download', 'Peak Upload'],
      ...(data.sims ?? []).map((s) => {
        const online = isToday && Date.now() - new Date(s.last_seen).getTime() < 90_000;
        return [
          s.sim_number,
          s.customer_name ?? '',
          formatTime(s.first_seen),
          formatTime(s.last_seen),
          online ? 'Online' : 'Offline',
          formatBytes(s.peak_download_bytes),
          formatBytes(s.peak_upload_bytes),
        ];
      }),
    ];
    const csv = rows.map((r) => r.map((v) => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lte-report-${selectedDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 className="text-blue-600" size={24} />
            LTE Session Report
          </h1>
          <p className="text-gray-500 text-sm mt-1">{friendlyDate(selectedDate)}</p>
        </div>
        <div className="flex gap-2">
          {isToday && (
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-100 disabled:opacity-50"
            >
              <RefreshCw size={15} className={clsx(isFetching && 'animate-spin')} />
              Refresh
            </button>
          )}
          <button
            onClick={exportCsv}
            disabled={!data?.sims?.length}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            <Download size={15} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Date navigation */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => canGoPrev && setSelectedDate(availableDates[currentIdx + 1])}
          disabled={!canGoPrev}
          className="p-1.5 rounded-lg border border-gray-200 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={16} />
        </button>

        <div className="flex gap-2 flex-wrap">
          {availableDates.length === 0 && (
            <span className="text-sm text-gray-400">No recorded days yet</span>
          )}
          {availableDates.map((d) => (
            <button
              key={d}
              onClick={() => setSelectedDate(d)}
              className={clsx(
                'px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors',
                d === selectedDate
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'border-gray-200 text-gray-600 hover:border-blue-400 hover:text-blue-600'
              )}
            >
              {d === todayKey() ? 'Today' : d}
            </button>
          ))}
        </div>

        <button
          onClick={() => canGoNext && setSelectedDate(availableDates[currentIdx - 1])}
          disabled={!canGoNext}
          className="p-1.5 rounded-lg border border-gray-200 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-4">
          <div className="p-3 rounded-lg bg-blue-50">
            <BarChart3 className="text-blue-600" size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? '…' : data?.total ?? 0}</p>
            <p className="text-xs text-gray-500">Unique SIMs active</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-4">
          <div className="p-3 rounded-lg bg-green-50">
            <Wifi className="text-green-500" size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold">{isLoading ? '…' : data?.currently_online ?? 0}</p>
            <p className="text-xs text-gray-500">{isToday ? 'Currently online' : 'Were online (end of day)'}</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center gap-4">
          <div className="p-3 rounded-lg bg-orange-50">
            <WifiOff className="text-orange-500" size={20} />
          </div>
          <div>
            <p className="text-2xl font-bold">
              {isLoading ? '…' : (data?.total ?? 0) - (data?.currently_online ?? 0)}
            </p>
            <p className="text-xs text-gray-500">Disconnected</p>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {isLoading ? (
          <div className="py-20 text-center text-gray-400">Loading report…</div>
        ) : isError ? (
          <div className="py-20 text-center text-red-500">Failed to load report.</div>
        ) : !data?.sims?.length ? (
          <div className="py-20 text-center text-gray-400">
            {isToday
              ? 'No data yet — visit the Live Sessions tab to start tracking.'
              : `No data recorded for ${selectedDate}.`}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">#</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">SIM Number</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">First Seen</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Last Seen</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">↓ Peak DL</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">↑ Peak UL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.sims.map((sim, i) => (
                <SimReportRow key={sim.sim_number} sim={sim} index={i + 1} showLive={isToday} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data && data.sims.length > 0 && (
        <p className="text-xs text-gray-400 mt-3 text-right">
          {isToday ? 'Auto-refreshes every 60 seconds · ' : ''}
          {data.total} unique SIMs on {selectedDate}
        </p>
      )}
    </div>
  );
}

function SimReportRow({ sim, index, showLive }: { sim: DailySimEntry; index: number; showLive: boolean }) {
  const isOnline = showLive && Date.now() - new Date(sim.last_seen).getTime() < 90_000;
  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3 text-gray-400 text-xs">{index}</td>
      <td className="px-4 py-3 font-mono text-xs text-gray-800 font-medium">{sim.sim_number}</td>
      <td className="px-4 py-3 text-gray-700 text-sm">
        {sim.customer_name ?? (
          <span className="text-orange-500 text-xs bg-orange-50 px-2 py-0.5 rounded-full">Unlinked</span>
        )}
      </td>
      <td className="px-4 py-3 text-gray-500 text-xs">{formatTime(sim.first_seen)}</td>
      <td className="px-4 py-3 text-gray-500 text-xs">{formatTime(sim.last_seen)}</td>
      <td className="px-4 py-3">
        {isOnline ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Online
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
            Offline
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-green-600 text-xs">{formatBytes(sim.peak_download_bytes)}</td>
      <td className="px-4 py-3 text-blue-600 text-xs">{formatBytes(sim.peak_upload_bytes)}</td>
    </tr>
  );
}
