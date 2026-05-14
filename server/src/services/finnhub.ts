import axios from 'axios';
import { env } from '../env.js';

const BASE = 'https://finnhub.io/api/v1';

function client() {
  return axios.create({
    baseURL: BASE,
    params: { token: env.finnhubApiKey },
    timeout: 10_000,
    validateStatus: () => true,
  });
}

export async function companyNews(symbol: string, from: string, to: string): Promise<unknown[]> {
  const res = await client().get('/company-news', { params: { symbol, from, to } });
  return Array.isArray(res.data) ? res.data : [];
}

export async function newsSentiment(symbol: string): Promise<unknown> {
  const res = await client().get('/news-sentiment', { params: { symbol } });
  return res.data ?? null;
}

export async function earningsCalendar(symbol: string): Promise<unknown> {
  const res = await client().get('/calendar/earnings', { params: { symbol } });
  return res.data ?? null;
}

export async function insiderTransactions(symbol: string): Promise<unknown> {
  const res = await client().get('/stock/insider-transactions', { params: { symbol } });
  return res.data ?? null;
}
