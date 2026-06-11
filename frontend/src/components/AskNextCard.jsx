import { useState } from 'react';

export default function AskNextCard({ current, history, onSkip, onMarkAnswered, onEndScore }) {
  const [copied, setCopied] = useState(false);
  if (!current) return null;

  function copyQuestion() {
    navigator.clipboard.writeText(current.question).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 800);
  }

  return (
    <section className="card askNext">
      <div className="askNext__head">
        <span className="askNext__cat">{current.category || '—'}</span>
        <span className="askNext__prog">Q{history.length + 1}</span>
      </div>
      <p className="askNext__q" onClick={copyQuestion}
         style={{ cursor: 'pointer', color: copied ? 'var(--candidate)' : undefined }}>
        {current.question}
      </p>
      <p className="askNext__copyHint">Tap the question to copy. Auto-advances when the candidate answers it.</p>
      <div className="askNext__actions">
        <button className="btn btn--ghost btn--sm" onClick={onSkip}>Skip</button>
        <button className="btn btn--sm" onClick={onMarkAnswered}>✓ Mark answered</button>
        <button className="btn btn--sm" onClick={onEndScore}>⏹ End &amp; score</button>
      </div>
    </section>
  );
}
