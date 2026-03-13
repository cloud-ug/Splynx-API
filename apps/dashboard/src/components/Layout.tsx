import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Wifi, Users, BarChart2, Settings, Radio, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import api from '../api/client';

async function getAccountingHealth() {
  const res = await api.get('/health/accounting');
  return res.data as {
    ok: boolean;
    checked_at: string | null;
    latest_stat_at: string | null;
    hours_since_last_stat: number | null;
    message: string;
  };
}

const nav = [
  { to: '/sessions', icon: Radio, label: 'LTE Sessions' },
  { to: '/customers', icon: Users, label: 'Customers' },
  { to: '/reports', icon: BarChart2, label: 'Reports' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Layout() {
  const healthQuery = useQuery({
    queryKey: ['accounting-health'],
    queryFn: getAccountingHealth,
    refetchInterval: 60 * 60 * 1000,
    staleTime: 55 * 60 * 1000,
  });

  const accountingDown = healthQuery.data && !healthQuery.data.ok;

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-900 text-white flex flex-col flex-shrink-0">
        <div className="px-5 py-5 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <Wifi className="text-blue-400" size={22} />
            <span className="font-bold text-sm leading-tight">
              CloudCore<br />
              <span className="text-gray-400 font-normal text-xs">ISP Dashboard</span>
            </span>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {nav.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors',
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                )
              }
            >
              <Icon size={17} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-gray-700 text-xs text-gray-500 text-center">
          Powered by Splynx
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto flex flex-col">
        {accountingDown && (
          <div className="bg-red-600 text-white px-4 py-2.5 flex items-center gap-3 text-sm flex-shrink-0">
            <AlertTriangle size={16} className="flex-shrink-0" />
            <span className="font-medium">RADIUS Accounting Alert:</span>
            <span>{healthQuery.data?.message}</span>
            {healthQuery.data?.latest_stat_at && (
              <span className="ml-auto text-red-200 text-xs whitespace-nowrap">
                Last stat: {healthQuery.data.latest_stat_at}
              </span>
            )}
          </div>
        )}
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
