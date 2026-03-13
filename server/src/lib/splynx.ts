import axios, { AxiosInstance } from 'axios';

let client: AxiosInstance | null = null;
let tokenExpiry = 0;
let cachedToken = '';

function getClient(): AxiosInstance {
  if (!client) {
    client = axios.create({
      baseURL: `${process.env.SPLYNX_URL}/api/v2`,
      timeout: 15000,
    });
  }
  return client;
}

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await getClient().post('/auth/tokens', {
    auth_type: 'admin',
    login: process.env.SPLYNX_LOGIN,
    password: process.env.SPLYNX_PASSWORD,
  });

  cachedToken = res.data.access_token;
  // tokens last 1 hour — refresh 5 min early
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

export async function splynx(
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  data?: Record<string, unknown>,
  params?: Record<string, unknown>
) {
  const token = await getToken();
  const res = await getClient().request({
    method,
    url: path,
    data,
    params,
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.data;
}
