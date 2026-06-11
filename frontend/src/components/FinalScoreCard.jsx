import { useEffect, useRef } from 'react';

function scoreColor(v) {
  return v >= 70 ? 'var(--candidate)' : v >= 45 ? '#eab308' : '#ef4444';
}
function verdictColor(label) {
  const s = (label || '').toLowerCase();
  if (s.includes('strong hire')) return 'var(--candidate)';
  if (s.includes('hire'))        return 'var(--interviewer)';
  if (s.includes('no hire'))     return '#ef4444';
  if (s.includes('lean no'))     return '#f97316';
  return '#eab308';
}

function Evidence({ items, marker, kind }) {
  if (!items?.length) return null;
  return (
    <ul className={`evidence__list evidence__list--${kind}`}>
      {items.map((t, i) => <li key={i}>{marker} {t}</li>)}
    </ul>
  );
}

export default function FinalScoreCard({ finalScore }) {
  const ref = useRef(null);
  useEffect(() => {
    if (finalScore && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [finalScore]);

  if (!finalScore) return null;
  const score = finalScore.score || {};
  const overall = typeof score.overall === 'number' ? score.overall : 0;
  const ringStyle = { '--val': overall, '--c': scoreColor(overall) };

  return (
    <section className="card finalCard" ref={ref}>
      <div className="finalCard__head">
        <div className="card__title" style={{ marginBottom: 0 }}>Final evaluation</div>
        <span className="verdictBadge verdictBadge--lg" style={{ background: verdictColor(finalScore.verdict) }}>
          {finalScore.verdict || '—'}
        </span>
      </div>
      <div className="finalScore">
        <div className="score__ring finalScore__ring" style={ringStyle}>
          <span>{typeof score.overall === 'number' ? score.overall : '–'}</span>
        </div>
        <div className="score__bars">
          <Bar label="Skills match"  v={score.skills_match} />
          <Bar label="Relevance"     v={score.relevance} />
          <Bar label="Depth"         v={score.depth} />
          <Bar label="Communication" v={score.communication} />
        </div>
      </div>
      {finalScore.summary && <p className="finalSummary">{finalScore.summary}</p>}
      <div className="evidence">
        <Evidence items={finalScore.strengths} marker="✓" kind="good" />
        <Evidence items={finalScore.concerns}  marker="✗" kind="bad" />
      </div>
    </section>
  );
}

function Bar({ label, v }) {
  return (
    <div className="bar">
      <label>{label}</label>
      <div className="bar__track">
        <i style={{ width: `${v || 0}%` }} />
      </div>
    </div>
  );
}
