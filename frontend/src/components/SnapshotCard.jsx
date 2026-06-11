function verdictColor(label) {
  const s = (label || '').toLowerCase();
  if (s.includes('strong yes') || s.includes('strong fit') || s.includes('strong hire')) return 'var(--candidate)';
  if (s.includes('hire') || s.includes('yes') || s.includes('possible fit')) return 'var(--interviewer)';
  if (s.includes('strong no') || s.includes('weak fit')) return '#ef4444';
  if (s.includes('no')) return '#f97316';
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

export default function SnapshotCard({ snapshot }) {
  if (!snapshot || (!snapshot.summary && !snapshot.fitVerdict)) return null;
  return (
    <section className="card">
      <div className="card__title">
        Candidate snapshot
        {snapshot.fitVerdict && (
          <span className="verdictBadge" style={{ background: verdictColor(snapshot.fitVerdict) }}>
            {snapshot.fitVerdict}
          </span>
        )}
      </div>
      {snapshot.summary && <p className="snapshot">{snapshot.summary}</p>}
      <div className="evidence">
        <Evidence items={snapshot.strengths} marker="✓" kind="good" />
        <Evidence items={snapshot.gaps}      marker="✗" kind="bad" />
      </div>
    </section>
  );
}
