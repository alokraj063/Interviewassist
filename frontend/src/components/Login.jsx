import { useState, useRef } from 'react';
import { api } from '../lib/api';

// Full-viewport sign-in gate. The brand mark doubles as a "live signal" motif —
// concentric pulse rings around the mark echo the product's live-audio identity.
export default function Login({ onLogin, theme, onToggleTheme }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const userRef = useRef(null);
  const isDark = theme === 'dark';

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      const res = await api.login(username.trim(), password);
      onLogin({ token: res.token, username: res.username });
    } catch {
      setError('Invalid username or password');
      setShake(true);
      setTimeout(() => setShake(false), 450);
      setPassword('');
      userRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login__bg" aria-hidden="true" />

      <button
        type="button"
        className="themeToggle login__theme"
        onClick={onToggleTheme}
        aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        {isDark ? '☀' : '☾'}
      </button>

      <main className={`login__card ${shake ? 'is-shaking' : ''}`}>
        <div className="login__mark" aria-hidden="true">
          <span className="login__ring login__ring--1" />
          <span className="login__ring login__ring--2" />
          <span className="login__markCore">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M5 12v2M9 8v8M12 5v14M15 8v8M19 11v3" />
            </svg>
          </span>
        </div>

        <h1 className="login__title">Interview&nbsp;Assist</h1>
        <p className="login__sub">Live transcription &amp; interview co-pilot</p>

        <form className="login__form" onSubmit={submit}>
          <label className="login__field">
            <span>Username</span>
            <input
              ref={userRef}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </label>

          <label className="login__field">
            <span>Password</span>
            <div className="login__pwRow">
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="login__pwToggle"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                {showPw ? '◡' : '◉'}
              </button>
            </div>
          </label>

          <p className="login__error" role="alert" data-visible={!!error}>
            {error || ' '}
          </p>

          <button className="btn btn--primary btn--block login__submit" disabled={busy}>
            {busy ? <span className="login__spinner" aria-hidden="true" /> : 'Sign in'}
          </button>
        </form>

        <footer className="login__foot">
          <span className="login__dot" /> JoulesToWatts · internal tool
        </footer>
      </main>
    </div>
  );
}
