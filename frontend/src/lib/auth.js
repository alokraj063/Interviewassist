// Auth session storage. The backend issues a stateless HMAC-signed token on
// login; we keep it in localStorage so a refresh doesn't log the user out.

const KEY = 'ia-auth';

export function getAuth() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getToken() {
  return getAuth()?.token || null;
}

export function setAuth(auth) {
  try { localStorage.setItem(KEY, JSON.stringify(auth)); } catch {}
}

export function clearAuth() {
  try { localStorage.removeItem(KEY); } catch {}
}
