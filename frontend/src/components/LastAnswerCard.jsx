import { useState } from 'react';

export default function LastAnswerCard({ latest, hasCurrent }) {
  const [copied, setCopied] = useState(false);
  if (!hasCurrent) return null;

  const verdict = latest?.verdict || 'Waiting…';
  const kind    = latest?.kind    || 'wait';
  const feedback = latest?.feedback || 'Listening for the candidate\'s answer.';

  function copyFollowUp() {
    if (!latest?.followUp) return;
    navigator.clipboard.writeText(latest.followUp).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 800);
  }

  return (
    <section className="card">
      <div className="card__title">Latest answer</div>
      <div className="lastAns">
        <span className="lastAns__verdict" data-kind={kind}>{verdict}</span>
        <p className="lastAns__fb">{feedback}</p>
      </div>
      {latest?.answer && <div className="lastAns__quote">{latest.answer}</div>}
      {latest?.followUp && (
        <div
          className="lastAns__followup"
          onClick={copyFollowUp}
          style={{ borderColor: copied ? 'var(--candidate)' : undefined }}
        >
          {latest.followUp}
        </div>
      )}
    </section>
  );
}
