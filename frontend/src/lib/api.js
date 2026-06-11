// Thin fetch wrappers for the FastAPI backend. All calls are relative — Vite proxies
// /api, /assist, /transcript to localhost:3001 in dev; FastAPI serves them directly
// when the React build is mounted in production.

async function json(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export const api = {
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
  saveTurn: (payload) => fetch('/transcript', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
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
