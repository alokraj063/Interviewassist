export default function Topbar({
  view, onView,
  micState, callState, callMode,
  theme, onToggleTheme,
}) {
  const phone = callMode === 'phone';
  const isDark = theme === 'dark';
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand__mark" />
        <div>
          <h1>Interview Assist</h1>
          <p>Live call transcription · Deepgram nova-3</p>
        </div>
      </div>
      <nav className="nav">
        <button className={`nav__tab ${view === 'live' ? 'is-active' : ''}`} onClick={() => onView('live')}>● Live</button>
        <button className={`nav__tab ${view === 'library' ? 'is-active' : ''}`} onClick={() => onView('library')}>▤ Library</button>
      </nav>
      <div className="statuses">
        <div className="status">
          <span className="dot" data-state={micState} />
          <span>{phone ? 'Phone (mixed mic)' : 'Interviewer (mic)'}</span>
        </div>
        {!phone && (
          <div className="status">
            <span className="dot" data-state={callState} />
            <span>Candidate (call audio)</span>
          </div>
        )}
        <button
          type="button"
          className="themeToggle"
          onClick={onToggleTheme}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          title={isDark ? 'Light theme' : 'Dark theme'}
        >
          {isDark ? '☀' : '☾'}
        </button>
      </div>
    </header>
  );
}
