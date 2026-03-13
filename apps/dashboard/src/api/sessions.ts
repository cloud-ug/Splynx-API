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
