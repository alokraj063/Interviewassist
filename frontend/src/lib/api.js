// Thin fetch wrappers for the FastAPI backend. All calls are relative to Vite's base —
// '/' in dev (Vite proxies /api, /assist, /transcript to localhost:5000) and
// '/ai-interview-agent/' in production, where Caddy strips the prefix before FastAPI.

import { getToken, clearAuth } from './auth';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

function authHeaders(extra = {}) {
  const token = getToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function json(url, opts = {}) {
  const res = await fetch(BASE + url, { ...opts, headers: authHeaders(opts.headers || {}) });
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    // Token expired or revoked — drop the session and bounce to the login gate.
    clearAuth();
    window.location.reload();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export const api = {
  // Auth
  login: (username, password) => json('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }),
  me: () => json('/api/auth/me'),

  // Clients & JDs
  listClients:  ()             => json('/api/clients'),
  createClient: (name)         => json('/api/clients', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }),
  listJds:      (clientId)     => json(`/api/jds${clientId ? `?client_id=${encodeURIComponent(clientId)}` : ''}`),
  createJd:     (formData)     => json('/api/jds', { method: 'POST', body: formData }),

  // Interviews
  createInterview: (payload)   => json('/api/interviews', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }),
  endInterview:    (id)        => json(`/api/interviews/${id}/end`, { method: 'POST' }),
  listInterviews:  ()          => json('/api/interviews'),
  getInterview:    (id)        => json(`/api/interviews/${id}`),

  // Transcript turn log
  saveTurn: (payload) => fetch(BASE + '/transcript', {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  }).catch(() => {}),

  // Assist (GPT-driven flow)
  assistStart:   (formData)         => json('/assist/start',   { method: 'POST', body: formData }),
  assistNext:    (sessionId, history) => json('/assist/next',  {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, history }),
  }),
  assistVerify:  (sessionId, question, answer) => json('/assist/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, question, answer }),
  }),
  assistFinal:   (sessionId, history) => json('/assist/final', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, history }),
  }),
};
