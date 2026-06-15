import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import FinalScoreCard from './FinalScoreCard.jsx';

function speakerClass(speaker) {
  const s = (speaker || '').toLowerCase();
  if (s.startsWith('interviewer')) return 'turn--interviewer';
  if (s.startsWith('candidate'))   return 'turn--candidate';
  const m = /speaker\s*(\d+)/i.exec(speaker || '');
  return m ? `turn--s${m[1]}` : '';
}

export default function Library() {
  const [groups, setGroups] = useState({}); // client -> jd -> [interviews]
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { reload(); }, []);

  async function reload() {
    setLoading(true);
    try {
      const data = await api.listInterviews();
      if (data.ok) setGroups(groupBy(data.interviews));
    } finally { setLoading(false); }
  }
  async function open(id) {
    setSelected(id); setDetail(null);
    try {
      const data = await api.getInterview(id);
      if (data.ok) setDetail(data.interview);
    } catch {}
  }

  return (
    <main className="library">
      <aside className="library__list">
        <div className="library__listHead">
          <span>Saved interviews</span>
          <button className="btn btn--ghost btn--sm" onClick={reload}>↻</button>
        </div>
        <div id="libraryGroups">
          {loading && <p style={{ padding: 12, color: 'var(--muted)' }}>Loading…</p>}
          {!loading && Object.keys(groups).length === 0 && (
            <p style={{ padding: 12, color: 'var(--muted)' }}>No interviews saved yet.</p>
          )}
          {Object.entries(groups).map(([client, jds]) => (
            <div className="libGroup" key={client}>
              <div className="libGroup__client">{client}</div>
              {Object.entries(jds).map(([jd, items]) => (
                <div className="libGroup__jd" key={jd}>
                  <div className="libGroup__jdTitle">{jd}</div>
                  {items.map((it) => (
                    <button key={it.id}
                            className={`libItem ${selected === it.id ? 'is-active' : ''}`}
                            onClick={() => open(it.id)}>
                      <span className="libItem__name">{it.candidate_name || '(unnamed)'}</span>
                      {typeof it.score_overall === 'number' && (
                        <span className="scoreBadge"
                              style={{ background: scoreBg(it.score_overall) }}>{it.score_overall}</span>
                      )}
                      <span className="libItem__meta">
                        {fmtTime(it.started_at)}{it.rec_verdict ? ` · ${it.rec_verdict}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <section className="library__detail">
        {!detail && (
          <div className="empty">
            <h2>Select an interview</h2>
            <p className="hint">Pick a saved interview on the left to see its transcript and analysis.</p>
          </div>
        )}
        {detail && (
          <>
            <div className="detailHead">
              <h2>{detail.candidate_name || '(unnamed)'}</h2>
              <p style={{ color: 'var(--muted)' }}>
                {detail.client_name || '—'} · {detail.jd_title || '—'} · {fmtTime(detail.started_at)}
              </p>
            </div>
            {detail.summary && (
              <section className="card">
                <div className="card__title">Pre-call snapshot</div>
                <p className="snapshot">{detail.summary}</p>
              </section>
            )}
            {hasFinal(detail.final) && <FinalScoreCard finalScore={detail.final} />}
            {detail.turns && detail.turns.length > 0 && (
              <section className="card">
                <div className="card__title">Transcript</div>
                <div className="transcript transcript--static">
                  {detail.turns.map((t, i) => (
                    <div key={i} className={`turn ${speakerClass(t.speaker)}`}>
                      <div className="turn__meta">
                        <span className="turn__who">{t.speaker}</span>
                        {t.time && <span className="turn__time">{t.time}</span>}
                      </div>
                      <div className="turn__text">{t.text}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}

// True when a saved interview has a stored end-of-call evaluation worth rendering.
function hasFinal(f) {
  if (!f) return false;
  return Boolean(f.summary || f.verdict || (f.score && f.score.overall != null));
}

function groupBy(list) {
  const out = {};
  list.forEach((it) => {
    const c = it.client_name || '(No client)';
    const j = it.jd_title    || '(No JD)';
    (out[c] = out[c] || {});
    (out[c][j] = out[c][j] || []).push(it);
  });
  return out;
}
function fmtTime(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}
function scoreBg(v) {
  if (v == null) return 'var(--border)';
  return v >= 70 ? 'var(--candidate)' : v >= 45 ? '#eab308' : '#ef4444';
}
