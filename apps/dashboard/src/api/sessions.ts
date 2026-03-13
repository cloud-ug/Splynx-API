import api from './client';

export interface SimSession {
  sim_number: string;
  customer_id: string | null;
  customer_name: string | null;
  ip: string;
  router_id: string;
  router_name: string | null;
  started: string;
  download_bytes: number;
  upload_bytes: number;
  online: boolean;
}

export interface LteSimsResponse {
  total: number;
  sims: SimSession[];
}

export async function getActiveLteSims(): Promise<LteSimsResponse> {
  const res = await api.get('/sessions/online/lte-sims');
  return res.data;
}

export async function getRecentLteSims(): Promise<LteSimsResponse> {
  const res = await api.get('/sessions/recent');
  return res.data;
}

export interface DailySimEntry {
  sim_number: string;
  customer_id: number;
  customer_name: string | null;
  first_seen: string;
  last_seen: string;
  peak_download_bytes: number;
  peak_upload_bytes: number;
}

export interface TodayReportResponse {
  date: string;
  total: number;
  currently_online: number;
  sims: DailySimEntry[];
}

export async function getDayReport(date?: string): Promise<TodayReportResponse> {
  const res = await api.get('/sessions/report/day', { params: date ? { date } : {} });
  return res.data;
}

export async function getReportDates(): Promise<{ dates: string[] }> {
  const res = await api.get('/sessions/report/dates');
  return res.data;
}

export async function getSessionHistory(params?: {
  mac?: string;
  customer_id?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
}) {
  const res = await api.get('/sessions/history', { params });
  return res.data;
}

export async function getSimHistory(mac: string, page = 1) {
  const res = await api.get(`/sessions/history/sim/${encodeURIComponent(mac)}`, {
    params: { page },
  });
  return res.data;
}
