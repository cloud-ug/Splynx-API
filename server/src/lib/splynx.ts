import axios, { AxiosInstance } from 'axios';

let client: AxiosInstance | null = null;
let cachedToken = '';
let tokenExpiry = 0;

function getClient(): AxiosInstance {
  if (!client) {
    client = axios.create({
      baseURL: `${process.env.SPLYNX_URL}/api/2.0`,
      timeout: 15000,
    });
  }
  return client;
}

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const login = process.env.SPLYNX_LOGIN;
  const password = process.env.SPLYNX_PASSWORD;

  if (!login || !password) {
    throw new Error('SPLYNX_LOGIN and SPLYNX_PASSWORD must be set in .env');
  }

  try {
    const res = await getClient().post('/admin/auth/tokens', {
      auth_type: 'admin',
      login,
      password,
    });

    console.log('Splynx auth success');
    cachedToken = res.data.access_token;
    tokenExpiry = Date.now() + 25 * 60 * 1000; // tokens expire in 30min, refresh at 25
    return cachedToken;
  } catch (err: any) {
    console.error('Splynx auth failed:', err.response?.status, JSON.stringify(err.response?.data));
    throw err;
  }
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
    headers: { Authorization: `Splynx-EA (access_token=${token})` },
  });
  return res.data;
}
