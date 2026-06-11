const VERDICT_KIND = {
  Strong: 'ok', Adequate: 'ok',
  Weak: 'weak', Vague: 'weak',
  'Off-topic': 'bad',
  Skipped: 'skip',
  'Manually accepted': 'ok',
};

export default function HistoryCard({ history }) {
  if (!history.length) return null;
  return (
    <section className="card">
      <div className="card__title">Asked so far</div>
      <div className="history">
        {history.map((h, i) => {
          const kind = VERDICT_KIND[h.verdict] || 'ok';
          return (
            <div className="qaItem" key={i}>
              <div className="qaItem__head">
                <span className="qaItem__num">{i + 1}</span>
                <span className="qaItem__cat">{h.category || '—'}</span>
                <span className="qaItem__verdict" data-kind={kind}>{h.verdict || '—'}</span>
              </div>
              <p className="qaItem__q">{h.question}</p>
              {h.answer && <p className="qaItem__a">{h.answer}</p>}
              {h.feedback && <p className="qaItem__fb">{h.feedback}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
